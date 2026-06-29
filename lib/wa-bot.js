/**
 * WhatsApp Bot Engine (Baileys)
 * Extracted from server.js — Phase 7 architecture refactor
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import fetch from 'node-fetch';
import QRCode from 'qrcode';
import moment from 'moment-timezone';
import { fileURLToPath } from 'url';
import { Server as SocketServer } from 'socket.io';
import giftedBtns from 'gifted-btns';
const { sendButtons: giftedSendButtons } = giftedBtns;

// Lib imports
import {
    transactionsFile, waTransactionsFile, waUsersFile, productFile,
    TX_TIMEOUT_MS, RESERVATION_EXPIRY_MS, POLL_INTERVAL_MS, TX_HISTORY_CAP,
    FAKE_PHONE, DEFAULT_USER_AGENT,
    writeFileAtomic,
    withTxLock, withWaTxFile, withTgTxFile,
    getWaPollerRunning, setWaPollerRunning,
    chatLog, rcLog,
    updateSalesCount, generateDeliveryFilename, rollbackStock,
} from './foundation.js';
import {
    getProducts, getConfig, setConfig, getMergedProducts,
    koalaStore, calculateBulkPrice,
} from './config.js';
import {
    loadTransactions, saveTransactionFile, loadAllTransactions, saveTgTransaction,
} from './transactions.js';
import {
    getStockPath, getStockCount, reserveStockForTx, commitReservedStock, releaseReservation,
} from './stock.js';
import {
    checkSaweriaPayment, checkPakasirPayment, createDompetxPayment, cancelDompetxPayment, checkPaymentByProvider,
} from './payments.js';
import * as digiflazz from './digiflazz.js';

// Fire-and-forget DompetX cancel — never throws, never blocks.
const waCancelDompetxIfNeeded = (provider, apiKey, dpxTxId, reason) => {
    if (provider !== 'dompetx' || !apiKey || !dpxTxId) return;
    cancelDompetxPayment(apiKey, dpxTxId).then(r => {
        rcLog('DOMPETX_CANCEL', `tx=${dpxTxId} reason=${reason} status=${r.status}${r.message ? ' msg=' + r.message : ''}`);
    }).catch(() => { /* swallow */ });
};
import { Pakasir } from 'pakasir-sdk';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// WA Global State
let waSock = null;
let waQrCode = null;
let waIsConnected = false;
let waIsConnecting = false;
let waLastError = null;
let getContentType = null;

// Helper: get WA config from configtelebot.json
const getWaConfig = () => {
    try {
        const conf = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json'), 'utf8'));
        return (Array.isArray(conf) ? conf[0] : conf).whatsapp || {};
    } catch { return {}; }
};

    // Helper: save WA users
    const saveWaUser = (jid, name) => {
        try {
            let users = JSON.parse(fs.readFileSync(waUsersFile, 'utf8'));
            const idx = users.findIndex(u => u.jid === jid);
            // Extract phone number from @s.whatsapp.net JIDs
            const phone = jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : '';
            if (idx === -1) {
                users.push({ jid, name, phone, lastSeen: Date.now() });
            } else {
                users[idx].lastSeen = Date.now();
                users[idx].name = name;
                if (phone) users[idx].phone = phone;
            }
            writeFileAtomic(waUsersFile, JSON.stringify(users, null, 2));
        } catch (e) { console.error('[WA] User tracking write failed:', e.message); }
    };

    // Helper: get WA products (same as Telegram products)
    const getWAProducts = async () => {
        try {
            return await getMergedProducts();
        } catch { return getProducts() || []; }
    };

    // getStockCount removed — use shared getStockCount from stock.js

function setupWABot(app, httpServer, deps) {
    const { notifyAdmin, recoverReservations, gopay } = deps;

    // --- WA master detection (mirrors TG's master.json model; compares phone) ---
    const masterFile = path.join(projectRoot, 'master.json');
    const _loadMasters = () => {
        try { return JSON.parse(fs.readFileSync(masterFile, 'utf8')); } catch { return []; }
    };
    const isWaMaster = (jid) => {
        const phone = jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0] : jid;
        const masters = _loadMasters();
        return masters.includes(phone) || masters.includes(String(phone));
    };

    // --- WA in-memory session map for multi-step flows (PPOB navigation) ---
    // Sessions auto-expire after 30 min inactivity to avoid leaks.
    const WA_SESSION_TTL_MS = 30 * 60 * 1000;
    const waSessions = new Map(); // jid → { state, data, _t }
    const getWaSession = (jid) => {
        if (!waSessions.has(jid)) waSessions.set(jid, { state: 'IDLE', data: {}, _t: Date.now() });
        const s = waSessions.get(jid);
        s._t = Date.now();
        return s;
    };
    setInterval(() => {
        const now = Date.now();
        for (const [jid, s] of waSessions) {
            if (s.state === 'IDLE' && (now - (s._t || 0) > WA_SESSION_TTL_MS)) waSessions.delete(jid);
        }
    }, WA_SESSION_TTL_MS);

    // --- Modules toggle helper (PPOB vs Beli Akun) ---
    const getWaModules = () => {
        const cfg = getConfig()[0] || {};
        const m = cfg.modules || {};
        const account = m.account_enabled !== false;
        const ppob = !!m.ppob_enabled;
        if (!account && !ppob) return { account: true, ppob: false };
        return { account, ppob };
    };

    // --- PPOB pending registry (refId → delivery target) for webhook-async tx ---
    const waPendingPpob = new Map();

    // Socket.IO setup for QR streaming to dashboard
    const io = new SocketServer(httpServer, { cors: { origin: '*' } });

    io.on('connection', (socket) => {
        console.log('[WA] Dashboard connected:', socket.id);
        // Send current WA status immediately to new client
        socket.emit('wa-status', { isConnected: waIsConnected, qr: waQrCode });
        socket.on('disconnect', () => console.log('[WA] Dashboard disconnected:', socket.id));
    });

    // WA Bot Message Handler

    // Helper: WA send with logging
    const waSend = async (jid, content, ...rest) => {
        const preview = content.text ? content.text.slice(0, 200)
            : content.image ? '[IMAGE] ' + (content.caption || '').slice(0, 150)
                : content.document ? '[DOCUMENT] ' + (content.fileName || '')
                    : content.delete ? '[DELETE_MSG]'
                        : '[OTHER]';
        chatLog('WA', 'OUT', jid, 'BOT', preview);
        return await waSock.sendMessage(jid, content, ...rest);
    };

    // Helper: send buttons with gifted-btns, fallback to plain text on error
    // Suppress gifted-btns "Interactive send" console.log noise (race-safe via refcount)
    let _giftedSuppressCount = 0;
    const _origConsoleLog = console.log;
    const _filteredLog = (...args) => {
        if (_giftedSuppressCount > 0 && typeof args[0] === 'string' && args[0].startsWith('Interactive send')) return;
        _origConsoleLog.apply(console, args);
    };

    const waSendButtons = async (from, payload) => {
        chatLog('WA', 'OUT', from, 'BOT', '[BUTTONS] ' + (payload.title || payload.text || '').slice(0, 150));
        try {
            _giftedSuppressCount++;
            console.log = _filteredLog;
            try {
                return await giftedSendButtons(waSock, from, { ...payload, aimode: true });
            } finally {
                _giftedSuppressCount--;
                if (_giftedSuppressCount === 0) console.log = _origConsoleLog;
            }
        } catch (e) {
            console.error('[WA] gifted-btns failed, fallback text:', e.message);
            return await waSend(from, { text: payload.text || payload.title || '' });
        }
    };

    // Post-delivery CTA — keeps the buyer in a "buy again" loop after a successful order.
    // Called after each delivery success path (local, KoalaStore, Digiflazz inline & webhook).
    const sendWaPostDeliveryCta = async (jid) => {
        try {
            const cfg = getConfig()[0] || {};
            const sName = cfg.store_name || 'WhatsApp Store';
            await waSendButtons(jid, {
                text: '🎉 Pesanan selesai. Mau lanjut order lagi?',
                footer: sName,
                buttons: [
                    { id: '1', text: '🛍️ Lihat Produk' },
                    { id: 'menu', text: '🏠 Menu Utama' },
                    { id: 'riwayat', text: '📜 Riwayat Saya' }
                ]
            });
        } catch (e) { /* best-effort CTA — never block delivery */ }
    };

    // Inline admin contact button — call after failure messages so buyer can reach support in one tap.
    // Returns nothing if no admin contact configured (graceful degrade).
    const sendWaAdminContactCta = async (jid) => {
        try {
            const cfg = getConfig()[0] || {};
            const waAdmin = cfg.admin_contact_whatsapp || '';
            const tgAdmin = cfg.admin_contact_telegram || '';
            const sName = cfg.store_name || 'WhatsApp Store';
            const buttons = [];
            if (waAdmin) buttons.push({ id: 'admin', text: '👤 Hubungi Admin' });
            buttons.push({ id: 'menu', text: '🏠 Menu Utama' });
            if (!waAdmin && !tgAdmin) return;
            await waSendButtons(jid, {
                text: `💬 Klik tombol di bawah untuk menghubungi admin.`,
                footer: sName,
                buttons
            });
        } catch (e) { /* best-effort — never block flow */ }
    };

    // WA Transaction check loop (auto-deliver on payment)
    const startWAPaymentPoller = () => {
        setInterval(async () => {
            if (!waSock || !waIsConnected) return;
            // Prevent re-entry if previous poll cycle is still running
            if (getWaPollerRunning()) return;
            setWaPollerRunning(true);
            try {
                // Snapshot for iteration only — NOT used for writes.
                // Each mutation re-reads the file via withWaTxFile to avoid overwriting concurrent changes.
                const snapshot = loadTransactions(waTransactionsFile);
                const config = getConfig()[0] || {};

                for (const snap of snapshot) {
                    if (snap.status !== 'UNPAID') continue;
                    if (snap.delivered || snap.processing) {
                        rcLog('BLOCKED', `WA poller skip tx=${snap.id} delivered=${snap.delivered} processing=${snap.processing}`);
                        continue;
                    }
                    const elapsed = Date.now() - snap.timestamp;
                    const TIMEOUT = TX_TIMEOUT_MS;

                    let isPaid = false;

                    if (elapsed > TIMEOUT) {
                        // Check provider API before expiring — user may have paid just before/during restart
                        try {
                            const timeoutResult = await checkPaymentByProvider(snap.provider, {
                                reference: snap.reference || snap.id,
                                config,
                                saweriaId: snap.saweriaId,
                                payAmount: snap.totalPrice || 0,
                                pakasirBaseAmount: snap.pakasirBaseAmount || 0,
                                dompetxTxId: snap.dompetxTxId || '',
                                createdAt: snap.timestamp || (Date.now() - TIMEOUT),
                                expiresAt: snap.gopayExpiresAt || ((snap.timestamp || Date.now()) + TIMEOUT),
                                gopayModule: gopay
                            });
                            const timeoutPaid = timeoutResult.status === 'Paid';

                            if (timeoutPaid) {
                                rcLog('RECOVERY', `WA poller: ${snap.provider} tx ${snap.id} confirmed PAID after timeout — proceeding to delivery`);
                                isPaid = true;
                                // Fall through to delivery flow below
                            } else {
                                // Genuinely expired — apply via withWaTxFile to avoid stale overwrite
                                await withWaTxFile(txs => {
                                    const fresh = txs.find(t => t.id === snap.id);
                                    if (!fresh || fresh.status !== 'UNPAID') return; // already handled
                                    fresh.status = 'EXPIRED';
                                    if (fresh.reservationStatus === 'HELD') {
                                        releaseReservation(fresh);
                                        rcLog('RELEASE', `WA tx=${fresh.id} product=${fresh.productName} reason=expired`);
                                    }
                                });
                                // Cancel on DompetX side for expired UNPAID tx
                                waCancelDompetxIfNeeded(snap.provider, config?.dompetx?.api_key || '', snap.dompetxTxId || '', 'poll-expired');
                                rcLog('EXPIRED', `WA | ${snap.jid.split('@')[0]} | ${snap.productName} x${snap.quantity || 1} | ${snap.provider} | inv=${snap.id}`);
                                const _expUserMap = (() => { try { return JSON.parse(fs.readFileSync(path.join(projectRoot, 'wa_users.json'), 'utf8')); } catch { return []; } })();
                                const _expUser = _expUserMap.find(u => u.jid === snap.jid);
                                const _expBuyer = _expUser ? (_expUser.name || _expUser.phone || snap.jid.split('@')[0]) : snap.jid.split('@')[0];
                                notifyAdmin({ type: 'expired', platform: 'whatsapp', buyer: _expBuyer, product: snap.productName, quantity: snap.quantity || 1, invoice: snap.id || '-' });
                                if (snap.msgKeys && Array.isArray(snap.msgKeys)) {
                                    for (const key of snap.msgKeys) {
                                        try { await waSend(snap.jid, { delete: key }); } catch (e) { }
                                    }
                                }
                                const expiredAt = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
                                try {
                                    await waSend(snap.jid, { text: `⏰ *PAYMENT EXPIRED*\n\nProduk: *${snap.productName}*\nRef: \`${snap.reference || snap.id}\`\nExpired pada: *${expiredAt} WIB*\n\n_Batas waktu ${Math.round(TX_TIMEOUT_MS / 60000)} menit habis. Ketik *menu* untuk order ulang._` });
                                } catch (e) { console.error(`[WA] Failed to send expiry notice to ${snap.jid}:`, e.message); }
                                continue;
                            }
                        } catch (e) {
                            console.error(`[WA] ${snap.provider} timeout check error:`, e.message);
                            // On API error, don't expire — keep UNPAID, retry next cycle
                            continue;
                        }
                    }

                    if (!isPaid) {
                        const pollResult = await checkPaymentByProvider(snap.provider, {
                            reference: snap.reference || snap.id,
                            config,
                            saweriaId: snap.saweriaId,
                            payAmount: snap.totalPrice || 0,
                            pakasirBaseAmount: snap.pakasirBaseAmount || 0,
                            createdAt: snap.timestamp || (Date.now() - TX_TIMEOUT_MS),
                            expiresAt: snap.gopayExpiresAt || ((snap.timestamp || Date.now()) + TX_TIMEOUT_MS),
                            gopayModule: gopay
                        });
                        if (pollResult.status === 'Paid') isPaid = true;
                    }

                    if (isPaid) {
                        // Use per-tx lock to prevent concurrent delivery
                        await withTxLock('wa:' + snap.id, async () => {
                            // Mark PAID via withWaTxFile — re-reads file to avoid stale overwrite
                            const tx = await withWaTxFile(txs => {
                                const fresh = txs.find(t => t.id === snap.id);
                                if (!fresh || fresh.delivered || fresh.processing) return null;
                                fresh.processing = true;
                                fresh.status = 'PAID';
                                return fresh;
                            });
                            if (!tx) {
                                rcLog('BLOCKED', `WA lock re-check blocked tx=${snap.id} (already processed)`);
                                return;
                            }
                            rcLog('PAID', `WA | ${tx.jid.split('@')[0]} | ${tx.productName} x${tx.quantity} | Rp${(tx.totalPrice || 0).toLocaleString('id-ID')} | ${tx.provider} | inv=${tx.id}`);

                            const products = await getWAProducts();
                            const product = products.find(p => p.productId === tx.productId || p.productName === tx.productName);

                            if (!product) {
                                await waSend(tx.jid, { text: `✅ Pembayaran diterima! Namun produk tidak ditemukan. Hubungi admin untuk bantuan.` });
                                await sendWaAdminContactCta(tx.jid);
                                await withWaTxFile(txs => {
                                    const f = txs.find(t => t.id === tx.id);
                                    if (f) { f.processing = false; f.deliveryState = 'NEEDS_REVIEW'; }
                                });
                                return;
                            }

                            // Deliver product
                            if (product.source === 'digiflazz') {
                                // PPOB dispatch — call Digiflazz transaction endpoint, then await SUCCESS/PENDING/FAILED
                                const cfg = getConfig()[0] || {};
                                const df = cfg.digiflazz || {};
                                const customerNo = tx.digiflazz?.customer_no || tx.customer_no || '';
                                if (!customerNo) {
                                    await waSend(tx.jid, { text: '⚠️ Pembayaran diterima tapi nomor tujuan kosong. Admin akan menindaklanjuti.' });
                                    await sendWaAdminContactCta(tx.jid);
                                    notifyAdmin({ type: 'paid', platform: 'whatsapp', buyer: tx.jid.split('@')[0], product: product.productName, quantity: tx.quantity, amount: tx.totalPrice, invoice: tx.id, extra: 'PPOB FAILED — missing customer_no' });
                                    await withWaTxFile(txs => { const f = txs.find(t => t.id === tx.id); if (f) { f.processing = false; f.deliveryState = 'NEEDS_REVIEW'; } });
                                    return;
                                }
                                if (!df.is_active || !df.username || !df.api_key) {
                                    await waSend(tx.jid, { text: '⚠️ Pembayaran diterima tapi provider PPOB belum aktif. Admin akan proses manual.' });
                                    await sendWaAdminContactCta(tx.jid);
                                    notifyAdmin({ type: 'paid', platform: 'whatsapp', buyer: tx.jid.split('@')[0], product: product.productName, quantity: tx.quantity, amount: tx.totalPrice, invoice: tx.id, extra: 'PPOB SKIPPED — Digiflazz disabled' });
                                    await withWaTxFile(txs => { const f = txs.find(t => t.id === tx.id); if (f) { f.processing = false; f.deliveryState = 'NEEDS_REVIEW'; } });
                                    return;
                                }
                                await waSend(tx.jid, { text: `🔄 *Memproses topup...*\n\n📦 ${product.productName}\n📱 \`${customerNo}\`\n🧾 Ref: \`${tx.id}\`\n\n_Memproses pengiriman..._` });

                                const dfRes = await digiflazz.createTransaction({
                                    username: df.username, apiKey: df.api_key,
                                    buyerSkuCode: product.buyer_sku_code,
                                    customerNo, refId: tx.id,
                                    maxPrice: Math.max(parseInt(tx.totalPrice) || 0, parseInt(product.df_base_price) || 0),
                                });
                                const bucket = dfRes.ok ? digiflazz.classifyRc(dfRes.rc, dfRes.status) : 'FAILED';
                                rcLog('PPOB_DISPATCH', `WA ref=${tx.id} sku=${product.buyer_sku_code} cust=${customerNo} ok=${dfRes.ok} rc=${dfRes.rc || '-'} → ${bucket}`);

                                await withWaTxFile(txs => {
                                    const f = txs.find(t => t.id === tx.id);
                                    if (!f) return;
                                    f.digiflazz = {
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
                                    if (bucket === 'SUCCESS') { f.deliveryState = 'SENT'; f.delivered = true; f.wa_revenue_counted = true; f.processing = false; }
                                    else if (bucket === 'PENDING') { f.deliveryState = 'PROCESSING'; f.processing = false; }
                                    else { f.deliveryState = 'NEEDS_REVIEW'; f.processing = false; }
                                });

                                if (bucket === 'SUCCESS') {
                                    await updateSalesCount(product.productName, tx.quantity || 1);
                                    await waSend(tx.jid, { text:
                                        `✅ *TRANSAKSI SUKSES*\n\n📦 *${product.productName}*\n📱 Tujuan: \`${customerNo}\`\n🧾 Ref: \`${tx.id}\`\n` +
                                        (dfRes.sn ? `🔐 SN: \`${dfRes.sn}\`\n` : '') +
                                        (dfRes.message ? `\n_${dfRes.message}_` : '') });
                                    rcLog('DELIVERED', `WA | ${tx.jid.split('@')[0]} | ${product.productName} x${tx.quantity} | digiflazz | inv=${tx.id}`);
                                    await sendWaPostDeliveryCta(tx.jid);
                                } else if (bucket === 'PENDING') {
                                    waPendingPpob.set(tx.id, {
                                        jid: tx.jid, productName: product.productName, customerNo,
                                        skuCode: product.buyer_sku_code, refId: tx.id,
                                        quantity: tx.quantity || 1, started_at: Date.now()
                                    });
                                    await waSend(tx.jid, { text:
                                        `⏳ *Transaksi Diproses*\n\n📦 *${product.productName}*\n📱 \`${customerNo}\`\n🧾 Ref: \`${tx.id}\`\n\n` +
                                        `Topup sedang diproses provider. SN akan dikirim otomatis (biasanya <2 menit).` });
                                } else {
                                    const errMsg = dfRes.message || dfRes.error || `rc=${dfRes.rc || 'unknown'}`;
                                    await waSend(tx.jid, { text:
                                        `⚠️ *TRANSAKSI GAGAL DI PROVIDER*\n\n📦 ${product.productName}\n📱 \`${customerNo}\`\n🧾 Ref: \`${tx.id}\`\n\nAlasan: _${errMsg}_\n\n💸 Dana akan di-refund admin. Mohon hubungi admin untuk konfirmasi refund.` });
                                    notifyAdmin({ type: 'paid', platform: 'whatsapp', buyer: tx.jid.split('@')[0], product: product.productName, quantity: tx.quantity, amount: tx.totalPrice, invoice: tx.id, extra: `PPOB FAILED rc=${dfRes.rc || '?'} msg="${errMsg}" cust=${customerNo} — REFUND REQUIRED` });
                                    await sendWaAdminContactCta(tx.jid);
                                }
                            } else if (product.source === 'koalastore') {
                                const ksApi = config.koalastore ? config.koalastore.api_key : '';
                                const ksRes = await koalaStore.checkout(ksApi, product.variant_code, tx.quantity);
                                if (ksRes.success && ksRes.data) {
                                    let detail = '';
                                    if (ksRes.data.items) {
                                        ksRes.data.items.forEach(item => {
                                            if (item.stock_data) item.stock_data.forEach(sd => { if (sd.dataStock) detail += `\`${sd.dataStock}\`\n`; });
                                        });
                                    }
                                    // Update totalProdukTerjual for KoalaStore
                                    await updateSalesCount(product.productName, tx.quantity || 1);
                                    const deliveryMsg = `✅ *PEMBAYARAN TERKONFIRMASI!*\n\nTerima kasih telah membeli *${product.productName}* (x${tx.quantity})\n🧾 Ref: \`${tx.id}\`\n\n━━━━ DETAIL AKUN ━━━━\n${detail || 'Cek dashboard reseller'}\n━━━━━━━━━━━━━━━━━━\n\n_Semoga bermanfaat! Hubungi admin jika ada kendala._`;
                                    await waSend(tx.jid, { text: deliveryMsg });

                                    // Send as .txt file for easy copy
                                    const ksRawLines = [];
                                    if (ksRes.data.items) {
                                        ksRes.data.items.forEach(item => {
                                            if (item.stock_data) item.stock_data.forEach(sd => { if (sd.dataStock) ksRawLines.push(sd.dataStock); });
                                        });
                                    }
                                    if (ksRawLines.length > 0) {
                                        const txtFilename = generateDeliveryFilename(product.productName, tx.quantity);
                                        const txtContent = `${product.productName} ${tx.quantity} item\n` + ksRawLines.join('\n');
                                        await waSend(tx.jid, { document: Buffer.from(txtContent, 'utf8'), mimetype: 'text/plain', fileName: txtFilename });
                                    }
                                    rcLog('DELIVERED', `WA | ${tx.jid.split('@')[0]} | ${product.productName} x${tx.quantity} | koalastore | inv=${tx.id}`);
                                    await withWaTxFile(txs => {
                                        const f = txs.find(t => t.id === tx.id);
                                        if (f) { f.wa_revenue_counted = true; f.delivered = true; f.deliveryState = 'SENT'; f.processing = false; }
                                    });
                                    await sendWaPostDeliveryCta(tx.jid);
                                } else {
                                    console.error('[WA] KoalaStore checkout failed:', ksRes.message);
                                    await waSend(tx.jid, { text: `✅ Pembayaran diterima! Terjadi kendala saat pengiriman dari provider.\n\nProduk: *${product.productName}*\nRef: \`${tx.id}\`\n\nHubungi admin untuk bantuan.` });
                                    await sendWaAdminContactCta(tx.jid);
                                    await withWaTxFile(txs => {
                                        const f = txs.find(t => t.id === tx.id);
                                        if (f) { f.processing = false; f.deliveryState = 'NEEDS_REVIEW'; }
                                    });
                                }
                            } else {
                                // Local stock delivery — use reserved lines from tx
                                const qty = tx.quantity || 1;
                                let deliveredLines = tx.reservedLines || [];

                                if (deliveredLines.length === 0) {
                                    // Fallback: no reservation (legacy tx without reservation fields)
                                    const reservation = await reserveStockForTx(product.productName, qty);
                                    if (!reservation.success) {
                                        await waSend(tx.jid, { text: `✅ Pembayaran diterima! Maaf stok habis, admin akan segera menghubungi Anda.` });
                                        await sendWaAdminContactCta(tx.jid);
                                        await withWaTxFile(txs => {
                                            const f = txs.find(t => t.id === tx.id);
                                            if (f) { f.processing = false; f.deliveryState = 'NEEDS_REVIEW'; }
                                        });
                                        return;
                                    }
                                    deliveredLines = reservation.reservedLines;
                                    await withWaTxFile(txs => {
                                        const f = txs.find(t => t.id === tx.id);
                                        if (f) { f.reservedLines = deliveredLines; f.reservationStatus = 'HELD'; }
                                    });
                                }

                                try {
                                    // Commit: remove reserved lines from stock file
                                    await commitReservedStock(product.productName, deliveredLines);

                                    const formatStr = product.format || 'email|password';
                                    const fieldEmojis = { email: '📧', password: '🔑', pin: '📌', profile: '👤', username: '👤', user: '👤' };
                                    let formattedOutput = '';
                                    deliveredLines.forEach((account, idx) => {
                                        if (qty > 1) formattedOutput += `\n📦 *AKUN ${idx + 1}:*\n`;
                                        if (formatStr.toLowerCase() === 'file') {
                                            formattedOutput += `${account}\n`;
                                        } else {
                                            const fields = formatStr.split('|');
                                            const values = account.split('|');
                                            formattedOutput += fields.map((field, i) => {
                                                const emoji = fieldEmojis[field.toLowerCase()] || '▫️';
                                                return `${emoji} *${field.charAt(0).toUpperCase() + field.slice(1)}:* ${values[i] || '-'}`;
                                            }).join('\n') + '\n';
                                        }
                                    });

                                    // Update sales count in product.json
                                    await updateSalesCount(product.productName, qty);

                                    const deliveryMsg = `✅ *PEMBAYARAN TERKONFIRMASI!*\n\nTerima kasih telah membeli *${product.productName}* (x${qty})\n🧾 Ref: \`${tx.id}\`\n\n━━━━ DETAIL AKUN ━━━━\n${formattedOutput}\n━━━━━━━━━━━━━━━━━━\n\n${product.usage ? `📖 *Cara Pakai:* ${product.usage}\n\n` : ''}_Semoga bermanfaat! Hubungi admin jika ada kendala._`;
                                    await waSend(tx.jid, { text: deliveryMsg });

                                    // Send as .txt file for easy copy
                                    const txtFilename = generateDeliveryFilename(product.productName, qty);
                                    const txtContent = `${product.productName} ${qty} item\n` + deliveredLines.join('\n');
                                    await waSend(tx.jid, { document: Buffer.from(txtContent, 'utf8'), mimetype: 'text/plain', fileName: txtFilename });

                                    await withWaTxFile(txs => {
                                        const f = txs.find(t => t.id === tx.id);
                                        if (f) { f.reservationStatus = 'COMMITTED'; f.wa_revenue_counted = true; f.delivered = true; f.deliveryState = 'SENT'; f.processing = false; }
                                    });
                                    rcLog('DELIVERED', `WA | ${tx.jid.split('@')[0]} | ${product.productName} x${qty} | inv=${tx.id}`);
                                    await sendWaPostDeliveryCta(tx.jid);
                                } catch (e) {
                                    console.error("[WA] Delivery failed:", e);
                                    await withWaTxFile(async txs => {
                                        const f = txs.find(t => t.id === tx.id);
                                        if (f) {
                                            if (f.reservationStatus === 'COMMITTED') await rollbackStock(product.productName, deliveredLines);
                                            f.deliveryState = 'NEEDS_REVIEW';
                                            f.processing = false;
                                        }
                                    });
                                    try {
                                        await waSend(tx.jid, { text: `✅ Pembayaran diterima! Terjadi kesalahan saat pengiriman.\n\nProduk: *${product.productName}*\nRef: \`${tx.id}\`\n\nMohon hubungi admin untuk bantuan.` });
                                        await sendWaAdminContactCta(tx.jid);
                                    } catch (me) { console.error("[WA] Failed to send error msg:", me); }
                                }
                            }

                            // Log WA transaction (with price for revenue tracking)
                            try {
                                await withTgTxFile(tele_hist => {
                                    tele_hist.push({
                                        name: tx.jid.split('@')[0],
                                        product: tx.productName,
                                        quantity: tx.quantity || 1,
                                        price: Number(tx.price) || 0,
                                        totalPrice: Number(tx.totalPrice) || 0,
                                        profit: Number(tx.profit) || 0,
                                        time: new Date().toLocaleString('id-ID'),
                                        timestamp: Date.now(),
                                        platform: 'whatsapp',
                                        status: 'PAID'
                                    });
                                    if (tele_hist.length > TX_HISTORY_CAP) tele_hist.splice(0, tele_hist.length - TX_HISTORY_CAP);
                                });
                            } catch (e) { console.error(`[WA] Transaction save failed for tx=${tx.id}:`, e.message); }

                            // Notify admin of WA paid order
                            const waUserMap = (() => { try { return JSON.parse(fs.readFileSync(path.join(projectRoot, 'wa_users.json'), 'utf8')); } catch { return []; } })();
                            const waUser = waUserMap.find(u => u.jid === tx.jid);
                            const waBuyerName = waUser ? (waUser.name || waUser.phone || tx.jid.split('@')[0]) : tx.jid.split('@')[0];
                            const waBuyerPhone = waUser && waUser.phone ? ` (${waUser.phone})` : '';
                            notifyAdmin({
                                type: 'paid', platform: 'whatsapp',
                                buyer: `${waBuyerName}${waBuyerPhone}`,
                                product: tx.productName, quantity: tx.quantity || 1,
                                amount: tx.totalPrice || tx.price || 0,
                                invoice: tx.id || tx.reference || '-'
                            });
                        }); // end withTxLock
                    }
                }
                // No final bulk save — all mutations go through withWaTxFile
            } catch (e) {
            } finally {
                setWaPollerRunning(false);
            }
        }, POLL_INTERVAL_MS);
    };

    const handleWAMessage = async (msg) => {
        if (!waSock) return;
        try {
            const rawFrom = msg.key.remoteJid;
            const type = getContentType(msg.message);
            const isGroup = rawFrom.endsWith('@g.us');
            if (isGroup) return; // Only handle DMs

            const from = rawFrom;
            const senderName = msg.pushName || 'Pelanggan';

            // Save user
            saveWaUser(from, senderName);

            // Extract body
            let body = '';
            if (type === 'conversation') body = msg.message.conversation || '';
            else if (type === 'extendedTextMessage') body = msg.message.extendedTextMessage?.text || '';
            else if (type === 'imageMessage') body = msg.message.imageMessage?.caption || '';
            else if (type === 'listResponseMessage') body = msg.message.listResponseMessage?.singleSelectReply?.selectedRowId || '';
            else if (type === 'buttonsResponseMessage') body = msg.message.buttonsResponseMessage?.selectedButtonId || '';
            else if (type === 'templateButtonReplyMessage') body = msg.message.templateButtonReplyMessage?.selectedId || '';

            else if (type === 'interactiveResponseMessage') {
                try {
                    const nativeFlowResp = msg.message.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
                    if (nativeFlowResp) {
                        const parsed = JSON.parse(nativeFlowResp);
                        body = parsed.id || '';
                    }
                } catch (e) { /* malformed interactive response JSON - ignore */ }
            }

            const cmd = body.toLowerCase().trim();
            if (!cmd) return;

            // Log incoming WA message
            chatLog('WA', 'IN', from, senderName, body);

            const waConfig = getWaConfig();
            const config = getConfig()[0] || {};

            // waSess is read by both the PPOB state machine (dispatched below, after
            // sendMenu / initiatePayment are declared, to avoid a TDZ ReferenceError) and
            // by command-router branches that redirect Digiflazz items into PPOB_CUSTOMER_NO.
            // Keeping the binding up here is harmless: getWaSession is idempotent.
            const waSess = getWaSession(from);

            // ─────── PPOB / SALDO COMMANDS ───────
            if (cmd === 'ppob' || cmd === 'pulsa' || cmd === '/ppob') {
                const mods = getWaModules();
                if (!mods.ppob) { await waSend(from, { text: '⚠️ Modul PPOB tidak aktif.' }); return; }
                const ppobProducts = (await getWAProducts()).filter(p => p && p.source === 'digiflazz' && (p.buyer_product_status !== false));
                if (ppobProducts.length === 0) { await waSend(from, { text: '⚠️ Belum ada produk PPOB. Hubungi admin.' }); return; }
                const categories = [...new Set(ppobProducts.map(p => p.category || 'Lainnya'))].sort();
                waSess.state = 'PPOB_CATEGORY';
                waSess.data.ppob = { categories };
                // Use buttons for categories (max 10, fallback to text for overflow)
                if (categories.length <= 10) {
                    const catButtons = categories.map((c, i) => ({ id: String(i + 1), text: `📲 ${c}` }));
                    catButtons.push({ id: 'batal', text: '❌ Batal' });
                    await waSendButtons(from, {
                        text: `📲 *PPOB / PULSA*\n\nPilih kategori:`,
                        footer: 'Ketik *kembali* atau *batal* untuk keluar',
                        buttons: catButtons
                    });
                } else {
                    const list = categories.map((c, i) => `*${i + 1}.* ${c}`).join('\n');
                    await waSend(from, { text: `📲 *PPOB / PULSA*\n\nPilih kategori (ketik nomor):\n\n${list}\n\nKetik *kembali* atau *batal* untuk keluar.` });
                }
                return;
            }

            if (cmd === 'saldo' || cmd === '/saldo') {
                if (!isWaMaster(from)) {
                    await waSend(from, { text: '❌ Perintah ini khusus admin.' });
                    return;
                }
                const df = config.digiflazz || {};
                if (!df.is_active || !df.username || !df.api_key) {
                    await waSend(from, { text: '⚠️ Digiflazz belum aktif / kredensial kosong.' });
                    return;
                }
                await waSend(from, { text: '🔄 Mengecek saldo Digiflazz...' });
                const r = await digiflazz.cekSaldo({ username: df.username, apiKey: df.api_key });
                if (r.ok) {
                    await waSend(from, { text: `💰 *Saldo Digiflazz*\n\n*Rp ${Number(r.deposit).toLocaleString('id-ID')}*\n\n_username: ${df.username}_` });
                } else {
                    await waSend(from, { text: `❌ Gagal cek saldo: ${r.error || 'unknown'}${r.rc ? ' (rc=' + r.rc + ')' : ''}` });
                }
                return;
            }

            const storeName = config.store_name || 'WhatsApp Store';
            const products = await getWAProducts();
            const jam = moment().tz('Asia/Jakarta').format('HH:mm');
            const tanggal = moment().tz('Asia/Jakarta').format('D MMM YYYY');
            const sep = '━━━━━━━━━━━━━━━━━━━━━';

            // ─────── SEND MENU dengan gifted-btns ───────
            const sendMenu = async () => {
                let productLines = '';
                products.slice(0, 8).forEach(p => {
                    const stok = getStockCount(p);
                    let menuPriceLabel = `Rp${Number(p.priceProduct).toLocaleString('id-ID')}`;
                    const menuTiers = Array.isArray(p.bulkDiscounts) ? p.bulkDiscounts.filter(t => t.minQty && t.price) : [];
                    if (menuTiers.length > 0) {
                        const lowestTier = [...menuTiers].sort((a, b) => a.price - b.price)[0];
                        menuPriceLabel += `~${Number(lowestTier.price).toLocaleString('id-ID')}`;
                    }
                    productLines += `\n┃ ${stok > 0 ? '🟢' : '🔴'} *${p.productName}* — ${menuPriceLabel}`;
                });

                const menuText =
                    `🏪 *${storeName.toUpperCase()}*
${sep}
👋 Halo *${senderName}*!
📅 ${tanggal} • ⏰ ${jam} WIB

🔥 *TOP PRODUK TERLARIS*
${products.slice(0, 2).map(p => `┃ ⭐ *${p.productName}*`).join('\n')}

📦 *DAFTAR PRODUK*${productLines}
${sep}
📖 *CARA PESAN:* Ketik *beli <kode> <qty>*
${sep}`;

                const menuButtons = [
                    { id: '1', text: '🛍️ LIHAT SEMUA PRODUK' },
                    { id: 'cari_produk', text: '🔍 CARI PRODUK' },
                    { id: '2', text: '📖 CARA ORDER' },
                    { id: 'stok', text: '📊 CEK STOK' },
                    { id: 'riwayat', text: '📜 RIWAYAT SAYA' },
                    { id: '3', text: '👤 HUBUNGI ADMIN' }
                ];

                await waSendButtons(from, {
                    text: menuText,
                    footer: `💡 ${storeName} — Pilih menu di bawah`,
                    buttons: menuButtons
                });
            };

            // ─────── SEND PRODUCT LIST dengan gifted-btns ───────
            const sendProductList = async () => {
                // "Beli Akun" listing — exclude PPOB-sourced items, those live behind the
                // PPOB menu so we don't double-list Telkomsel/etc here.
                const accountProducts = products.filter(p =>
                    p && p.source !== 'digiflazz' && !(p.productId || '').toLowerCase().startsWith('df_')
                );
                if (accountProducts.length === 0) {
                    await waSendButtons(from, {
                        text: '⚠️ Belum ada produk akun yang tersedia.',
                        footer: storeName,
                        buttons: [{ id: 'menu', text: '🔄 Kembali ke Menu' }]
                    });
                    return;
                }
                let prodCards = '';
                accountProducts.forEach((p, i) => {
                    const stok = getStockCount(p);
                    const kode = p.productId || p.productName.toLowerCase().replace(/\s+/g, '_');
                    let priceInfo = `💰 Harga: *Rp${Number(p.priceProduct).toLocaleString('id-ID')}*`;
                    const waTiers = Array.isArray(p.bulkDiscounts) ? p.bulkDiscounts.filter(t => t.minQty && t.price) : [];
                    if (waTiers.length > 0) {
                        const sortedWaTiers = [...waTiers].sort((a, b) => Number(a.minQty) - Number(b.minQty));
                        sortedWaTiers.forEach(t => {
                            priceInfo += `\n┃   ≥${t.minQty}pcs: *Rp${Number(t.price).toLocaleString('id-ID')}*/pcs`;
                        });
                    }
                    prodCards += `\n┃ *${i + 1}. ${p.productName}*\n┃ 🏷️ Kode: \`${kode}\`\n┃ ${priceInfo}\n┃ 📝 ${p.description || '-'}\n┃ ${stok > 0 ? `✅ Stok: ${stok}` : '❌ Habis'}\n┃`;
                });

                const prodText =
                    `┏${sep}┓
┃  📦 *KATALOG AKUN ${storeName.toUpperCase()}*
┃${prodCards}
┣${sep}┫
┃  💡 Ketik: *beli <kode> <jumlah>*
┃  _Contoh:_ \`beli netflix_1bln 1\`
┗${sep}┛`;

                // tombol beli per produk (max 5 karena limit gifted-btns)
                const buyButtons = accountProducts
                    .filter(p => getStockCount(p) > 0)
                    .slice(0, 5)
                    .map(p => ({
                        id: `pilih_jumlah ${p.productId || p.productName.toLowerCase().replace(/\s+/g, '_')}`,
                        text: `🛒 Beli ${p.productName} (Rp${Number(p.priceProduct).toLocaleString('id-ID')})`
                    }));

                if (buyButtons.length > 0) {
                    await waSendButtons(from, {
                        title: '📦 Katalog Akun',
                        text: prodText,
                        footer: '💡 Klik tombol untuk langsung beli',
                        buttons: buyButtons
                    });
                } else {
                    await waSend(from, { text: prodText });
                }
            };

            // Category picker for "Lihat Semua Produk" — mirrors the Telegram main keyboard
            // (Beli Akun / PPOB & Pulsa) when both modules are enabled. If only one module is
            // active, the picker is skipped and we go straight to that flow.
            const sendCategoryPicker = async () => {
                const mods = getWaModules();
                if (mods.account && !mods.ppob) {
                    await sendProductList();
                    return;
                }
                if (mods.ppob && !mods.account) {
                    // Mimic the existing 'ppob' command entry-point (kept intentionally inline
                    // there for the keyword path; this branch is the button equivalent).
                    const ppobProducts = (await getWAProducts()).filter(p => p && p.source === 'digiflazz' && (p.buyer_product_status !== false));
                    if (ppobProducts.length === 0) {
                        await waSend(from, { text: '⚠️ Belum ada produk PPOB. Hubungi admin.' });
                        return;
                    }
                    const categories = [...new Set(ppobProducts.map(p => p.category || 'Lainnya'))].sort();
                    waSess.state = 'PPOB_CATEGORY';
                    waSess.data.ppob = { categories };
                    if (categories.length <= 10) {
                        const catButtons = categories.map((c, i) => ({ id: String(i + 1), text: `📲 ${c}` }));
                        catButtons.push({ id: 'batal', text: '❌ Batal' });
                        await waSendButtons(from, {
                            text: `📲 *PPOB / PULSA*\n\nPilih kategori:`,
                            footer: 'Ketik *kembali* atau *batal* untuk keluar',
                            buttons: catButtons
                        });
                    } else {
                        const list = categories.map((c, i) => `*${i + 1}.* ${c}`).join('\n');
                        await waSend(from, { text: `📲 *PPOB / PULSA*\n\nPilih kategori (ketik nomor):\n\n${list}\n\nKetik *kembali* atau *batal* untuk keluar.` });
                    }
                    return;
                }
                // Both modules active → 2-tile chooser
                await waSendButtons(from, {
                    title: '🛍️ Pilih Kategori',
                    text: `🛍️ *PILIH KATEGORI*\n${sep}\nMau belanja apa hari ini?\n\n🛒 *Akun* — Netflix, Fore, KFC, dll\n📲 *PPOB & Pulsa* — Pulsa, paket data, PLN\n${sep}`,
                    footer: 'Pilih salah satu',
                    buttons: [
                        { id: 'beli_akun', text: '🛒 Beli Akun' },
                        { id: 'ppob', text: '📲 PPOB & Pulsa' },
                        { id: 'menu', text: '🔄 Menu Utama' }
                    ]
                });
            };

            // ─────── INITIATE PAYMENT ───────
            const initiatePayment = async (product, quantity = 1, opts = {}) => {
                const txId = `WAINV-${Date.now()}${crypto.randomBytes(4).toString('hex')}`;
                const waBulkCalc = calculateBulkPrice(product, quantity);
                const total = waBulkCalc.totalPrice;
                const ppobCustomerNo = opts.ppobCustomerNo || '';

                // Reserve stock BEFORE creating payment (for local products only — KS & Digiflazz are provider-side)
                let reservedLines = [];
                let reservationStatus = 'NONE';
                let reservationExpiresAt = 0;
                if (product.source !== 'koalastore' && product.source !== 'digiflazz') {
                    const reservation = await reserveStockForTx(product.productName, quantity);
                    if (!reservation.success) {
                        await waSend(from, { text: `❌ *STOK TIDAK CUKUP*\n\nProduk: *${product.productName}*\nStok tersisa: *${reservation.available}*\nDiminta: *${quantity}*\n\n_Ketik *menu* untuk melihat produk lain._` });
                        return;
                    }
                    reservedLines = reservation.reservedLines;
                    reservationStatus = 'HELD';
                    reservationExpiresAt = Date.now() + RESERVATION_EXPIRY_MS;
                }

                // Helper: attach PPOB customer_no to the WA tx after provider tx is persisted.
                // Called once at the end of each provider branch — gracefully a no-op if not PPOB.
                const _attachPpobMeta = async () => {
                    if (!ppobCustomerNo || product.source !== 'digiflazz') return;
                    try {
                        await withWaTxFile(txs => {
                            const f = txs.find(t => t.id === txId);
                            if (f) {
                                f.customer_no = ppobCustomerNo;
                                f.digiflazz = { customer_no: ppobCustomerNo, buyer_sku_code: product.buyer_sku_code };
                            }
                        });
                    } catch (e) { console.error('[PPOB] attach customer_no failed:', e.message); }
                };

                try {
                    if (config.payment_provider === 'saweria') {
                        let saweriaToken = config.saweria?.token;
                        if (!saweriaToken) throw new Error('Saweria Token belum disetting.');
                        saweriaToken = saweriaToken.replace('Bearer ', '');

                        const tokenParts = saweriaToken.split('.');
                        const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
                        const saweriaUserId = config.saweria?.user_id || payload.id;

                        const saweriaRes = await fetch(`https://backend.saweria.co/donations/snap/${saweriaUserId}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'User-Agent': DEFAULT_USER_AGENT, 'Origin': 'https://saweria.co', 'Referer': 'https://saweria.co/' },
                            body: JSON.stringify({
                                agree: true, notUnderage: true,
                                message: `WA Order ${product.productName} - ${txId}`,
                                amount: total, payment_type: 'qris', vote: '', currency: 'IDR',
                                customer_info: { first_name: senderName, email: `${from.split('@')[0]}@wa.com`, phone: '' }
                            })
                        });
                        if (!saweriaRes.ok) throw new Error('Saweria API Error: ' + saweriaRes.statusText);
                        const saweriaData = await saweriaRes.json();
                        if (!saweriaData?.data?.qr_string) throw new Error('Gagal mendapat QR Saweria');

                        const donationId = saweriaData.data.id;
                        const actualAmount = saweriaData.data.amount || total;
                        const qrBuffer = await QRCode.toBuffer(saweriaData.data.qr_string);
                        const waExpiredAt = new Date(Date.now() + TX_TIMEOUT_MS).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

                        const saweriaDiscountLine = waBulkCalc.unitPrice < (parseInt(product.priceProduct) || 0) ? ` (Diskon Grosir)` : '';
                        const paymentCaption =
                            `💳 *PEMBAYARAN QRIS*
${sep}
┃ Produk: *${product.productName}*
┃ Jumlah: *${quantity}*
┃ Harga: *Rp${waBulkCalc.unitPrice.toLocaleString('id-ID')}*/pcs${saweriaDiscountLine}
┃ Total: *Rp${actualAmount.toLocaleString('id-ID')}*
┃ Ref: \`${txId}\`
${sep}
⏳ Status: *MENUNGGU PEMBAYARAN*
⏰ Expired pada: *${waExpiredAt} WIB*

_Scan QR di atas dan bayar sesuai total._`;

                        const qrMsg = await waSend(from, { image: qrBuffer, caption: paymentCaption });

                        // Tombol cancel + cek pembayaran manual dengan gifted-btns
                        const btnMsg = await waSendButtons(from, {
                            text: `💡 Setelah membayar, klik *Cek Pembayaran*. Atau batalkan pesanan *${product.productName}*.`,
                            footer: `Ref: ${txId} — Total: Rp${actualAmount.toLocaleString('id-ID')}`,
                            buttons: [
                                { id: `check ${txId}`, text: '🔄 Cek Pembayaran' },
                                { id: `cancel ${txId}`, text: '❌ Batalkan Pesanan' }
                            ]
                        });

                        // store both msgKeys for cleanup on cancel
                        await withWaTxFile(txs => {
                            txs.push({
                                id: txId, reference: txId, jid: from, productId: product.productId, productName: product.productName,
                                price: waBulkCalc.unitPrice, quantity, totalPrice: actualAmount, profit: waBulkCalc.totalProfit, status: 'UNPAID',
                                timestamp: Date.now(), provider: 'saweria', saweriaId: donationId,
                                source: product.source || 'local', variant_code: product.variant_code || null,
                                msgKeys: [qrMsg?.key, btnMsg?.key].filter(Boolean),
                                reservedLines, reservationStatus, reservationExpiresAt,
                                processing: false, delivered: false, deliveryState: 'NONE'
                            });
                        });
                        rcLog('ORDER_NEW', `WA | ${senderName || from.split('@')[0]} | ${product.productName} x${quantity} | Rp${(actualAmount || total).toLocaleString('id-ID')} | saweria | inv=${txId}`);
                        notifyAdmin({ type: 'new', platform: 'whatsapp', buyer: senderName || from.split('@')[0], product: product.productName, quantity, amount: actualAmount || total, invoice: txId });
                        await _attachPpobMeta();

                    } else if (config.payment_provider === 'tripay') {
                        const apiKey = config.apiKey;
                        const privateKey = config.privateKey;
                        const merchantCode = config.merchant_code;
                        if (!apiKey || !privateKey) throw new Error('Tripay belum dikonfigurasi.');

                        const expiry = parseInt(Math.floor(new Date() / 1000) + (5 * 60)); // 5 minutes
                        const ref_id = txId;
                        const signature = crypto.createHmac('sha256', privateKey).update(merchantCode + ref_id + total).digest('hex');

                        const payload = {
                            method: 'QRIS', merchant_ref: ref_id, amount: total, signature,
                            customer_name: senderName, customer_email: `${from.split('@')[0]}@wa.com`, customer_phone: FAKE_PHONE,
                            order_items: [{ sku: product.productId, name: product.productName, price: waBulkCalc.unitPrice, quantity: quantity }],
                            expired_time: expiry
                        };

                        const res = await fetch('https://tripay.co.id/api/transaction/create', {
                            method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        const payment = await res.json();
                        if (!payment.success || !payment.data?.qr_url) throw new Error(payment.message || 'Tripay error');

                        const reference = payment.data.reference;
                        const qrUrl = payment.data.qr_url;
                        const qrString = payment.data.qr_string;

                        let qrBuffer;
                        if (qrString) {
                            qrBuffer = await QRCode.toBuffer(qrString);
                        } else {
                            const imgRes = await fetch(qrUrl);
                            qrBuffer = Buffer.from(await imgRes.arrayBuffer());
                        }
                        const waExpiredAt2 = new Date(Date.now() + TX_TIMEOUT_MS).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

                        const tripayDiscountLine = waBulkCalc.unitPrice < (parseInt(product.priceProduct) || 0) ? ` (Diskon Grosir)` : '';
                        const paymentCaption =
                            `💳 *PEMBAYARAN QRIS (Tripay)*
${sep}
┃ Produk: *${product.productName}*
┃ Jumlah: *${quantity}*
┃ Harga: *Rp${waBulkCalc.unitPrice.toLocaleString('id-ID')}*/pcs${tripayDiscountLine}
┃ Total: *Rp${total.toLocaleString('id-ID')}*
┃ Ref: \`${ref_id}\`
${sep}
⏳ Status: *MENUNGGU PEMBAYARAN*
⏰ Expired pada: *${waExpiredAt2} WIB*

_Scan QR di atas dan bayar sesuai total._`;

                        const qrMsg2 = await waSend(from, { image: qrBuffer, caption: paymentCaption });

                        // Tombol cancel + cek pembayaran manual dengan gifted-btns
                        const btnMsg2 = await waSendButtons(from, {
                            text: `💡 Setelah membayar, klik *Cek Pembayaran*. Atau batalkan pesanan *${product.productName}*.`,
                            footer: `Ref: ${ref_id} — Total: Rp${total.toLocaleString('id-ID')}`,
                            buttons: [
                                { id: `check ${txId}`, text: '🔄 Cek Pembayaran' },
                                { id: `cancel ${txId}`, text: '❌ Batalkan Pesanan' }
                            ]
                        });

                        await withWaTxFile(txs => {
                            txs.push({
                                id: txId, reference, jid: from, productId: product.productId, productName: product.productName,
                                price: waBulkCalc.unitPrice, quantity, totalPrice: total, profit: waBulkCalc.totalProfit, status: 'UNPAID',
                                timestamp: Date.now(), provider: 'tripay',
                                source: product.source || 'local', variant_code: product.variant_code || null,
                                msgKeys: [qrMsg2?.key, btnMsg2?.key].filter(Boolean),
                                reservedLines, reservationStatus, reservationExpiresAt,
                                processing: false, delivered: false, deliveryState: 'NONE'
                            });
                        });
                        rcLog('ORDER_NEW', `WA | ${senderName || from.split('@')[0]} | ${product.productName} x${quantity} | Rp${total.toLocaleString('id-ID')} | tripay | inv=${txId}`);
                        notifyAdmin({ type: 'new', platform: 'whatsapp', buyer: senderName || from.split('@')[0], product: product.productName, quantity, amount: total, invoice: txId });
                        await _attachPpobMeta();

                    } else if (config.payment_provider === 'pakasir') {
                        const pakasirCfg = config.pakasir || {};
                        const apiKey = pakasirCfg.api_key;
                        const projectSlug = pakasirCfg.project_slug;

                        if (!apiKey || !projectSlug) throw new Error('Pakasir belum dikonfigurasi sepenuhnya (API Key/Slug kosong).');

                        const ref_id = txId;

                        // Create Transaction via pakasir-sdk
                        const pakasir = new Pakasir({ slug: projectSlug, apikey: apiKey });
                        const pakPayment = await pakasir.createPayment('qris', ref_id, total);

                        if (!pakPayment || !pakPayment.payment_number) {
                            throw new Error('Gagal generate QRIS Pakasir (No Data)');
                        }

                        const reference = pakPayment.order_id;
                        const pakasirBaseAmount = total; // Base amount (before fees) — needed for detailPayment API
                        const actualAmount = pakPayment.total_payment || total;
                        const qrBuffer = await QRCode.toBuffer(pakPayment.payment_number);
                        const waExpiredAt3 = new Date(Date.now() + TX_TIMEOUT_MS).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

                        const pakasirDiscountLine = waBulkCalc.unitPrice < (parseInt(product.priceProduct) || 0) ? ` (Diskon Grosir)` : '';
                        const paymentCaption =
                            `💳 *PEMBAYARAN QRIS (Pakasir)*
${sep}
┃ Produk: *${product.productName}*
┃ Jumlah: *${quantity}*
┃ Harga: *Rp${waBulkCalc.unitPrice.toLocaleString('id-ID')}*/pcs${pakasirDiscountLine}
┃ Total: *Rp${actualAmount.toLocaleString('id-ID')}*
┃ Ref: \`${ref_id}\`
${sep}
⏳ Status: *MENUNGGU PEMBAYARAN*
⏰ Expired pada: *${waExpiredAt3} WIB*

_Scan QR di atas dan bayar sesuai total._`;

                        const qrMsg3 = await waSend(from, { image: qrBuffer, caption: paymentCaption });

                        const btnMsg3 = await waSendButtons(from, {
                            text: `💡 Setelah membayar, klik *Cek Pembayaran*. Atau batalkan pesanan *${product.productName}*.`,
                            footer: `Ref: ${ref_id} — Total: Rp${actualAmount.toLocaleString('id-ID')}`,
                            buttons: [
                                { id: `check ${txId}`, text: '🔄 Cek Pembayaran' },
                                { id: `cancel ${txId}`, text: '❌ Batalkan Pesanan' }
                            ]
                        });

                        await withWaTxFile(txs => {
                            txs.push({
                                id: txId, reference, jid: from, productId: product.productId, productName: product.productName,
                                price: waBulkCalc.unitPrice, quantity, totalPrice: actualAmount, profit: waBulkCalc.totalProfit, status: 'UNPAID',
                                timestamp: Date.now(), provider: 'pakasir',
                                pakasirBaseAmount,
                                source: product.source || 'local', variant_code: product.variant_code || null,
                                msgKeys: [qrMsg3?.key, btnMsg3?.key].filter(Boolean),
                                reservedLines, reservationStatus, reservationExpiresAt,
                                processing: false, delivered: false, deliveryState: 'NONE'
                            });
                        });
                        rcLog('ORDER_NEW', `WA | ${senderName || from.split('@')[0]} | ${product.productName} x${quantity} | Rp${(actualAmount || total).toLocaleString('id-ID')} | pakasir | inv=${txId}`);
                        notifyAdmin({ type: 'new', platform: 'whatsapp', buyer: senderName || from.split('@')[0], product: product.productName, quantity, amount: actualAmount || total, invoice: txId });
                        await _attachPpobMeta();

                    } else if (config.payment_provider === 'dompetx') {
                        const dpxCfg = config.dompetx || {};
                        const apiKey = dpxCfg.api_key;
                        if (!apiKey) throw new Error('DompetX belum dikonfigurasi (API Key kosong).');

                        const ref_id = txId;
                        const method = dpxCfg.method || 'QRIS';
                        const dpxPayment = await createDompetxPayment(apiKey, ref_id, total, method);
                        if (!dpxPayment || (!dpxPayment.qrcode && !dpxPayment.payment_url && !dpxPayment.va_number)) {
                            throw new Error('Gagal generate DompetX payment (No QR/URL/VA in response).');
                        }

                        const reference = ref_id;
                        const actualAmount = dpxPayment.total_payment || total;
                        const dpxBaseAmount = dpxPayment.base_amount || total;
                        let qrSource = dpxPayment.qrcode || dpxPayment.payment_url || `VA ${method}: ${dpxPayment.va_number}`;
                        const qrBuffer = await QRCode.toBuffer(qrSource);
                        const waExpiredAtDpx = new Date(Date.now() + TX_TIMEOUT_MS).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

                        const dpxDiscountLine = waBulkCalc.unitPrice < (parseInt(product.priceProduct) || 0) ? ` (Diskon Grosir)` : '';
                        const vaLine = dpxPayment.va_number ? `\n┃ VA: \`${dpxPayment.va_number}\`` : '';
                        const urlLine = dpxPayment.payment_url ? `\n┃ Link: ${dpxPayment.payment_url}` : '';
                        const paymentCaption =
                            `💳 *PEMBAYARAN ${method} (DompetX)*
${sep}
┃ Produk: *${product.productName}*
┃ Jumlah: *${quantity}*
┃ Harga: *Rp${waBulkCalc.unitPrice.toLocaleString('id-ID')}*/pcs${dpxDiscountLine}
┃ Total: *Rp${actualAmount.toLocaleString('id-ID')}*
┃ Ref: \`${ref_id}\`${vaLine}${urlLine}
${sep}
⏳ Status: *MENUNGGU PEMBAYARAN*
⏰ Expired pada: *${waExpiredAtDpx} WIB*

_Scan QR di atas atau gunakan metode pembayaran yang tersedia._`;

                        const qrMsgDpx = await waSend(from, { image: qrBuffer, caption: paymentCaption });

                        const btnMsgDpx = await waSendButtons(from, {
                            text: `💡 Setelah membayar, klik *Cek Pembayaran*. Atau batalkan pesanan *${product.productName}*.`,
                            footer: `Ref: ${ref_id} — Total: Rp${actualAmount.toLocaleString('id-ID')}`,
                            buttons: [
                                { id: `check ${txId}`, text: '🔄 Cek Pembayaran' },
                                { id: `cancel ${txId}`, text: '❌ Batalkan Pesanan' }
                            ]
                        });

                        await withWaTxFile(txs => {
                            txs.push({
                                id: txId, reference, jid: from, productId: product.productId, productName: product.productName,
                                price: waBulkCalc.unitPrice, quantity, totalPrice: actualAmount, profit: waBulkCalc.totalProfit, status: 'UNPAID',
                                timestamp: Date.now(), provider: 'dompetx',
                                dompetxTxId: dpxPayment.order_id,
                                dompetxMethod: method,
                                dompetxPaymentUrl: dpxPayment.payment_url || '',
                                dompetxVaNumber: dpxPayment.va_number || '',
                                dompetxBaseAmount: dpxBaseAmount,
                                dompetxFee: dpxPayment.dompetx_fee || 0,
                                dompetxAdditionalFee: dpxPayment.additional_fee || 0,
                                dompetxMerchantReceive: dpxPayment.merchant_receive || dpxBaseAmount,
                                source: product.source || 'local', variant_code: product.variant_code || null,
                                msgKeys: [qrMsgDpx?.key, btnMsgDpx?.key].filter(Boolean),
                                reservedLines, reservationStatus, reservationExpiresAt,
                                processing: false, delivered: false, deliveryState: 'NONE'
                            });
                        });
                        rcLog('ORDER_NEW', `WA | ${senderName || from.split('@')[0]} | ${product.productName} x${quantity} | Rp${(actualAmount || total).toLocaleString('id-ID')} | dompetx | inv=${txId}`);
                        notifyAdmin({ type: 'new', platform: 'whatsapp', buyer: senderName || from.split('@')[0], product: product.productName, quantity, amount: actualAmount || total, invoice: txId });
                        await _attachPpobMeta();

                    } else if (config.payment_provider === 'gopay') {
                        const gopayConfig = config.gopay || {};
                        if (!gopayConfig.email || !gopayConfig.password || !gopayConfig.qr_string) {
                            throw new Error('GoPay belum dikonfigurasi sepenuhnya (email/password/QR String kosong).');
                        }

                        const getPendingTxAmounts = () => {
                            try {
                                const allTx = loadAllTransactions();
                                return allTx
                                    .filter(t => t.status === 'UNPAID' && (t.provider === 'gopay' || t.paymentProvider === 'gopay'))
                                    .map(t => t.totalPrice || t.amount);
                            } catch { return []; }
                        };

                        const gopayResult = await gopay.createPayment(gopayConfig, total, getPendingTxAmounts, 5);
                        const reference = gopayResult.reference;
                        const actualAmount = gopayResult.paymentRupiah;
                        const qrBuffer = await QRCode.toBuffer(gopayResult.qrcode);
                        const waExpiredAtGopay = new Date(Date.now() + TX_TIMEOUT_MS).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });

                        const gopayDiscountLine = waBulkCalc.unitPrice < (parseInt(product.priceProduct) || 0) ? ` (Diskon Grosir)` : '';
                        const paymentCaption =
                            `💳 *PEMBAYARAN QRIS (GoPay)*
${sep}
┃ Produk: *${product.productName}*
┃ Jumlah: *${quantity}*
┃ Harga: *Rp${waBulkCalc.unitPrice.toLocaleString('id-ID')}*/pcs${gopayDiscountLine}
┃ Total: *Rp${actualAmount.toLocaleString('id-ID')}*
┃ Ref: \`${txId}\`
${sep}
⏳ Status: *MENUNGGU PEMBAYARAN*
⏰ Expired pada: *${waExpiredAtGopay} WIB*

_Scan QR di atas dan bayar sesuai total._`;

                        const qrMsgGopay = await waSend(from, { image: qrBuffer, caption: paymentCaption });

                        const btnMsgGopay = await waSendButtons(from, {
                            text: `💡 Setelah membayar, klik *Cek Pembayaran*. Atau batalkan pesanan *${product.productName}*.`,
                            footer: `Ref: ${txId} — Total: Rp${actualAmount.toLocaleString('id-ID')}`,
                            buttons: [
                                { id: `check ${txId}`, text: '🔄 Cek Pembayaran' },
                                { id: `cancel ${txId}`, text: '❌ Batalkan Pesanan' }
                            ]
                        });

                        await withWaTxFile(txs => {
                            txs.push({
                                id: txId, reference, jid: from, productId: product.productId, productName: product.productName,
                                price: waBulkCalc.unitPrice, quantity, totalPrice: actualAmount, profit: waBulkCalc.totalProfit, status: 'UNPAID',
                                timestamp: Date.now(), provider: 'gopay', gopayExpiresAt: Date.now() + TX_TIMEOUT_MS,
                                source: product.source || 'local', variant_code: product.variant_code || null,
                                msgKeys: [qrMsgGopay?.key, btnMsgGopay?.key].filter(Boolean),
                                reservedLines, reservationStatus, reservationExpiresAt,
                                processing: false, delivered: false, deliveryState: 'NONE'
                            });
                        });
                        rcLog('ORDER_NEW', `WA | ${senderName || from.split('@')[0]} | ${product.productName} x${quantity} | Rp${(actualAmount || total).toLocaleString('id-ID')} | gopay | inv=${txId}`);
                        notifyAdmin({ type: 'new', platform: 'whatsapp', buyer: senderName || from.split('@')[0], product: product.productName, quantity, amount: actualAmount || total, invoice: txId });
                        await _attachPpobMeta();

                    } else {
                        await waSend(from, { text: `❌ Payment provider belum dikonfigurasi. Hubungi admin.` });
                    }
                } catch (err) {
                    console.error('[WA] Payment Error:', err.message);
                    // Release reservation if payment creation failed
                    if (reservationStatus === 'HELD' && reservedLines.length > 0) {
                        reservationStatus = 'RELEASED';
                        reservedLines = [];
                        rcLog('RELEASE', `WA product=${product.productName} reason=payment-creation-failed`);
                    }
                    console.error('[WA] QR creation failed for', product.productName, '-', err.message);
                    await waSend(from, { text: `❌ Gagal membuat QR pembayaran. Silakan coba lagi atau hubungi admin.` });
                }
            };

            // ─────── PPOB STATE MACHINE (priority over generic dispatch) ───────
            // Sits BELOW sendMenu / initiatePayment because both are referenced from
            // its branches (back-to-menu, confirm-pay). Keeping it above would re-introduce
            // the TDZ ReferenceError that previously masked itself behind unreachable paths.
            const ppobState = waSess.state;
            if (ppobState && ppobState.startsWith('PPOB_')) {
                if (cmd === 'batal' || cmd === 'cancel' || cmd === 'menu') {
                    waSess.state = 'IDLE';
                    waSess.data.ppob = null;
                    await waSend(from, { text: '❌ PPOB dibatalkan. Ketik *menu* untuk lihat opsi lain.' });
                    return;
                }

                // Back navigation per step
                if (cmd === 'kembali' || cmd === 'back') {
                    if (ppobState === 'PPOB_CATEGORY') {
                        // Back from category = exit PPOB
                        waSess.state = 'IDLE';
                        waSess.data.ppob = null;
                        await sendMenu();
                        return;
                    }
                    if (ppobState === 'PPOB_BRAND') {
                        // Back to category list
                        const ppobProducts = (await getWAProducts()).filter(p => p && p.source === 'digiflazz' && (p.buyer_product_status !== false));
                        const categories = [...new Set(ppobProducts.map(p => p.category || 'Lainnya'))].sort();
                        waSess.state = 'PPOB_CATEGORY';
                        waSess.data.ppob = { categories };
                        if (categories.length <= 10) {
                            const catButtons = categories.map((c, i) => ({ id: String(i + 1), text: `📲 ${c}` }));
                            catButtons.push({ id: 'batal', text: '❌ Batal' });
                            await waSendButtons(from, {
                                text: `📲 *PPOB / PULSA*\n\nPilih kategori:`,
                                footer: 'Ketik *kembali* atau *batal* untuk keluar',
                                buttons: catButtons
                            });
                        } else {
                            const list = categories.map((c, i) => `*${i + 1}.* ${c}`).join('\n');
                            await waSend(from, { text: `📲 *PPOB / PULSA*\n\nPilih kategori (ketik nomor):\n\n${list}\n\nKetik *kembali* atau *batal* untuk keluar.` });
                        }
                        return;
                    }
                    if (ppobState === 'PPOB_SKU') {
                        // Back to brand list
                        const { category } = waSess.data.ppob || {};
                        const ppobItems = (await getWAProducts()).filter(p => p && p.source === 'digiflazz' && (p.category || 'Lainnya') === category && (p.buyer_product_status !== false));
                        const brands = [...new Set(ppobItems.map(p => p.brand || '-'))].sort();
                        waSess.state = 'PPOB_BRAND';
                        waSess.data.ppob = { ...(waSess.data.ppob || {}), brands };
                        if (brands.length <= 10) {
                            const brandButtons = brands.map((b, i) => ({ id: String(i + 1), text: `🏷️ ${b}` }));
                            brandButtons.push({ id: 'kembali', text: '🔙 Kembali' });
                            await waSendButtons(from, {
                                text: `📲 *${category}*\n\nPilih brand:`,
                                footer: 'Ketik *kembali* atau *batal* untuk keluar',
                                buttons: brandButtons
                            });
                        } else {
                            const list = brands.map((b, i) => `*${i + 1}.* ${b}`).join('\n');
                            await waSend(from, { text: `📲 *${category}*\n\nPilih brand (ketik nomor):\n\n${list}\n\nKetik *kembali* atau *batal* untuk keluar.` });
                        }
                        return;
                    }
                    if (ppobState === 'PPOB_CUSTOMER_NO') {
                        // Back to SKU list
                        const { category, brand } = waSess.data.ppob || {};
                        const skus = (await getWAProducts())
                            .filter(p => p && p.source === 'digiflazz' && (p.category || 'Lainnya') === category && (p.brand || '-') === brand && (p.buyer_product_status !== false))
                            .sort((a, b) => (a.priceProduct || 0) - (b.priceProduct || 0));
                        waSess.state = 'PPOB_SKU';
                        waSess.data.ppob = { ...waSess.data.ppob, skus };
                        const list = skus.slice(0, 30).map((p, i) => {
                            const stok = p.unlimited_stock ? '∞' : (p.stockCount || 0);
                            const harga = (p.priceProduct || 0).toLocaleString('id-ID');
                            return `*${i + 1}.* ${p.productName} — Rp${harga} _(${stok})_`;
                        }).join('\n');
                        await waSend(from, { text: `📲 *${category} — ${brand}*\n\nKetik nomor produk:\n\n${list}\n\nKetik *kembali* atau *batal* untuk keluar.` });
                        return;
                    }
                    if (ppobState === 'PPOB_PLN_CONFIRM' || ppobState === 'PPOB_CONFIRM') {
                        // Back to customer_no input
                        waSess.state = 'PPOB_CUSTOMER_NO';
                        const product = waSess.data.ppob?.product;
                        const harga = (product?.priceProduct || 0).toLocaleString('id-ID');
                        await waSend(from, { text:
                            `✅ *${product?.productName || ''}*\nHarga: *Rp${harga}*\n\n` +
                            `📝 Ketik ulang *nomor tujuan* (HP/ID PLN/ID game).\n\nKetik *kembali* atau *batal* untuk keluar.` });
                        return;
                    }
                    // Fallback: treat as cancel
                    waSess.state = 'IDLE';
                    waSess.data.ppob = null;
                    await sendMenu();
                    return;
                }

                // PPOB_CATEGORY: user picks a category
                if (ppobState === 'PPOB_CATEGORY') {
                    const cats = waSess.data.ppob?.categories || [];
                    const pickIdx = parseInt(cmd) - 1;
                    const picked = (pickIdx >= 0 && pickIdx < cats.length) ? cats[pickIdx] : cats.find(c => c.toLowerCase() === cmd);
                    if (!picked) {
                        await waSend(from, { text: '⚠️ Ketik nomor kategori dari daftar di atas (atau *kembali* / *batal*).' });
                        return;
                    }
                    const ppobItems = (await getWAProducts()).filter(p => p && p.source === 'digiflazz' && (p.category || 'Lainnya') === picked && (p.buyer_product_status !== false));
                    const brands = [...new Set(ppobItems.map(p => p.brand || '-'))].sort();
                    waSess.state = 'PPOB_BRAND';
                    waSess.data.ppob = { ...(waSess.data.ppob || {}), category: picked, brands };
                    // Use buttons for brands (max 10, fallback to text)
                    if (brands.length <= 10) {
                        const brandButtons = brands.map((b, i) => ({ id: String(i + 1), text: `🏷️ ${b}` }));
                        brandButtons.push({ id: 'kembali', text: '🔙 Kembali' });
                        await waSendButtons(from, {
                            text: `📲 *${picked}*\n\nPilih brand:`,
                            footer: 'Ketik *kembali* atau *batal* untuk keluar',
                            buttons: brandButtons
                        });
                    } else {
                        const list = brands.map((b, i) => `*${i + 1}.* ${b}`).join('\n');
                        await waSend(from, { text: `📲 *${picked}*\n\nPilih brand (ketik nomor):\n\n${list}\n\nKetik *kembali* atau *batal* untuk keluar.` });
                    }
                    return;
                }

                if (ppobState === 'PPOB_BRAND') {
                    const brands = waSess.data.ppob?.brands || [];
                    const pickIdx = parseInt(cmd) - 1;
                    const picked = (pickIdx >= 0 && pickIdx < brands.length) ? brands[pickIdx] : brands.find(b => b.toLowerCase() === cmd);
                    if (!picked) {
                        await waSend(from, { text: '⚠️ Ketik nomor brand dari daftar (atau *kembali* / *batal*).' });
                        return;
                    }
                    const { category } = waSess.data.ppob;
                    const skus = (await getWAProducts())
                        .filter(p => p && p.source === 'digiflazz' && (p.category || 'Lainnya') === category && (p.brand || '-') === picked && (p.buyer_product_status !== false))
                        .sort((a, b) => (a.priceProduct || 0) - (b.priceProduct || 0));
                    waSess.state = 'PPOB_SKU';
                    waSess.data.ppob = { ...waSess.data.ppob, brand: picked, skus };
                    if (skus.length === 0) {
                        await waSend(from, { text: '⚠️ Tidak ada SKU untuk brand ini. Ketik *kembali* atau *batal*.' });
                        return;
                    }
                    const list = skus.slice(0, 30).map((p, i) => {
                        const stok = p.unlimited_stock ? '∞' : (p.stockCount || 0);
                        const harga = (p.priceProduct || 0).toLocaleString('id-ID');
                        return `*${i + 1}.* ${p.productName} — Rp${harga} _(${stok})_`;
                    }).join('\n');
                    await waSend(from, { text: `📲 *${category} — ${picked}*\n\nKetik nomor produk:\n\n${list}\n\nKetik *kembali* atau *batal* untuk keluar.` });
                    return;
                }

                if (ppobState === 'PPOB_SKU') {
                    const skus = waSess.data.ppob?.skus || [];
                    const idx = parseInt(cmd) - 1;
                    if (isNaN(idx) || idx < 0 || idx >= skus.length) {
                        await waSend(from, { text: '⚠️ Ketik nomor produk dari daftar (atau *kembali* / *batal*).' });
                        return;
                    }
                    const product = skus[idx];
                    waSess.state = 'PPOB_CUSTOMER_NO';
                    waSess.data.ppob = { ...waSess.data.ppob, product };
                    const harga = (product.priceProduct || 0).toLocaleString('id-ID');
                    await waSend(from, { text:
                        `✅ *${product.productName}*\nHarga: *Rp${harga}*\nSKU: \`${product.buyer_sku_code}\`\n\n` +
                        `📝 Ketik *nomor tujuan* (HP/ID PLN/ID game). Contoh: \`081234567890\`.\n\nKetik *kembali* atau *batal* untuk keluar.` });
                    return;
                }

                if (ppobState === 'PPOB_CUSTOMER_NO') {
                    const customerNo = cmd.replace(/\s+/g, '');
                    if (!/^[0-9.]{4,20}$/.test(customerNo)) {
                        await waSend(from, { text: '⚠️ Nomor tujuan harus 4–20 digit angka. Coba lagi, atau ketik *kembali* / *batal*.' });
                        return;
                    }
                    const product = waSess.data.ppob?.product;
                    if (!product) { waSess.state = 'IDLE'; await waSend(from, { text: '⚠️ Sesi PPOB tidak valid. Ketik *menu*.' }); return; }
                    waSess.data.ppob.customer_no = customerNo;

                    // PLN prabayar — inquiry first (verify nama/meter) before payment
                    const isPln = (product.brand || '').toUpperCase() === 'PLN';
                    if (isPln) {
                        const df = config.digiflazz || {};
                        await waSend(from, { text: '🔄 *Cek data PLN...*\n\nMemverifikasi ID Pelanggan...' });
                        const inq = await digiflazz.inquiryPln({ username: df.username, apiKey: df.api_key, customerNo });
                        rcLog('PPOB_INQUIRY_PLN', `WA cust=${customerNo} ok=${inq.ok} rc=${inq.rc || '-'} name=${inq.name || '-'}`);
                        if (!inq.ok) {
                            const errMsg = inq.message || inq.error || `rc=${inq.rc || 'unknown'}`;
                            await waSend(from, { text: `❌ *Cek PLN Gagal*\n\nID Pelanggan: \`${customerNo}\`\nAlasan: _${errMsg}_\n\nKetik ulang ID Pelanggan atau *batal* untuk keluar.` });
                            return; // stay on PPOB_CUSTOMER_NO
                        }
                        waSess.state = 'PPOB_PLN_CONFIRM';
                        waSess.data.ppob.pln_inquiry = inq;
                        const harga = (product.priceProduct || 0).toLocaleString('id-ID');
                        const detail =
                            `✅ *Konfirmasi Pembayaran PLN*\n\n` +
                            `📦 Produk: *${product.productName}*\n` +
                            `💰 Harga: *Rp${harga}*\n\n` +
                            `━━━━━━━━━━━━━━━\n` +
                            `📱 ID Pelanggan: \`${inq.customer_no}\`\n` +
                            (inq.name ? `🏠 Nama: *${inq.name}*\n` : '') +
                            (inq.meter_no ? `🔌 No. Meter: \`${inq.meter_no}\`\n` : '') +
                            (inq.subscriber_id ? `🆔 Subscriber ID: \`${inq.subscriber_id}\`\n` : '') +
                            (inq.segment_power ? `⚡ Segmen/Daya: *${inq.segment_power}*\n` : '') +
                            `━━━━━━━━━━━━━━━`;
                        await waSendButtons(from, {
                            text: detail,
                            footer: 'Tekan tombol untuk lanjut bayar atau batal',
                            buttons: [
                                { id: 'ya', text: '✅ Ya, Bayar' },
                                { id: 'batal', text: '❌ Batal' }
                            ]
                        });
                        return;
                    }

                    // Non-PLN — show confirmation before payment
                    waSess.state = 'PPOB_CONFIRM';
                    waSess.data.ppob.customer_no = customerNo;
                    const hargaConfirm = (product.priceProduct || 0).toLocaleString('id-ID');
                    await waSendButtons(from, {
                        text:
                            `📋 *Konfirmasi Pembayaran*\n\n` +
                            `📦 Produk: *${product.productName}*\n` +
                            `💰 Harga: *Rp${hargaConfirm}*\n` +
                            `📱 Tujuan: \`${customerNo}\`\n` +
                            `🧾 SKU: \`${product.buyer_sku_code}\`\n\n` +
                            `Pastikan data di atas sudah *benar*.`,
                        footer: 'Tekan tombol untuk lanjut bayar atau batal',
                        buttons: [
                            { id: 'ya', text: '✅ Ya, Bayar' },
                            { id: 'kembali', text: '🔙 Ganti Nomor' },
                            { id: 'batal', text: '❌ Batal' }
                        ]
                    });
                    return;
                }

                if (ppobState === 'PPOB_PLN_CONFIRM') {
                    if (cmd === 'ya' || cmd === 'lanjut' || cmd === 'ok' || cmd === 'y') {
                        const product = waSess.data.ppob?.product;
                        const customerNo = waSess.data.ppob?.customer_no;
                        if (!product || !customerNo) { waSess.state = 'IDLE'; await waSend(from, { text: '⚠️ Sesi PPOB tidak valid. Ketik *menu*.' }); return; }
                        waSess.state = 'IDLE';
                        await initiatePayment(product, 1, { ppobCustomerNo: customerNo });
                        return;
                    }
                    await waSendButtons(from, {
                        text: '⚠️ Tekan tombol *Ya, Bayar* untuk lanjut atau *Batal* untuk keluar.',
                        buttons: [
                            { id: 'ya', text: '✅ Ya, Bayar' },
                            { id: 'batal', text: '❌ Batal' }
                        ]
                    });
                    return;
                }

                if (ppobState === 'PPOB_CONFIRM') {
                    if (cmd === 'ya' || cmd === 'lanjut' || cmd === 'ok' || cmd === 'y') {
                        const product = waSess.data.ppob?.product;
                        const customerNo = waSess.data.ppob?.customer_no;
                        if (!product || !customerNo) { waSess.state = 'IDLE'; await waSend(from, { text: '⚠️ Sesi PPOB tidak valid. Ketik *menu*.' }); return; }
                        waSess.state = 'IDLE';
                        await initiatePayment(product, 1, { ppobCustomerNo: customerNo });
                        return;
                    }
                    if (cmd === 'kembali' || cmd === 'back') {
                        waSess.state = 'PPOB_CUSTOMER_NO';
                        const product = waSess.data.ppob?.product;
                        const harga = (product?.priceProduct || 0).toLocaleString('id-ID');
                        await waSend(from, { text:
                            `✅ *${product?.productName || ''}*\nHarga: *Rp${harga}*\n\n` +
                            `📝 Ketik ulang *nomor tujuan* (HP/ID PLN/ID game).\n\nKetik *batal* untuk keluar.` });
                        return;
                    }
                    await waSendButtons(from, {
                        text: '⚠️ Tekan tombol untuk melanjutkan.',
                        buttons: [
                            { id: 'ya', text: '✅ Ya, Bayar' },
                            { id: 'kembali', text: '🔙 Ganti Nomor' },
                            { id: 'batal', text: '❌ Batal' }
                        ]
                    });
                    return;
                }
            }

            // ─────── COMMAND ROUTER dengan gifted-btns ───────
            const greetings = ['p', 'halo', 'menu', 'hi', 'hai', 'bot', 'start', 'help', '.menu', '#menu', 'mulai'];
            if (greetings.includes(cmd)) {
                await sendMenu();
            } else if (cmd === 'list' || cmd === '.list' || cmd === '#produk' || cmd === 'lihat' || cmd === '1') {
                // Show category picker (Akun / PPOB) when both modules active.
                // sendCategoryPicker auto-shortcuts to the right flow when only one is enabled.
                await sendCategoryPicker();
            } else if (cmd === 'beli_akun' || cmd === 'akun') {
                // Direct entry to account catalog (button id from sendCategoryPicker, or typed alias).
                await sendProductList();
            } else if (cmd === 'stok' || cmd === 'stock' || cmd === 'cek stok') {
                let stockMsg = `📦 *STATUS STOK PRODUK*\n${sep}\n`;
                products.forEach(p => {
                    const stok = getStockCount(p);
                    stockMsg += `${stok > 0 ? '🟢' : '🔴'} *${p.productName}* — ${stok} Unit\n`;
                });
                stockMsg += `\n${sep}\n💡 Ketik *beli <kode> <qty>* untuk memesan.`;
                await waSendButtons(from, {
                    text: stockMsg,
                    footer: storeName,
                    buttons: [{ id: '1', text: '🛍️ Lihat Produk' }, { id: 'menu', text: '🔄 Kembali ke Menu' }]
                });
            } else if (cmd === 'riwayat' || cmd === 'history') {
                // Per-buyer history only — never expose other buyers' transactions
                let waHist = [];
                try { waHist = loadTransactions(waTransactionsFile); } catch { }
                const myHist = waHist.filter(tx => tx.jid === from);
                let text = `📜 *RIWAYAT TRANSAKSI ANDA*\n${sep}\n`;
                if (myHist.length === 0) {
                    text += '_Belum ada transaksi._\n\nKetik *menu* untuk mulai berbelanja.';
                } else {
                    myHist.sort((a, b) => b.timestamp - a.timestamp).slice(0, 10).forEach(tx => {
                        const statusIcon = tx.status === 'PAID' || tx.delivered ? '✅'
                            : tx.status === 'CANCELLED' ? '❌'
                            : tx.status === 'EXPIRED' ? '⏰'
                            : '⏳';
                        const when = tx.timestamp ? new Date(tx.timestamp).toLocaleString('id-ID', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '-';
                        const totalLabel = tx.totalPrice ? ` — Rp${Number(tx.totalPrice).toLocaleString('id-ID')}` : '';
                        text += `${statusIcon} *${tx.productName || '-'}* (x${tx.quantity || 1})${totalLabel}\n└ ${when} • Ref: \`${tx.id || '-'}\`\n\n`;
                    });
                }
                await waSendButtons(from, {
                    text,
                    footer: storeName,
                    buttons: [{ id: 'menu', text: '🏠 Menu Utama' }, { id: '1', text: '🛍️ Lihat Produk' }]
                });
            } else if (cmd === 'cari_produk') {
                await waSendButtons(from, {
                    text: `🔍 *CARI PRODUK*\n\nKetik nama produk yang dicari:\n*cari <nama>*\n\nContoh:\n\`cari netflix\`\n\`cari spotify\`\n\`cari 1 bulan\``,
                    footer: storeName,
                    buttons: [{ id: '1', text: '📦 Lihat Semua' }, { id: 'menu', text: '🔄 Menu' }]
                });
            } else if (cmd.startsWith('cari ')) {
                const query = cmd.replace('cari ', '').trim();
                const filtered = products.filter(p =>
                    p.productName.toLowerCase().includes(query) ||
                    (p.productId || '').toLowerCase().includes(query)
                );
                if (filtered.length === 0) {
                    await waSendButtons(from, {
                        text: `❌ Produk dengan kata kunci *"${query}"* tidak ditemukan.`,
                        footer: storeName,
                        buttons: [{ id: '1', text: '📦 Lihat Semua Produk' }, { id: 'menu', text: '🔄 Menu' }]
                    });
                } else {
                    let prodCards = '';
                    filtered.forEach((p, i) => {
                        const stok = getStockCount(p);
                        let searchPriceInfo = `🏷️ Rp${Number(p.priceProduct).toLocaleString('id-ID')}`;
                        const searchTiers = Array.isArray(p.bulkDiscounts) ? p.bulkDiscounts.filter(t => t.minQty && t.price) : [];
                        if (searchTiers.length > 0) {
                            const sortedSearchTiers = [...searchTiers].sort((a, b) => Number(a.minQty) - Number(b.minQty));
                            searchPriceInfo += ` (Grosir: ${sortedSearchTiers.map(t => `≥${t.minQty}=Rp${Number(t.price).toLocaleString('id-ID')}`).join(', ')})`;
                        }
                        prodCards += `\n┃ *${p.productName}*\n┃ ${searchPriceInfo} • ${stok > 0 ? `✅ ${stok}` : '❌ Habis'}\n┃`;
                    });
                    await waSendButtons(from, {
                        title: `🔍 Hasil: "${query}"`,
                        text: `┏${sep}┓\n┃ 🔎 *HASIL PENCARIAN: "${query.toUpperCase()}"*\n┃${prodCards}\n┗${sep}┛`,
                        footer: '💡 Pilih produk untuk beli',
                        buttons: filtered.filter(p => getStockCount(p) > 0).slice(0, 5).map(p => ({
                            id: `pilih_jumlah ${p.productId || p.productName.toLowerCase().replace(/\s+/g, '_')}`,
                            text: `🛒 Beli ${p.productName}`
                        }))
                    });
                }
            } else if (cmd.startsWith('pilih_jumlah ')) {
                // Quantity selector per produk dengan tombol 1-5
                const kode = cmd.replace('pilih_jumlah ', '').trim();
                // Case-insensitive match on productId — Digiflazz SKUs (df_BGTSEL5K) are uppercase
                // but `cmd` is lowercased by the router, so a strict === miss leaves the user
                // staring at silence. Compare both sides lowercased.
                const product = products.find(p =>
                    (p.productId || '').toLowerCase() === kode ||
                    p.productName.toLowerCase().replace(/\s+/g, '_') === kode
                );
                if (!product) {
                    await waSendButtons(from, {
                        text: `❌ Produk dengan kode \`${kode}\` tidak ditemukan atau sudah tidak tersedia.`,
                        footer: storeName,
                        buttons: [{ id: '1', text: '📦 Lihat Semua Produk' }, { id: 'menu', text: '🔄 Menu' }]
                    });
                    return;
                }
                // Digiflazz PPOB → qty fixed at 1, but we MUST collect customer_no first.
                // Hand off to the PPOB state machine instead of going straight to payment.
                if (product.source === 'digiflazz' || (product.productId || '').toLowerCase().startsWith('df_')) {
                    waSess.state = 'PPOB_CUSTOMER_NO';
                    waSess.data.ppob = { ...(waSess.data.ppob || {}), product };
                    const hargaPpob = (product.priceProduct || 0).toLocaleString('id-ID');
                    await waSend(from, { text:
                        `✅ *${product.productName}*\nHarga: *Rp${hargaPpob}*\nSKU: \`${product.buyer_sku_code}\`\n\n` +
                        `📝 Ketik *nomor tujuan* (HP/ID PLN/ID game). Contoh: \`081234567890\`.\n\nKetik *batal* untuk keluar.` });
                    return;
                }
                const stok = getStockCount(product);
                const kodeId = product.productId || product.productName.toLowerCase().replace(/\s+/g, '_');
                const qtyOptions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 50, 100].filter(n => n <= stok);
                const qtyButtons = qtyOptions.map(n => {
                    const bc = calculateBulkPrice(product, n);
                    return { id: `beli ${kodeId} ${n}`, text: `${n} Pcs — Rp${bc.totalPrice.toLocaleString('id-ID')}` };
                });
                let qtyText = `Berapa banyak *${product.productName}* yang ingin Anda beli?\n\n💰 Harga: *Rp${Number(product.priceProduct).toLocaleString('id-ID')}*/pcs\n📦 Stok tersedia: *${stok}*`;
                const pjTiers = Array.isArray(product.bulkDiscounts) ? product.bulkDiscounts.filter(t => t.minQty && t.price) : [];
                if (pjTiers.length > 0) {
                    qtyText += `\n\n💰 *Diskon Grosir:*`;
                    [...pjTiers].sort((a, b) => Number(a.minQty) - Number(b.minQty)).forEach(t => {
                        qtyText += `\n├ ≥${t.minQty}pcs → Rp${Number(t.price).toLocaleString('id-ID')}/pcs`;
                    });
                }
                await waSendButtons(from, {
                    title: '📦 Pilih Jumlah',
                    text: qtyText,
                    footer: '💡 Pilih jumlah order',
                    buttons: qtyButtons
                });
            } else if (cmd === 'cara' || cmd === '2' || cmd === 'cara beli' || cmd === 'order') {
                await waSendButtons(from, {
                    text: `📖 *CARA ORDER*\n\n1️⃣ Ketik *menu* → Tampilkan produk\n2️⃣ Klik tombol *🛍️ Lihat Produk* atau ketik *list*\n3️⃣ Klik tombol *🛒 Beli* pada produk\n4️⃣ Pilih jumlah yang diinginkan\n5️⃣ Scan QR yang muncul & bayar\n6️⃣ Bot kirim akun otomatis! 🎉\n\n_Atau ketik langsung: beli <kode> <qty>_`,
                    footer: storeName,
                    buttons: [{ id: '1', text: '🛍️ Lihat Produk' }, { id: 'menu', text: '🔄 Menu Utama' }]
                });
            } else if (cmd === 'admin' || cmd === '3' || cmd === 'hub admin' || cmd === 'kontak') {
                const waAdmin = config.admin_contact_whatsapp || '';
                const tgAdmin = config.admin_contact_telegram || '';
                const waOpHours = config.operating_hours || '';
                let adminText = `👤 *HUBUNGI ADMIN*\n\nButuh bantuan atau ada pertanyaan?\nKami siap membantu kamu!\n`;
                adminText += `\n🏪 *Store:* ${storeName}`;
                if (waAdmin) adminText += `\n📞 *WhatsApp:* https://wa.me/${waAdmin}`;
                if (tgAdmin) adminText += `\n📱 *Telegram:* https://t.me/${tgAdmin}`;
                if (!waAdmin && !tgAdmin) adminText += `\n\n_Admin belum tersedia_`;
                adminText += `\n\n━━━━━━━━━━━━━━━━━━━━`;
                if (waOpHours) adminText += `\n⏰ *Jam Operasional:* ${waOpHours}`;
                adminText += `\n💬 Respon dalam 1x24 jam`;
                adminText += `\n━━━━━━━━━━━━━━━━━━━━`;
                if (waAdmin || tgAdmin) adminText += `\n\nKlik link di atas untuk langsung chat. ✨`;
                await waSendButtons(from, {
                    text: adminText,
                    footer: storeName,
                    buttons: [{ id: 'menu', text: '🔄 Kembali ke Menu' }]
                });
            } else if (cmd.startsWith('beli ')) {
                const parts = cmd.split(' ');
                const code = parts[1];
                const qty = parseInt(parts[2]) || 1;
                // Case-insensitive productId match — Digiflazz SKUs ship in uppercase
                // (df_BGTSEL5K) but `cmd` is lowercased before reaching this router.
                const product = products.find(p =>
                    (p.productId || '').toLowerCase() === code ||
                    p.productName.toLowerCase().replace(/\s+/g, '_') === code ||
                    p.productName.toLowerCase() === code
                );
                if (!product) {
                    await waSendButtons(from, {
                        text: `❌ Produk dengan kode *${code}* tidak ditemukan.`,
                        footer: storeName,
                        buttons: [{ id: '1', text: '📦 Lihat Semua Produk' }, { id: 'cari_produk', text: '🔍 Cari Produk' }]
                    });
                } else {
                    const stok = getStockCount(product);
                    if (stok < qty) {
                        await waSendButtons(from, {
                            text: `❌ *STOK TIDAK CUKUP*\n\nProduk: *${product.productName}*\nStok tersisa: *${stok}*\nDiminta: *${qty}*`,
                            footer: storeName,
                            buttons: [{ id: '1', text: '📦 Lihat Produk Lain' }, { id: 'menu', text: '🔄 Menu' }]
                        });
                    } else if (product.source === 'digiflazz' || (product.productId || '').toLowerCase().startsWith('df_')) {
                        // Digiflazz PPOB always needs a customer_no — never go straight to payment.
                        waSess.state = 'PPOB_CUSTOMER_NO';
                        waSess.data.ppob = { ...(waSess.data.ppob || {}), product };
                        const hargaBeli = (product.priceProduct || 0).toLocaleString('id-ID');
                        await waSend(from, { text:
                            `✅ *${product.productName}*\nHarga: *Rp${hargaBeli}*\nSKU: \`${product.buyer_sku_code}\`\n\n` +
                            `📝 Ketik *nomor tujuan* (HP/ID PLN/ID game). Contoh: \`081234567890\`.\n\nKetik *batal* untuk keluar.` });
                    } else {
                        if (!parts[2]) {
                            // Tidak ada qty → tampilkan pemilih jumlah
                            const kodeId = product.productId || product.productName.toLowerCase().replace(/\s+/g, '_');
                            const qtyOptions = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 50, 100].filter(n => n <= stok);
                            const qtyBtns = qtyOptions.map(n => {
                                const bc2 = calculateBulkPrice(product, n);
                                return { id: `beli ${kodeId} ${n}`, text: `${n} Pcs — Rp${bc2.totalPrice.toLocaleString('id-ID')}` };
                            });
                            let beliQtyText = `Berapa banyak *${product.productName}* yang ingin Anda beli?\n\n💰 Harga: *Rp${Number(product.priceProduct).toLocaleString('id-ID')}*/pcs\n📦 Stok: *${stok}*`;
                            const beliTiers = Array.isArray(product.bulkDiscounts) ? product.bulkDiscounts.filter(t => t.minQty && t.price) : [];
                            if (beliTiers.length > 0) {
                                beliQtyText += `\n\n💰 *Diskon Grosir:*`;
                                [...beliTiers].sort((a, b) => Number(a.minQty) - Number(b.minQty)).forEach(t => {
                                    beliQtyText += `\n├ ≥${t.minQty}pcs → Rp${Number(t.price).toLocaleString('id-ID')}/pcs`;
                                });
                            }
                            await waSendButtons(from, {
                                title: '📦 Pilih Jumlah',
                                text: beliQtyText,
                                footer: '💡 Pilih jumlah order',
                                buttons: qtyBtns
                            });
                        } else {
                            await initiatePayment(product, qty);
                        }
                    }
                }
            } else if (cmd.startsWith('check ')) {
                // tx.id contains hex (crypto.randomBytes -> lowercase) but `cmd` was lowercased
                // by the router. Compare case-insensitively rather than force-uppercasing the
                // input — uppercasing the hex tail (e.g. e1ff277d -> E1FF277D) breaks find().
                const checkIdRaw = cmd.split(' ')[1] || '';
                const checkIdLc = checkIdRaw.toLowerCase();
                let tx = null;
                try {
                    const all = loadTransactions(waTransactionsFile);
                    tx = all.find(t => (t.id || '').toLowerCase() === checkIdLc);
                } catch { /* ignore */ }
                if (!tx) {
                    await waSend(from, { text: `❌ Transaksi \`${checkIdRaw}\` tidak ditemukan.` });
                    return;
                }
                if (tx.status === 'PAID' || tx.delivered) {
                    await waSend(from, { text: `✅ Pembayaran sudah diterima dan sedang diproses. Mohon tunggu sebentar.` });
                    return;
                }
                if (tx.status === 'CANCELLED') {
                    await waSend(from, { text: `❌ Transaksi ini sudah dibatalkan. Ketik *menu* untuk order ulang.` });
                    return;
                }
                if (tx.status === 'EXPIRED') {
                    await waSend(from, { text: `⏰ Transaksi ini sudah kadaluarsa. Ketik *menu* untuk order ulang.` });
                    return;
                }
                // UNPAID — query provider on-demand
                await waSend(from, { text: `🔄 Mengecek status pembayaran...` });
                try {
                    const r = await checkPaymentByProvider(tx.provider, {
                        reference: tx.reference || tx.id,
                        config,
                        saweriaId: tx.saweriaId,
                        payAmount: tx.totalPrice || 0,
                        pakasirBaseAmount: tx.pakasirBaseAmount || 0,
                        dompetxTxId: tx.dompetxTxId || '',
                        createdAt: tx.timestamp || (Date.now() - TX_TIMEOUT_MS),
                        expiresAt: tx.gopayExpiresAt || ((tx.timestamp || Date.now()) + TX_TIMEOUT_MS),
                        gopayModule: gopay
                    });
                    if (r.status === 'Paid') {
                        await waSend(from, { text: `✅ *Pembayaran terdeteksi!*\n\nProduk Anda akan dikirim sebentar lagi.` });
                        // Poller will pick it up on next tick (≤5s) and deliver — don't double-deliver here.
                    } else {
                        await waSendButtons(from, {
                            text: `⏳ *Pembayaran belum diterima*\n\nRef: \`${tx.id}\`\n\nSelesaikan pembayaran lalu klik *Cek Pembayaran* lagi.`,
                            footer: storeName,
                            buttons: [
                                { id: `check ${tx.id}`, text: '🔄 Cek Lagi' },
                                { id: `cancel ${tx.id}`, text: '❌ Batalkan Pesanan' }
                            ]
                        });
                    }
                } catch (e) {
                    console.error('[WA] Manual payment check failed for', checkIdRaw, '-', e.message);
                    await waSend(from, { text: `⚠️ Gagal mengecek status pembayaran. Coba lagi dalam beberapa saat.` });
                }
            } else if (cmd.startsWith('cancel ')) {
                // Same case story as `check ` — match tx.id case-insensitively.
                const cancelIdRaw = cmd.split(' ')[1] || '';
                const cancelIdLc = cancelIdRaw.toLowerCase();
                // Use withWaTxFile to atomically find + cancel, return tx snapshot for notifications
                const cancelledTx = await withWaTxFile(txs => {
                    const idx = txs.findIndex(t => (t.id || '').toLowerCase() === cancelIdLc && t.status === 'UNPAID');
                    if (idx === -1) return null;
                    const tx = txs[idx];
                    if (tx.reservationStatus === 'HELD') {
                        releaseReservation(tx);
                        rcLog('RELEASE', `WA tx=${tx.id} product=${tx.productName} reason=user-cancel`);
                    }
                    tx.status = 'CANCELLED';
                    return { ...tx }; // snapshot for post-save notifications
                });
                if (cancelledTx) {
                    // Cancel on DompetX side (fire-and-forget)
                    waCancelDompetxIfNeeded(cancelledTx.provider, config?.dompetx?.api_key || '', cancelledTx.dompetxTxId || '', 'user-cancel');
                    rcLog('CANCELLED', `WA | ${from.split('@')[0]} | ${cancelledTx.productName} x${cancelledTx.quantity || 1} | inv=${cancelledTx.id}`);
                    const _canUserMap = (() => { try { return JSON.parse(fs.readFileSync(path.join(projectRoot, 'wa_users.json'), 'utf8')); } catch { return []; } })();
                    const _canUser = _canUserMap.find(u => u.jid === cancelledTx.jid);
                    const _canBuyer = _canUser ? (_canUser.name || _canUser.phone || cancelledTx.jid.split('@')[0]) : cancelledTx.jid.split('@')[0];
                    notifyAdmin({ type: 'cancelled', platform: 'whatsapp', buyer: _canBuyer, product: cancelledTx.productName, quantity: cancelledTx.quantity || 1, invoice: cancelledTx.id });
                    // Hapus pesan QR + tombol dari chat
                    if (cancelledTx.msgKeys && Array.isArray(cancelledTx.msgKeys)) {
                        for (const key of cancelledTx.msgKeys) {
                            try { await waSend(from, { delete: key }); } catch (e) { }
                        }
                    }
                    const displayRef = cancelledTx.reference || cancelledTx.id;
                    await waSendButtons(from, {
                        text: `❌ *PEMBAYARAN DIBATALKAN*\n\nRef: \`${displayRef}\`\nStatus: *CANCELLED*\n\n_Transaksi ini telah dibatalkan. Ketik menu untuk order ulang._`,
                        footer: storeName,
                        buttons: [{ id: 'menu', text: '🏠 Menu Utama' }, { id: '1', text: '🛍️ Lihat Produk' }]
                    });
                } else {
                    await waSendButtons(from, {
                        text: `❌ Transaksi \`${cancelIdRaw}\` tidak ditemukan atau sudah diproses.`,
                        footer: storeName,
                        buttons: [{ id: 'menu', text: '🏠 Menu Utama' }]
                    });
                }
            } else {
                // Default: show menu
                await sendMenu();
            }
        } catch (err) {
            console.error('[WA] Message handler error:', err);
        }
    };

    // Connect to WhatsApp using dynamic import (Baileys is ESM)
    async function connectToWhatsApp() {
        // Guard: prevent multiple parallel connections
        if (waIsConnecting) {
            console.log('[WA] Connection already in progress, skipping.');
            return;
        }

        try {
            const waConfig = getWaConfig();
            if (!waConfig.enabled) {
                console.log('[WA] WhatsApp bot disabled in settings.');
                return;
            }
        } catch (e) { console.error('[WA] Config read failed, proceeding with connection:', e.message); }

        waIsConnecting = true;
        waLastError = null;

        try {
            console.log('[WA] Loading Baileys (ESM)...');
            const baileys = await import('baileys');
            const pino = (await import('pino')).default;
            const makeWASocket = baileys.default || baileys.makeWASocket;
            const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = baileys;
            getContentType = baileys.getContentType;

            const { state, saveCreds } = await useMultiFileAuthState(path.join(projectRoot, 'wa_session'));
            const { version } = await fetchLatestBaileysVersion();
            console.log(`[WA] Using Baileys v${version.join('.')}`);

            waSock = makeWASocket({
                version,
                logger: pino({ level: 'silent' }),
                auth: state,
                browser: Browsers ? Browsers.macOS('Desktop') : ['Store Bot', 'Chrome', '100.0']
            });

            waSock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;
                if (qr) {
                    QRCode.toDataURL(qr, (err, url) => {
                        waQrCode = url;
                        io.emit('wa-qr', url);
                        console.log('[WA] New QR code generated. Scan it!');
                    });
                }
                if (connection === 'close') {
                    waIsConnected = false;
                    waIsConnecting = false;
                    waQrCode = null;
                    const code = lastDisconnect?.error?.output?.statusCode;
                    const errMsg = lastDisconnect?.error?.message || '';
                    console.log('[WA] Connection closed, reason:', code, 'message:', errMsg);

                    // Determine if this is a fatal (non-recoverable) error
                    const isBanned = code === 403;
                    const isLoggedOut = code === DisconnectReason.loggedOut;
                    const isBadMAC = errMsg.includes('Bad MAC');
                    const isFatal = isBanned || isLoggedOut || isBadMAC;

                    if (isFatal) {
                        // Clear corrupted/banned session
                        try { fs.rmSync(path.join(projectRoot, 'wa_session'), { recursive: true, force: true }); } catch (e) { }

                        if (isBanned) {
                            waLastError = 'banned';
                            console.log('[WA] Account BANNED (403). Session cleared. Not reconnecting.');
                            io.emit('wa-error', { type: 'banned', message: 'Nomor WhatsApp ini terkena banned. Gunakan nomor lain.' });
                        } else {
                            waLastError = 'logged_out';
                            console.log('[WA] Logged out / Bad MAC. Session cleared.');
                            io.emit('wa-error', { type: 'logged_out', message: 'Sesi WhatsApp berakhir. Silakan scan QR ulang.' });
                        }
                        io.emit('wa-status', { isConnected: false });
                        // Do NOT reconnect for fatal errors
                    } else {
                        // Recoverable error — reconnect with backoff
                        io.emit('wa-status', { isConnected: false });
                        console.log('[WA] Reconnecting in 3s...');
                        setTimeout(() => connectToWhatsApp(), 3000);
                    }
                } else if (connection === 'open') {
                    waIsConnected = true;
                    waIsConnecting = false;
                    waQrCode = null;
                    waLastError = null;
                    io.emit('wa-status', { isConnected: true, user: waSock.user });
                    console.log('[WA] WhatsApp connected!', waSock.user?.id);
                    // Register global WA send function for web-checkout
                    app.set('sendWhatsAppMessage', async (jid, text) => {
                        if (waSock && waIsConnected) {
                            return await waSock.sendMessage(jid, { text });
                        }
                    });
                }
            });

            waSock.ev.on('creds.update', saveCreds);
            waSock.ev.on('messages.upsert', async (m) => {
                const msg = m.messages[0];
                if (!msg.message || msg.key.fromMe) return;
                await handleWAMessage(msg);
            });

            recoverReservations().catch(e => console.error('[Recovery] recoverReservations error:', e));
            startWAPaymentPoller();
        } catch (e) {
            waIsConnecting = false;
            console.error('[WA] Connection failed:', e.message);
        }
    }

    // ─────── WA API ENDPOINTS ───────

    // GET WA Status
    app.get('/api/wa/status', (req, res) => {
        res.json({ isConnected: waIsConnected, qr: waQrCode, user: waIsConnected && waSock ? waSock.user : null, error: waLastError });
    });

    // POST WA Logout / Reset Session
    app.post('/api/wa/logout', async (req, res) => {
        try {
            waIsConnected = false;
            waIsConnecting = false;
            waQrCode = null;
            waLastError = null;
            io.emit('wa-status', { isConnected: false });
            if (waSock) {
                try { await waSock.logout(); } catch (e) { }
                try { waSock.end(undefined); } catch (e) { }
                waSock = null;
            }
            try { fs.rmSync(path.join(projectRoot, 'wa_session'), { recursive: true, force: true }); } catch (e) { }
            res.json({ success: true });
            setTimeout(() => connectToWhatsApp(), 1500);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST Enable/Disable WA Bot
    app.post('/api/wa/toggle', async (req, res) => {
        const { enabled } = req.body;
        try {
            let conf = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json'), 'utf8'));
            const c = Array.isArray(conf) ? conf[0] : conf;
            if (!c.whatsapp) c.whatsapp = {};
            c.whatsapp.enabled = enabled;
            fs.writeFileSync('configtelebot.json', JSON.stringify(Array.isArray(conf) ? conf : [c], null, 2));
            setConfig(Array.isArray(conf) ? conf : [c]);

            if (enabled) {
                await connectToWhatsApp();
            } else {
                if (waSock) {
                    try { await waSock.logout(); } catch (e) { }
                    try { waSock.end(undefined); } catch (e) { }
                    waSock = null;
                }
                waIsConnected = false;
                io.emit('wa-status', { isConnected: false });
            }
            res.json({ success: true, enabled });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // GET WA Users
    app.get('/api/wa/users', (req, res) => {
        try { res.json(JSON.parse(fs.readFileSync(waUsersFile, 'utf8'))); } catch { res.json([]); }
    });

    // GET WA Transactions
    app.get('/api/wa/transactions', (req, res) => {
        try { res.json(loadTransactions(waTransactionsFile)); } catch { res.json([]); }
    });

    // GET All Transactions (unified: Telegram + WhatsApp)
    app.get('/api/all-transactions', (req, res) => {
        try {
            // Load products for profit lookup (backfill old transactions without profit)
            let products = [];
            try {
                products = JSON.parse(fs.readFileSync(productFile, 'utf8'));
                if (!Array.isArray(products)) products = [];
            } catch { products = []; }
            const productProfitMap = {};
            const productPriceMap = {};
            products.forEach(p => {
                const key = (p.productName || '').toLowerCase().trim();
                productProfitMap[key] = parseInt(p.profit) || 0;
                productPriceMap[key] = parseInt(p.priceProduct) || 0;
            });

            // Load Telegram transactions
            let tgTxns = [];
            try {
                tgTxns = loadTransactions(transactionsFile);
                if (!Array.isArray(tgTxns)) tgTxns = [];
            } catch { tgTxns = []; }

            // Load WhatsApp transactions
            let waTxns = [];
            try {
                waTxns = loadTransactions(waTransactionsFile);
                if (!Array.isArray(waTxns)) waTxns = [];
            } catch { waTxns = []; }

            // Normalize Telegram transactions (skip WA-duplicates that have platform:'whatsapp')
            const normalizedTg = tgTxns
                .filter(tx => tx.platform !== 'whatsapp')
                .map((tx, i) => {
                    // Build buyer display: "Name(@username)" or just "Name"
                    let buyerDisplay = tx.name || 'Unknown';
                    if (tx.username) {
                        buyerDisplay = `${tx.name || 'Unknown'}(@${tx.username})`;
                    }
                    const qty = tx.quantity || 1;
                    // Use stored profit if available, otherwise lookup from current product data
                    let profit = 0;
                    if (tx.profit != null) {
                        profit = Number(tx.profit) || 0;
                    } else {
                        const prodKey = (tx.productName || tx.product || '').toLowerCase().trim();
                        profit = (productProfitMap[prodKey] || 0) * qty;
                    }
                    // Use stored totalPrice/amount, otherwise lookup price from product data
                    let amount = Number(tx.totalPrice) || Number(tx.amount) || 0;
                    if (amount === 0) {
                        const prodKey = (tx.productName || tx.product || '').toLowerCase().trim();
                        amount = (productPriceMap[prodKey] || 0) * qty;
                    }
                    return {
                        id: tx.reference || `TELEINV-${tx.timestamp || i}`,
                        source: 'telegram',
                        buyer: buyerDisplay,
                        product: tx.productName || tx.product || '-',
                        quantity: qty,
                        amount: amount,
                        profit: profit,
                        status: tx.status || 'PAID',
                        timestamp: tx.timestamp || 0,
                        date: tx.timestamp ? new Date(tx.timestamp).toLocaleString('id-ID') : '-'
                    };
                });

            // Load WA users for name lookup
            let waUsers = [];
            try {
                waUsers = JSON.parse(fs.readFileSync(waUsersFile, 'utf8'));
                if (!Array.isArray(waUsers)) waUsers = [];
            } catch { waUsers = []; }
            const waUserMap = {};
            waUsers.forEach(u => { waUserMap[u.jid] = { name: u.name, phone: u.phone || '' }; });

            // Normalize WhatsApp transactions
            const normalizedWa = waTxns.map(tx => {
                let buyerDisplay = 'Unknown';
                if (tx.jid) {
                    const userData = waUserMap[tx.jid] || {};
                    const savedName = userData.name;
                    // Phone from user record, or extract from @s.whatsapp.net JID
                    const phoneNum = userData.phone || (tx.jid.endsWith('@s.whatsapp.net') ? tx.jid.split('@')[0] : '');
                    if (savedName && phoneNum) {
                        buyerDisplay = `${savedName} (${phoneNum})`;
                    } else if (savedName) {
                        buyerDisplay = savedName;
                    } else if (phoneNum) {
                        buyerDisplay = phoneNum;
                    } else {
                        buyerDisplay = tx.jid.split('@')[0];
                    }
                }
                const qty = tx.quantity || 1;
                // Use stored profit if available, otherwise lookup from current product data
                let profit = 0;
                if (tx.profit != null) {
                    profit = Number(tx.profit) || 0;
                } else {
                    const prodKey = (tx.productName || '').toLowerCase().trim();
                    profit = (productProfitMap[prodKey] || 0) * qty;
                }
                return {
                    id: (() => { const raw = (tx.id || tx.reference || tx.timestamp || 0).toString(); return raw.startsWith('WAINV-') ? raw : `WAINV-${raw.replace(/^WATX/, '')}`; })(),
                    source: 'whatsapp',
                    buyer: buyerDisplay,
                    product: tx.productName || '-',
                    quantity: qty,
                    amount: tx.totalPrice || tx.price || 0,
                    profit: profit,
                    status: tx.status || 'UNKNOWN',
                    timestamp: tx.timestamp || 0,
                    date: tx.timestamp ? new Date(tx.timestamp).toLocaleString('id-ID') : '-'
                };
            });

            // Merge and sort by timestamp descending (newest first)
            const all = [...normalizedTg, ...normalizedWa].sort((a, b) => b.timestamp - a.timestamp);

            res.json(all);
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // POST WA Broadcast
    app.post('/api/wa/broadcast', async (req, res) => {
        const { message } = req.body;
        if (!waSock || !waIsConnected) return res.status(400).json({ error: 'WhatsApp not connected' });
        try {
            let users = JSON.parse(fs.readFileSync(waUsersFile, 'utf8'));
            res.json({ success: true, count: users.length });
            for (const user of users) {
                try { await waSend(user.jid, { text: message }); } catch (e) { /* best-effort broadcast per user */ }
                await new Promise(r => setTimeout(r, 2000));
            }
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Webhook dispatcher for Digiflazz — invoked by routes.js POST /webhook/digiflazz.
    // Resolves WA tx that came back PENDING from initial dispatch.
    const dfDispatcher = async ({ refId, payload, bucket }) => {
        if (!refId) return;
        let entry = waPendingPpob.get(refId);

        // Fallback: rebuild from tx file (covers bot restart between dispatch & webhook)
        if (!entry) {
            try {
                let tx = null;
                await withWaTxFile(txs => { tx = txs.find(t => t.id === refId); });
                if (tx && tx.jid) {
                    entry = {
                        jid: tx.jid, productName: tx.productName || 'PPOB',
                        customerNo: tx.digiflazz?.customer_no || tx.customer_no || '',
                        skuCode: tx.digiflazz?.buyer_sku_code || '',
                        refId, quantity: tx.quantity || 1,
                    };
                }
            } catch {}
        }
        if (!entry) return; // not a WA tx — ignore silently

        const { jid, productName, customerNo, quantity } = entry;
        const sn = payload.sn || '';
        const msg = payload.message || '';

        if (bucket === 'SUCCESS') {
            await waSend(jid, { text:
                `✅ *TRANSAKSI SUKSES*\n\n📦 *${productName}*\n📱 Tujuan: \`${customerNo}\`\n🧾 Ref: \`${refId}\`\n` +
                (sn ? `🔐 SN: \`${sn}\`\n` : '') + (msg ? `\n_${msg}_` : '') });
            try { await updateSalesCount(productName, quantity || 1); } catch {}
            try {
                await withWaTxFile(txs => {
                    const f = txs.find(t => t.id === refId);
                    if (f) { f.delivered = true; f.deliveryState = 'SENT'; f.wa_revenue_counted = true; }
                });
            } catch {}
            waPendingPpob.delete(refId);
            rcLog('PPOB_DELIVERED', `WA ref=${refId} sku=${payload.buyer_sku_code} sn=${sn ? 'yes' : 'no'}`);
            await sendWaPostDeliveryCta(jid);
            return;
        }
        if (bucket === 'PENDING') return;

        // FAILED
        await waSend(jid, { text:
            `⚠️ *TRANSAKSI GAGAL*\n\n📦 ${productName}\n📱 \`${customerNo}\`\n🧾 Ref: \`${refId}\`\n\nAlasan: _${msg || ('rc=' + payload.rc)}_\n\n💸 Dana akan di-refund admin.` });
        notifyAdmin({
            type: 'paid', platform: 'whatsapp',
            buyer: jid.split('@')[0], product: productName, quantity: quantity || 1,
            amount: 0, invoice: refId,
            extra: `PPOB FAILED via webhook rc=${payload.rc} msg="${msg}" — REFUND REQUIRED`
        });
        try {
            await withWaTxFile(txs => {
                const f = txs.find(t => t.id === refId);
                if (f) { f.deliveryState = 'NEEDS_REVIEW'; }
            });
        } catch {}
        waPendingPpob.delete(refId);
        await sendWaAdminContactCta(jid);
    };

    // Periodic poll for stale PENDING PPOB tx — self-rescheduling so admin can change
    // delivery_mode / poll_interval_seconds live without restart.
    const _waPpobPollTick = async () => {
        const cfg = getConfig()[0] || {};
        const df = cfg.digiflazz || {};
        const interval = digiflazz.getEffectivePollIntervalMs(df);

        if (waPendingPpob.size === 0 || !df.is_active || !df.username || !df.api_key) {
            setTimeout(_waPpobPollTick, interval);
            return;
        }
        const minAge = Math.min(interval, 90_000);
        const now = Date.now();
        for (const [refId, entry] of waPendingPpob) {
            if (now - (entry.started_at || 0) < minAge) continue;
            if (!entry.skuCode) continue;
            try {
                const r = await digiflazz.checkTransactionStatus({
                    username: df.username, apiKey: df.api_key,
                    buyerSkuCode: entry.skuCode, customerNo: entry.customerNo, refId
                });
                if (!r.ok) continue;
                const bucket = digiflazz.classifyRc(r.rc, r.status);
                if (bucket !== 'PENDING') await dfDispatcher({ refId, payload: r, bucket, eventType: 'poll' });
            } catch {}
        }
        setTimeout(_waPpobPollTick, interval);
    };
    setTimeout(_waPpobPollTick, 30_000);

    // Startup: rebuild waPendingPpob for any WA tx still in PROCESSING within 24h
    try {
        let waTxs = [];
        try { waTxs = JSON.parse(fs.readFileSync(waTransactionsFile, 'utf8')); } catch { waTxs = []; }
        const horizon = Date.now() - (24 * 60 * 60 * 1000);
        for (const tx of waTxs) {
            if (tx.source !== 'digiflazz') continue;
            if (tx.deliveryState !== 'PROCESSING' && tx.digiflazz?.bucket !== 'PENDING') continue;
            if ((tx.timestamp || 0) < horizon) continue;
            if (!tx.jid || !tx.id) continue;
            waPendingPpob.set(tx.id, {
                jid: tx.jid, productName: tx.productName || 'PPOB',
                customerNo: tx.digiflazz?.customer_no || tx.customer_no || '',
                skuCode: tx.digiflazz?.buyer_sku_code || '',
                refId: tx.id, quantity: tx.quantity || 1,
                started_at: tx.digiflazz?.dispatched_at || tx.timestamp,
            });
        }
        if (waPendingPpob.size > 0) console.log(`[PPOB-WA] Recovered ${waPendingPpob.size} pending Digiflazz tx into in-memory registry.`);
    } catch (e) { console.error('[PPOB-WA] startup recovery failed:', e.message); }

    return { connectToWhatsApp, io, dfDispatcher };

    // Expose waSend globally via app reference for web-checkout module
    // This is set AFTER waSock is initialized (inside connectToWhatsApp)
}

export { setupWABot };
export const getWaSock = () => waSock;
export const getWaIsConnected = () => waIsConnected;
export const getWaQrCode = () => waQrCode;
export const getWaLastError = () => waLastError;
