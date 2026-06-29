import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import fetch from 'node-fetch';
import xlsx from 'xlsx';
import QRCode from 'qrcode';
import querystring from 'querystring';
import moment from 'moment-timezone';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Import from lib modules
import { productFile, transactionsFile, waTransactionsFile, TX_TIMEOUT_MS, RESERVATION_EXPIRY_MS, POLL_INTERVAL_MS, TX_HISTORY_CAP, TG_MSG_LIMIT, FAKE_PHONE, DEFAULT_USER_AGENT, writeFileAtomic, withProductLock, withTxLock, withUserPurchaseLock, withWaTxFile, withTgTxFile, tgActiveReservations, chatLog, rcLog, updateSalesCount, generateDeliveryFilename, rollbackStock } from './foundation.js';
import { getProducts, setProducts, getConfig, setConfig, getImageId, setImageId, loadCache, saveProducts, koalaStore, getKoalaProductsCached, getMergedProducts, calculateBulkPrice } from './config.js';
import { loadTransactions, saveTransactionFile, loadAllTransactions, saveTgTransaction, updateTgTransactionStatus } from './transactions.js';
import { getStockPath, getStockCount, checkStockAccount, loadStockByFormat, loadSosmedAccount, loadSosmedAccountNetflix, renameProductFile, getHeldReservations, reserveStockForTx, commitReservedStock, releaseReservation } from './stock.js';
import { checkTransactionStatus, checkSaweriaPayment, checkPakasirPayment, createDompetxPayment, cancelDompetxPayment, checkPaymentByProvider } from './payments.js';
import * as digiflazz from './digiflazz.js';

// Fire-and-forget DompetX cancel — never throws, never blocks.
// Used wherever a TG transaction transitions away from UNPAID via timeout/cancel/sweep.
const tgCancelDompetxIfNeeded = (provider, apiKey, dpxTxId, reason) => {
    if (provider !== 'dompetx' || !apiKey || !dpxTxId) return;
    cancelDompetxPayment(apiKey, dpxTxId).then(r => {
        rcLog('DOMPETX_CANCEL', `tx=${dpxTxId} reason=${reason} status=${r.status}${r.message ? ' msg=' + r.message : ''}`);
    }).catch(() => { /* swallow */ });
};
import { Pakasir } from 'pakasir-sdk';

function setupTGBot(deps) {
    const { bot, sessions, saveUser, gopay, getUsers } = deps;

    // --- Master Data Management ---
    let GLOBAL_MASTERS = [];
    const loadMasterData = () => {
        try {
            if (!fs.existsSync(path.join(projectRoot, 'master.json'))) fs.writeFileSync(path.join(projectRoot, 'master.json'), '[]');
            const data = fs.readFileSync(path.join(projectRoot, 'master.json'), 'utf8');
            GLOBAL_MASTERS = JSON.parse(data);
        } catch { GLOBAL_MASTERS = []; }
    };
    loadMasterData(); // Initial Load

    function isMaster(userId) {
        // Asumsi master.json berisi array of commands/IDs atau string ID
        // Jika format master.json adalah ["12345", 67890]
        return GLOBAL_MASTERS.includes(userId) || GLOBAL_MASTERS.includes(userId.toString());
    }

    function getSession(chatId) {
        if (!sessions.has(chatId)) {
            sessions.set(chatId, { state: 'IDLE', data: {} });
        }
        const s = sessions.get(chatId);
        s._lastActivity = Date.now();
        return s;
    }

    // Periodic session cleanup — remove IDLE sessions inactive for 1 hour
    const SESSION_TTL_MS = 60 * 60 * 1000;
    setInterval(() => {
        const now = Date.now();
        let cleaned = 0;
        for (const [chatId, s] of sessions) {
            if (s.state === 'IDLE' && s._lastActivity && (now - s._lastActivity > SESSION_TTL_MS)) {
                sessions.delete(chatId);
                cleaned++;
            }
        }
        if (cleaned > 0) console.log(`[TG] Session cleanup: removed ${cleaned} stale sessions (${sessions.size} remaining)`);
    }, SESSION_TTL_MS);

    // --- GATEKEEPER HELPERS ---
    const checkMembership = async (chatId) => {
        const config = getConfig()[0];
        if (!config.gatekeeper || !config.gatekeeper.enabled) return true;

        const channelId = config.gatekeeper.channel ? config.gatekeeper.channel.id : null;
        const groupId = config.gatekeeper.group ? config.gatekeeper.group.id : null;

        try {
            let channelOk = true;
            if (channelId && channelId.trim() !== '') {
                channelOk = await bot.getChatMember(channelId, chatId)
                    .then(m => ['creator', 'administrator', 'member'].includes(m.status))
                    .catch(() => false);
            }

            let groupOk = true;
            if (groupId && groupId.trim() !== '') {
                groupOk = await bot.getChatMember(groupId, chatId)
                    .then(m => ['creator', 'administrator', 'member'].includes(m.status))
                    .catch(() => false);
            }

            return channelOk && groupOk;
        } catch (e) {
            console.error("Gatekeeper Check Error:", e);
            return true; // fail open if error
        }
    };

    const sendGatekeeperMessage = async (chatId) => {
        const config = getConfig()[0];
        const adminTg = config.admin_contact_telegram || 'admin_username';
        const adminUrl = `https://t.me/${adminTg}`;

        const channelId = config.gatekeeper.channel ? config.gatekeeper.channel.id : null;
        const channelLink = config.gatekeeper.channel ? (config.gatekeeper.channel.link || config.gatekeeper.channel.id) : null;
        const groupId = config.gatekeeper.group ? config.gatekeeper.group.id : null;
        const groupLink = config.gatekeeper.group ? (config.gatekeeper.group.link || config.gatekeeper.group.id) : null;

        let requirementsMsg = "";
        const inlineKeyboard = [];

        if (channelId && channelId.trim() !== '') {
            requirementsMsg += `📢 *Channel:* [Join Sini](${channelLink})\n`;
            inlineKeyboard.push([{ text: '📢 Join Channel', url: channelLink }]);
        }

        if (groupId && groupId.trim() !== '') {
            requirementsMsg += `💬 *Group:* [Join Sini](${groupLink})\n`;
            inlineKeyboard.push([{ text: '💬 Join Group', url: groupLink }]);
        }

        const msg = `⚠️ *Akses Dibatasi!*

Anda harus bergabung ke komunitas kami terlebih dahulu untuk menggunakan bot ini.

${requirementsMsg}
Setelah bergabung, klik tombol **✅ Saya Sudah Join** di bawah.
Jika ada kendala, hubungi [Admin](${adminUrl})`;

        inlineKeyboard.push([{ text: '✅ Saya Sudah Join', callback_data: 'check_gatekeeper' }]);
        inlineKeyboard.push([{ text: '📞 Hubungi Admin', url: adminUrl }]);

        return bot.sendMessage(chatId, msg, {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: inlineKeyboard
            }
        });
    };

    // Modules config — controls which top-level menu the user sees.
    // Default: account only (backward compatible). If both enabled, user gets a 2-button picker.
    const getModules = () => {
        const cfg = getConfig()[0] || {};
        const m = cfg.modules || {};
        const account = m.account_enabled !== false;
        const ppob = !!m.ppob_enabled;
        // Safety: at least one must be on
        if (!account && !ppob) return { account: true, ppob: false };
        return { account, ppob };
    };

    const isDigiflazzReady = () => {
        const cfg = getConfig()[0] || {};
        const df = cfg.digiflazz || {};
        return !!(df.is_active && df.username && df.api_key);
    };

    const getMainMenuKeyboard = (isMasterUser) => {
        if (isMasterUser) {
            return [['➕ Tambah Produk', '✏️ Edit Produk', '✏️ Edit Stock', '📢 Broadcast'], ['💰 Saldo PPOB', '📜 Riwayat']];
        }
        const mods = getModules();
        // Both modules → 2-button top row
        if (mods.account && mods.ppob) {
            return [
                ['🛒 Beli Akun', '📲 PPOB & Pulsa'],
                ['📦 Stok', '🔍 Cari Produk'],
                ['🛍️ Cara Order', 'ℹ️ Informasi'],
                ['🔥 Produk Populer', '📜 Riwayat']
            ];
        }
        // PPOB only
        if (mods.ppob && !mods.account) {
            return [
                ['📲 PPOB & Pulsa'],
                ['🔍 Cari Produk', '🛍️ Cara Order'],
                ['ℹ️ Informasi', '📜 Riwayat']
            ];
        }
        // Account only (default — current behavior)
        return [
            ['📃 List Product', '📦 Stok'],
            ['🔍 Cari Produk', '🛍️ Cara Order'],
            ['ℹ️ Informasi', '🔥 Produk Populer'],
            ['📜 Riwayat']
        ];
    };

    // Local helpers for PPOB navigation: return Digiflazz-sourced products only
    const getPpobProducts = () => (getProducts() || []).filter(p => p && p.source === 'digiflazz' && (p.buyer_product_status !== false));
    const getNonPpobProducts = () => (getProducts() || []).filter(p => !p || p.source !== 'digiflazz');

    // PPOB pending dispatch registry — refId → { chatId, productName, customer_no, userInfo, msg_id }
    // Used when Digiflazz returns rc=03 (Pending): webhook later resolves it via dfDispatcher.
    const pendingPpob = new Map();

    // Webhook dispatcher — invoked by routes.js POST /webhook/digiflazz after sig verify.
    // Looks up pendingPpob by refId; if found, delivers SN to user and notifies admin.
    // If not in memory (bot restart), tries to recover from tx file.
    const dfDispatcher = async ({ refId, payload, bucket, eventType }) => {
        if (!refId) return;
        let entry = pendingPpob.get(refId);

        // Fallback: rebuild from tx file (covers bot restart between dispatch & webhook)
        if (!entry) {
            try {
                let tx = null;
                await withTgTxFile(txs => { tx = txs.find(t => t.reference === refId); });
                if (tx && tx.chatId) {
                    entry = {
                        chatId: tx.chatId,
                        productName: tx.productName || 'PPOB',
                        customerNo: tx.digiflazz?.customer_no || '',
                        refId,
                        userInfo: { id: tx.chatId, first_name: tx.name || '', username: tx.username || '' },
                        msg_id: null,
                        quantity: tx.quantity || 1,
                    };
                }
            } catch (e) { console.error('[PPOB] dfDispatcher recovery failed:', e.message); }
        }

        if (!entry) {
            rcLog('PPOB_WEBHOOK', `IGNORED ref=${refId} (not in pending registry, not a TG tx). bucket=${bucket}`);
            return;
        }

        const { chatId, productName, customerNo, quantity, msg_id } = entry;
        const sn = payload.sn || '';
        const msg = payload.message || '';

        if (bucket === 'SUCCESS') {
            const text =
                `✅ *Transaksi Sukses!*\n\n` +
                `📦 *${productName}*\n` +
                `📱 Tujuan: \`${customerNo}\`\n` +
                `🧾 Ref: \`${refId}\`\n` +
                (sn ? `🔐 SN: \`${sn}\`\n` : '') +
                (msg ? `_${msg}_\n` : '') +
                `\n_Terima kasih telah membeli!_`;
            if (msg_id) {
                await bot.editMessageText(text, { chat_id: chatId, message_id: msg_id, parse_mode: 'Markdown' }).catch(() => bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }));
            } else {
                await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
            }
            try { await updateSalesCount(productName, quantity || 1); } catch {}
            pendingPpob.delete(refId);
            rcLog('PPOB_DELIVERED', `ref=${refId} sku=${payload.buyer_sku_code} cust=${customerNo} sn=${sn ? 'yes' : 'no'}`);
            return;
        }

        if (bucket === 'PENDING') {
            // Intermediate updates — leave the original "diproses" message in place.
            return;
        }

        // FAILED
        const errText =
            `⚠️ *Transaksi Gagal*\n\n` +
            `📦 *${productName}*\n` +
            `📱 Tujuan: \`${customerNo}\`\n` +
            `🧾 Ref: \`${refId}\`\n` +
            `Alasan: _${msg || ('rc=' + payload.rc)}_\n\n` +
            `💸 *Dana Anda akan di-refund oleh admin.*`;
        if (msg_id) {
            await bot.editMessageText(errText, { chat_id: chatId, message_id: msg_id, parse_mode: 'Markdown' }).catch(() => bot.sendMessage(chatId, errText, { parse_mode: 'Markdown' }));
        } else {
            await bot.sendMessage(chatId, errText, { parse_mode: 'Markdown' });
        }
        notifyAdmin({
            type: 'paid', platform: 'telegram',
            buyer: String(chatId), product: productName, quantity: quantity || 1,
            amount: 0, invoice: refId,
            extra: `PPOB FAILED via webhook rc=${payload.rc} msg="${msg}" cust=${customerNo} — REFUND REQUIRED`
        });
        pendingPpob.delete(refId);
        rcLog('PPOB_FAILED', `ref=${refId} sku=${payload.buyer_sku_code} cust=${customerNo} rc=${payload.rc}`);
    };


    // Helper: Function to clean up ALL previous bot messages (Clear Screen)
    const cleanupPreviousMessage = async (chatId) => {
        const session = getSession(chatId);
        // Ensure array exists
        if (!session.activeBotMessages) session.activeBotMessages = [];

        // Loop and delete
        for (const msgId of session.activeBotMessages) {
            try {
                await bot.deleteMessage(chatId, msgId);
            } catch (e) {
                // Ignore "Message to delete not found" or too old
            }
        }
        // Reset array
        session.activeBotMessages = [];
        session.lastBotMessageId = null; // Deprecated but keep for safety reset
    };

    const sendWelcomeMessage = async (chatId, from) => {
        const session = getSession(chatId);
        saveUser(chatId);
        await cleanupPreviousMessage(chatId);

        const isMasterUser = isMaster(from.id);
        const userName = from.username || from.first_name || "Pelanggan";
        const currentProvider = (getConfig()[0].payment_provider === 'saweria') ? 'Saweria' : 'Tripay';
        const storeName = getConfig()[0].store_name || 'Telegram Store';
        const now = new Date().toLocaleString('id-ID', {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Asia/Jakarta'
        });

        const welcomeMessage = `
━━━━━━━━━━━━━━
✨ *${storeName.toUpperCase()}* ✨
━━━━━━━━━━━━━━

📅 *${now}* WIB
👋 *Halo, ${userName}!*
Selamat datang di ${storeName}. Belanja otomatis 24/7 — order, bayar, terima langsung di chat.

🚀 *MULAI BELANJA:*
🛒 /beli - Lihat Produk & Order
ℹ️ /info - Informasi Layanan
💰 /harga - Cek Harga Terupdate
📞 /kontak - Hubungi Admin

_Silakan pilih menu di bawah untuk mulai menggunakan bot!_
        `;

        try {
            let msgSent;
            const imagePath = path.join(projectRoot, 'imagetele.jpg');
            if (getImageId()) {
                msgSent = await bot.sendPhoto(chatId, getImageId(), { parse_mode: 'Markdown', caption: welcomeMessage });
            } else {
                const fileStream = fs.createReadStream(imagePath);
                msgSent = await bot.sendPhoto(chatId, fileStream, { parse_mode: 'Markdown', caption: welcomeMessage }, { contentType: 'image/jpeg' });
                if (msgSent.photo && msgSent.photo.length > 0) setImageId(msgSent.photo[msgSent.photo.length - 1].file_id);
            }
            session.activeBotMessages.push(msgSent.message_id);
        } catch (e) {
            const sent = await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
            session.activeBotMessages.push(sent.message_id);
        }

        const sentMenu = await bot.sendMessage(chatId, `🛍️ Halo *${isMasterUser ? 'Master' : userName}*! Pilih aksi di bawah:`, {
            parse_mode: 'Markdown',
            reply_markup: { keyboard: getMainMenuKeyboard(isMasterUser), resize_keyboard: true },
        });
        session.activeBotMessages.push(sentMenu.message_id);
    };


    bot.on('message', async (msg) => {
        if (!msg.text) return;
        const chatId = msg.chat.id;
        const text = msg.text.trim();
        const session = getSession(chatId);

        // Log incoming TG message
        const tgName = (msg.from.first_name || '') + (msg.from.last_name ? ' ' + msg.from.last_name : '') || msg.from.username || String(msg.from.id);
        chatLog('TG', 'IN', chatId, tgName.trim(), text);

        // Auto-refresh products on likely purchase intents
        if (text === '📃 List Product' || text === '🔥 Produk Populer' || text === '/start' || (text && text.startsWith('/beli'))) {
            try {
                const merged = await getMergedProducts();
                setProducts(merged);
            } catch (e) { console.error('[TG] Product refresh failed:', e.message); }
        }

        // Ensure activeBotMessages exists in session
        if (!session.activeBotMessages) session.activeBotMessages = [];

        // GATEKEEPER CHECK (EXCEPT for callback queries handled elsewhere)
        const isMasterUser = isMaster(msg.from.id);
        if (!isMasterUser) {
            const isMember = await checkMembership(chatId);
            if (!isMember) {
                await cleanupPreviousMessage(chatId);
                await sendGatekeeperMessage(chatId);
                return;
            }
        }

        // Delete User's Input Message (EXCEPT /start)
        // Delete user's input (best-effort — message may already be gone)
        if (text !== '/start') {
            try {
                await bot.deleteMessage(chatId, msg.message_id);
            } catch (e) { /* best-effort delete */ }
        }

        // --- PPOB State Machine (before generic states) ---
        const backToMainMenu = async () => {
            session.state = 'IDLE';
            session.data.ppob = null;
            await cleanupPreviousMessage(chatId);
            const sent = await bot.sendMessage(chatId, 'Kembali ke menu utama.', {
                reply_markup: { keyboard: getMainMenuKeyboard(isMasterUser), resize_keyboard: true }
            });
            session.activeBotMessages.push(sent.message_id);
        };

        if (session.state === 'PPOB_CATEGORY') {
            if (text === '🔙 Back' || text === '❌ Cancel') { await backToMainMenu(); return; }
            const picked = text.replace(/^📲 /, '').trim();
            const cats = session.data.ppob?.categories || [];
            if (!cats.includes(picked)) {
                const sent = await bot.sendMessage(chatId, '⚠️ Pilih kategori dari tombol di bawah.');
                setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(()=>{}), 2500);
                return;
            }
            await showPpobBrands(chatId, picked);
            return;
        }
        if (session.state === 'PPOB_BRAND') {
            if (text === '🔙 Back' || text === '❌ Cancel') { await startPpobFlow(chatId, msg.from); return; }
            const picked = text.replace(/^🏷️ /, '').trim();
            const brands = session.data.ppob?.brands || [];
            if (!brands.includes(picked)) {
                const sent = await bot.sendMessage(chatId, '⚠️ Pilih brand dari tombol di bawah.');
                setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(()=>{}), 2500);
                return;
            }
            await showPpobSkus(chatId, picked);
            return;
        }
        if (session.state === 'PPOB_SKU') {
            if (text === '🔙 Back' || text === '❌ Cancel') {
                const cat = session.data.ppob?.category;
                if (cat) { await showPpobBrands(chatId, cat); } else { await startPpobFlow(chatId, msg.from); }
                return;
            }
            if (/^\d+$/.test(text)) {
                const idx = parseInt(text) - 1;
                await askPpobCustomerNo(chatId, idx);
                return;
            }
            const sent = await bot.sendMessage(chatId, '⚠️ Ketik nomor produk (angka) dari daftar.');
            setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(()=>{}), 2500);
            return;
        }
        if (session.state === 'PPOB_CUSTOMER_NO') {
            if (text === '🔙 Back') {
                const brand = session.data.ppob?.brand;
                if (brand) { await showPpobSkus(chatId, brand); } else { await startPpobFlow(chatId, msg.from); }
                return;
            }
            if (text === '❌ Cancel') { await backToMainMenu(); return; }
            // Accept digits and optional dot for SKUs that need it (rare)
            const customerNo = text.replace(/\s+/g, '');
            if (!/^[0-9.]{4,20}$/.test(customerNo)) {
                const sent = await bot.sendMessage(chatId, '⚠️ Nomor tujuan harus angka 4–20 digit. Coba lagi.');
                setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(()=>{}), 3000);
                return;
            }
            const product = session.data.ppob?.product;
            if (!product) { await backToMainMenu(); return; }
            session.data.ppob.customer_no = customerNo;
            await cleanupPreviousMessage(chatId);

            // PLN prabayar (token) — run inquiry first so user can verify nama/meter
            // before paying. Heuristic: brand === "PLN" (case-insensitive).
            const isPln = (product.brand || '').toUpperCase() === 'PLN';
            if (isPln) {
                const cfg = getConfig()[0] || {};
                const df = cfg.digiflazz || {};
                const wait = await bot.sendMessage(chatId, '🔄 *Cek data PLN...*\n\nMemverifikasi ID Pelanggan...', { parse_mode: 'Markdown' });
                session.activeBotMessages.push(wait.message_id);
                const inq = await digiflazz.inquiryPln({ username: df.username, apiKey: df.api_key, customerNo });
                rcLog('PPOB_INQUIRY_PLN', `cust=${customerNo} ok=${inq.ok} rc=${inq.rc || '-'} name=${inq.name || '-'}`);

                if (!inq.ok) {
                    session.state = 'PPOB_CUSTOMER_NO'; // stay on input
                    const errMsg = inq.message || inq.error || `rc=${inq.rc || 'unknown'}`;
                    await bot.editMessageText(
                        `❌ *Cek PLN Gagal*\n\nID Pelanggan: \`${customerNo}\`\nAlasan: _${errMsg}_\n\n` +
                        `Periksa kembali nomor lalu ketik ulang, atau ketik *❌ Cancel* untuk batal.`,
                        { chat_id: chatId, message_id: wait.message_id, parse_mode: 'Markdown' }
                    ).catch(() => {});
                    return;
                }

                session.state = 'PPOB_PLN_CONFIRM';
                session.data.ppob.pln_inquiry = inq;
                const harga = (product.priceProduct || 0).toLocaleString('id-ID');
                const detail =
                    `✅ *Konfirmasi Pembayaran PLN*\n\n` +
                    `📦 Produk: *${product.productName}*\n` +
                    `💰 Harga: *Rp${harga}*\n` +
                    `\n━━━━━━━━━━━━━━━\n` +
                    `📱 ID Pelanggan: \`${inq.customer_no}\`\n` +
                    (inq.name ? `🏠 Nama: *${inq.name}*\n` : '') +
                    (inq.meter_no ? `🔌 No. Meter: \`${inq.meter_no}\`\n` : '') +
                    (inq.subscriber_id ? `🆔 Subscriber ID: \`${inq.subscriber_id}\`\n` : '') +
                    (inq.segment_power ? `⚡ Segmen/Daya: *${inq.segment_power}*\n` : '') +
                    `━━━━━━━━━━━━━━━\n\n` +
                    `Pastikan data di atas sudah *benar*. Lanjut ke pembayaran?`;
                await bot.editMessageText(detail, {
                    chat_id: chatId, message_id: wait.message_id, parse_mode: 'Markdown'
                }).catch(() => {});
                await bot.sendMessage(chatId, 'Pilih:', {
                    reply_markup: { keyboard: [['✅ Lanjut Bayar'], ['🔙 Back', '❌ Cancel']], resize_keyboard: true }
                }).then(m => session.activeBotMessages.push(m.message_id));
                return;
            }

            // Non-PLN — show confirmation before payment
            session.state = 'PPOB_CONFIRM';
            session.data.ppob.customer_no = customerNo;
            const hargaConfirm = (product.priceProduct || 0).toLocaleString('id-ID');
            const confirmMsg =
                `📋 *Konfirmasi Pembayaran*\n\n` +
                `📦 Produk: *${product.productName}*\n` +
                `💰 Harga: *Rp${hargaConfirm}*\n` +
                `📱 Tujuan: \`${customerNo}\`\n` +
                `🧾 SKU: \`${product.buyer_sku_code}\`\n\n` +
                `Pastikan data di atas sudah *benar*. Lanjut ke pembayaran?`;
            const confirmSent = await bot.sendMessage(chatId, confirmMsg, {
                parse_mode: 'Markdown',
                reply_markup: { keyboard: [['✅ Lanjut Bayar'], ['🔙 Back', '❌ Cancel']], resize_keyboard: true }
            });
            session.activeBotMessages.push(confirmSent.message_id);
            return;
        }

        if (session.state === 'PPOB_PLN_CONFIRM') {
            if (text === '🔙 Back') {
                session.state = 'PPOB_CUSTOMER_NO';
                const product = session.data.ppob?.product;
                await cleanupPreviousMessage(chatId);
                const harga = (product?.priceProduct || 0).toLocaleString('id-ID');
                const sent = await bot.sendMessage(chatId,
                    `✅ *${product?.productName || ''}*\nHarga: *Rp${harga}*\n\n📝 Ketik ulang *ID Pelanggan PLN* (atau Back ke daftar produk).`,
                    { parse_mode: 'Markdown', reply_markup: { keyboard: [['🔙 Back', '❌ Cancel']], resize_keyboard: true } });
                session.activeBotMessages.push(sent.message_id);
                return;
            }
            if (text === '❌ Cancel') { await backToMainMenu(); return; }
            if (text === '✅ Lanjut Bayar' || text.toLowerCase() === 'ya' || text.toLowerCase() === 'lanjut') {
                const product = session.data.ppob?.product;
                if (!product) { await backToMainMenu(); return; }
                await cleanupPreviousMessage(chatId);
                await executePurchaseGlobal(chatId, product, 1, msg.from);
                return;
            }
            const sent = await bot.sendMessage(chatId, '⚠️ Pilih *✅ Lanjut Bayar* atau *❌ Cancel*.', { parse_mode: 'Markdown' });
            setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(()=>{}), 3000);
            return;
        }

        // --- State: PPOB_CONFIRM (non-PLN confirmation before payment) ---
        if (session.state === 'PPOB_CONFIRM') {
            if (text === '🔙 Back') {
                session.state = 'PPOB_CUSTOMER_NO';
                const product = session.data.ppob?.product;
                await cleanupPreviousMessage(chatId);
                const harga = (product?.priceProduct || 0).toLocaleString('id-ID');
                const sent = await bot.sendMessage(chatId,
                    `✅ *${product?.productName || ''}*\nHarga: *Rp${harga}*\n\n📝 Ketik ulang *nomor tujuan* (atau Back ke daftar produk).`,
                    { parse_mode: 'Markdown', reply_markup: { keyboard: [['🔙 Back', '❌ Cancel']], resize_keyboard: true } });
                session.activeBotMessages.push(sent.message_id);
                return;
            }
            if (text === '❌ Cancel') { await backToMainMenu(); return; }
            if (text === '✅ Lanjut Bayar' || text.toLowerCase() === 'ya' || text.toLowerCase() === 'lanjut') {
                const product = session.data.ppob?.product;
                const customerNo = session.data.ppob?.customer_no;
                if (!product || !customerNo) { await backToMainMenu(); return; }
                await cleanupPreviousMessage(chatId);
                await executePurchaseGlobal(chatId, product, 1, msg.from);
                return;
            }
            const sent = await bot.sendMessage(chatId, '⚠️ Pilih *✅ Lanjut Bayar* atau *❌ Cancel*.', { parse_mode: 'Markdown' });
            setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(()=>{}), 3000);
            return;
        }

        // --- 0. State: WAITING_PAYMENT — block most input, but allow explicit escape commands ---
        if (session.state === 'WAITING_PAYMENT') {
            // Escape hatch: /cancel, /batal, ❌ Cancel — force-cancel the in-flight tx so user can recover
            // (covers stuck flows where the QR's inline button is gone or unresponsive).
            const isCancelIntent = /^(\/cancel|\/batal|❌\s*cancel|❌\s*batalkan\s*pesanan|batal|cancel)$/i.test(text);
            if (isCancelIntent) {
                const ref = session.data.paymentReference;
                try { stopTGPaymentPoller(session); } catch {}
                if (ref) {
                    try { await updateTgTransactionStatus(ref, 'CANCELLED'); } catch {}
                    // Best-effort DompetX cancel
                    try {
                        const _c = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json'), 'utf8'));
                        const _cfg = Array.isArray(_c) ? _c[0] : _c;
                        tgCancelDompetxIfNeeded(session.data.paymentProvider, _cfg?.dompetx?.api_key || '', session.data.dompetxTxId || '', 'user-cancel-escape');
                    } catch {}
                    // Release any held reservation
                    const r = tgActiveReservations.get(ref);
                    if (r && r.reservationStatus === 'HELD') tgActiveReservations.delete(ref);
                    if (session.data.reservedLines && session.data.reservationStatus === 'HELD') {
                        try { releaseReservation(session.data); } catch {}
                    }
                    rcLog('CANCELLED', `TG | escape-cancel | inv=${ref}`);
                }
                session.state = 'IDLE';
                session.data.ppob = null;
                await bot.sendMessage(chatId, '❌ Transaksi dibatalkan. Kembali ke menu utama.', {
                    reply_markup: { keyboard: getMainMenuKeyboard(isMasterUser), resize_keyboard: true }
                });
                return;
            }
            const warn = await bot.sendMessage(chatId, '⏳ *Transaksi sedang berjalan!*\n\nSelesaikan pembayaran, klik tombol di bawah QR, atau ketik */cancel* untuk membatalkan.', { parse_mode: 'Markdown' });
            setTimeout(() => bot.deleteMessage(chatId, warn.message_id).catch(() => { }), 5000);
            return;
        }

        // --- 1. State: WAITING_QUANTITY ---
        if (session.state === 'WAITING_QUANTITY') {
            // Jika user ketik Back/Cancel
            if (text === '🔙 Back' || text === '❌ Cancel') {
                session.state = 'IDLE';
                await cleanupPreviousMessage(chatId);
                const sent = await bot.sendMessage(chatId, `Kembali ke menu utama.`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        keyboard: getMainMenuKeyboard(isMasterUser),
                        resize_keyboard: true,
                    },
                });
                session.activeBotMessages.push(sent.message_id);
                return;
            }

            // Jika user ketik angka (Manual Quantity)
            if (/^\d+$/.test(text)) {
                const quantity = parseInt(text);
                await cleanupPreviousMessage(chatId);
                await confirmAndPurchase(chatId, session.data.selectedProduct, quantity, msg.from);
                return;
            }

            // Jika input ngawur - Send Warning then Delete
            const sent = await bot.sendMessage(chatId, '❌ Harap masukkan angka yang benar atau pilih tombol di atas.');
            setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(() => { }), 3000);
            return;
        }

        // --- State: WAITING_PURCHASE_CONFIRM (review order before payment) ---
        if (session.state === 'WAITING_PURCHASE_CONFIRM') {
            if (text === '🔙 Back' || text === '❌ Cancel') {
                session.state = 'IDLE';
                session.data.confirmProduct = null;
                session.data.confirmQuantity = null;
                await cleanupPreviousMessage(chatId);
                const sent = await bot.sendMessage(chatId, `❌ Pesanan dibatalkan. Kembali ke menu utama.`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        keyboard: getMainMenuKeyboard(isMasterUser),
                        resize_keyboard: true,
                    },
                });
                session.activeBotMessages.push(sent.message_id);
                return;
            }
            if (text === '✅ Lanjut Bayar' || text.toLowerCase() === 'ya' || text.toLowerCase() === 'lanjut') {
                const confirmProduct = session.data.confirmProduct;
                const confirmQuantity = session.data.confirmQuantity;
                if (!confirmProduct || !confirmQuantity) {
                    session.state = 'IDLE';
                    return bot.sendMessage(chatId, '⚠️ Sesi pesanan kadaluarsa. Silakan ulangi pembelian.', {
                        reply_markup: { keyboard: getMainMenuKeyboard(isMasterUser), resize_keyboard: true }
                    });
                }
                session.data.confirmProduct = null;
                session.data.confirmQuantity = null;
                await cleanupPreviousMessage(chatId);
                await executePurchaseGlobal(chatId, confirmProduct, confirmQuantity, msg.from);
                return;
            }
            const sent = await bot.sendMessage(chatId, '⚠️ Pilih *✅ Lanjut Bayar* atau *❌ Cancel*.', { parse_mode: 'Markdown' });
            setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(() => { }), 3000);
            return;
        }

        // --- 2. State: SELECTING_CATEGORY ---
        if (session.state === 'SELECTING_CATEGORY') {
            if (text === '🔙 Back' || text === '❌ Cancel') {
                session.state = 'IDLE';
                await cleanupPreviousMessage(chatId);
                const sent = await bot.sendMessage(chatId, `Kembali ke menu utama.`, {
                    reply_markup: { keyboard: getMainMenuKeyboard(isMasterUser), resize_keyboard: true }
                });
                session.activeBotMessages.push(sent.message_id);
                return;
            }

            const categories = [...new Set(getProducts().map(p => p.category || 'Lainnya'))];
            const category = text.replace(/^📁 /, '');
            if (!categories.includes(category)) {
                return; // or error
            }

            session.state = 'SELECTING_VARIANT';
            session.data.selectedCategory = category;
            await cleanupPreviousMessage(chatId);

            const variants = getProducts().filter(p => (p.category || 'Lainnya') === category);
            let msg = `🗂️ *Pilih Varian Produk:*\n📂 Kategori: *${category}*\n\n📦 *Status Stok Produk:*\n`;

            variants.forEach(v => {
                msg += `🔹 ${v.productName} — Stock: *${getStockCount(v)}*\n`;
            });

            const variantButtons = variants.map((v, i) => [`${i + 1}. ${v.productName} (Stock: ${getStockCount(v)})`]);
            variantButtons.push(['🔙 Back']);

            const sent = await bot.sendMessage(chatId, msg, {
                parse_mode: 'Markdown',
                reply_markup: { keyboard: variantButtons, resize_keyboard: true }
            });
            session.activeBotMessages.push(sent.message_id);
            return;
        }

        // --- 2.5 State: SELECTING_VARIANT ---
        if (session.state === 'SELECTING_VARIANT') {
            if (text === '🔙 Back') {
                // Return to category list
                session.state = 'IDLE';
                await cleanupPreviousMessage(chatId);
                const categories = [...new Set(getProducts().map(p => p.category || 'Lainnya'))];
                const categoryButtons = categories.map(c => [`📁 ${c}`]);
                categoryButtons.push(['🔙 Back']);

                let stockSummary = "\n\n📦 *Status Stok Produk:*\n";
                getProducts().forEach(p => {
                    stockSummary += `🔹 ${p.productName} — Stock: *${getStockCount(p)}*\n`;
                });

                const sent = await bot.sendMessage(chatId, `🗂️ *Silahkan pilih kategori produk:*${stockSummary}`, {
                    parse_mode: 'Markdown',
                    reply_markup: { keyboard: categoryButtons, resize_keyboard: true }
                });
                session.activeBotMessages.push(sent.message_id);
                session.state = 'SELECTING_CATEGORY';
                return;
            }

            const category = session.data.selectedCategory;
            const variants = getProducts().filter(p => (p.category || 'Lainnya') === category);

            const match = text.match(/^(\d+)\./);
            if (!match) return;

            const index = parseInt(match[1]) - 1;
            const selectedProduct = variants[index];

            if (!selectedProduct) {
                const sent = await bot.sendMessage(chatId, '❌ Varian tidak ditemukan.');
                session.activeBotMessages.push(sent.message_id);
                return;
            }

            session.state = 'IDLE';
            const globalIndex = getProducts().findIndex(p => p.productName === selectedProduct.productName);
            handleProductSelection(chatId, selectedProduct, globalIndex);
            return;
        }

        // --- 3. Global Handler: Back Button (untuk semua state) ---
        if (text === '🔙 Back') {
            const userId = msg.from.id;
            const username = msg.from.username;
            const isMasterUser = isMaster(userId);

            session.state = 'IDLE';
            await cleanupPreviousMessage(chatId);

            const keyboard = getMainMenuKeyboard(isMasterUser);

            const sent = await bot.sendMessage(chatId, `🛍️ Kembali ke menu utama.\n\nHallo ${isMasterUser ? 'Master' : username}! Pilih aksi yang ingin Anda lakukan:`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: keyboard,
                    resize_keyboard: true,
                },
            });
            session.activeBotMessages.push(sent.message_id);
            return;
        }

        // ... existing /start logic check ...
        const lowerText = text.toLowerCase();
        if (lowerText.includes('mulai') || lowerText.includes('start')) {
            await sendWelcomeMessage(chatId, msg.from);
            return;
        }

        // --- QUICK STOCK CHECK ---
        if (lowerText.startsWith('cek stok') || lowerText.startsWith('stock')) {
            const query = lowerText.replace(/^(cek stok|stock)\s*/, '');
            setProducts(await getMergedProducts());
            if (!query || query === 'semua') {
                let stockMsg = "📦 *Status Stok Semua Produk:*\n\n";
                getProducts().forEach(p => {
                    stockMsg += `🔹 *${p.productName}* — Stock: *${getStockCount(p)}*\n`;
                });
                const sent = await bot.sendMessage(chatId, stockMsg, { parse_mode: 'Markdown' });
                session.activeBotMessages.push(sent.message_id);
            } else {
                const found = getProducts().filter(p => p.productName.toLowerCase().includes(query));
                if (found.length > 0) {
                    let stockMsg = `📦 *Status Stok: "${query}"*\n\n`;
                    found.forEach(p => { stockMsg += `🔹 *${p.productName}* — Stock: *${getStockCount(p)}*\n`; });
                    const sent = await bot.sendMessage(chatId, stockMsg, { parse_mode: 'Markdown' });
                    session.activeBotMessages.push(sent.message_id);
                } else {
                    const sent = await bot.sendMessage(chatId, '❌ Produk tidak ditemukan.');
                    session.activeBotMessages.push(sent.message_id);
                }
            }
            return;
        }

        // --- State: SEARCHING (user types search query) ---
        if (session.state === 'SEARCHING') {
            if (text === '🔙 Back' || text === '❌ Cancel') {
                session.state = 'IDLE';
                await cleanupPreviousMessage(chatId);
                const sent = await bot.sendMessage(chatId, `🛍️ Kembali ke menu utama.`, {
                    reply_markup: { keyboard: getMainMenuKeyboard(isMasterUser), resize_keyboard: true }
                });
                session.activeBotMessages.push(sent.message_id);
                return;
            }

            const query = text.toLowerCase();
            setProducts(await getMergedProducts());
            const found = getProducts().filter(p =>
                p.productName.toLowerCase().includes(query) ||
                (p.productId || '').toLowerCase().includes(query) ||
                (p.category || '').toLowerCase().includes(query)
            );

            await cleanupPreviousMessage(chatId);

            if (found.length === 0) {
                const sent = await bot.sendMessage(chatId, `❌ Produk dengan kata kunci *"${text}"* tidak ditemukan.\n\nCoba kata kunci lain atau klik 🔙 Back.`, {
                    parse_mode: 'Markdown',
                    reply_markup: { keyboard: [['🔙 Back']], resize_keyboard: true }
                });
                session.activeBotMessages.push(sent.message_id);
                return;
            }

            let resultMsg = `🔍 *Hasil Pencarian: "${text}"*\n\n`;
            found.forEach((p, i) => {
                const stock = getStockCount(p);
                const price = (p.priceProduct || 0).toLocaleString('id-ID');
                const icon = stock > 0 ? '✅' : '❌';
                resultMsg += `*${i + 1}.* ${p.productName}\n└ Rp${price} • ${icon} Stok: ${stock}\n\n`;
            });
            resultMsg += `_Ketik nomor untuk melihat detail, atau cari lagi._`;

            session.state = 'SEARCH_RESULT';
            session.data.searchResults = found;

            const sent = await bot.sendMessage(chatId, resultMsg, {
                parse_mode: 'Markdown',
                reply_markup: { keyboard: [['🔙 Back']], resize_keyboard: true }
            });
            session.activeBotMessages.push(sent.message_id);
            return;
        }

        // --- State: SEARCH_RESULT (user picks from search results) ---
        if (session.state === 'SEARCH_RESULT') {
            if (text === '🔙 Back') {
                session.state = 'SEARCHING';
                await cleanupPreviousMessage(chatId);
                const sent = await bot.sendMessage(chatId, '🔍 *Cari Produk*\n\nKetik nama produk yang ingin dicari:', {
                    parse_mode: 'Markdown',
                    reply_markup: { keyboard: [['🔙 Back']], resize_keyboard: true }
                });
                session.activeBotMessages.push(sent.message_id);
                return;
            }

            if (/^\d+$/.test(text)) {
                const idx = parseInt(text) - 1;
                const results = session.data.searchResults || [];
                if (idx >= 0 && idx < results.length) {
                    const product = results[idx];
                    const globalIndex = getProducts().findIndex(p => p.productName === product.productName);
                    await handleProductSelection(chatId, product, globalIndex >= 0 ? globalIndex : idx);
                } else {
                    const sent = await bot.sendMessage(chatId, '❌ Nomor tidak valid. Pilih dari daftar hasil pencarian.');
                    setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(() => {}), 3000);
                }
                return;
            }

            // If user types non-number, treat as new search
            const query = text.toLowerCase();
            setProducts(await getMergedProducts());
            const found = getProducts().filter(p =>
                p.productName.toLowerCase().includes(query) ||
                (p.productId || '').toLowerCase().includes(query) ||
                (p.category || '').toLowerCase().includes(query)
            );
            await cleanupPreviousMessage(chatId);

            if (found.length === 0) {
                const sent = await bot.sendMessage(chatId, `❌ Produk *"${text}"* tidak ditemukan.\n\nCoba kata kunci lain atau klik 🔙 Back.`, {
                    parse_mode: 'Markdown',
                    reply_markup: { keyboard: [['🔙 Back']], resize_keyboard: true }
                });
                session.activeBotMessages.push(sent.message_id);
                return;
            }

            let resultMsg = `🔍 *Hasil Pencarian: "${text}"*\n\n`;
            found.forEach((p, i) => {
                const stock = getStockCount(p);
                const price = (p.priceProduct || 0).toLocaleString('id-ID');
                const icon = stock > 0 ? '✅' : '❌';
                resultMsg += `*${i + 1}.* ${p.productName}\n└ Rp${price} • ${icon} Stok: ${stock}\n\n`;
            });
            resultMsg += `_Ketik nomor untuk melihat detail, atau cari lagi._`;

            session.data.searchResults = found;
            const sent = await bot.sendMessage(chatId, resultMsg, {
                parse_mode: 'Markdown',
                reply_markup: { keyboard: [['🔙 Back']], resize_keyboard: true }
            });
            session.activeBotMessages.push(sent.message_id);
            return;
        }

        // --- 1.5 State: LIST_PRODUCT (Paginated Selection) ---
        if (session.state === 'LIST_PRODUCT') {
            if (text === '🔙 Back' || text === '❌ Cancel') {
                session.state = 'IDLE';
                await cleanupPreviousMessage(chatId);
                const isMasterUser = isMaster(msg.from.id);
                const sent = await bot.sendMessage(chatId, `🛍️ Kembali ke menu utama.`, {
                    reply_markup: { keyboard: getMainMenuKeyboard(isMasterUser), resize_keyboard: true }
                });
                session.activeBotMessages.push(sent.message_id);
                return;
            }

            if (/^\d+$/.test(text)) {
                const index = parseInt(text) - 1;
                // Lookup against the SAME filtered list shown in the paginated UI
                // (sendPaginatedProducts uses getNonPpobProducts) — using getProducts()
                // here would map the buyer's number to the wrong product when PPOB
                // items are present.
                const accountProducts = getNonPpobProducts();
                const product = accountProducts[index];
                if (product) {
                    // handleProductSelection expects a GLOBAL index into getProducts()
                    // (buy_<index>_<qty> callbacks resolve from getProducts()).
                    const globalIndex = getProducts().findIndex(p => p.productName === product.productName);
                    await handleProductSelection(chatId, product, globalIndex >= 0 ? globalIndex : index);
                } else {
                    const sent = await bot.sendMessage(chatId, '❌ Nomor produk tidak valid.');
                    setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(() => { }), 3000);
                }
                return;
            }
        }
    });

    // Helper: Logic setelah pilih produk (tampilkan stok & button quantity)
    // Ini memindahkan logic dari dalam bot.once yang lama
    const handleProductSelection = async (chatId, product, index) => {
        const session = getSession(chatId);
        await cleanupPreviousMessage(chatId);

        const userId = session.data.userId || 0;
        const isMasterUser = isMaster(userId);

        // Clear the numbered keyboard and show a Back button
        const kbMsg = await bot.sendMessage(chatId, `🔍 Menampilkan detail untuk ${product.productName}...`, {
            reply_markup: {
                keyboard: [['🔙 Back']],
                resize_keyboard: true
            }
        });
        session.activeBotMessages.push(kbMsg.message_id);

        const stock = getStockCount(product);
        if (stock === 0) {
            const sent = await bot.sendMessage(chatId, `❌ Stok habis untuk ${product.productName}.`, {
                reply_markup: { keyboard: getMainMenuKeyboard(isMasterUser), resize_keyboard: true }
            });
            session.activeBotMessages.push(sent.message_id);
            return;
        }

        const priceStr = (product.priceProduct || 0).toLocaleString('id-ID');

        const qtyOptions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 50, 100].filter(n => n <= stock);
        const inlineKeyboard = [];
        // Row 1: 1-5
        const row1 = qtyOptions.filter(n => n >= 1 && n <= 5).map(n => ({ text: n.toString(), callback_data: `buy_${index}_${n}` }));
        if (row1.length) inlineKeyboard.push(row1);
        // Row 2: 6-10
        const row2 = qtyOptions.filter(n => n >= 6 && n <= 10).map(n => ({ text: n.toString(), callback_data: `buy_${index}_${n}` }));
        if (row2.length) inlineKeyboard.push(row2);
        // Row 3: 20, 50, 100
        const row3 = qtyOptions.filter(n => n > 10).map(n => ({ text: n.toString(), callback_data: `buy_${index}_${n}` }));
        if (row3.length) inlineKeyboard.push(row3);
        inlineKeyboard.push([{ text: '❌ Cancel', callback_data: `buy_${index}_cancel` }]);

        // Mobile-friendly markdown layout (no ASCII box)
        let detailMsg = `📦 *DETAIL PRODUK*\n━━━━━━━━━━━━━━━━━━\n\n`;
        detailMsg += `*${product.productName}*\n\n`;
        detailMsg += `💰 Harga: *Rp${priceStr}*\n`;
        detailMsg += `📦 Stok: *${stock} Paket*\n`;
        detailMsg += `🛡️ Garansi: ${product.warranty || '-'}\n`;
        detailMsg += `🔑 Aktivasi: ${product.activation || '-'}\n`;
        detailMsg += `📧 Email: ${product.email || '-'}\n`;

        // Show bulk discount tiers if available
        const tiers = Array.isArray(product.bulkDiscounts) ? product.bulkDiscounts.filter(t => t.minQty && t.price) : [];
        if (tiers.length > 0) {
            const sortedTiers = [...tiers].sort((a, b) => Number(a.minQty) - Number(b.minQty));
            detailMsg += `\n💰 *Diskon Grosir:*\n`;
            sortedTiers.forEach(t => {
                detailMsg += `├ Beli ≥${t.minQty} pcs → *Rp${Number(t.price).toLocaleString('id-ID')}*/pcs\n`;
            });
        }

        detailMsg += `\n📝 *Deskripsi:* ${product.description || '-'}\n⚠️ *Aturan:* ${product.usage || '-'}\n\n🔢 *Pilih jumlah atau Ketik Manual:*`;

        const sent = await bot.sendMessage(chatId, detailMsg, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: inlineKeyboard },
        });
        session.activeBotMessages.push(sent.message_id);

        session.state = 'WAITING_QUANTITY';
        session.data.selectedProduct = product;
        session.data.productIndex = index;
    };

    const showPopularProducts = async (chatId, editMsgId = null) => {
        const session = getSession(chatId);
        if (!editMsgId) await cleanupPreviousMessage(chatId);

        loadCache();
        // GLOBAL_CONFIG refreshed via getConfig()
        session.state = 'popular';
        session.data = {};

        if (getProducts().length === 0) {
            const isMasterUser = isMaster(session.data.userId || 0);
            const msg = "❌ Data produk tidak tersedia.";
            if (editMsgId) {
                return bot.editMessageText(msg, { chat_id: chatId, message_id: editMsgId, reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'list_page_1' }]] } });
            }
            const sent = await bot.sendMessage(chatId, msg, {
                reply_markup: {
                    keyboard: [['🔙 Back']],
                    resize_keyboard: true,
                }
            });
            session.activeBotMessages.push(sent.message_id);
            return;
        }

        try {
            const filteredProducts = getProducts().filter(product =>
                typeof product.totalProdukTerjual === 'number' && product.totalProdukTerjual > 0
            );

            if (filteredProducts.length === 0) {
                const msg = "❌ Tidak ada produk populer berdasarkan data penjualan.";
                if (editMsgId) {
                    return bot.editMessageText(msg, { chat_id: chatId, message_id: editMsgId, reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'list_page_1' }]] } });
                }
                const sent = await bot.sendMessage(chatId, msg, {
                    reply_markup: {
                        keyboard: [['🔙 Back']],
                        resize_keyboard: true,
                    }
                });
                session.activeBotMessages.push(sent.message_id);
                return;
            }

            filteredProducts.sort((a, b) => b.totalProdukTerjual - a.totalProdukTerjual);
            const topProducts = filteredProducts.slice(0, 5);

            // Mobile-friendly markdown layout (no ASCII box)
            let message = `🔥 *PRODUK POPULER*\n_Top 5 Terlaris_\n━━━━━━━━━━━━━━━━━━\n\n`;

            const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
            topProducts.forEach((product, index) => {
                const price = (product.priceProduct || 0).toLocaleString('id-ID');
                const medal = medals[index] || `${index + 1}.`;
                message += `${medal} *${product.productName}*\n`;
                message += `└ Rp${price} • Terjual ${product.totalProdukTerjual}x\n\n`;
            });

            message += `━━━━━━━━━━━━━━━━━━`;

            if (editMsgId) {
                try {
                    return await bot.editMessageCaption(message, {
                        chat_id: chatId,
                        message_id: editMsgId,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'list_page_1' }]] }
                    });
                } catch (e) {
                    return await bot.editMessageText(message, {
                        chat_id: chatId,
                        message_id: editMsgId,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'list_page_1' }]] }
                    });
                }
            }

            const sent = await bot.sendMessage(chatId, message, {
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: [['🔙 Back']],
                    resize_keyboard: true,
                }
            });
            session.activeBotMessages.push(sent.message_id);
        } catch (error) {
            console.error("Error processing popular products:", error);
            const msg = "❌ Terjadi kesalahan saat membaca data produk.";
            if (editMsgId) {
                return bot.editMessageText(msg, { chat_id: chatId, message_id: editMsgId, reply_markup: { inline_keyboard: [[{ text: '🔙 Back', callback_data: 'list_page_1' }]] } });
            }
            const sent = await bot.sendMessage(chatId, msg, {
                reply_markup: {
                    keyboard: [['🔙 Back']],
                    resize_keyboard: true,
                }
            });
            session.activeBotMessages.push(sent.message_id);
        }
    };

    const sendPaginatedProducts = async (chatId, page = 1, editMsgId = null) => {
        const session = getSession(chatId);
        if (!editMsgId) await cleanupPreviousMessage(chatId);

        setProducts(await getMergedProducts());

        // "Beli Akun" listing — exclude PPOB-sourced products (they live behind the PPOB menu)
        const accountProducts = getNonPpobProducts();

        if (accountProducts.length === 0) {
            const isMasterUser = isMaster(session.data.userId || 0);
            const msg = '❌ Tidak ada produk.';
            if (editMsgId) {
                return bot.editMessageText(msg, { chat_id: chatId, message_id: editMsgId });
            }
            const sent = await bot.sendMessage(chatId, msg, {
                reply_markup: { keyboard: getMainMenuKeyboard(isMasterUser), resize_keyboard: true }
            });
            session.activeBotMessages.push(sent.message_id);
            return;
        }

        const itemsPerPage = 10;
        const totalPages = Math.ceil(accountProducts.length / itemsPerPage);
        const start = (page - 1) * itemsPerPage;
        const pageProducts = accountProducts.slice(start, start + itemsPerPage);

        // Mobile-friendly markdown layout (no ASCII box — renders cleanly on iOS/Android Telegram)
        let listText = `🛍️ *DAFTAR PRODUK*\n━━━━━━━━━━━━━━━━━━\n\n`;

        pageProducts.forEach((p, i) => {
            const stock = getStockCount(p);
            const price = (p.priceProduct || 0).toLocaleString('id-ID');
            const stockIcon = stock > 0 ? '✅' : '❌';
            const stockLabel = stock > 0 ? `Stok ${stock}` : 'Habis';
            const idx = start + i + 1;
            listText += `*${idx}.* ${p.productName}\n`;
            listText += `└ Rp${price} • ${stockIcon} ${stockLabel}\n\n`;
        });

        listText += `━━━━━━━━━━━━━━━━━━`;

        const now = new Date();
        const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
        const dayStr = days[now.getDay()];
        const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });

        listText += `\n📄 Halaman ${page} / ${totalPages}`;
        listText += `\n📆 ${dayStr}, ${timeStr}`;
        listText += `\n\n_Ketik nomor atau klik tombol untuk pilih produk._`;

        const inlineKeyboard = [];
        const navRow = [];
        if (page > 1) navRow.push({ text: '⬅️ Sebelumnya', callback_data: `list_page_${page - 1}` });
        if (page < totalPages) navRow.push({ text: '➡️ Selanjutnya', callback_data: `list_page_${page + 1}` });
        if (navRow.length > 0) inlineKeyboard.push(navRow);
        inlineKeyboard.push([{ text: '🔥 PRODUK POPULER', callback_data: 'popular_list' }]);

        const replyKeyboard = [];
        for (let i = 0; i < pageProducts.length; i += 3) {
            const row = [];
            for (let j = 0; j < 3 && (i + j) < pageProducts.length; j++) {
                row.push((start + i + j + 1).toString());
            }
            replyKeyboard.push(row);
        }
        replyKeyboard.push(['🔙 Back']);

        const welcomeImage = path.join(projectRoot, 'imagetele.jpg');
        let mainMsgId = editMsgId;

        if (editMsgId) {
            try {
                if (fs.existsSync(welcomeImage)) {
                    await bot.editMessageCaption(listText, {
                        chat_id: chatId,
                        message_id: editMsgId,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: inlineKeyboard }
                    });
                } else {
                    await bot.editMessageText(listText, {
                        chat_id: chatId,
                        message_id: editMsgId,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: inlineKeyboard }
                    });
                }
            } catch (e) {
                await cleanupPreviousMessage(chatId);
                mainMsgId = null;
            }
        }

        if (!mainMsgId) {
            try {
                if (fs.existsSync(welcomeImage)) {
                    const msgSent = await bot.sendPhoto(chatId, fs.createReadStream(welcomeImage), {
                        caption: listText,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: inlineKeyboard }
                    });
                    mainMsgId = msgSent.message_id;
                } else {
                    const msgSent = await bot.sendMessage(chatId, listText, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: inlineKeyboard }
                    });
                    mainMsgId = msgSent.message_id;
                }
                session.activeBotMessages.push(mainMsgId);
            } catch (e) { console.error(e); }
        }

        try {
            const menuSent = await bot.sendMessage(chatId, `🛍️ Pilih nomor di bawah untuk detail:`, {
                reply_markup: { keyboard: replyKeyboard, resize_keyboard: true }
            });
            session.activeBotMessages.push(menuSent.message_id);
        } catch (e) { console.error(e); }

        session.state = 'LIST_PRODUCT';
        session.data.currentPage = page;
    };


    function paymentOrder(apiKey, payload) {
        return fetch('https://tripay.co.id/api/transaction/create', {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        })
            .then(async res => {
                const data = await res.json();
                return data;
            })
            .catch(err => {
                console.error('Error:', err);
                return { success: false, message: err.message || 'Connection Error' };
            });
    }




    bot.onText(/\/beli/, async (msg) => {
        try {
            const chatId = msg.chat.id;
            try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

            saveUser(chatId);
            const session = getSession(chatId);
            await cleanupPreviousMessage(chatId);

            session.state = 'beli';
            session.data = {};

            const userId = msg.from.id;
            const username = msg.from.username;
            const isMasterUser = isMaster(userId);
            const keyboard = getMainMenuKeyboard(isMasterUser);

            const sent = await bot.sendMessage(chatId, `🛍️ Hallo ${isMasterUser ? 'Master' : username} ! Pilih aksi yang ingin Anda lakukan di bawah:`, {
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: keyboard,
                    resize_keyboard: true,
                },
            });
            session.activeBotMessages.push(sent.message_id);
        } catch (error) {
            console.error("Error handling /beli command:", error);
        }
    });

    bot.onText(/\/info/, async (msg) => {
        const chatId = msg.chat.id;
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        const session = getSession(chatId);
        await cleanupPreviousMessage(chatId);

        session.state = 'info';
        session.data = {};
        const storeName = getConfig()[0]?.store_name || 'Toko Online';
        const infoMessage = `
🔹 *Informasi ${storeName}* 🛍️
Belanja otomatis 24/7 — order, bayar, terima langsung di chat.

🛒 *Perintah berbelanja:*
- /beli - Beli produk
- /harga - Cek daftar harga
- /kontak - Hubungi admin

✨ Selamat berbelanja!
`;
        const sent = await bot.sendMessage(chatId, infoMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [['🔙 Back']],
                resize_keyboard: true,
            }
        });
        session.activeBotMessages.push(sent.message_id);
    });

    bot.onText(/\/kontak/, async (msg) => {
        const chatId = msg.chat.id;
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        const session = getSession(chatId);
        await cleanupPreviousMessage(chatId);

        const config = getConfig()[0];
        const adminTg = config.admin_contact_telegram || '';
        const adminWa = config.admin_contact_whatsapp || '';
        const opHours = config.operating_hours || '';
        const storeName = config.store_name || 'Telegram Store';

        session.state = 'kontak';
        session.data = {};

        let contactMessage = `📞 *HUBUNGI ADMIN*\n\nButuh bantuan atau ada pertanyaan?\nKami siap membantu kamu!\n\n🏪 *Store:* ${storeName}`;
        if (adminTg) contactMessage += `\n📱 *Telegram:* [@${adminTg}](https://t.me/${adminTg})`;
        if (adminWa) contactMessage += `\n📞 *WhatsApp:* [${adminWa}](https://wa.me/${adminWa})`;
        if (!adminTg && !adminWa) contactMessage += `\n👤 *Admin:* _Belum tersedia_`;
        contactMessage += `\n\n━━━━━━━━━━━━━━━━━━━━`;
        if (opHours) contactMessage += `\n⏰ *Jam Operasional:* ${opHours}`;
        contactMessage += `\n💬 Respon dalam 1x24 jam`;
        contactMessage += `\n━━━━━━━━━━━━━━━━━━━━`;
        contactMessage += `\n\nKlik link di atas untuk langsung chat. ✨`;
        const sent = await bot.sendMessage(chatId, contactMessage, {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [['🔙 Back']],
                resize_keyboard: true,
            }
        });
        session.activeBotMessages.push(sent.message_id);
    });

    bot.onText(/\/harga/, async (msg) => {
        const chatId = msg.chat.id;
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        const session = getSession(chatId);
        await cleanupPreviousMessage(chatId);

        session.state = 'harga';
        session.data = {};

        // Sync with Live Data
        setProducts(await getMergedProducts());

        let priceList;
        if (getProducts().length === 0) {
            priceList = "❌ *Tidak ada produk yang tersedia saat ini.*";
        } else {
            const now = new Date().toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: 'numeric', month: 'short' });
            priceList = `💰 *DAFTAR HARGA & STOK PRODUK*\n`;
            priceList += `⏰ _Last Update: ${now}_ \n\n`;

            getProducts().forEach((product) => {
                const stockVal = getStockCount(product);
                const stockIcon = stockVal > 0 ? "✅ Ready" : "❌ Habis";

                priceList += `🔹 *${product.productName}*\n`;
                priceList += `├ Harga : *Rp${Number(product.priceProduct).toLocaleString('id-ID')}*\n`;
                const hargaTiers = Array.isArray(product.bulkDiscounts) ? product.bulkDiscounts.filter(t => t.minQty && t.price) : [];
                if (hargaTiers.length > 0) {
                    const sortedHargaTiers = [...hargaTiers].sort((a, b) => Number(a.minQty) - Number(b.minQty));
                    sortedHargaTiers.forEach(t => {
                        priceList += `├ ≥${t.minQty}pcs : *Rp${Number(t.price).toLocaleString('id-ID')}*/pcs\n`;
                    });
                }
                priceList += `└ Stok  : *${stockVal}* (${stockIcon})\n\n`;
            });

            priceList += `──────────────────────\n`;
            priceList += `_Gunakan /beli atau menu di bawah untuk memesan._`;
        }

        const sent = await bot.sendMessage(chatId, priceList, {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [['🔙 Back']],
                resize_keyboard: true,
            }
        });
        session.activeBotMessages.push(sent.message_id);
    });

    let pendingBroadcasts = {};

    bot.onText(/📢 Broadcast/, async (msg) => {
        const chatId = msg.chat.id;
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        const userId = msg.from.id;
        const session = getSession(chatId);
        await cleanupPreviousMessage(chatId); // Clean screen

        // Ubah state sesuai dengan alur percakapan /beli
        session.state = 'broadcast';
        session.data = {}; // Misal reset data jika diperlukan
        if (isMaster(userId)) {
            const sent = await bot.sendMessage(chatId, "📢 *Apa pesan yang ingin Anda kirim ke semua pengguna?*", {
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: [['❌ Cancel']], // Tombol untuk membatalkan
                    resize_keyboard: true,
                },
            });
            session.activeBotMessages.push(sent.message_id);

            pendingBroadcasts[chatId] = true; // Menandai bahwa admin sedang dalam mode broadcast

            bot.once('message', async (msg) => { // Pakai `once` agar hanya menangkap satu pesan
                try { await bot.deleteMessage(msg.chat.id, msg.message_id); } catch (e) { }
                const chatId = msg.chat.id;
                const message = msg.text;

                if (message === '❌ Cancel') {
                    delete pendingBroadcasts[chatId]; // Hapus status broadcast
                    await cleanupPreviousMessage(chatId);

                    await bot.sendMessage(chatId, '❌ Proses broadcast dibatalkan.', {
                        parse_mode: 'Markdown',
                    });

                    // Kembali ke menu utama
                    const sentM = await bot.sendMessage(chatId, `Kembali ke menu utama. Pilih aksi yang ingin Anda lakukan:`, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            keyboard: [['➕ Tambah Produk', '✏️ Edit Produk', '✏️ Edit Stock', '📢 Broadcast']],
                            resize_keyboard: true,
                        },
                    });
                    session.activeBotMessages.push(sentM.message_id);
                    return;
                }

                if (pendingBroadcasts[chatId]) {
                    delete pendingBroadcasts[chatId]; // Hapus status setelah pesan dikirim

                    const users = getUsers();
                    users.forEach(userId => {
                        bot.sendMessage(userId, `📢 *Broadcast Message:*\n\n${message}`, { parse_mode: 'Markdown' });
                    });

                    const sentS = await bot.sendMessage(chatId, `✅ Pesan broadcast telah dikirim ke ${users.length} pengguna.`);
                    session.activeBotMessages.push(sentS.message_id);
                }
            });
        } else {
            const sentErr = await bot.sendMessage(chatId, "❌ Anda tidak memiliki izin untuk menggunakan perintah ini.");
            session.activeBotMessages.push(sentErr.message_id);
        }
    });

    bot.onText(/🛍️ Cara Order/, async (msg) => {
        const chatId = msg.chat.id;
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }
        const session = getSession(chatId);
        await cleanupPreviousMessage(chatId);

        const text = `
📖 *Cara Order di ${getConfig()[0].store_name || 'Store Kami'}:*

1. Pilih menu *📃 List Product*.
2. Pilih Kategori dan Varian produk yang diinginkan.
3. Klik varian produk untuk melihat detail & stok.
4. Klik angka atau ketik jumlah yang ingin dibeli.
5. Selesaikan pembayaran sesuai instruksi.
6. Produk akan otomatis dikirim setelah pembayaran terkonfirmasi.

Mudah dan Cepat! ✨
        `;
        const sent = await bot.sendMessage(chatId, text, {
            parse_mode: 'Markdown',
            reply_markup: { keyboard: [['🔙 Back']], resize_keyboard: true }
        });
        session.activeBotMessages.push(sent.message_id);
    });

    bot.onText(/📜 Riwayat|\/riwayat/, async (msg) => {
        const chatId = msg.chat.id;
        const isAdminViewer = isMaster(msg.from.id);
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }
        const session = getSession(chatId);
        await cleanupPreviousMessage(chatId);

        const allHistory = loadTransactions(transactionsFile);
        // Buyers see only their own history; masters see all.
        const history = isAdminViewer
            ? allHistory
            : allHistory.filter(tx => tx.chatId === chatId || tx.chatId === msg.from.id);

        let text = isAdminViewer
            ? "📜 *RIWAYAT TRANSAKSI TERAKHIR*\n📦 _Real-time Order Updates_ \n\n"
            : "📜 *RIWAYAT TRANSAKSI ANDA*\n\n";

        if (history.length === 0) {
            text += isAdminViewer
                ? " belum ada transaksi tercatat. Jadilah yang pertama belanja! 🛍️"
                : "_Belum ada transaksi._\n\nKetik /beli untuk mulai berbelanja. 🛍️";
        } else {
            // Sort by unique timestamp descending (latest first)
            const sorted = history.sort((a, b) => b.timestamp - a.timestamp).slice(0, 10);

            sorted.forEach((tx) => {
                const prod = tx.productName || tx.product || "Produk Digital";
                const qty = tx.quantity || 1;
                const time = tx.timestamp ? new Date(tx.timestamp).toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : "--:--";
                const statusIcon = (tx.status === 'PAID' || tx.status === undefined) ? '✅'
                    : tx.status === 'CANCELLED' ? '❌'
                    : tx.status === 'EXPIRED' ? '⏰'
                    : '⏳';
                const totalPrice = Number(tx.totalPrice || tx.amount || 0);
                const totalLabel = totalPrice > 0 ? ` — Rp${totalPrice.toLocaleString('id-ID')}` : '';

                if (isAdminViewer) {
                    const name = tx.name || "Customer";
                    text += `${statusIcon} *${name}*\n`;
                    text += `└ Membeli: *${prod}* (x${qty})${totalLabel}\n`;
                    text += `   🕒 _${time}_\n\n`;
                } else {
                    text += `${statusIcon} *${prod}* (x${qty})${totalLabel}\n`;
                    text += `└ 🕒 ${time}\n`;
                    if (tx.reference) text += `   🧾 Ref: \`${tx.reference}\`\n`;
                    text += `\n`;
                }
            });
            text += `──────────────────────\n`;
            text += isAdminViewer
                ? `_Ingin belanja juga? Pilih menu di bawah._`
                : `_Ingin belanja lagi? Pilih menu di bawah._`;
        }

        try {
            const sent = await bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: { keyboard: [['🔙 Back']], resize_keyboard: true }
            });
            session.activeBotMessages.push(sent.message_id);
        } catch (botErr) {
            console.error("Error sending history message:", botErr.message);
            // Fallback: Send without Markdown
            const fallbackSent = await bot.sendMessage(chatId, text.replace(/[\*_]/g, ''), {
                reply_markup: { keyboard: [['🔙 Back']], resize_keyboard: true }
            });
            session.activeBotMessages.push(fallbackSent.message_id);
        }
    });

    console.log("Bot berjalan...");
    const chunkArray = (array, chunkSize) => {
        const result = [];
        for (let i = 0; i < array.length; i += chunkSize) {
            result.push(array.slice(i, i + chunkSize));
        }
        return result;
    };

    bot.onText(/🔥 Produk Populer/, async (msg) => {
        const chatId = msg.chat.id;
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }
        await showPopularProducts(chatId);
    });

    bot.onText(/📃 List Product/, async (msg) => {
        const chatId = msg.chat.id;
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }
        await sendPaginatedProducts(chatId, 1);
    });

    // 🛒 Beli Akun — alias for List Product when both modules are enabled
    bot.onText(/🛒 Beli Akun/, async (msg) => {
        const chatId = msg.chat.id;
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }
        await sendPaginatedProducts(chatId, 1);
    });

    // 📲 PPOB & Pulsa — enters the Digiflazz prepaid topup flow
    bot.onText(/📲 PPOB( & Pulsa)?/, async (msg) => {
        const chatId = msg.chat.id;
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }
        await startPpobFlow(chatId, msg.from);
    });

    // 💰 Saldo PPOB / /saldo — master-only Digiflazz balance check
    const handleSaldoCommand = async (msg) => {
        const chatId = msg.chat.id;
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }
        if (!isMaster(msg.from.id)) {
            const sent = await bot.sendMessage(chatId, '❌ Perintah ini khusus admin.');
            setTimeout(() => bot.deleteMessage(chatId, sent.message_id).catch(() => {}), 3000);
            return;
        }
        const cfg = getConfig()[0] || {};
        const df = cfg.digiflazz || {};
        if (!df.is_active || !df.username || !df.api_key) {
            return bot.sendMessage(chatId, '⚠️ Digiflazz belum aktif / kredensial kosong. Atur di dashboard.');
        }
        const wait = await bot.sendMessage(chatId, '🔄 Mengecek saldo Digiflazz...');
        const r = await digiflazz.cekSaldo({ username: df.username, apiKey: df.api_key });
        const text = r.ok
            ? `💰 *Saldo Digiflazz*\n\n*Rp ${Number(r.deposit).toLocaleString('id-ID')}*\n\n_username: ${df.username}_`
            : `❌ Gagal cek saldo: ${r.error || 'unknown'}${r.rc ? ' (rc=' + r.rc + ')' : ''}`;
        await bot.editMessageText(text, { chat_id: chatId, message_id: wait.message_id, parse_mode: 'Markdown' });
    };
    bot.onText(/^\/saldo$/, handleSaldoCommand);
    bot.onText(/^💰 Saldo PPOB$/, handleSaldoCommand);

    // ==========================================
    // PPOB FLOW — category → brand → SKU → customer_no → invoice
    // Uses session.state: PPOB_CATEGORY | PPOB_BRAND | PPOB_SKU | PPOB_CUSTOMER_NO
    // ==========================================
    const startPpobFlow = async (chatId, from) => {
        const session = getSession(chatId);
        session.data.userInfo = from;
        await cleanupPreviousMessage(chatId);

        if (!getModules().ppob) {
            const sent = await bot.sendMessage(chatId, '⚠️ Modul PPOB tidak aktif.');
            session.activeBotMessages.push(sent.message_id);
            return;
        }
        // Refresh products so newly-imported SKUs show up
        try { setProducts(await getMergedProducts()); } catch {}
        const ppobProducts = getPpobProducts();
        if (ppobProducts.length === 0) {
            const sent = await bot.sendMessage(chatId, '⚠️ Belum ada produk PPOB yang di-import. Hubungi admin.', {
                reply_markup: { keyboard: getMainMenuKeyboard(isMaster(from.id)), resize_keyboard: true }
            });
            session.activeBotMessages.push(sent.message_id);
            return;
        }
        const categories = [...new Set(ppobProducts.map(p => p.category || 'Lainnya'))].sort();
        session.state = 'PPOB_CATEGORY';
        session.data.ppob = { categories };

        const keyboard = [];
        for (let i = 0; i < categories.length; i += 2) {
            const row = [];
            row.push(`📲 ${categories[i]}`);
            if (categories[i + 1]) row.push(`📲 ${categories[i + 1]}`);
            keyboard.push(row);
        }
        keyboard.push(['🔙 Back']);
        const sent = await bot.sendMessage(chatId, '📲 *PPOB / Pulsa*\n\nPilih kategori:', {
            parse_mode: 'Markdown',
            reply_markup: { keyboard, resize_keyboard: true }
        });
        session.activeBotMessages.push(sent.message_id);
    };

    const showPpobBrands = async (chatId, category) => {
        const session = getSession(chatId);
        const items = getPpobProducts().filter(p => (p.category || 'Lainnya') === category);
        const brands = [...new Set(items.map(p => p.brand || '-'))].sort();
        session.state = 'PPOB_BRAND';
        session.data.ppob = { ...(session.data.ppob || {}), category, brands };
        await cleanupPreviousMessage(chatId);

        const keyboard = [];
        for (let i = 0; i < brands.length; i += 2) {
            const row = [];
            row.push(`🏷️ ${brands[i]}`);
            if (brands[i + 1]) row.push(`🏷️ ${brands[i + 1]}`);
            keyboard.push(row);
        }
        keyboard.push(['🔙 Back']);
        const sent = await bot.sendMessage(chatId, `📲 *${category}*\n\nPilih brand:`, {
            parse_mode: 'Markdown',
            reply_markup: { keyboard, resize_keyboard: true }
        });
        session.activeBotMessages.push(sent.message_id);
    };

    const showPpobSkus = async (chatId, brand) => {
        const session = getSession(chatId);
        const { category } = session.data.ppob || {};
        const items = getPpobProducts()
            .filter(p => (p.category || 'Lainnya') === category && (p.brand || '-') === brand)
            .sort((a, b) => (a.priceProduct || 0) - (b.priceProduct || 0));
        session.state = 'PPOB_SKU';
        session.data.ppob = { ...(session.data.ppob || {}), brand, skus: items };
        await cleanupPreviousMessage(chatId);

        if (items.length === 0) {
            const sent = await bot.sendMessage(chatId, '⚠️ Tidak ada produk untuk brand ini.', {
                reply_markup: { keyboard: [['🔙 Back']], resize_keyboard: true }
            });
            session.activeBotMessages.push(sent.message_id);
            return;
        }
        let listText = `📲 *${category} — ${brand}*\n\nKetik nomor produk untuk membeli:\n\n`;
        const keyboard = [];
        items.slice(0, 30).forEach((p, idx) => {
            const stock = p.unlimited_stock ? '∞' : (p.stockCount || 0);
            const harga = (p.priceProduct || 0).toLocaleString('id-ID');
            listText += `*${idx + 1}.* ${p.productName} — Rp${harga} _(${stock})_\n`;
        });
        // Number-pad keyboard, 4 per row
        for (let i = 0; i < items.length && i < 30; i += 4) {
            const row = [];
            for (let j = 0; j < 4 && (i + j) < items.length && (i + j) < 30; j++) row.push(String(i + j + 1));
            keyboard.push(row);
        }
        keyboard.push(['🔙 Back']);
        const sent = await bot.sendMessage(chatId, listText, {
            parse_mode: 'Markdown',
            reply_markup: { keyboard, resize_keyboard: true }
        });
        session.activeBotMessages.push(sent.message_id);
    };

    const askPpobCustomerNo = async (chatId, productIdx) => {
        const session = getSession(chatId);
        const skus = session.data.ppob?.skus || [];
        const product = skus[productIdx];
        if (!product) {
            const sent = await bot.sendMessage(chatId, '⚠️ Produk tidak valid. Coba pilih ulang.');
            session.activeBotMessages.push(sent.message_id);
            return;
        }
        // Cut-off window check
        if (product.start_cut_off && product.end_cut_off) {
            const nowJkt = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jakarta' }));
            const [sh, sm] = String(product.start_cut_off).split(':').map(Number);
            const [eh, em] = String(product.end_cut_off).split(':').map(Number);
            if (!isNaN(sh) && !isNaN(eh)) {
                const cur = nowJkt.getHours() * 60 + nowJkt.getMinutes();
                const start = (sh || 0) * 60 + (sm || 0);
                const end = (eh || 0) * 60 + (em || 0);
                if (cur >= start && cur <= end) {
                    const sent = await bot.sendMessage(chatId,
                        `⏰ Produk sedang dalam jam *cut-off* (${product.start_cut_off}–${product.end_cut_off}).\nSilakan coba di luar jam tersebut.`,
                        { parse_mode: 'Markdown', reply_markup: { keyboard: [['🔙 Back']], resize_keyboard: true } });
                    session.activeBotMessages.push(sent.message_id);
                    return;
                }
            }
        }
        session.state = 'PPOB_CUSTOMER_NO';
        session.data.ppob = { ...(session.data.ppob || {}), product };
        await cleanupPreviousMessage(chatId);

        const harga = (product.priceProduct || 0).toLocaleString('id-ID');
        const sent = await bot.sendMessage(chatId,
            `✅ *${product.productName}*\nHarga: *Rp${harga}*\nSKU: \`${product.buyer_sku_code}\`\n\n` +
            `📝 Ketik *nomor tujuan* (HP / ID PLN / ID game):\n\n` +
            `_Contoh: 081234567890 untuk pulsa, 530000000003 untuk PLN._`, {
            parse_mode: 'Markdown',
            reply_markup: { keyboard: [['🔙 Back', '❌ Cancel']], resize_keyboard: true }
        });
        session.activeBotMessages.push(sent.message_id);
    };

    // 🔍 Cari Produk — search products by name
    bot.onText(/🔍 Cari Produk/, async (msg) => {
        const chatId = msg.chat.id;
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        const session = getSession(chatId);
        await cleanupPreviousMessage(chatId);

        session.state = 'SEARCHING';
        session.data = {};

        const sent = await bot.sendMessage(chatId, '🔍 *Cari Produk*\n\nKetik nama produk yang ingin dicari:\n\n_Contoh: netflix, spotify, canva_', {
            parse_mode: 'Markdown',
            reply_markup: { keyboard: [['🔙 Back']], resize_keyboard: true }
        });
        session.activeBotMessages.push(sent.message_id);
    });

    bot.onText(/📦 Stok/, async (msg) => {
        const chatId = msg.chat.id;
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        const session = getSession(chatId);
        await cleanupPreviousMessage(chatId);

        // Sync with Live Data
        setProducts(await getMergedProducts());

        let stockMsg;
        if (getProducts().length === 0) {
            stockMsg = "❌ *Tidak ada produk yang tercatat.*";
        } else {
            const now = new Date().toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
            stockMsg = "📦 *STATUS STOK REAL-TIME*\n";
            stockMsg += `⏰ _Update: ${now}_ \n\n`;

            getProducts().forEach(p => {
                const count = getStockCount(p);
                const icon = count > 0 ? "✅" : "❌";
                stockMsg += `${icon} *${p.productName}*\n`;
                stockMsg += `└ Tersedia: *${count}* Unit\n\n`;
            });

            stockMsg += `──────────────────────\n`;
            stockMsg += `_Ingin membeli? Klik /beli sekarang!_`;
        }

        const sent = await bot.sendMessage(chatId, stockMsg, {
            parse_mode: 'Markdown',
            reply_markup: { keyboard: [['🔙 Back']], resize_keyboard: true }
        });
        session.activeBotMessages.push(sent.message_id);
        session.state = 'IDLE';
    });

    // ==========================================
    // GLOBAL HANDLERS (Callback & Logic)
    // ==========================================

    // 1. Global Callback Query Handler (Untuk Button Inline)
    bot.on('callback_query', async (query) => {
        const chatId = query.message.chat.id;
        const session = getSession(chatId);
        const data = query.data;

        // Log callback query (button click)
        const cbName = (query.from.first_name || '') + (query.from.last_name ? ' ' + query.from.last_name : '') || query.from.username || String(query.from.id);
        chatLog('TG', 'IN', chatId, cbName.trim(), `[CALLBACK] ${data}`);

        if (data.startsWith('list_page_')) {
            const pageSelect = parseInt(data.replace('list_page_', ''));
            bot.answerCallbackQuery(query.id);
            await sendPaginatedProducts(chatId, pageSelect, query.message.message_id);
            return;
        }

        if (data === 'popular_list') {
            bot.answerCallbackQuery(query.id);
            await showPopularProducts(chatId, query.message.message_id);
            return;
        }

        if (data === 'check_gatekeeper') {
            const isMember = await checkMembership(chatId);
            if (isMember) {
                bot.answerCallbackQuery(query.id, { text: '✅ Terimakasih! Sekarang Anda bisa menggunakan bot.' });
                await sendWelcomeMessage(chatId, query.from);
            } else {
                bot.answerCallbackQuery(query.id, { text: '❌ Anda belum bergabung ke Channel/Group kami!', show_alert: true });
            }
            return;
        }

        // Handle State: WAITING_QUANTITY (Saat pilih jumlah via button)
        if (session.state === 'WAITING_QUANTITY' && session.data.selectedProduct) {

            // Handle Cancel
            if (data.endsWith('_cancel')) {
                bot.answerCallbackQuery(query.id);
                // Return to product list instead of deleting
                await sendPaginatedProducts(chatId, session.data.currentPage || 1, query.message.message_id);
                return;
            }

            // Handle Buy Quantity
            if (data.startsWith('buy_')) {
                const parts = data.split('_');
                // parts[0] = buy, parts[1] = index, parts[2] = quantity
                const quantity = parseInt(parts[2]);

                bot.answerCallbackQuery(query.id);
                // Hapus keyboard inline agar tidak diklik 2x
                bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: chatId, message_id: query.message.message_id }).catch(() => { });

                // Per-user lock: prevents double-click race condition
                await withUserPurchaseLock(chatId, async () => {
                    // Re-check state inside lock — if first click already moved state, skip
                    if (session.state !== 'WAITING_QUANTITY') {
                        rcLog('BLOCKED', `TG chatId=${chatId} duplicate buy callback — state=${session.state}`);
                        return;
                    }
                    // Eksekusi Pembelian (via confirmation step for account products)
                    await confirmAndPurchase(chatId, session.data.selectedProduct, quantity, query.from);
                });
            }
        }

        // Handle State: WAITING_PAYMENT (Saat user klik tombol konfirmasi pembayaran)
        let status = "Unpaid";
        if (session.state === 'WAITING_PAYMENT') {
            // Handle Payment Check (Ya, Sudah Bayar)
            if (data.startsWith('payment_check_')) {
                // Guard: ignore rapid double-clicks while a manual check is in-flight
                if (session.data._manualCheckInProgress) {
                    bot.answerCallbackQuery(query.id, { text: '⏳ Sedang mengecek...', show_alert: false }).catch(() => { });
                    return;
                }
                session.data._manualCheckInProgress = true;

                // Stop auto-poller — manual check takes over
                stopTGPaymentPoller(session);

                // Show loading indicator on the callback (no destructive UI change — buttons stay
                // visible so user can retry / cancel even if check hangs).
                bot.answerCallbackQuery(query.id, { text: '⏳ Mengecek pembayaran...', show_alert: false }).catch(() => { });

                const reference = session.data.paymentReference;
                const paymentProvider = session.data.paymentProvider;
                const apiKey = session.data.paymentApiKey;
                const product = session.data.productData;
                const quantity = session.data.quantityData;


                try {
                    const conf = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json'), 'utf8'));
                    const manualConfig = Array.isArray(conf) ? conf[0] : conf;
                    const payResult = await checkPaymentByProvider(paymentProvider, {
                        reference,
                        config: manualConfig,
                        saweriaId: session.data.saweriaId || reference,
                        payAmount: session.data.paymentRupiah || 0,
                        pakasirBaseAmount: session.data.pakasirBaseAmount || 0,
                        dompetxTxId: session.data.dompetxTxId || '',
                        createdAt: session.data.gopayCreatedAt || (Date.now() - TX_TIMEOUT_MS),
                        expiresAt: session.data.gopayExpiresAt || Date.now(),
                        gopayModule: gopay
                    });
                    status = payResult.status;
                    if (payResult.providerRef) session.data.gopayProviderRef = payResult.providerRef;

                    if (status === "Paid") {
                        // Clean up per-invoice reservation tracking on successful payment
                        tgActiveReservations.delete(reference);
                        // Use tx lock to prevent double-click race
                        await withTxLock('tg:' + chatId, async () => {
                            // Idempotency: check if already delivered
                            if (session.data.delivered) {
                                rcLog('BLOCKED', `TG double-click blocked chatId=${chatId} product=${product.productName}`);
                                return;
                            }
                            session.data.processing = true;
                            session.state = 'IDLE';
                            try {
                                await bot.sendMessage(chatId, `✅ *Pembayaran Berhasil!*\n\nTransaksi Anda telah dikonfirmasi.`, { parse_mode: 'Markdown' });
                                await processTransactionFinish(chatId, product, quantity, query.from);
                                session.data.delivered = true;
                                session.data.deliveryState = 'SENT';

                                // Notify admin of successful order
                                const buyerName = (query.from.first_name || '') + (query.from.last_name ? ' ' + query.from.last_name : '');
                                const buyerDisplay = query.from.username ? `${buyerName.trim()} (@${query.from.username})` : buyerName.trim() || String(query.from.id);
                                rcLog('PAID', `TG | ${buyerDisplay} | ${product.productName} x${quantity} | Rp${(session.data.paymentRupiah || calculateBulkPrice(product, quantity).totalPrice).toLocaleString('id-ID')} | inv=${session.data.paymentReference || '-'}`);
                                rcLog('DELIVERED', `TG | ${buyerDisplay} | ${product.productName} x${quantity} | inv=${session.data.paymentReference || '-'}`);
                                notifyAdmin({
                                    type: 'paid', platform: 'telegram',
                                    buyer: buyerDisplay, product: product.productName,
                                    quantity, amount: session.data.paymentRupiah || calculateBulkPrice(product, quantity).totalPrice,
                                    invoice: session.data.paymentReference || '-'
                                });

                                const master = isMaster(query.from.id);
                                await bot.sendMessage(chatId, '🔙 Kembali ke menu utama', {
                                    reply_markup: { keyboard: getMainMenuKeyboard(master), resize_keyboard: true }
                                });
                            } catch (errInternal) {
                                console.error("Internal processing error:", errInternal);
                                session.data.deliveryState = 'NEEDS_REVIEW';
                                try {
                                    await bot.sendMessage(chatId, `❌ *Terjadi kesalahan saat mengirim produk.*\n\nSilakan hubungi admin dengan bukti pembayaran Anda untuk pengiriman manual.`, { parse_mode: 'Markdown' });
                                    await sendTgAdminContactCta(chatId);
                                    const master = isMaster(query.from.id);
                                    await bot.sendMessage(chatId, '🔙 Kembali ke menu utama', {
                                        reply_markup: { keyboard: getMainMenuKeyboard(master), resize_keyboard: true }
                                    });
                                } catch (e) { console.error("Failed to send error message to user:", e); }
                            } finally {
                                session.data.processing = false;
                            }
                        });
                        return;
                    } else if (status === "Failed") {
                        session.state = 'IDLE';
                        // Update transaction status to EXPIRED in file
                        await updateTgTransactionStatus(reference, 'EXPIRED');
                        // Cancel on provider side (DompetX only — others self-expire)
                        tgCancelDompetxIfNeeded(paymentProvider, (manualConfig?.dompetx?.api_key) || '', session.data.dompetxTxId || '', 'manual-check-failed');
                        rcLog('EXPIRED', `TG | ${query.from.username ? `@${query.from.username}` : query.from.id} | ${product.productName} x${quantity} | inv=${reference}`);
                        notifyAdmin({ type: 'expired', platform: 'telegram', buyer: query.from.username ? `@${query.from.username}` : String(query.from.id), product: product.productName, quantity, invoice: reference });
                        // Release reserved stock on payment failure — use per-invoice tracking
                        const manualFailRes = tgActiveReservations.get(reference);
                        if (manualFailRes && manualFailRes.reservationStatus === 'HELD') {
                            rcLog('RELEASE', `txId=${reference} product=${manualFailRes.productName || 'unknown'} lines=${(manualFailRes.reservedLines || []).length} reason=manual-check-failed`);
                            manualFailRes.reservedLines = [];
                            manualFailRes.reservationStatus = 'RELEASED';
                            tgActiveReservations.delete(reference);
                            rcLog('RELEASE', `TG chatId=${chatId} inv=${reference} reason=payment-failed`);
                        } else if (session.data.reservedLines && session.data.reservationStatus === 'HELD') {
                            releaseReservation(session.data);
                            rcLog('RELEASE', `TG chatId=${chatId} reason=payment-failed (session fallback)`);
                        }
                        await bot.sendMessage(chatId, `❌ *Pembayaran Gagal*\n\nTransaksi gagal atau kadaluarsa.`, {
                            parse_mode: 'Markdown',
                            reply_markup: { keyboard: getMainMenuKeyboard(isMaster(query.from.id)), resize_keyboard: true }
                        });
                        return;
                    } else {
                        // Unpaid — show alert; buttons remain visible (no destructive UI change), poller resumes.
                        bot.answerCallbackQuery(query.id, {
                            text: "⏳ Pembayaran belum diterima.\nSelesaikan pembayaran lalu klik tombol lagi, atau Cancel untuk batal.",
                            show_alert: true
                        }).catch(() => { });
                        startTGPaymentPoller(chatId, session);
                        return;
                    }
                } catch (error) {
                    console.error("Error overall checking payment:", error);
                    // Buttons still visible — user can retry / cancel. Just alert + restart poller.
                    if (status !== "Paid") {
                        bot.answerCallbackQuery(query.id, {
                            text: `❌ Gagal cek pembayaran: ${(error.message || 'connection error').slice(0, 100)}. Coba lagi.`,
                            show_alert: true
                        }).catch(() => { });
                        startTGPaymentPoller(chatId, session);
                    }
                } finally {
                    session.data._manualCheckInProgress = false;
                }
            }

            if (data.startsWith('payment_cancel_')) {
                const cancelRef = data.replace('payment_cancel_', '');
                // Stop auto-poller
                stopTGPaymentPoller(session);
                // Update transaction status to CANCELLED in file
                await updateTgTransactionStatus(cancelRef, 'CANCELLED');
                // Cancel on DompetX side (fire-and-forget)
                if ((session.data.paymentProvider === 'dompetx') && session.data.dompetxTxId) {
                    try {
                        const _cancConf = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json'), 'utf8'));
                        const _cancCfg = Array.isArray(_cancConf) ? _cancConf[0] : _cancConf;
                        tgCancelDompetxIfNeeded('dompetx', _cancCfg?.dompetx?.api_key || '', session.data.dompetxTxId, 'user-cancel');
                    } catch { /* config read failed — skip cancel call */ }
                }
                bot.answerCallbackQuery(query.id, { text: '❌ Transaksi dibatalkan' });
                // Notify admin of cancelled order
                const cancelBuyerName = (query.from.first_name || '') + (query.from.last_name ? ' ' + query.from.last_name : '');
                const cancelBuyerDisplay = query.from.username ? `${cancelBuyerName.trim()} (@${query.from.username})` : cancelBuyerName.trim() || String(query.from.id);
                rcLog('CANCELLED', `TG | ${cancelBuyerDisplay} | ${session.data.productData?.productName || '-'} x${session.data.quantityData || 1} | inv=${cancelRef}`);
                notifyAdmin({
                    type: 'cancelled', platform: 'telegram',
                    buyer: cancelBuyerDisplay, product: session.data.productData?.productName || '-',
                    quantity: session.data.quantityData || 1, invoice: cancelRef
                });
                session.state = 'IDLE';
                // Release reserved stock on cancel — use per-invoice tracking
                const cancelResEntry = tgActiveReservations.get(cancelRef);
                if (cancelResEntry && cancelResEntry.reservationStatus === 'HELD') {
                    rcLog('RELEASE', `txId=${cancelRef} product=${cancelResEntry.productName || 'unknown'} lines=${(cancelResEntry.reservedLines || []).length} reason=user-cancel`);
                    cancelResEntry.reservedLines = [];
                    cancelResEntry.reservationStatus = 'RELEASED';
                    tgActiveReservations.delete(cancelRef);
                    rcLog('RELEASE', `TG chatId=${chatId} inv=${cancelRef} reason=user-cancel`);
                } else if (session.data.reservedLines && session.data.reservationStatus === 'HELD') {
                    // Fallback: release from session.data (legacy path)
                    releaseReservation(session.data);
                    rcLog('RELEASE', `TG chatId=${chatId} reason=user-cancel (session fallback)`);
                }
                // Hapus pesan QR dari chat
                bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
                bot.sendMessage(chatId, '❌ Pembelian dibatalkan.', {
                    reply_markup: { keyboard: getMainMenuKeyboard(isMaster(query.from.id)), resize_keyboard: true }
                });
            }
        }
    });

    // 2. Fungsi Eksekusi Pembelian (Dipisah agar reusable & bersih)
    // Wrapper: shows order confirmation for account products before going to payment.
    // PPOB products skip this — they have their own PPOB_CONFIRM step.
    const confirmAndPurchase = async (chatId, product, quantity, userInfo = {}) => {
        if (!product || !quantity || quantity <= 0) {
            return bot.sendMessage(chatId, `❌ Data pesanan tidak valid. Silakan ulangi.`);
        }
        // PPOB has its own dedicated confirm flow earlier — go straight to payment.
        if (product.source === 'digiflazz') {
            return executePurchaseGlobal(chatId, product, quantity, userInfo);
        }
        const session = getSession(chatId);
        const stock = getStockCount(product);
        // KoalaStore stock is provider-side; only enforce for local products at this stage.
        if (product.source !== 'koalastore' && stock < quantity) {
            return bot.sendMessage(chatId, `❌ Stok tidak mencukupi.\nTersedia: ${stock}\nDiminta: ${quantity}`);
        }
        const bulk = calculateBulkPrice(product, quantity);
        const unitPrice = bulk.unitPrice;
        const total = bulk.totalPrice;
        const basePrice = parseInt(product.priceProduct) || 0;
        const discountLine = unitPrice < basePrice ? ' _(Diskon Grosir)_' : '';

        let msg = `📋 *Konfirmasi Pesanan*\n\n`;
        msg += `📦 Produk: *${product.productName}*\n`;
        msg += `🔢 Jumlah: *${quantity}*\n`;
        msg += `💰 Harga: *Rp${unitPrice.toLocaleString('id-ID')}*/pcs${discountLine}\n`;
        msg += `💵 Total: *Rp${total.toLocaleString('id-ID')}*\n\n`;
        msg += `_Pastikan data sudah benar. Klik *✅ Lanjut Bayar* untuk melanjutkan ke QRIS._`;

        session.state = 'WAITING_PURCHASE_CONFIRM';
        session.data.confirmProduct = product;
        session.data.confirmQuantity = quantity;
        session.data.userInfo = userInfo;

        const sent = await bot.sendMessage(chatId, msg, {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [['✅ Lanjut Bayar'], ['🔙 Back', '❌ Cancel']],
                resize_keyboard: true,
            },
        });
        session.activeBotMessages.push(sent.message_id);
    };

    const executePurchaseGlobal = async (chatId, product, quantity, userInfo = {}) => {
        const session = getSession(chatId);

        // Block if user already has an active UNPAID transaction (per-invoice tracking)
        for (const [ref, res] of tgActiveReservations) {
            if (res.chatId === chatId && res.reservationStatus === 'HELD') {
                // Check if reservation expired (auto-cleanup stale entries)
                if (res.reservationExpiresAt && Date.now() > res.reservationExpiresAt) {
                    rcLog('RELEASE', `txId=${ref} product=${res.productName || 'unknown'} lines=${(res.reservedLines || []).length} reason=expired-guard`);
                    tgActiveReservations.delete(ref);
                    continue;
                }
                session.state = 'IDLE';
                rcLog('BLOCKED', `TG chatId=${chatId} active tx=${ref} — purchase blocked`);
                return bot.sendMessage(chatId, `❌ Anda masih memiliki transaksi aktif (${ref}).\n\nSilakan selesaikan atau batalkan transaksi tersebut terlebih dahulu.`, {
                    reply_markup: { keyboard: getMainMenuKeyboard(isMaster(userInfo.id)), resize_keyboard: true }
                });
            }
        }

        // Reset idempotency flags from previous purchase
        session.data.delivered = false;
        session.data.processing = false;
        session.data.deliveryState = 'NONE';

        // Validasi input
        if (isNaN(quantity) || quantity <= 0) {
            return bot.sendMessage(chatId, `❌ Jumlah tidak valid. Silakan ulangi pembelian.`);
        }

        // --- DIGIFLAZZ PPOB: PRE-CHECK (saldo + sku status) ---
        if (product.source === 'digiflazz') {
            const cfg = getConfig()[0] || {};
            const df = cfg.digiflazz || {};
            if (!df.is_active || !df.username || !df.api_key) {
                return bot.sendMessage(chatId, '❌ Layanan PPOB sedang tidak aktif. Hubungi admin.');
            }
            if (product.seller_product_status === false || product.buyer_product_status === false) {
                return bot.sendMessage(chatId, '⚠️ Produk PPOB sedang nonaktif di provider. Coba beberapa saat lagi.');
            }
            // Saldo check — fail fast (informational): user payment will still go through; the
            // admin needs visibility. We only block if saldo < estimated buy cost (df_base_price).
            try {
                const balRes = await digiflazz.cekSaldo({ username: df.username, apiKey: df.api_key });
                if (balRes.ok) {
                    const need = (parseFloat(product.df_base_price) || 0) * quantity;
                    if (balRes.deposit < need) {
                        const adminTg = cfg.admin_contact_telegram || '';
                        const adminLink = adminTg ? `https://t.me/${adminTg}` : '-';
                        return bot.sendMessage(chatId,
                            `⚠️ Layanan PPOB sementara terganggu. Mohon coba beberapa saat lagi atau hubungi admin: ${adminLink}`);
                    }
                }
            } catch (e) {
                console.error('[PPOB] saldo precheck error:', e.message);
            }
            // No local stock reservation for PPOB — Digiflazz is the source of truth.
        }
        // --- KOALA STORE: PRE-CHECK (Balance & Stock) ---
        else if (product.source === 'koalastore') {
            const config = getConfig()[0];
            const ksKey = config.koalastore ? config.koalastore.api_key : '';

            if (!ksKey) return bot.sendMessage(chatId, `❌ Koala Store API Key tidak diatur. Hubungi admin.`);

            try {
                // 1. Check Balance Admin
                const balanceRes = await koalaStore.getBalance(ksKey);
                if (!balanceRes.success) return bot.sendMessage(chatId, `❌ Gagal mengecek saldo Koala Store.`);

                // Fetch products to get latest price and stock
                const ksProductsRes = await koalaStore.getProducts(ksKey);
                let ksVariant = null;
                if (ksProductsRes.success && ksProductsRes.data) {
                    for (const kp of ksProductsRes.data) {
                        ksVariant = kp.variants.find(v => v.code_variant === product.variant_code);
                        if (ksVariant) break;
                    }
                }

                if (!ksVariant) return bot.sendMessage(chatId, `❌ Produk tidak ditemukan di Koala Store.`);

                const curStock = ksVariant.available_stock !== undefined ? ksVariant.available_stock : (ksVariant.stock !== undefined ? ksVariant.stock : (ksVariant.item_count !== undefined ? ksVariant.item_count : 0));
                const buyCost = ksVariant.price * quantity;

                // 2. Check Stock
                if (curStock < quantity) {
                    return bot.sendMessage(chatId, `❌ Stok di provider habis.\nTersedia: ${curStock}\nDiminta: ${quantity}`);
                }

                // 3. Check Balance enough to cover buyCost
                if (balanceRes.data.balance < buyCost) {
                    const _adminTg = config.admin_contact_telegram || '';
                    const _adminTgLink = _adminTg ? `https://t.me/${_adminTg}` : '-';
                    return bot.sendMessage(chatId, `⚠️ Terjadi kendala teknis (Low Balance). Harap hubungi admin: ${_adminTgLink}`);
                }

                // Auto-sync price: use fresh API base price + local profit
                const freshBasePrice = parseFloat(ksVariant.price) || 0;
                const localProfit = parseFloat(product.profit) || 0;
                product.ks_base_price = freshBasePrice;
                product.priceProduct = freshBasePrice + localProfit;
            } catch (e) {
                console.error("KS Pre-check Error:", e);
                return bot.sendMessage(chatId, `❌ Gagal melakukan sinkronisasi dengan Koala Store.`);
            }
        } else {
            // LOCAL STOCK CHECK + RESERVATION
            const reservation = await reserveStockForTx(product.productName, quantity);
            if (!reservation.success) {
                session.state = 'IDLE';
                return bot.sendMessage(chatId, `❌ Stok tidak mencukupi.\nTersedia: ${reservation.available}\nDiminta: ${quantity}`, {
                    parse_mode: 'Markdown',
                    reply_markup: { keyboard: getMainMenuKeyboard(isMaster(userInfo.id)), resize_keyboard: true }
                });
            }
            // Store reserved lines in session for later commit
            session.data.reservedLines = reservation.reservedLines;
            session.data.reservationStatus = 'HELD';
            session.data.reservationExpiresAt = Date.now() + RESERVATION_EXPIRY_MS;
        }

        const messageWait = await bot.sendMessage(chatId, "🔄 Menunggu Pembayaran Muncul... \n", {
            reply_markup: { keyboard: [['❌ Batalkan Pesanan']], resize_keyboard: true }
        });
        const statusMessageWait = messageWait.message_id;

        // State khusus saat menunggu pembayaran (agar bisa dicancel via pesan teks)
        session.state = 'WAITING_PAYMENT';
        session.data.isCancelled = false;

        let reference, paymentRupiah, qrcode, imageQr, checkoutUrl;
        let paymentProvider = 'tripay';
        let apiKey = null;

        try {
            const readFileConfig = fs.readFileSync(path.join(projectRoot, 'configtelebot.json'), 'utf8');
            const jsonParse = JSON.parse(readFileConfig);
            paymentProvider = jsonParse[0].payment_provider || 'tripay';
            apiKey = null;

            // --- TRIPAY FLOW ---
            if (paymentProvider === 'tripay') {
                apiKey = jsonParse[0].apiKey;
                const privateKey = jsonParse[0].privateKey;
                const merchant_code = jsonParse[0].merchant_code;
                const merchant_ref = jsonParse[0].merchant_ref;

                const bulkCalc = calculateBulkPrice(product, quantity);
                const amount = bulkCalc.totalPrice;
                const productName = product.productName;
                const nominal = amount;
                const expiry = parseInt(Math.floor(new Date() / 1000) + (5 * 60)); // 5 minutes

                let signature = crypto.createHmac('sha256', privateKey)
                    .update(merchant_code + merchant_ref + amount)
                    .digest('hex');

                const payload = {
                    'method': 'QRIS',
                    'merchant_ref': merchant_ref,
                    'amount': amount,
                    'customer_name': 'dowertopup',
                    'customer_email': 'dowertopup@domain.com',
                    'customer_phone': FAKE_PHONE,
                    'order_items': [{
                        'sku': productName,
                        'name': productName,
                        'price': bulkCalc.unitPrice,
                        'quantity': quantity,
                    }],
                    'return_url': 'https://toko.alinea.co.id/api/tripay-callback',
                    'expired_time': expiry,
                    'signature': signature
                };

                const ref_id = `TELEINV-${Date.now()}${crypto.randomBytes(4).toString('hex')}`;
                payload.merchant_ref = ref_id;
                signature = crypto.createHmac('sha256', privateKey)
                    .update(merchant_code + ref_id + amount)
                    .digest('hex');
                payload.signature = signature;

                // Check cancel before API call
                if (session.state !== 'WAITING_PAYMENT') throw new Error('CANCELED_BY_USER');

                const payment = await paymentOrder(apiKey, payload);

                // Check cancel after API call
                if (session.state !== 'WAITING_PAYMENT') throw new Error('CANCELED_BY_USER');

                if (!payment || !payment.success) {
                    console.error('Payment Error:', payment);
                    throw new Error(payment ? payment.message : 'Gagal menghubungi server pembayaran.');
                }

                if (!payment.data || !payment.data.qr_url) {
                    throw new Error('Respon pembayaran tidak lengkap (tidak ada QR).');
                }

                reference = payment.data.reference
                paymentRupiah = payment.data.amount
                qrcode = payment.data.qr_string
                imageQr = payment.data.qr_url
                checkoutUrl = payment.data.checkout_url


            } else if (paymentProvider === 'saweria') {
                const saweriaToken = jsonParse[0].saweria ? jsonParse[0].saweria.token : '';
                if (!saweriaToken) throw new Error('Saweria Token belum disetting di Dashboard.');

                // 1. Decode JWT to get Saweria User ID
                // Token structure: "Bearer <header>.<payload>.<signature>" (sometimes just <header>.<payload>.<signature>)
                const tokenParts = saweriaToken.replace('Bearer ', '').split('.');
                let saweriaUserId = '';
                try {
                    const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
                    saweriaUserId = payload.id;
                } catch (e) {
                    throw new Error('Saweria Token Invalid (Gagal Decode ID)');
                }

                const baseAmount = calculateBulkPrice(product, quantity).totalPrice;
                // Saweria usually doesn't need unique code for QRIS dynamic, but standard is fine.
                // However, user curl example suggests simple amount.
                // We use baseAmount (API might add fee/unique).

                const userMsg = `Order ${product.productName} (${quantity}x) - ${chatId}`;

                // 2. Create Donation / Snap
                const saweriaRes = await fetch(`https://backend.saweria.co/donations/snap/${saweriaUserId}`, {
                    method: 'POST',
                    headers: {
                        'User-Agent': DEFAULT_USER_AGENT,
                        'Accept-Encoding': 'gzip, deflate, br, zstd',
                        'Content-Type': 'application/json',
                        'Origin': 'https://saweria.co',
                        'Referer': 'https://saweria.co/'
                    },
                    body: JSON.stringify({
                        agree: true,
                        notUnderage: true,
                        message: userMsg,
                        amount: baseAmount,
                        payment_type: "qris",
                        vote: "",
                        currency: "IDR",
                        customer_info: {
                            first_name: `Tele: ${userInfo.username || userInfo.first_name || chatId}`,
                            email: `${userInfo.username || chatId}@telegram.com`,
                            phone: ""
                        }
                    })
                });

                if (!saweriaRes.ok) throw new Error(`Saweria API Error: ${saweriaRes.statusText}`);

                const saweriaData = await saweriaRes.json();
                const sData = saweriaData.data;
                const donationId = sData.id; // Saweria Transaction ID (UUID) — used for polling
                reference = `TELEINV-${Date.now()}${crypto.randomBytes(4).toString('hex')}`; // Consistent invoice format
                session.data.saweriaId = donationId; // Store Saweria UUID for payment status polling
                paymentRupiah = sData.amount; // Adjusted amount (fees etc)
                qrcode = sData.qr_string;

                // 3. Generate QR Image from String (Buffer)
                imageQr = await QRCode.toBuffer(qrcode);
                checkoutUrl = ""; // No specific checkout URL for Saweria Snap QR
            } else if (paymentProvider === 'pakasir') {
                const pakasirCfg = jsonParse[0].pakasir || {};
                const apiKey = pakasirCfg.api_key;
                const projectSlug = pakasirCfg.project_slug;

                if (!apiKey || !projectSlug) throw new Error('Pakasir Project belum dikonfigurasi sepenuhnya (API Key/Slug Missing).');

                // Hitung Amount (bulk discount aware)
                const amount = calculateBulkPrice(product, quantity).totalPrice;

                // Generate Order ID
                const ref_id = `TELEINV-${Date.now()}${crypto.randomBytes(4).toString('hex')}`;

                // Create Transaction via pakasir-sdk
                const pakasir = new Pakasir({ slug: projectSlug, apikey: apiKey });
                const pakPayment = await pakasir.createPayment('qris', ref_id, amount);

                if (!pakPayment || !pakPayment.payment_number) {
                    throw new Error('Gagal generate QRIS Pakasir (No Data)');
                }

                // Set Variables for Bot Response
                reference = pakPayment.order_id;
                paymentRupiah = pakPayment.total_payment || amount;
                qrcode = pakPayment.payment_number;
                session.data.pakasirBaseAmount = amount; // Base amount (before fees) — needed for detailPayment API

                // Generate QR Image Buffer
                imageQr = await QRCode.toBuffer(qrcode);
                checkoutUrl = "";
            } else if (paymentProvider === 'dompetx') {
                const dpxCfg = jsonParse[0].dompetx || {};
                const apiKey = dpxCfg.api_key;
                if (!apiKey) throw new Error('DompetX belum dikonfigurasi (API Key kosong).');

                const amount = calculateBulkPrice(product, quantity).totalPrice;
                const ref_id = `TELEINV-${Date.now()}${crypto.randomBytes(4).toString('hex')}`;
                const method = dpxCfg.method || 'QRIS';

                const dpxPayment = await createDompetxPayment(apiKey, ref_id, amount, method);
                if (!dpxPayment || (!dpxPayment.qrcode && !dpxPayment.payment_url && !dpxPayment.va_number)) {
                    throw new Error('Gagal generate DompetX payment (No QR/URL/VA in response).');
                }

                reference = ref_id;
                paymentRupiah = dpxPayment.total_payment || amount;
                qrcode = dpxPayment.qrcode || '';
                session.data.dompetxTxId = dpxPayment.order_id; // DompetX-side id for status checks
                session.data.dompetxMethod = method;
                session.data.dompetxPaymentUrl = dpxPayment.payment_url || '';
                session.data.dompetxVaNumber = dpxPayment.va_number || '';
                // Fee snapshot — DompetX fees (especially additionalFee) are dynamic per tx
                session.data.dompetxBaseAmount = dpxPayment.base_amount || amount;
                session.data.dompetxFee = dpxPayment.dompetx_fee || 0;
                session.data.dompetxAdditionalFee = dpxPayment.additional_fee || 0;
                session.data.dompetxMerchantReceive = dpxPayment.merchant_receive || amount;

                if (qrcode) {
                    imageQr = await QRCode.toBuffer(qrcode);
                } else if (dpxPayment.payment_url) {
                    // Non-QR channel — encode payment URL as QR so user can scan/open
                    imageQr = await QRCode.toBuffer(dpxPayment.payment_url);
                } else {
                    // VA-only fallback — encode VA number string
                    imageQr = await QRCode.toBuffer(`VA ${method}: ${dpxPayment.va_number}`);
                }
                checkoutUrl = dpxPayment.payment_url || '';
            } else if (paymentProvider === 'gopay') {
                const gopayConfig = jsonParse[0].gopay || {};
                if (!gopayConfig.email || !gopayConfig.password || !gopayConfig.qr_string) {
                    throw new Error('GoPay belum dikonfigurasi sepenuhnya (email/password/QR String kosong).');
                }

                const amount = calculateBulkPrice(product, quantity).totalPrice;

                // Get pending GoPay tx amounts from BOTH TG and WA transactions for collision detection
                // Both TG and WA now use provider + totalPrice; fallback for legacy txs
                const getPendingTxAmounts = () => {
                    try {
                        const allTx = loadAllTransactions();
                        return allTx
                            .filter(t => t.status === 'UNPAID' && (t.provider === 'gopay' || t.paymentProvider === 'gopay'))
                            .map(t => t.totalPrice || t.amount || 0);
                    } catch { return []; }
                };

                const gopayResult = await gopay.createPayment(gopayConfig, amount, getPendingTxAmounts, 5, 'TELEINV');

                reference = gopayResult.reference;
                paymentRupiah = gopayResult.paymentRupiah;
                qrcode = gopayResult.qrcode;

                // Generate QR Image Buffer from QRIS string
                imageQr = await QRCode.toBuffer(qrcode);
                checkoutUrl = "";
            }

        } catch (err) {
            console.log(err)
            await bot.deleteMessage(chatId, statusMessageWait).catch(() => { });

            session.state = 'IDLE'; // Reset state

            if (err.message === 'CANCELED_BY_USER') {
                bot.sendMessage(chatId, '❌ Pembelian dibatalkan.', {
                    reply_markup: {
                        keyboard: getMainMenuKeyboard(isMaster(userInfo.id)),
                        resize_keyboard: true,
                    },
                });
            } else {
                console.error('[TG] Payment creation failed:', err.message);
                bot.sendMessage(chatId, `❌ Terjadi kesalahan saat memproses pembayaran. Silakan coba lagi atau hubungi admin.`, {
                    reply_markup: {
                        keyboard: getMainMenuKeyboard(isMaster(userInfo.id)),
                        resize_keyboard: true,
                    },
                });
            }
            return;
        }

        const isUrl = typeof imageQr === 'string' && imageQr.startsWith('http');
        const isBuffer = Buffer.isBuffer(imageQr);

        if (!isUrl && !isBuffer) {
            return bot.sendMessage(chatId, "❌ Gagal mendapatkan gambar QR. Coba lagi.");
        }

        // Compute bulk pricing for QR caption display
        const tgBulkCalc = calculateBulkPrice(product, quantity);
        const tgBasePrice = parseInt(product.priceProduct) || 0;
        const tgDiscountLine = tgBulkCalc.unitPrice < tgBasePrice ? ' (Diskon Grosir)' : '';

        const expiryTime = new Date(Date.now() + TG_POLL_MAX_MS);
        const expiryStr = expiryTime.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

        let statusPhoto;
        try {
            statusPhoto = await bot.sendPhoto(chatId, imageQr, {
                caption: `✅ Anda telah memilih produk: *${product.productName}*.\n\n💰 Jumlah: ${quantity}\n💰 Harga: *Rp${tgBulkCalc.unitPrice.toLocaleString('id-ID')}*/pcs${tgDiscountLine}\n💰 Total: *Rp${Number(paymentRupiah).toLocaleString('id-ID')}*\n\n📌 Scan QR ini untuk membayar.\n\n⏰ Expired pada: *${expiryStr} WIB*\n\n⏳ Setelah selesai bayar, klik tombol di bawah:`,
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Ya, Sudah Bayar', callback_data: `payment_check_${reference}` },
                            { text: '❌ Batalkan Pesanan', callback_data: `payment_cancel_${reference}` }
                        ]
                    ]
                },
            });
        } catch (err) {
            console.error('[TG] sendPhoto QR failed:', err.message);
            session.state = 'IDLE';
            // Release reserved stock since payment flow is aborted
            if (session.data.reservedLines && session.data.reservationStatus === 'HELD') {
                releaseReservation(session.data);
                rcLog('RELEASE', `TG chatId=${chatId} reason=QR-send-failed`);
            }
            await bot.deleteMessage(chatId, statusMessageWait).catch(() => { });
            return bot.sendMessage(chatId, "❌ Gagal mengirim gambar QR. Silakan coba lagi.", {
                reply_markup: { keyboard: getMainMenuKeyboard(isMaster(userInfo.id)), resize_keyboard: true }
            });
        }

        await bot.deleteMessage(chatId, statusMessageWait).catch(() => { });

        let statusPhotoId;
        try { statusPhotoId = statusPhoto.message_id; } catch (err) { /* statusPhoto may be undefined if photo send failed */ }

        // Simpan data pembayaran di session untuk digunakan saat user klik tombol
        session.data.paymentReference = reference;
        session.data.paymentProvider = paymentProvider;
        session.data.paymentApiKey = paymentProvider === 'tripay' ? apiKey : null;
        session.data.statusPhotoId = statusPhotoId;
        session.data.productData = product;
        session.data.quantityData = quantity;
        session.data.userInfo = userInfo;
        session.data.paymentRupiah = paymentRupiah; // Store actual gateway amount for later update

        // GoPay-specific: store timestamps for payment window checking
        if (paymentProvider === 'gopay') {
            session.data.gopayCreatedAt = Date.now();
            session.data.gopayExpiresAt = Date.now() + TX_TIMEOUT_MS;
        }

        // Start auto-polling for payment status (like WA poller)
        startTGPaymentPoller(chatId, session);

        // Log UNPAID transaction to file so it appears in Sales History
        // Include recovery data so TG sessions can be restored after bot restart
        const tgTxExtra = {
            chatId: chatId,
            productData: product,
            reservedLines: session.data.reservedLines || [],
            reservationStatus: session.data.reservationStatus || null,
            paymentApiKey: paymentProvider === 'tripay' ? apiKey : null,
            paymentRupiah: paymentRupiah || 0,
        };
        if (paymentProvider === 'gopay') {
            tgTxExtra.gopayExpiresAt = Date.now() + TG_POLL_MAX_MS;
            tgTxExtra.gopayCreatedAt = session.data.gopayCreatedAt || Date.now();
        }
        if (paymentProvider === 'saweria') {
            tgTxExtra.saweriaId = session.data.saweriaId || null;
        }
        if (paymentProvider === 'pakasir') {
            tgTxExtra.pakasirBaseAmount = session.data.pakasirBaseAmount || 0;
        }
        if (paymentProvider === 'dompetx') {
            tgTxExtra.dompetxTxId = session.data.dompetxTxId || '';
            tgTxExtra.dompetxMethod = session.data.dompetxMethod || 'QRIS';
            tgTxExtra.dompetxPaymentUrl = session.data.dompetxPaymentUrl || '';
            tgTxExtra.dompetxVaNumber = session.data.dompetxVaNumber || '';
            tgTxExtra.dompetxBaseAmount = session.data.dompetxBaseAmount || 0;
            tgTxExtra.dompetxFee = session.data.dompetxFee || 0;
            tgTxExtra.dompetxAdditionalFee = session.data.dompetxAdditionalFee || 0;
            tgTxExtra.dompetxMerchantReceive = session.data.dompetxMerchantReceive || 0;
        }
        await saveTgTransaction(reference, product, quantity, userInfo, paymentProvider, paymentRupiah, tgTxExtra);

        // Register per-invoice reservation in tgActiveReservations for proper tracking
        if (session.data.reservedLines && session.data.reservationStatus === 'HELD') {
            tgActiveReservations.set(reference, {
                chatId,
                productName: product.productName,
                reservedLines: [...session.data.reservedLines],
                reservationStatus: 'HELD',
                reservationExpiresAt: session.data.reservationExpiresAt
            });
        }

        // Notify admin of new order
        const newBuyerName = (userInfo.first_name || '') + (userInfo.last_name ? ' ' + userInfo.last_name : '');
        const newBuyerDisplay = userInfo.username ? `${newBuyerName.trim()} (@${userInfo.username})` : newBuyerName.trim() || String(userInfo.id);
        rcLog('ORDER_NEW', `TG | ${newBuyerDisplay} | ${product.productName} x${quantity} | Rp${(paymentRupiah || calculateBulkPrice(product, quantity).totalPrice).toLocaleString('id-ID')} | ${session.data.paymentProvider || '-'} | inv=${reference || '-'}`);
        notifyAdmin({
            type: 'new', platform: 'telegram',
            buyer: newBuyerDisplay, product: product.productName,
            quantity, amount: paymentRupiah || calculateBulkPrice(product, quantity).totalPrice,
            invoice: reference || '-'
        });
    };

    // --- TG PAYMENT AUTO-POLLER ---
    // Polls payment status every 10s, auto-delivers on PAID, stops on cancel/fail/deliver
    const TG_POLL_INTERVAL_MS = POLL_INTERVAL_MS;
    const TG_POLL_MAX_MS = TX_TIMEOUT_MS;

    function stopTGPaymentPoller(session) {
        if (session.data._tgPollerId) {
            clearInterval(session.data._tgPollerId);
            session.data._tgPollerId = null;
        }
    }

    function startTGPaymentPoller(chatId, session) {
        // Clear any existing poller for this session
        stopTGPaymentPoller(session);

        const startTime = Date.now();
        const reference = session.data.paymentReference;
        const paymentProvider = session.data.paymentProvider;
        const apiKey = session.data.paymentApiKey;

        session.data._tgPollerId = setInterval(async () => {
            try {
                // Stop conditions
                if (session.state !== 'WAITING_PAYMENT' || session.data.delivered || session.data.processing) {
                    stopTGPaymentPoller(session);
                    return;
                }

                // Max timeout
                if (Date.now() - startTime > TG_POLL_MAX_MS) {
                    rcLog('TIMEOUT', `TG chatId=${chatId} inv=${reference} — max poll timeout`);
                    stopTGPaymentPoller(session);
                    // Update transaction status to EXPIRED in file
                    await updateTgTransactionStatus(reference, 'EXPIRED');
                    // Cancel on DompetX side (fire-and-forget)
                    if (paymentProvider === 'dompetx' && session.data.dompetxTxId) {
                        try {
                            const _polConf = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json'), 'utf8'));
                            const _polCfg = Array.isArray(_polConf) ? _polConf[0] : _polConf;
                            tgCancelDompetxIfNeeded('dompetx', _polCfg?.dompetx?.api_key || '', session.data.dompetxTxId, 'poll-timeout');
                        } catch { /* skip */ }
                    }
                    const _ui = session.data.userInfo || {};
                    rcLog('EXPIRED', `TG | ${_ui.username ? `@${_ui.username}` : (_ui.id || chatId)} | ${session.data.productData?.productName || '-'} x${session.data.quantityData || 1} | inv=${reference}`);
                    notifyAdmin({ type: 'expired', platform: 'telegram', buyer: _ui.username ? `@${_ui.username}` : String(_ui.id || chatId), product: session.data.productData?.productName || '-', quantity: session.data.quantityData || 1, invoice: reference });
                    // Release reservation on timeout — use per-invoice tracking
                    const expResEntry = tgActiveReservations.get(reference);
                    if (expResEntry && expResEntry.reservationStatus === 'HELD') {
                        rcLog('RELEASE', `txId=${reference} product=${expResEntry.productName || 'unknown'} lines=${(expResEntry.reservedLines || []).length} reason=poll-timeout`);
                        expResEntry.reservedLines = [];
                        expResEntry.reservationStatus = 'RELEASED';
                        tgActiveReservations.delete(reference);
                        console.log(`[TG-POLLER] Released reservation for chatId ${chatId} invoice=${reference} — poll timeout`);
                    } else if (session.data.reservedLines && session.data.reservationStatus === 'HELD') {
                        releaseReservation(session.data);
                        console.log(`[TG-POLLER] Released reservation for chatId ${chatId} — poll timeout (session fallback)`);
                    }
                    session.state = 'IDLE';
                    // Delete QR photo message and replace with expired text
                    if (session.data.statusPhotoId) {
                        bot.deleteMessage(chatId, session.data.statusPhotoId).catch(() => { });
                    }
                    const expiredAt = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
                    bot.sendMessage(chatId, `⏰ *PAYMENT EXPIRED*\n\nProduk: *${session.data.productData?.productName || '-'}*\nExpired pada: *${expiredAt} WIB*\n\nSilakan ulangi pembelian jika masih berminat.`, {
                        parse_mode: 'Markdown',
                        reply_markup: { keyboard: getMainMenuKeyboard(isMaster(session.data.userInfo?.id)), resize_keyboard: true }
                    }).catch(() => { });
                    return;
                }

                // Check payment status via unified dispatcher
                const conf = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json'), 'utf8'));
                const pollerConfig = Array.isArray(conf) ? conf[0] : conf;
                const payResult = await checkPaymentByProvider(paymentProvider, {
                    reference,
                    config: pollerConfig,
                    saweriaId: session.data.saweriaId || reference,
                    payAmount: session.data.paymentRupiah || 0,
                    pakasirBaseAmount: session.data.pakasirBaseAmount || 0,
                    createdAt: session.data.gopayCreatedAt || (Date.now() - TX_TIMEOUT_MS),
                    expiresAt: session.data.gopayExpiresAt || Date.now(),
                    gopayModule: gopay
                });
                const status = payResult.status;
                if (payResult.providerRef) session.data.gopayProviderRef = payResult.providerRef;

                if (status === 'Paid') {
                    stopTGPaymentPoller(session);
                    // Clean up per-invoice reservation tracking on successful payment
                    tgActiveReservations.delete(reference);
                    console.log(`[TG-POLLER] Payment PAID detected for chatId=${chatId} ref=${reference}`);

                    // Use tx lock to prevent race with manual button click
                    await withTxLock('tg:' + chatId, async () => {
                        // Idempotency: check if already delivered (button click may have beaten us)
                        if (session.data.delivered) {
                            rcLog('BLOCKED', `TG poller blocked — already delivered chatId=${chatId}`);
                            return;
                        }
                        session.data.processing = true;
                        session.state = 'IDLE';

                        const product = session.data.productData;
                        const quantity = session.data.quantityData;
                        const userInfo = session.data.userInfo || {};

                        try {
                            // Remove buttons from QR message
                            if (session.data.statusPhotoId) {
                                bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                                    chat_id: chatId,
                                    message_id: session.data.statusPhotoId
                                }).catch(() => { });
                            }

                            await bot.sendMessage(chatId, `✅ *Pembayaran Berhasil!*\n\nTransaksi Anda telah dikonfirmasi secara otomatis.`, { parse_mode: 'Markdown' });
                            await processTransactionFinish(chatId, product, quantity, userInfo);
                            session.data.delivered = true;
                            session.data.deliveryState = 'SENT';

                            // Notify admin of successful order (auto-poller)
                            const pollerBuyerName = (userInfo.first_name || '') + (userInfo.last_name ? ' ' + userInfo.last_name : '');
                            const pollerBuyerDisplay = userInfo.username ? `${pollerBuyerName.trim()} (@${userInfo.username})` : pollerBuyerName.trim() || String(userInfo.id);
                            rcLog('PAID', `TG | ${pollerBuyerDisplay} | ${product.productName} x${quantity} | Rp${(session.data.paymentRupiah || calculateBulkPrice(product, quantity).totalPrice).toLocaleString('id-ID')} | inv=${reference || '-'}`);
                            rcLog('DELIVERED', `TG | ${pollerBuyerDisplay} | ${product.productName} x${quantity} | inv=${reference || '-'}`);
                            notifyAdmin({
                                type: 'paid', platform: 'telegram',
                                buyer: pollerBuyerDisplay, product: product.productName,
                                quantity, amount: session.data.paymentRupiah || calculateBulkPrice(product, quantity).totalPrice,
                                invoice: reference || '-'
                            });

                            const master = isMaster(userInfo.id);
                            await bot.sendMessage(chatId, '🔙 Kembali ke menu utama', {
                                reply_markup: { keyboard: getMainMenuKeyboard(master), resize_keyboard: true }
                            });
                        } catch (errInternal) {
                            console.error('[TG-POLLER] Delivery error:', errInternal);
                            session.data.deliveryState = 'NEEDS_REVIEW';
                            try {
                                await bot.sendMessage(chatId, `❌ *Pembayaran terdeteksi, tapi terjadi kesalahan saat mengirim produk.*\n\nSilakan hubungi admin dengan bukti pembayaran Anda.`, { parse_mode: 'Markdown' });
                                await sendTgAdminContactCta(chatId);
                                const master = isMaster((session.data.userInfo || {}).id);
                                await bot.sendMessage(chatId, '🔙 Kembali ke menu utama', {
                                    reply_markup: { keyboard: getMainMenuKeyboard(master), resize_keyboard: true }
                                });
                            } catch (e) { console.error('[TG-POLLER] Failed to send error msg:', e); }
                        } finally {
                            session.data.processing = false;
                        }
                    });
                } else if (status === 'Failed') {
                    stopTGPaymentPoller(session);
                    rcLog('FAILED', `TG chatId=${chatId} inv=${reference} — payment failed`);
                    // Update transaction status to EXPIRED in file
                    await updateTgTransactionStatus(reference, 'EXPIRED');
                    const _uiFailed = session.data.userInfo || {};
                    rcLog('EXPIRED', `TG | ${_uiFailed.username ? `@${_uiFailed.username}` : (_uiFailed.id || chatId)} | ${session.data.productData?.productName || '-'} x${session.data.quantityData || 1} | inv=${reference}`);
                    notifyAdmin({ type: 'expired', platform: 'telegram', buyer: _uiFailed.username ? `@${_uiFailed.username}` : String(_uiFailed.id || chatId), product: session.data.productData?.productName || '-', quantity: session.data.quantityData || 1, invoice: reference });
                    session.state = 'IDLE';
                    // Release reserved stock — use per-invoice tracking
                    const failResEntry = tgActiveReservations.get(reference);
                    if (failResEntry && failResEntry.reservationStatus === 'HELD') {
                        rcLog('RELEASE', `txId=${reference} product=${failResEntry.productName || 'unknown'} lines=${(failResEntry.reservedLines || []).length} reason=payment-failed`);
                        failResEntry.reservedLines = [];
                        failResEntry.reservationStatus = 'RELEASED';
                        tgActiveReservations.delete(reference);
                        console.log(`[TG-POLLER] Released reservation for chatId ${chatId} invoice=${reference} — payment failed`);
                    } else if (session.data.reservedLines && session.data.reservationStatus === 'HELD') {
                        releaseReservation(session.data);
                        console.log(`[TG-POLLER] Released reservation for chatId ${chatId} — payment failed (session fallback)`);
                    }
                    // Remove buttons from QR message
                    if (session.data.statusPhotoId) {
                        bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
                            chat_id: chatId,
                            message_id: session.data.statusPhotoId
                        }).catch(() => { });
                    }
                    await bot.sendMessage(chatId, `❌ *Pembayaran Gagal / Kadaluarsa*\n\nTransaksi tidak berhasil.`, {
                        parse_mode: 'Markdown',
                        reply_markup: { keyboard: getMainMenuKeyboard(isMaster(session.data.userInfo?.id)), resize_keyboard: true }
                    }).catch(() => { });
                }
                // If still Unpaid/Pending, do nothing — next poll will check again
            } catch (err) {
                console.error(`[TG-POLLER] Error polling chatId=${chatId}:`, err.message);
                // Don't stop on transient errors — next poll will retry
            }
        }, TG_POLL_INTERVAL_MS);
    }

    // --- ADMIN ORDER NOTIFICATION HELPER ---
    const notifyAdmin = (orderDetails) => {
        try {
            const config = getConfig()[0] || {};
            // Check if notifications are enabled (supports both old boolean and new object format)
            const notifConfig = config.order_notifications;
            if (!notifConfig) return;
            // Must have at least one master registered
            if (!GLOBAL_MASTERS || GLOBAL_MASTERS.length === 0) return;

            const { type, platform, buyer, product, quantity, amount, invoice, status } = orderDetails;

            // Per-type check: if object, check specific type; if boolean true (legacy), allow all
            if (typeof notifConfig === 'object') {
                if (!notifConfig[type]) return;
            }
            // else: notifConfig is truthy (legacy boolean) → allow all types
            const timeStr = new Date().toLocaleString('id-ID', {
                day: 'numeric', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });

            let msg = '';
            if (type === 'paid') {
                const platformIcon = platform === 'whatsapp' ? '🟢 WhatsApp' : '🔵 Telegram';
                const amountStr = amount ? `Rp ${Number(amount).toLocaleString('id-ID')}` : '-';
                msg = `🔔 *ORDER TERBAYAR!*\n\n` +
                    `📦 *Produk:* ${product}\n` +
                    `🔢 *Qty:* ${quantity}\n` +
                    `💰 *Total:* ${amountStr}\n` +
                    `👤 *Buyer:* ${buyer}\n` +
                    `📱 *Platform:* ${platformIcon}\n` +
                    `🧾 *Invoice:* \`${invoice || '-'}\`\n` +
                    `⏰ *Waktu:* ${timeStr}\n\n` +
                    `✅ Produk telah dikirim ke buyer.`;
            } else if (type === 'new') {
                const platformIcon = platform === 'whatsapp' ? '🟢 WhatsApp' : '🔵 Telegram';
                const amountStr = amount ? `Rp ${Number(amount).toLocaleString('id-ID')}` : '-';
                msg = `🛒 *ORDER BARU!*\n\n` +
                    `📦 *Produk:* ${product}\n` +
                    `🔢 *Qty:* ${quantity}\n` +
                    `💰 *Total:* ${amountStr}\n` +
                    `👤 *Buyer:* ${buyer}\n` +
                    `📱 *Platform:* ${platformIcon}\n` +
                    `🧾 *Invoice:* \`${invoice || '-'}\`\n` +
                    `⏰ *Waktu:* ${timeStr}\n\n` +
                    `⏳ Menunggu pembayaran...`;
            } else if (type === 'expired' || type === 'cancelled') {
                const label = type === 'expired' ? '⏰ ORDER EXPIRED' : '❌ ORDER DIBATALKAN';
                msg = `${label}\n\n` +
                    `📦 *Produk:* ${product}\n` +
                    `👤 *Buyer:* ${buyer}\n` +
                    `🧾 *Invoice:* \`${invoice || '-'}\`\n` +
                    `⏰ *Waktu:* ${timeStr}`;
            } else if (type === 'recovered') {
                const platformIcon = platform === 'whatsapp' ? '🟢 WhatsApp' : '🔵 Telegram';
                const amountStr = amount ? `Rp ${Number(amount).toLocaleString('id-ID')}` : '-';
                msg = `🔄 *PAYMENT RECOVERED!*\n\n` +
                    `📦 *Produk:* ${product}\n` +
                    `🔢 *Qty:* ${quantity}\n` +
                    `💰 *Total:* ${amountStr}\n` +
                    `👤 *Buyer:* ${buyer}\n` +
                    `📱 *Platform:* ${platformIcon}\n` +
                    `🧾 *Invoice:* \`${invoice || '-'}\`\n` +
                    `⏰ *Waktu:* ${timeStr}\n\n` +
                    `⚠️ Pembayaran terdeteksi setelah bot restart. Cek & kirim produk manual jika belum terkirim.`;
            }

            if (!msg) return;

            GLOBAL_MASTERS.forEach(masterId => {
                bot.sendMessage(masterId, msg, { parse_mode: 'Markdown' }).catch(err => {
                    console.error(`[NOTIFY] Failed to send to master ${masterId}:`, err.message);
                });
            });
        } catch (e) {
            console.error('[NOTIFY] Error sending admin notification:', e);
        }
    };

    // Inline admin contact CTA — sends a clickable button row pointing to admin TG/WA.
    // Returns silently if no admin contact configured. Use after failure messages.
    const sendTgAdminContactCta = async (chatId, hint = '💬 Klik tombol di bawah untuk menghubungi admin.') => {
        try {
            const cfg = getConfig()[0] || {};
            const tgAdmin = cfg.admin_contact_telegram || '';
            const waAdmin = cfg.admin_contact_whatsapp || '';
            const buttons = [];
            if (tgAdmin) buttons.push({ text: '📱 Admin Telegram', url: `https://t.me/${tgAdmin}` });
            if (waAdmin) buttons.push({ text: '📞 Admin WhatsApp', url: `https://wa.me/${waAdmin}` });
            if (buttons.length === 0) return;
            await bot.sendMessage(chatId, hint, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [buttons] }
            });
        } catch (e) { /* best-effort — never block flow */ }
    };

    // Helper Function: Process Transaction Finish (dipindahkan ke luar agar bisa diakses dari callback)
    const processTransactionFinish = async (chatId, product, quantity, userInfo = {}) => {
        // --- LOG TRANSACTION HELPER ---
        const logTransaction = async () => {
            // Update existing UNPAID entry to PAID (created by saveTgTransaction)
            // Also correct amount with actual gateway total (paymentRupiah) in case initial save had wrong value
            const session = getSession(chatId);
            const ref = session.data.paymentReference;
            if (ref) {
                await updateTgTransactionStatus(ref, 'PAID', session.data.paymentRupiah);
            } else {
                // Fallback: no reference (shouldn't happen), push new entry
                try {
                    await withTgTxFile(history => {
                        const fullName = (userInfo.first_name || "") + (userInfo.last_name ? " " + userInfo.last_name : "");
                        const displayName = fullName.trim() || userInfo.username || userInfo.id || "Anonymous";
                        const timeStr = new Date().toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
                        const fallbackBulk = calculateBulkPrice(product, quantity);
                        const totalPrice = fallbackBulk.totalPrice;
                        history.push({ name: displayName, username: userInfo.username || '', product: product.productName, quantity: quantity, amount: totalPrice, profit: fallbackBulk.totalProfit, status: 'PAID', time: timeStr, timestamp: Date.now() });
                        if (history.length > TX_HISTORY_CAP) history.splice(0, history.length - TX_HISTORY_CAP);
                    });
                } catch (e) { console.error("Error logging transaction:", e); }
            }
        };

        let message = `🎉 Berikut detail untuk produk *${product.productName}*:\n\n`;
        // ... (rest of logic) ...

        // DETERMINE FORMAT (Explicit > Auto-Detect)
        let formatStr = product.format;
        if (!formatStr || formatStr.trim() === '') {
            if (product.productName.toLowerCase().includes('netflix')) {
                formatStr = 'email|password|profile|pin';
            } else {
                formatStr = 'email|password';
            }
        }

        // --- DELIVERY UI: mobile-friendly markdown (no ASCII box) ---
        // headerBox/contentWidth/divider were used by the old ASCII layout — kept absent.

        // --- DIGIFLAZZ PPOB: dispatch topup to provider after user payment confirmed ---
        if (product && product.source === 'digiflazz') {
            const cfg = getConfig()[0] || {};
            const df = cfg.digiflazz || {};
            const session = getSession(chatId);
            const refId = session.data.paymentReference;
            const customerNo = session.data.ppob?.customer_no;
            const paid = session.data.paymentRupiah || (product.priceProduct || 0) * quantity;

            if (!refId || !customerNo) {
                await bot.sendMessage(chatId, '⚠️ Data transaksi PPOB tidak lengkap. Admin akan menindaklanjuti.');
                notifyAdmin({ type: 'paid', platform: 'telegram', buyer: String(userInfo.id || ''), product: product.productName, quantity, amount: paid, invoice: refId || '-', extra: 'PPOB dispatch FAILED — missing customer_no' });
                await logTransaction();
                return;
            }
            if (!df.is_active || !df.username || !df.api_key) {
                await bot.sendMessage(chatId, '⚠️ Provider PPOB belum aktif. Admin akan memproses manual.');
                notifyAdmin({ type: 'paid', platform: 'telegram', buyer: String(userInfo.id || ''), product: product.productName, quantity, amount: paid, invoice: refId, extra: 'PPOB dispatch SKIPPED — Digiflazz disabled' });
                await logTransaction();
                return;
            }

            const processingMsg = await bot.sendMessage(chatId,
                `🔄 *Memproses topup...*\n\n` +
                `📦 Produk: *${product.productName}*\n` +
                `📱 Tujuan: \`${customerNo}\`\n` +
                `🧾 Ref: \`${refId}\`\n\n` +
                `_Mohon tunggu, sedang diproses..._`,
                { parse_mode: 'Markdown' }
            );

            const dfRes = await digiflazz.createTransaction({
                username: df.username, apiKey: df.api_key,
                buyerSkuCode: product.buyer_sku_code,
                customerNo,
                refId,
                maxPrice: Math.max(parseInt(paid) || 0, parseInt(product.df_base_price) || 0),
                cbUrl: undefined, // global webhook is configured at Digiflazz dashboard
            });

            const bucket = dfRes.ok ? digiflazz.classifyRc(dfRes.rc, dfRes.status) : 'FAILED';
            rcLog('PPOB_DISPATCH', `ref=${refId} sku=${product.buyer_sku_code} cust=${customerNo} ok=${dfRes.ok} rc=${dfRes.rc || '-'} → ${bucket}`);

            // Persist Digiflazz response onto tx for audit
            try {
                await withTgTxFile(history => {
                    const i = history.findIndex(t => t.reference === refId);
                    if (i !== -1) {
                        history[i].digiflazz = {
                            customer_no: customerNo,
                            buyer_sku_code: product.buyer_sku_code,
                            rc: dfRes.rc || (dfRes.ok ? '' : 'ERR'),
                            status: dfRes.status,
                            message: dfRes.message || dfRes.error,
                            sn: dfRes.sn || '',
                            buyer_last_saldo: dfRes.buyer_last_saldo,
                            bucket,
                            dispatched_at: Date.now(),
                        };
                        history[i].deliveryState = bucket === 'SUCCESS' ? 'DELIVERED' : (bucket === 'PENDING' ? 'PROCESSING' : 'FAILED');
                    }
                });
            } catch (e) { console.error('[PPOB] persist tx failed:', e.message); }

            const deliverSuccess = (sn, extraMsg = '') => {
                const lines = [
                    '✅ *Transaksi Sukses!*',
                    '',
                    `📦 *${product.productName}*`,
                    `📱 Tujuan: \`${customerNo}\``,
                    `🧾 Ref: \`${refId}\``,
                    sn ? `🔐 SN: \`${sn}\`` : '',
                    extraMsg ? '' : '',
                    extraMsg,
                    '',
                    '_Terima kasih telah membeli!_'
                ].filter(Boolean).join('\n');
                return bot.editMessageText(lines, { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' })
                    .catch(() => bot.sendMessage(chatId, lines, { parse_mode: 'Markdown' }));
            };

            if (bucket === 'SUCCESS') {
                await deliverSuccess(dfRes.sn, dfRes.message ? `_${dfRes.message}_` : '');
                await updateSalesCount(product.productName, quantity);
                await logTransaction();
                return;
            }

            if (bucket === 'PENDING') {
                // Register for webhook delivery; user notified now, SN sent on webhook resolve.
                pendingPpob.set(refId, {
                    chatId, productName: product.productName, customerNo, refId,
                    skuCode: product.buyer_sku_code,
                    userInfo, msg_id: processingMsg.message_id, quantity,
                    started_at: Date.now()
                });
                await bot.editMessageText(
                    `⏳ *Transaksi Diproses*\n\n` +
                    `📦 *${product.productName}*\n` +
                    `📱 Tujuan: \`${customerNo}\`\n` +
                    `🧾 Ref: \`${refId}\`\n\n` +
                    `Topup sedang diproses provider. SN akan dikirim otomatis ke chat ini saat selesai (biasanya <2 menit).`,
                    { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
                ).catch(() => {});
                await logTransaction();
                return;
            }

            // FAILED — user paid but Digiflazz rejected; admin must handle refund manually.
            const errMsg = dfRes.message || dfRes.error || `rc=${dfRes.rc || 'unknown'}`;
            await bot.editMessageText(
                `⚠️ *Transaksi Gagal di Provider*\n\n` +
                `📦 *${product.productName}*\n` +
                `📱 Tujuan: \`${customerNo}\`\n` +
                `🧾 Ref: \`${refId}\`\n` +
                `Alasan: _${errMsg}_\n\n` +
                `💸 *Dana Anda akan di-refund oleh admin.* Mohon hubungi admin untuk konfirmasi refund.`,
                { chat_id: chatId, message_id: processingMsg.message_id, parse_mode: 'Markdown' }
            ).catch(() => bot.sendMessage(chatId, `⚠️ Transaksi PPOB gagal: ${errMsg}. Hubungi admin untuk refund.`, { parse_mode: 'Markdown' }));
            await sendTgAdminContactCta(chatId, '💸 Klik tombol di bawah untuk hubungi admin terkait refund.');
            notifyAdmin({
                type: 'paid', platform: 'telegram',
                buyer: String(userInfo.id || ''), product: product.productName,
                quantity, amount: paid, invoice: refId,
                extra: `PPOB FAILED rc=${dfRes.rc || '?'} msg="${errMsg}" cust=${customerNo} — REFUND REQUIRED`
            });
            await logTransaction();
            return;
        }

        if (product && product.source === 'koalastore') {
            const config = getConfig()[0];
            const koalaApiKey = config.koalastore ? config.koalastore.api_key : '';
            if (!koalaApiKey) {
                await bot.sendMessage(chatId, `❌ Provider produk belum dikonfigurasi. Hubungi admin.`);
                return;
            }

            try {
                const ksRes = await koalaStore.checkout(koalaApiKey, product.variant_code || product.productId, quantity);
                if (ksRes.success && ksRes.data) {
                    const order = ksRes.data;
                    const ksRefId = getSession(chatId).data.paymentReference || '';

                    let details = [];
                    if (order.items && Array.isArray(order.items)) {
                        order.items.forEach(item => {
                            if (item.stock_data && Array.isArray(item.stock_data)) {
                                item.stock_data.forEach(sd => {
                                    if (sd.dataStock) details.push(sd.dataStock);
                                });
                            }
                        });
                    }
                    if (details.length === 0 && order.stock_data && Array.isArray(order.stock_data)) {
                        order.stock_data.forEach(acc => { details.push(acc); });
                    }

                    // Mobile-friendly delivery message (no ASCII box)
                    let msgText = `✅ *ORDER SUKSES*\n━━━━━━━━━━━━━━━━━━\n\n`;
                    msgText += `📦 Produk: *${product.productName}*\n`;
                    msgText += `🔢 Jumlah: *${quantity} item*\n`;
                    if (ksRefId) msgText += `🧾 Ref: \`${ksRefId}\`\n`;
                    msgText += `\n━━ DETAIL AKUN ━━\n\n`;

                    if (details.length > 0) {
                        details.forEach((d, idx) => {
                            msgText += `*Item ${idx + 1}:*\n`;
                            const parts = d.split(',');
                            parts.forEach(line => {
                                const cleanLine = line.trim();
                                if (cleanLine) msgText += `\`${cleanLine}\`\n`;
                            });
                            if (idx < details.length - 1) msgText += `\n`;
                        });
                    } else if (order.manual_delivery) {
                        msgText += `_⏳ Status: PROSES MANUAL_\n_Mohon tunggu diproses tim._\n`;
                    } else {
                        msgText += `_✅ Status: Sukses diproses_\n`;
                    }

                    msgText += `\n━━━━━━━━━━━━━━━━━━\n_🙏 Terima kasih telah membeli!_`;

                    await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });

                    // Send as .txt file for easy copy
                    if (details.length > 0) {
                        const txtContent = `${product.productName} ${quantity} item\n` + details.join('\n');
                        const txtFilename = generateDeliveryFilename(product.productName, quantity);
                        await bot.sendDocument(chatId, Buffer.from(txtContent, 'utf8'), {
                            caption: `📄 ${product.productName} - ${quantity} item`,
                        }, { filename: txtFilename, contentType: 'text/plain' });
                    }

                    // Update Local Sales count
                    await updateSalesCount(product.productName, quantity);

                    await logTransaction();
                    return;
                } else {
                    console.error('[TG] KoalaStore checkout failed:', ksRes.message || 'no data');
                    await bot.sendMessage(chatId, `❌ Terjadi kendala saat pengiriman dari provider. Hubungi admin untuk bantuan.`);
                    await sendTgAdminContactCta(chatId);
                    return;
                }
            } catch (e) {
                console.error("KS Checkout error", e);
                await bot.sendMessage(chatId, `❌ Terjadi kesalahan fatal saat checkout. Hubungi admin untuk bantuan.`);
                await sendTgAdminContactCta(chatId);
                return;
            }
        }

        // Use reserved lines from session (set during executePurchaseGlobal)
        const session = getSession(chatId);
        const rawLines = session.data.reservedLines;
        if (!rawLines || rawLines.length === 0) {
            await bot.sendMessage(chatId, "⚠️ Stok habis atau terjadi kesalahan saat mengambil stok.");
            return;
        }

        // Commit reserved stock: remove from file atomically
        try {
            await commitReservedStock(product.productName, rawLines);
            session.data.reservationStatus = 'COMMITTED';
        } catch (commitErr) {
            console.error("Stock commit failed:", commitErr);
            await bot.sendMessage(chatId, "⚠️ Terjadi kesalahan saat memproses stok. Hubungi admin.");
            return;
        }

        // rollbackStock is now imported from foundation.js

        try {

            if (formatStr.toLowerCase().includes('file')) {
                await bot.sendMessage(chatId, `🎉 Pembayaran terkonfirmasi! Menyiapkan pengiriman file...`);
                for (let i = 0; i < rawLines.length; i++) {
                    const fileName = rawLines[i].trim();
                    const filePath = path.join(projectRoot, 'files', fileName);
                    const rootFilePath = path.join(projectRoot, fileName);
                    let targetPath = fs.existsSync(filePath) ? filePath : (fs.existsSync(rootFilePath) ? rootFilePath : null);
                    if (targetPath) {
                        try {
                            await bot.sendDocument(chatId, fs.createReadStream(targetPath), {
                                caption: `📦 *${product.productName}* — Item ${i + 1}/${rawLines.length}`,
                                parse_mode: 'Markdown'
                            });
                        } catch (e) {
                            await bot.sendMessage(chatId, `❌ Gagal mengirim file: *${fileName}*`);
                        }
                    } else {
                        await bot.sendMessage(chatId, `❌ File \`${fileName}\` tidak ditemukan.`);
                    }
                }
            } else {
                const keys = formatStr.split('|').map(k => k.trim());
                const TELEGRAM_LIMIT = TG_MSG_LIMIT;
                const localRefId = getSession(chatId).data.paymentReference || '';

                // Build per-item markdown blocks (mobile-friendly, no ASCII box)
                const itemBlocks = rawLines.map((line, index) => {
                    const values = line.split('|').map(v => v.trim());
                    let block = `*Item ${index + 1}:*\n`;
                    keys.forEach((key, kIndex) => {
                        const val = values[kIndex] || "-";
                        const label = key.charAt(0).toUpperCase() + key.slice(1);
                        block += `${label}: \`${val}\`\n`;
                    });
                    return block;
                });

                // Header for first message
                let firstHeader = `✅ *ORDER SUKSES*\n━━━━━━━━━━━━━━━━━━\n\n`;
                firstHeader += `📦 Produk: *${product.productName}*\n`;
                firstHeader += `🔢 Jumlah: *${quantity} item*\n`;
                if (localRefId) firstHeader += `🧾 Ref: \`${localRefId}\`\n`;
                firstHeader += `\n━━ DETAIL AKUN ━━\n\n`;

                const contHeader = `📦 *${product.productName}* — _Lanjutan_\n━━━━━━━━━━━━━━━━━━\n\n`;
                const footer = `\n━━━━━━━━━━━━━━━━━━\n_🙏 Terima kasih telah membeli!_`;

                // Pack item blocks into messages that fit Telegram message limit
                const chunks = [];
                let currentItems = [];
                let currentSize = 0;
                const headerSize = () => chunks.length === 0 ? firstHeader.length : contHeader.length;
                const sep = '\n';

                itemBlocks.forEach((block) => {
                    const sepSize = currentItems.length > 0 ? sep.length : 0;
                    const projected = currentSize + sepSize + block.length + headerSize() + footer.length;
                    if (projected > TELEGRAM_LIMIT && currentItems.length > 0) {
                        chunks.push(currentItems);
                        currentItems = [];
                        currentSize = 0;
                    }
                    if (currentItems.length > 0) currentSize += sep.length;
                    currentItems.push(block);
                    currentSize += block.length;
                });
                if (currentItems.length > 0) chunks.push(currentItems);

                // Send each chunk as a separate message
                for (let c = 0; c < chunks.length; c++) {
                    let msgText = (c === 0) ? firstHeader : contHeader;
                    msgText += chunks[c].join(sep);
                    msgText += footer;
                    await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' });
                }

                // Send as .txt file for easy copy
                const txtContent = `${product.productName} ${quantity} item\n` + rawLines.join('\n');
                const txtFilename = generateDeliveryFilename(product.productName, quantity);
                await bot.sendDocument(chatId, Buffer.from(txtContent, 'utf8'), {
                    caption: `📄 ${product.productName} - ${quantity} item`,
                }, { filename: txtFilename, contentType: 'text/plain' });
            }

        } catch (deliveryErr) {
            console.error("Delivery failed, rolling back stock:", deliveryErr);
            await rollbackStock(product.productName, rawLines);
            throw deliveryErr; // re-throw so outer catch (line 1596) sends error msg to user
        }

        await updateSalesCount(product.productName, quantity);

        await logTransaction();
    };

    // Tangani klik tombol "Informasi"
    bot.onText(/ℹ️ Informasi/, async (msg) => {
        const chatId = msg.chat.id;
        try { await bot.deleteMessage(chatId, msg.message_id); } catch (e) { }

        await cleanupPreviousMessage(chatId);
        const session = getSession(chatId);

        // Ubah state sesuai dengan alur percakapan /beli
        session.state = 'awal';
        session.data = {};

        // Get Admin Contact from Config
        const _tg = getConfig()[0].admin_contact_telegram || '';
        const _wa = getConfig()[0].admin_contact_whatsapp || '';
        const _opHours = getConfig()[0].operating_hours || '';
        const _storeName = getConfig()[0].store_name || 'Telegram Store';
        let contactInfo = `\n\n🏪 *Store:* ${_storeName}`;
        if (_tg) contactInfo += `\n📱 *Telegram:* [@${_tg}](https://t.me/${_tg})`;
        if (_wa) contactInfo += `\n📞 *WhatsApp:* [${_wa}](https://wa.me/${_wa})`;
        if (!_tg && !_wa) contactInfo += `\n👤 *Admin:* -`;
        if (_opHours) contactInfo += `\n⏰ *Jam Operasional:* ${_opHours}`;

        const sent = await bot.sendMessage(
            msg.chat.id,
            `ℹ️ *INFORMASI*\n\nBot ini membantu Anda untuk melihat daftar produk, melakukan pembelian, dan cek stok secara otomatis.${contactInfo}`,
            {
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
                reply_markup: {
                    keyboard: [['🔙 Back']],
                    resize_keyboard: true,
                }
            }
        );
        session.activeBotMessages.push(sent.message_id);
    });

    bot.onText(/➕ Tambah Produk/, (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const data = fs.readFileSync(productFile, 'utf8');
        const products = JSON.parse(data)
        const session = getSession(chatId);

        // Ubah state sesuai dengan alur percakapan /beli
        session.state = 'tambahproduk';
        session.data = {}; // Misal reset data jika diperlukan
        if (isMaster(userId)) { } else {
            bot.sendMessage(msg.chat.id, '❌ Feature ini hanya untuk master.');
            return
        }
        // Kirim instruksi ke pengguna
        bot.sendMessage(chatId, 'Masukkan nama produk dan ID produk dengan format:\n`productName|idProduct|harga|profit`', {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: [
                    ['❌ Cancel']
                ], // Tombol Cancel untuk membatalkan proses
                resize_keyboard: true,
            },
        });

        bot.once('message', (response) => {
            const [productName, idProduct, harga, profit] = response.text.split('|');
            const text = response.text.trim();

            // Cek apakah pengguna memilih untuk membatalkan
            if (text === '❌ Cancel') {
                bot.sendMessage(chatId, 'Proses penambahan produk dibatalkan.', {
                    parse_mode: 'Markdown',
                });
                // Kembali ke menu utama setelah membatalkan
                bot.sendMessage(chatId, `Kembali ke menu utama. Pilih aksi yang ingin Anda lakukan:`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        keyboard: [
                            ['➕ Tambah Produk', '✏️ Edit Produk', '✏️ Edit Stock', '📢 Broadcast'],
                        ],
                        resize_keyboard: true,
                    },
                });
                return;
            }

            // Validasi input
            if (!productName || !idProduct) {
                bot.sendMessage(chatId, 'Format salah. Gunakan: `productName|idProduct|harga|profit`', {
                    parse_mode: 'Markdown',
                });
                return;
            }

            // Tambahkan produk baru
            const newProduct = {
                productName: productName.trim(),
                idProduct: idProduct.trim(),
                priceProduct: harga.trim(),
                profit: profit.trim(),
                addedAt: new Date().toISOString(),

            };
            products.push(newProduct);
            fs.appendFileSync(getStockPath(productName.trim()), "")
            // Simpan ke file JSON
            saveProducts(products);

            // Berikan konfirmasi
            bot.sendMessage(chatId, `✅ Produk *${productName}* dengan ID *${idProduct}* berhasil ditambahkan!`, {
                parse_mode: 'Markdown',
            });

            bot.sendMessage(chatId, 'Kembali ke menu utama. Pilih aksi yang ingin Anda lakukan:', {
                reply_markup: {
                    keyboard: [
                        ['➕ Tambah Produk', '✏️ Edit Produk', '✏️ Edit Stock', '📢 Broadcast'],
                    ],
                    resize_keyboard: true,
                },
            });

        });
    });

    bot.onText(/✏️ Edit Produk/, (msg) => {
        const chatId = msg.chat.id;
        const data = fs.readFileSync(productFile, 'utf8');
        const products = JSON.parse(data)
        const userId = msg.from.id;
        const session = getSession(chatId);

        // Ubah state sesuai dengan alur percakapan /beli
        session.state = 'editproduk';
        session.data = {}; // Misal reset data jika diperlukan
        if (isMaster(userId)) {
            if (products.length === 0) {
                bot.sendMessage(chatId, '❌ Tidak ada produk yang tersedia untuk diedit.', {
                    parse_mode: 'Markdown',
                });
                return;
            }

            let isProcessing = false;
            // Tampilkan daftar produk yang ada untuk diedit
            const productKeyboard = products.map((product) => [`${addEmoticonToProduct(product.productName)}`]);
            productKeyboard.push(['🔙 Kembali ke Menu']); // Tombol Back

            bot.sendMessage(chatId, 'Silakan pilih produk yang ingin Anda edit:', {
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: productKeyboard,
                    resize_keyboard: true,
                    one_time_keyboard: true,
                },
            });

            bot.once('message', (response) => {
                if (isProcessing) return; // Abaikan jika sudah diproses sebelumnya
                isProcessing = true; // Set flag agar tidak bisa input lagi

                const selectedText = response.text;

                if (selectedText === '🔙 Kembali ke Menu') {
                    bot.sendMessage(chatId, 'Kembali ke menu utama. Pilih aksi yang ingin Anda lakukan:', {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            keyboard: [
                                ['➕ Tambah Produk', '✏️ Edit Produk', '✏️ Edit Stock', '📢 Broadcast'],
                            ],
                            resize_keyboard: true,
                        },
                    });
                    return;
                }

                // Cari produk yang dipilih
                const selectedProductName = products.find((product) => {
                    const productWithEmoticon = `${addEmoticonToProduct(product.productName)}`;
                    return productWithEmoticon === selectedText;
                })?.productName;


                const selectProduct = products.find((product) => product.productName === selectedProductName)
                if (!selectedProductName) {
                    bot.sendMessage(chatId, '❌ Produk tidak ditemukan. Silakan pilih produk dari daftar.', {
                        parse_mode: 'Markdown',
                    });
                    return;
                }

                // Minta pengguna untuk memasukkan nama baru produk
                bot.sendMessage(chatId, `✏️ Masukkan nama baru untuk produk *${selectedProductName}* (misalnya: "netflix baru"):`, {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        keyboard: [
                            ['❌ Cancel']
                        ], // Tombol Cancel untuk membatalkan proses
                        resize_keyboard: true,
                    },
                });

                bot.once('message', (newNameResponse) => {
                    const newProductName = newNameResponse.text.trim();

                    // Cek apakah pengguna memilih untuk membatalkan
                    if (newProductName === '❌ Cancel') {
                        bot.sendMessage(chatId, 'Proses Edit Produk Dibatalkan.', {
                            parse_mode: 'Markdown',
                        });
                        // Kembali ke menu utama setelah membatalkan
                        bot.sendMessage(chatId, `Kembali ke menu utama. Pilih aksi yang ingin Anda lakukan:`, {
                            parse_mode: 'Markdown',
                            reply_markup: {
                                keyboard: [
                                    ['➕ Tambah Produk', '✏️ Edit Produk', '✏️ Edit Stock', '📢 Broadcast'],
                                ],
                                resize_keyboard: true,
                            },
                        });
                        return;
                    }

                    if (!newProductName) {
                        bot.sendMessage(chatId, '❌ Nama produk tidak valid. Silakan coba lagi.', {
                            parse_mode: 'Markdown',
                        });
                        return;
                    }

                    // Update produk di product.json
                    selectProduct.productName = newProductName

                    // Rename file produk
                    renameProductFile(selectedProductName, newProductName);

                    // Simpan perubahan ke product.json
                    saveProducts(products);

                    bot.sendMessage(chatId, `✅ Produk *${selectedProductName}* berhasil diubah menjadi *${newProductName}*!`, {
                        parse_mode: 'Markdown',
                    });

                    // Kembali ke menu utama setelah edit
                    bot.sendMessage(chatId, 'Kembali ke menu utama:', {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            keyboard: [
                                ['➕ Tambah Produk', '✏️ Edit Produk', '✏️ Edit Stock', '📢 Broadcast'],
                            ],
                            resize_keyboard: true,
                        },
                    });
                });
            });
        } else {
            bot.sendMessage(msg.chat.id, '❌ Feature ini hanya untuk master.');
            return
        }
    });

    bot.onText(/✏️ Edit Stock/, (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const data = fs.readFileSync(productFile, 'utf8');
        const products = JSON.parse(data)
        const session = getSession(chatId);

        // Ubah state sesuai dengan alur percakapan /beli
        session.state = 'editstock';
        session.data = {}; // Misal reset data jika diperlukan
        if (isMaster(userId)) { } else {
            bot.sendMessage(msg.chat.id, '❌ Feature ini hanya untuk master.');
            return
        }

        if (products.length === 0) {
            bot.sendMessage(chatId, '❌ Tidak ada produk yang tersedia.');
            return;
        }

        // Tampilkan daftar produk
        const productKeyboard = products.map((product) => [`${addEmoticonToProduct(product.productName)}`]);
        productKeyboard.push(['🔙 Back']); // Tambahkan tombol "Back"

        bot.sendMessage(chatId, 'Pilih produk untuk mengedit stok:', {
            parse_mode: 'Markdown',
            reply_markup: {
                keyboard: productKeyboard,
                resize_keyboard: true,
            },
        });

        bot.once('message', (response) => {
            const selectedText = response.text;
            if (selectedText === '🔙 Back') {
                bot.sendMessage(chatId, 'Kembali ke menu utama.', {
                    reply_markup: {
                        keyboard: [
                            ['➕ Tambah Produk', '✏️ Edit Produk', '✏️ Edit Stock', '📢 Broadcast'],
                        ],
                        resize_keyboard: true,
                    },
                });
                return;
            }

            const selectedProductName = products.find((product) => {
                const productWithEmoticon = `${addEmoticonToProduct(product.productName)}`;
                return productWithEmoticon === selectedText;
            })?.productName;

            const filePath = getStockPath(selectedProductName);

            if (!fs.existsSync(filePath)) {
                bot.sendMessage(chatId, `❌ File ${selectedProductName.toLowerCase()}.txt tidak ditemukan.`);
                return;
            }

            const fileData = fs.readFileSync(filePath, 'utf8').trim();
            const totalLines = fileData ? fileData.split('\n').length : 0;
            if (!fileData) {
                bot.sendMessage(chatId, `❌ Tidak ada stok tersedia untuk produk ${selectedProductName}.`);

                bot.sendMessage(chatId, 'Kembali ke menu utama:', {
                    parse_mode: 'Markdown',
                    reply_markup: {
                        keyboard: [
                            ['➕ Tambah Produk', '✏️ Edit Produk', '✏️ Edit Stock', '📢 Broadcast'],
                        ],
                        resize_keyboard: true,
                    },
                });
            }

            const accounts = fileData.split('\n').map((line, index) => `*${index + 1}.* ${line}`).join('\n');

            // Find keys to dynamic prompt
            const targetProduct = products.find(p => p.productName === selectedProductName);
            const formatHint = (targetProduct && targetProduct.format) ? targetProduct.format :
                (selectedProductName.toLowerCase().includes('netflix') ? 'email|password|profile|pin' : 'email|password');

            bot.sendMessage(chatId, `📄 Stok saat ini untuk *${selectedProductName}*:\n${totalLines}\n\n🖊️ Kirim perintah:\n- Untuk tambah: \`${formatHint}\`\n- Untuk hapus: \`hapus nomor\``, {
                parse_mode: 'Markdown',
                reply_markup: {
                    keyboard: [
                        ['❌ Cancel']
                    ], // Tombol Cancel untuk membatalkan proses
                    remove_keyboard: true
                }, // Hapus semua tombol
            });

            bot.once('message', (editResponse) => {
                const input = editResponse.text;

                if (input === '❌ Cancel') {
                    bot.sendMessage(chatId, 'Proses pemilihan produk dibatalkan.', {
                        parse_mode: 'Markdown',
                    });
                    // Kembali ke menu utama setelah membatalkan
                    bot.sendMessage(chatId, `Kembali ke menu utama. Pilih aksi yang ingin Anda lakukan:`, {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            keyboard: [
                                ['➕ Tambah Produk', '✏️ Edit Produk', '✏️ Edit Stock', '📢 Broadcast'],
                            ],
                            resize_keyboard: true,
                        },
                    });
                    return;
                } else if (input.startsWith('hapus ')) {
                    // Hapus akun berdasarkan nomor
                    const lineToDelete = parseInt(input.split(' ')[1], 10);

                    if (isNaN(lineToDelete) || lineToDelete < 1 || lineToDelete > fileData.split('\n').length) {
                        bot.sendMessage(chatId, '❌ Nomor tidak valid.');
                        return;
                    }

                    const updatedData = fileData.split('\n').filter((_, index) => index !== lineToDelete - 1).join('\n');
                    writeFileAtomic(filePath, updatedData);

                    bot.sendMessage(chatId, `✅ Akun nomor ${lineToDelete} berhasil dihapus dari *${selectedProductName}*!`);

                    bot.sendMessage(chatId, 'Kembali ke menu utama:', {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            keyboard: [
                                ['➕ Tambah Produk', '✏️ Edit Produk', '✏️ Edit Stock', '📢 Broadcast'],
                            ],
                            resize_keyboard: true,
                        },
                    });
                } else if (input.includes('|')) {
                    // Tambah akun
                    fs.appendFileSync(filePath, `\n${input.trim()}`);
                    bot.sendMessage(chatId, `✅ Akun berhasil ditambahkan ke *${selectedProductName}*!`);

                    bot.sendMessage(chatId, 'Kembali ke menu utama:', {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            keyboard: [
                                ['➕ Tambah Produk', '✏️ Edit Produk', '✏️ Edit Stock', '📢 Broadcast'],
                            ],
                            resize_keyboard: true,
                        },
                    });
                } else {
                    bot.sendMessage(chatId, '❌ Input tidak valid. Gunakan format tambah atau hapus dengan benar.');
                    bot.sendMessage(chatId, 'Kembali ke menu utama:', {
                        parse_mode: 'Markdown',
                        reply_markup: {
                            keyboard: ['➕ Tambah Produk', '✏️ Edit Produk', '✏️ Edit Stock', '📢 Broadcast'],
                            resize_keyboard: true,
                        },
                    });
                }
            });
        });
    });

    bot.getMe().then(botInfo => {
        console.log(`🤖 Bot ${botInfo.username} aktif dan siap digunakan. (PID: ${process.pid})`);
    }).catch(err => {
        console.error("Gagal menginisialisasi bot:", err.message);
        process.exit(1);
    });

    // Handle Polling Errors
    bot.on('polling_error', (error) => {
        console.error(`[Polling Error] ${error.code}: ${error.message}`);
    });

    // Tangani error global agar bot tidak berhenti
    // UPDATE: Sebaiknya bot berhenti (exit) jika ada error critical agar tidak jadi zombie process
    // User menggunakan nodemon, jadi akan auto-restart.
    process.on('uncaughtException', (err) => {
        console.error('🔥 Uncaught Exception:', err);
        process.exit(1); // Exit agar tidak menumpuk process di background
    });

    process.on('unhandledRejection', (reason, promise) => {
        console.error('🚨 Unhandled Rejection:', reason);
        // process.exit(1); // Opsional: matikan jika unhandled rejection dianggap fatal
    });

    // Graceful shutdown — stop polling before exit to prevent 409 Conflict on restart
    const gracefulShutdown = async (signal) => {
        console.log(`\n🛑 ${signal} received. Stopping bot polling...`);
        try {
            if (bot._instance) {
                await bot._instance.stopPolling();
                console.log('✅ Bot polling stopped cleanly.');
            }
        } catch (e) {
            console.error('⚠️ Error stopping polling:', e.message);
        }
        process.exit(0);
    };
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));





    // Startup recovery: clean up stale reservations from previous crash/restart
    const recoverReservations = async () => {
        try {
            await withWaTxFile(transactions => {
                if (transactions.length === 0) return;
                const now = Date.now();

                for (const tx of transactions) {
                    // Release expired UNPAID reservations
                    if (tx.status === 'UNPAID' && tx.reservationStatus === 'HELD') {
                        if (tx.reservationExpiresAt && now > tx.reservationExpiresAt) {
                            releaseReservation(tx);
                            tx.status = 'EXPIRED';
                            rcLog('RECOVERY', `Released expired reservation for tx ${tx.id} product=${tx.productName}`);
                        }
                    }
                    // Mark stale PROCESSING as NEEDS_REVIEW (crash during delivery)
                    if (tx.processing === true && !tx.delivered) {
                        tx.processing = false;
                        tx.deliveryState = 'NEEDS_REVIEW';
                        rcLog('RECOVERY', `Marked stale PROCESSING tx ${tx.id} as NEEDS_REVIEW`);
                    }
                    // Keep PAID + HELD (paid but not yet delivered) — poller will handle them
                    // Keep COMMITTED + not delivered — mark as NEEDS_REVIEW
                    if (tx.reservationStatus === 'COMMITTED' && !tx.delivered && tx.status === 'PAID') {
                        tx.deliveryState = 'NEEDS_REVIEW';
                        rcLog('RECOVERY', `Marked committed-but-undelivered tx ${tx.id} as NEEDS_REVIEW`);
                    }
                }
            });
            rcLog('RECOVERY', 'WA transactions cleaned up on startup');
        } catch (e) {
            console.error('[Recovery] Failed to recover reservations:', e);
        }
    };

    // Startup recovery: restore TG sessions + pollers for UNPAID transactions still within timeout.
    // Must run BEFORE recoverStaleTransactions() so pollers are active when stale check runs.
    const recoverTGSessions = () => {
        const now = Date.now();
        const TIMEOUT_MS = TX_TIMEOUT_MS;
        let restored = 0;

        try {
            const tgTxs = loadTransactions(transactionsFile);
            if (tgTxs.length === 0) return;

            for (const tx of tgTxs) {
                if (tx.status !== 'UNPAID') continue;
                const txTime = tx.timestamp || 0;
                if (txTime <= 0) continue;

                // Only restore sessions still within timeout window
                const elapsed = now - txTime;
                if (elapsed > TIMEOUT_MS) continue; // let recoverStaleTransactions handle expired ones

                // Need chatId and productData to restore session
                const chatId = tx.chatId;
                const productData = tx.productData;
                if (!chatId || !productData) {
                    console.log(`[TG-RECOVER] Skipping tx ref=${tx.reference} — missing chatId or productData`);
                    continue;
                }

                // Restore session state
                const session = getSession(chatId);
                session.state = 'WAITING_PAYMENT';
                session.data.paymentReference = tx.reference;
                session.data.paymentProvider = tx.provider || tx.paymentProvider || 'unknown';
                session.data.paymentApiKey = tx.paymentApiKey || null;
                session.data.productData = productData;
                session.data.quantityData = tx.quantity || 1;
                session.data.userInfo = { first_name: tx.name || '', username: tx.username || '', id: chatId };
                session.data.paymentRupiah = tx.paymentRupiah || tx.totalPrice || tx.amount || 0;
                session.data.reservedLines = tx.reservedLines || [];
                session.data.reservationStatus = tx.reservationStatus || null;

                // Provider-specific data
                const txProvider = tx.provider || tx.paymentProvider || '';
                if (txProvider === 'gopay') {
                    session.data.gopayCreatedAt = tx.gopayCreatedAt || txTime;
                    session.data.gopayExpiresAt = tx.gopayExpiresAt || (txTime + TIMEOUT_MS);
                }
                if (txProvider === 'saweria') {
                    session.data.saweriaId = tx.saweriaId || null;
                }

                // Restore tgActiveReservations for held reservations
                if (tx.reservedLines && tx.reservedLines.length > 0 && tx.reservationStatus === 'HELD') {
                    tgActiveReservations.set(tx.reference, {
                        chatId,
                        productName: productData.productName,
                        reservedLines: [...tx.reservedLines],
                        reservationStatus: 'HELD',
                        reservationExpiresAt: tx.reservationExpiresAt || (txTime + TIMEOUT_MS)
                    });
                }

                // Restart poller — remaining time will be handled by poller's own timeout
                startTGPaymentPoller(chatId, session);
                restored++;
                console.log(`[TG-RECOVER] Restored session chatId=${chatId} ref=${tx.reference} provider=${tx.provider || tx.paymentProvider} elapsed=${Math.round(elapsed / 1000)}s`);
            }

            if (restored > 0) {
                console.log(`[TG-RECOVER] ✅ Restored ${restored} TG session(s) with active pollers`);
            }
        } catch (e) {
            console.error('[TG-RECOVER] Error restoring TG sessions:', e);
        }
    };

    // Startup recovery: expire stale UNPAID transactions from previous crash/restart
    // When bot restarts, in-memory pollers are lost. This catches any UNPAID tx past timeout.
    // For GoPay: checks payment status via API before expiring (amount-based matching).
    const recoverStaleTransactions = async () => {
        const now = Date.now();
        const DEFAULT_TIMEOUT_MS = TX_TIMEOUT_MS;
        let totalExpired = 0;
        let totalRecovered = 0;

        // Load config once for provider API checks
        let config = {};
        let gopayConfig = null;
        try {
            const conf = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json'), 'utf8'));
            config = Array.isArray(conf) ? conf[0] : conf;
            gopayConfig = config.gopay || null;
        } catch {}

        // Helper: check payment status via provider API before expiring
        const checkProviderBeforeExpire = async (tx, txLabel) => {
            const provider = tx.provider || tx.paymentProvider || '';
            const ref = tx.reference || tx.id || '';
            try {
                if (provider === 'gopay') {
                    const payAmount = tx.totalPrice || tx.amount || 0;
                    const createdAt = tx.timestamp || (now - DEFAULT_TIMEOUT_MS);
                    const expiresAt = tx.gopayExpiresAt || (createdAt + DEFAULT_TIMEOUT_MS);

                    // Try cache first (zero API cost)
                    const cached = gopay.checkStatusFromCache(payAmount, createdAt, expiresAt);
                    if (cached.status === 'Paid') {
                        rcLog('RECOVERY', `${txLabel} GoPay tx PAID (cache hit) — recovering ref=${ref} amount=${payAmount}`);
                        return true;
                    }

                    // Cache miss — fallback to direct API only if credentials available
                    if (gopayConfig && gopayConfig.email && gopayConfig.password) {
                        const result = await gopay.checkStatus(gopayConfig, payAmount, createdAt, expiresAt);
                        if (result.status === 'Paid') {
                            rcLog('RECOVERY', `${txLabel} GoPay tx PAID (API fallback) — recovering ref=${ref} amount=${payAmount}`);
                            return true;
                        }
                    }
                } else if (provider === 'tripay') {
                    const apiKey = config.apiKey || '';
                    if (!apiKey || !ref) return false;
                    const res = await fetch(`https://tripay.co.id/api/transaction/check-status?reference=${encodeURIComponent(ref)}`, {
                        headers: { 'Authorization': `Bearer ${apiKey}` }
                    });
                    const data = await res.json();
                    if (data && data.message && data.message.toUpperCase().includes('PAID')) {
                        rcLog('RECOVERY', `${txLabel} Tripay tx PAID — recovering ref=${ref}`);
                        return true;
                    }
                } else if (provider === 'pakasir') {
                    const pakasirCfg = config.pakasir || {};
                    const slug = pakasirCfg.project_slug || '';
                    const apiKey = pakasirCfg.api_key || '';
                    if (!slug || !apiKey || !ref) return false;
                    const pakResult = await checkPakasirPayment(slug, apiKey, ref, tx.pakasirBaseAmount || tx.totalPrice || 0);
                    if (pakResult.status === 'Paid') {
                        rcLog('RECOVERY', `${txLabel} Pakasir tx PAID — recovering ref=${ref}`);
                        return true;
                    }
                } else if (provider === 'dompetx') {
                    const dpxCfg = config.dompetx || {};
                    const apiKey = dpxCfg.api_key || '';
                    const txId = tx.dompetxTxId || ref;
                    if (!apiKey || !txId) return false;
                    const dpxResult = await checkPaymentByProvider('dompetx', { reference: ref, config, dompetxTxId: txId });
                    if (dpxResult.status === 'Paid') {
                        rcLog('RECOVERY', `${txLabel} DompetX tx PAID — recovering ref=${ref}`);
                        return true;
                    }
                } else if (provider === 'saweria') {
                    const saweriaId = tx.saweriaId || ref;
                    if (!saweriaId) return false;
                    const sRes = await fetch(`https://backend.saweria.co/donations/qris/snap/${saweriaId}`, {
                        headers: { 'User-Agent': DEFAULT_USER_AGENT, 'Origin': 'https://saweria.co', 'Referer': 'https://saweria.co/' }
                    });
                    if (sRes.ok) {
                        const sData = await sRes.json();
                        if (sData.data && sData.data.transaction_status === 'Success') {
                            rcLog('RECOVERY', `${txLabel} Saweria tx PAID — recovering ref=${ref}`);
                            return true;
                        }
                    }
                }
            } catch (e) {
                console.error(`[Recovery] ${txLabel} ${provider} check error for ref=${ref}:`, e.message);
            }
            return false;
        };

        // --- TG Transactions (uses withTgTxFile lock to prevent race) ---
        try {
            {
                // Phase 1: snapshot stale UNPAID txs (no lock — read-only)
                const tgSnapshot = loadTransactions(transactionsFile);
                const staleTgTxs = tgSnapshot.filter(tx => {
                    if (tx.status !== 'UNPAID') return false;
                    const txTime = tx.timestamp || 0;
                    return txTime > 0 && (now - txTime) > DEFAULT_TIMEOUT_MS;
                });

                // Phase 2: check provider APIs outside lock (slow network calls)
                const tgApiResults = new Map(); // reference → { wasPaid, txData }
                for (const tx of staleTgTxs) {
                    const wasPaid = await checkProviderBeforeExpire(tx, 'TG');
                    tgApiResults.set(tx.reference, { wasPaid, txData: { ...tx } });
                }

                // Phase 3: apply mutations atomically inside lock
                if (staleTgTxs.length > 0) {
                    const deliveryQueue = []; // collect txs needing delivery (done outside lock)
                    await withTgTxFile(tgTxs => {
                        for (const [ref, { wasPaid, txData }] of tgApiResults) {
                            const tx = tgTxs.find(t => t.reference === ref);
                            if (!tx || tx.status !== 'UNPAID') continue; // already changed by another process

                            if (wasPaid) {
                                tx.status = 'PAID';
                                totalRecovered++;
                                deliveryQueue.push({ ...tx });
                            } else {
                                tx.status = 'EXPIRED';
                                totalExpired++;

                                // Cancel on DompetX side for stale recovered txs (fire-and-forget)
                                tgCancelDompetxIfNeeded(tx.provider || tx.paymentProvider, config?.dompetx?.api_key || '', tx.dompetxTxId || '', 'recovery-expired');

                                // Clean up session/poller that recoverTGSessions may have started
                                if (tx.chatId) {
                                    const expSession = getSession(tx.chatId);
                                    if (expSession.state === 'WAITING_PAYMENT') {
                                        stopTGPaymentPoller(expSession);
                                        expSession.state = 'IDLE';
                                    }
                                }
                                // Release tgActiveReservations entry
                                if (tx.reference && tgActiveReservations.has(tx.reference)) {
                                    const resEntry = tgActiveReservations.get(tx.reference);
                                    rcLog('RELEASE', `txId=${tx.reference} product=${resEntry.productName || 'unknown'} lines=${(resEntry.reservedLines || []).length} reason=recovery-expired`);
                                    tgActiveReservations.delete(tx.reference);
                                }

                                rcLog('RECOVERY', `Expired stale TG tx ref=${tx.reference} provider=${tx.provider || tx.paymentProvider} age=${Math.round((now - (tx.timestamp || 0)) / 1000)}s`);
                            }
                        }
                    });

                    if (totalExpired > 0 || totalRecovered > 0) {
                        rcLog('RECOVERY', `TG transactions: expired ${totalExpired}, recovered ${totalRecovered} on startup`);
                    }

                    // Phase 4: auto-deliver recovered txs outside lock (slow bot.sendMessage + delivery)
                    for (const txSnap of deliveryQueue) {
                        const chatId = txSnap.chatId;
                        const productData = txSnap.productData;
                        if (chatId && productData && txSnap.reservedLines && txSnap.reservedLines.length > 0) {
                            // Restore session so processTransactionFinish can read session.data
                            const session = getSession(chatId);
                            session.state = 'IDLE';
                            session.data.paymentReference = txSnap.reference;
                            session.data.paymentProvider = txSnap.provider || txSnap.paymentProvider || 'unknown';
                            session.data.paymentRupiah = txSnap.paymentRupiah || txSnap.totalPrice || txSnap.amount || 0;
                            session.data.reservedLines = txSnap.reservedLines;
                            session.data.reservationStatus = txSnap.reservationStatus || 'HELD';
                            session.data.productData = productData;
                            session.data.quantityData = txSnap.quantity || 1;
                            session.data.userInfo = { first_name: txSnap.name || '', username: txSnap.username || '', id: chatId };

                            // Restore tgActiveReservations so stock tracking is correct
                            if (txSnap.reservationStatus === 'HELD') {
                                tgActiveReservations.set(txSnap.reference, {
                                    chatId,
                                    productName: productData.productName,
                                    reservedLines: [...txSnap.reservedLines],
                                    reservationStatus: 'HELD'
                                });
                            }

                            try {
                                await bot.sendMessage(chatId, `✅ *Pembayaran Berhasil!*\n\nPembayaran Anda terdeteksi setelah bot restart. Mengirim produk...`, { parse_mode: 'Markdown' });
                                await processTransactionFinish(chatId, productData, txSnap.quantity || 1, session.data.userInfo);
                                session.data.delivered = true;
                                session.data.deliveryState = 'SENT';
                                tgActiveReservations.delete(txSnap.reference);
                                rcLog('RECOVERY', `TG auto-delivered recovered tx ref=${txSnap.reference} chatId=${chatId}`);

                                const buyerName = (txSnap.name || txSnap.username || String(chatId));
                                rcLog('PAID', `TG | ${buyerName} | ${productData.productName} x${txSnap.quantity || 1} | Rp${(txSnap.paymentRupiah || txSnap.totalPrice || txSnap.amount || 0).toLocaleString('id-ID')} | recovered | inv=${txSnap.reference || '-'}`);
                                notifyAdmin({ type: 'paid', platform: 'telegram', buyer: buyerName, product: productData.productName, quantity: txSnap.quantity || 1, amount: txSnap.paymentRupiah || txSnap.totalPrice || txSnap.amount || 0, invoice: txSnap.reference || '-' });
                            } catch (deliveryErr) {
                                console.error(`[Recovery] TG auto-delivery failed ref=${txSnap.reference}:`, deliveryErr.message);
                                // Mark NEEDS_REVIEW inside lock
                                await withTgTxFile(tgTxs => {
                                    const t = tgTxs.find(x => x.reference === txSnap.reference);
                                    if (t) t.deliveryState = 'NEEDS_REVIEW';
                                });
                                notifyAdmin({ type: 'recovered', platform: 'telegram', buyer: txSnap.name || txSnap.username || '-', product: txSnap.productName || txSnap.product || '-', quantity: txSnap.quantity || 1, amount: txSnap.totalPrice || txSnap.amount || 0, invoice: txSnap.reference || '-' });
                            }
                        } else {
                            // Missing data for auto-delivery — notify admin for manual handling
                            notifyAdmin({ type: 'recovered', platform: 'telegram', buyer: txSnap.name || txSnap.username || '-', product: txSnap.productName || txSnap.product || '-', quantity: txSnap.quantity || 1, amount: txSnap.totalPrice || txSnap.amount || 0, invoice: txSnap.reference || '-' });
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[Recovery] Failed to recover stale TG transactions:', e);
        }

        // --- WA Transactions (uses withWaTxFile lock to prevent race) ---
        try {
            {
                // Phase 1: snapshot UNPAID txs that are stale (no lock held during API calls)
                const snapshot = loadTransactions(waTransactionsFile);
                const staleTxIds = [];
                for (const tx of snapshot) {
                    if (tx.status !== 'UNPAID') continue;
                    const txTime = tx.timestamp || 0;
                    const timeout = DEFAULT_TIMEOUT_MS;
                    if (txTime > 0 && (now - txTime) > timeout) {
                        staleTxIds.push({ id: tx.id, ref: tx.reference, provider: tx.provider, txTime });
                    }
                }

                // Phase 2: check provider API for each stale tx (no lock held)
                const apiResults = new Map(); // id -> 'PAID' | 'EXPIRED'
                for (const { id, ref, provider, txTime } of staleTxIds) {
                    const txSnap = snapshot.find(t => t.id === id);
                    if (!txSnap) continue;
                    const wasPaid = await checkProviderBeforeExpire(txSnap, 'WA');
                    apiResults.set(id, wasPaid ? 'PAID' : 'EXPIRED');
                }

                // Phase 3: apply mutations atomically under lock
                let waExpired = 0;
                let waRecovered = 0;
                if (apiResults.size > 0) {
                    await withWaTxFile(waTxs => {
                        for (const [txId, result] of apiResults) {
                            const tx = waTxs.find(t => t.id === txId && t.status === 'UNPAID');
                            if (!tx) continue; // already changed by another process
                            if (result === 'PAID') {
                                tx.status = 'PAID';
                                waRecovered++;
                                totalRecovered++;
                            } else {
                                tx.status = 'EXPIRED';
                                if (tx.reservationStatus === 'HELD') {
                                    releaseReservation(tx);
                                }
                                // Cancel on DompetX side for stale WA recovered txs
                                tgCancelDompetxIfNeeded(tx.provider, config?.dompetx?.api_key || '', tx.dompetxTxId || '', 'recovery-expired');
                                waExpired++;
                                rcLog('RECOVERY', `Expired stale WA tx ref=${tx.reference} provider=${tx.provider} age=${Math.round((now - (tx.timestamp || 0)) / 1000)}s`);
                            }
                        }
                    });
                    if (waExpired > 0 || waRecovered > 0) {
                        rcLog('RECOVERY', `WA transactions: expired ${waExpired}, recovered ${waRecovered} on startup`);
                    }
                }
                totalExpired += waExpired;
            }
        } catch (e) {
            console.error('[Recovery] Failed to recover stale WA transactions:', e);
        }

        if (totalExpired > 0 || totalRecovered > 0) {
            console.log(`[Recovery] ✅ Expired ${totalExpired}, recovered ${totalRecovered} stale transaction(s) on startup`);
        } else {
            console.log('[Recovery] No stale UNPAID transactions found.');
        }
    };

    function addEmoticonToProduct(productName) {
        const categories = {
            // Streaming Services
            'netflix': '📺',
            'disney+': '🎥',
            'hulu': '📡',
            'amazon prime video': '🎬',
            'hbo max': '🍿',
            'viu': '📽️',
            'dramawave': '🎭',
            'youtube premium': '▶️',
            'video': '🎦',

            // Music Services
            'spotify': '🎵',
            'apple music': '🎶',
            'tidal': '🎧',
            'deezer': '🎼',

            // Tools & Productivity
            'zoom': '💻',
            'canva': '🛠️',
            'grammarly': '✍️',
            'google workspace': '🌐',

            // Education
            'coursera': '📚',
            'udemy': '🧑‍🏫',
            'skillshare': '👩‍💻',
            'linkedin learning': '🎓',

            // Gaming
            'steam': '🎮',
            'playstation plus': '🕹️',
            'xbox game pass': '🏆',
            'epic games': '🌟',

            // Social Media
            'instagram': '📱',
            'twitter': '🐦',
            'facebook': '🌐',
            'tiktok': '🎥',

            // Transportation & Travel
            'uber': '🚗',
            'grab': '🚕',
            'airbnb': '✈️',
            'booking.com': '🏨',

            // Food Delivery
            'grabfood': '🍔',
            'uber eats': '🥗',
            'foodpanda': '🍜',

            // Others
            'ebay': '🛒',
            'amazon': '📦',
            'shopify': '🛍️',
            'aliexpress': '🌏',
            'session': '🔑',
            'zip': '📦'
        };

        // Periksa jika kategori ada dalam daftar; jika tidak, tambahkan centang
        const productKey = productName.toLowerCase();
        const emoticon = categories[productKey] || '✔️';
        return `${emoticon} ${productName}`;
    }

    function updateExcel(fileName, newData) {
        let workbook;
        let worksheet;
        let data = [];

        // Cek apakah file Excel sudah ada
        if (fs.existsSync(fileName)) {
            // Baca file Excel yang ada
            workbook = xlsx.readFile(fileName);
            worksheet = workbook.Sheets[workbook.SheetNames[0]];
            data = xlsx.utils.sheet_to_json(worksheet); // Ambil data yang ada di worksheet
        } else {
            // Buat workbook baru jika file belum ada
            workbook = xlsx.utils.book_new();
        }

        // Tambahkan data baru
        data.push(newData);

        // Buat worksheet baru dari data yang telah diperbarui
        worksheet = xlsx.utils.json_to_sheet(data);

        // Hapus worksheet lama dan tambahkan yang baru
        workbook.SheetNames = [];
        xlsx.utils.book_append_sheet(workbook, worksheet, "Transaksi");

        // Tulis kembali file Excel
        xlsx.writeFile(workbook, fileName);

        console.log(`File berhasil diperbarui: ${fileName}`);
    }

    function getPriceList() {
        try {
            const data = fs.readFileSync(path.join(projectRoot, 'product.json'), 'utf8');
            const products = JSON.parse(data);

            if (products.length === 0) {
                return "❌ Tidak ada produk yang tersedia saat ini.";
            }

            let priceList = "💰 *Daftar Harga Produk:*\n\n";
            products.forEach((product) => {
                priceList += `🔹 *${product.productName}*\n💵 Harga: Rp${Number(product.priceProduct).toLocaleString('id-ID')}`;
                const plTiers = Array.isArray(product.bulkDiscounts) ? product.bulkDiscounts.filter(t => t.minQty && t.price) : [];
                if (plTiers.length > 0) {
                    const sortedPlTiers = [...plTiers].sort((a, b) => Number(a.minQty) - Number(b.minQty));
                    sortedPlTiers.forEach(t => {
                        priceList += `\n  ├ ≥${t.minQty}pcs: Rp${Number(t.price).toLocaleString('id-ID')}/pcs`;
                    });
                }
                priceList += `\n\n`;
            });

            return priceList;
        } catch (error) {
            console.error("Error membaca file JSON:", error);
            return "❌ Gagal mengambil daftar harga.";
        }
    }

    // On startup, rebuild pendingPpob from any tx whose Digiflazz dispatch hasn't terminated.
    // Covers bot restart between dispatch and webhook arrival.
    try {
        const tgTxs = loadTransactions(transactionsFile);
        const horizon = Date.now() - (24 * 60 * 60 * 1000); // ignore tx older than 24h
        for (const tx of tgTxs) {
            if (tx.source !== 'digiflazz') continue;
            if (tx.deliveryState !== 'PROCESSING' && tx.digiflazz?.bucket !== 'PENDING') continue;
            if ((tx.timestamp || 0) < horizon) continue;
            if (!tx.chatId || !tx.reference) continue;
            pendingPpob.set(tx.reference, {
                chatId: tx.chatId,
                productName: tx.productName || 'PPOB',
                customerNo: tx.digiflazz?.customer_no || '',
                skuCode: tx.digiflazz?.buyer_sku_code || '',
                refId: tx.reference,
                userInfo: { id: tx.chatId, first_name: tx.name || '', username: tx.username || '' },
                msg_id: null,
                quantity: tx.quantity || 1,
                started_at: tx.digiflazz?.dispatched_at || tx.timestamp,
            });
        }
        if (pendingPpob.size > 0) console.log(`[PPOB] Recovered ${pendingPpob.size} pending Digiflazz tx into in-memory registry.`);
    } catch (e) { console.error('[PPOB] startup recovery failed:', e.message); }

    // Polling fallback for pending PPOB tx — re-calls Digiflazz with same ref_id to fetch
    // last-known state. Self-reschedules each tick so admin can change delivery_mode /
    // poll_interval_seconds live without a restart.
    //
    // Min skip-age before polling an entry: shorter of (effective interval, 90s) — so when
    // user picks "polling only" with 15s cadence, we don't wait 90s before first poll.
    const _ppobPollTick = async () => {
        const cfg = getConfig()[0] || {};
        const df = cfg.digiflazz || {};
        const interval = digiflazz.getEffectivePollIntervalMs(df);

        if (pendingPpob.size === 0 || !df.is_active || !df.username || !df.api_key) {
            setTimeout(_ppobPollTick, interval);
            return;
        }
        const minAge = Math.min(interval, 90_000);
        const now = Date.now();
        for (const [refId, entry] of pendingPpob) {
            if (now - (entry.started_at || 0) < minAge) continue;
            try {
                const skuCode = entry.skuCode || '';
                if (!skuCode) continue;
                const r = await digiflazz.checkTransactionStatus({
                    username: df.username, apiKey: df.api_key,
                    buyerSkuCode: skuCode, customerNo: entry.customerNo, refId
                });
                if (!r.ok) continue;
                const bucket = digiflazz.classifyRc(r.rc, r.status);
                if (bucket !== 'PENDING') {
                    await dfDispatcher({ refId, payload: r, bucket, eventType: 'poll' });
                }
            } catch (e) { /* swallow — poll is best-effort */ }
        }
        setTimeout(_ppobPollTick, interval);
    };
    setTimeout(_ppobPollTick, 30_000); // initial delay 30s after boot

    // Return what server.js needs (dfDispatcher wired into Express app for webhook delivery)
    return { loadMasterData, isMaster, notifyAdmin, recoverReservations, recoverTGSessions, recoverStaleTransactions, dfDispatcher };
}

export { setupTGBot };
