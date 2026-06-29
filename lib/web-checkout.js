/**
 * Web Checkout Module — handles website-based purchases
 * 
 * Flow:
 * 1. Customer picks product on landing page → POST /api/web/checkout
 * 2. Server creates order, reserves stock, generates QRIS → returns QR + order ID
 * 3. Customer scans QRIS → payment detected by GoPay batch poller
 * 4. Server auto-delivers account to customer's WhatsApp + shows on web
 * 5. Invoice sent to customer WA
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { writeFileAtomic, TX_TIMEOUT_MS, POLL_INTERVAL_MS, rcLog } from './foundation.js';
import { getMergedProducts, getConfig, koalaStore, isKsProduct, calculateBulkPrice } from './config.js';
import { reserveStockForTx, commitReservedStock, releaseReservation } from './stock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const WEB_TX_FILE = path.join(projectRoot, 'web_transactions.json');
if (!fs.existsSync(WEB_TX_FILE)) fs.writeFileSync(WEB_TX_FILE, '[]');

// ==========================================
// TRANSACTION STORAGE
// ==========================================
function loadWebTx() {
    try { return JSON.parse(fs.readFileSync(WEB_TX_FILE, 'utf8')); } catch { return []; }
}

function saveWebTx(txs) {
    writeFileAtomic(WEB_TX_FILE, JSON.stringify(txs, null, 2));
}

function findTx(orderId) {
    return loadWebTx().find(t => t.id === orderId);
}

function updateTx(orderId, updates) {
    const txs = loadWebTx();
    const idx = txs.findIndex(t => t.id === orderId);
    if (idx === -1) return null;
    txs[idx] = { ...txs[idx], ...updates };
    saveWebTx(txs);
    return txs[idx];
}

// ==========================================
// SETUP WEB CHECKOUT ROUTES
// ==========================================
function setupWebCheckout(app, deps) {
    const { gopay, sendWhatsAppMessage } = deps;

    // --- POST /api/web/checkout ---
    // Creates an order, reserves stock, generates QRIS
    app.post('/api/web/checkout', async (req, res) => {
        const { productId, quantity, customerWA } = req.body;

        if (!productId || !quantity || !customerWA) {
            return res.status(400).json({ error: 'productId, quantity, dan customerWA wajib diisi' });
        }

        // Validate WA number format
        let waNumber = String(customerWA).replace(/[^0-9]/g, '');
        if (waNumber.startsWith('08')) waNumber = '62' + waNumber.slice(1);
        if (waNumber.length < 10) return res.status(400).json({ error: 'Nomor WhatsApp tidak valid' });

        try {
            // 1. Find product
            const products = await getMergedProducts();
            const product = products.find(p => p.productId === productId);
            if (!product) return res.status(404).json({ error: 'Produk tidak ditemukan' });

            const qty = Math.max(1, parseInt(quantity));
            const bulk = calculateBulkPrice(product, qty);
            const totalPrice = bulk.totalPrice;

            // 2. Check if GoPay is configured
            const config = getConfig()[0] || {};
            const gopayConfig = config.gopay || {};
            if (!gopayConfig.email || !gopayConfig.qr_string) {
                return res.status(400).json({ error: 'Payment gateway belum dikonfigurasi. Hubungi admin.' });
            }

            // 3. Reserve stock (for local/file-based products)
            let reservedLines = [];
            let reservationStatus = 'NONE';
            const isKs = isKsProduct(product);

            if (!isKs && product.source !== 'digiflazz') {
                const reservation = await reserveStockForTx(product.productName, qty);
                if (!reservation.success) {
                    return res.status(400).json({ error: `Stok tidak cukup. Tersedia: ${reservation.available}` });
                }
                reservedLines = reservation.reservedLines;
                reservationStatus = 'HELD';
            }

            // 4. Generate QRIS payment
            const getPendingAmounts = () => {
                const txs = loadWebTx();
                return txs.filter(t => t.status === 'UNPAID').map(t => t.payAmount);
            };

            const paymentResult = await gopay.createPayment(
                gopayConfig,
                totalPrice,
                getPendingAmounts,
                10, // 10 min expiry
                'WEBINV'
            );

            // 5. Create order record
            const orderId = 'WEB-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
            const now = Date.now();

            const order = {
                id: orderId,
                reference: paymentResult.reference,
                productId: product.productId,
                productName: product.productName,
                quantity: qty,
                unitPrice: bulk.unitPrice,
                totalPrice,
                payAmount: paymentResult.paymentRupiah,
                profit: bulk.totalProfit,
                customerWA: waNumber,
                status: 'UNPAID',
                provider: 'gopay',
                source: product.source || 'local',
                isKoalaStore: isKs,
                reservedLines,
                reservationStatus,
                reservationExpiresAt: now + TX_TIMEOUT_MS,
                qrcode: paymentResult.qrcode,
                imageQr: paymentResult.imageQr,
                createdAt: now,
                expiresAt: now + (10 * 60 * 1000),
                paidAt: null,
                deliveredAt: null,
                deliveryData: null,
            };

            const txs = loadWebTx();
            txs.push(order);
            // Keep max 500 entries
            if (txs.length > 500) txs.splice(0, txs.length - 500);
            saveWebTx(txs);

            rcLog('WEB_CHECKOUT', `order=${orderId} product=${product.productName} qty=${qty} amount=${paymentResult.paymentRupiah} wa=${waNumber}`);

            // 6. Start payment polling
            startPaymentPoller(orderId, gopayConfig, gopay, sendWhatsAppMessage);

            // 7. Return to frontend
            res.json({
                success: true,
                order: {
                    id: orderId,
                    productName: product.productName,
                    quantity: qty,
                    totalPrice,
                    payAmount: paymentResult.paymentRupiah,
                    qrcode: paymentResult.qrcode,
                    imageQr: paymentResult.imageQr,
                    expiresAt: order.expiresAt,
                }
            });

        } catch (err) {
            console.error('[WEB_CHECKOUT] Error:', err.message);
            res.status(500).json({ error: err.message || 'Gagal membuat order' });
        }
    });

    // --- GET /api/web/order/:id/status ---
    // Frontend polls this every 5 seconds
    app.get('/api/web/order/:id/status', (req, res) => {
        const order = findTx(req.params.id);
        if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });

        const response = {
            status: order.status,
            payAmount: order.payAmount,
            expiresAt: order.expiresAt,
        };

        if (order.status === 'PAID') {
            response.deliveryData = order.deliveryData;
            response.paidAt = order.paidAt;
            response.deliveredAt = order.deliveredAt;
        }

        if (order.status === 'EXPIRED') {
            response.message = 'Pembayaran expired. Silakan order ulang.';
        }

        res.json(response);
    });

    // --- GET /api/web/order/:id ---
    // Full order detail
    app.get('/api/web/order/:id', (req, res) => {
        const order = findTx(req.params.id);
        if (!order) return res.status(404).json({ error: 'Order tidak ditemukan' });
        res.json({
            id: order.id,
            productName: order.productName,
            quantity: order.quantity,
            totalPrice: order.totalPrice,
            payAmount: order.payAmount,
            customerWA: order.customerWA,
            status: order.status,
            imageQr: order.imageQr,
            qrcode: order.qrcode,
            expiresAt: order.expiresAt,
            createdAt: order.createdAt,
            paidAt: order.paidAt,
            deliveredAt: order.deliveredAt,
            deliveryData: order.deliveryData,
        });
    });
}

// ==========================================
// PAYMENT POLLER — checks GoPay every 5s
// ==========================================
function startPaymentPoller(orderId, gopayConfig, gopay, sendWhatsAppMessage) {
    const checkInterval = POLL_INTERVAL_MS;
    let attempts = 0;
    const maxAttempts = (10 * 60 * 1000) / checkInterval; // 10 min / 5s = 120 attempts

    const poller = setInterval(async () => {
        attempts++;
        const order = findTx(orderId);

        if (!order || order.status !== 'UNPAID') {
            clearInterval(poller);
            return;
        }

        // Check expiry
        if (Date.now() > order.expiresAt || attempts > maxAttempts) {
            clearInterval(poller);
            // Release stock reservation
            if (order.reservationStatus === 'HELD' && order.reservedLines.length > 0) {
                releaseReservation(order);
            }
            updateTx(orderId, { status: 'EXPIRED', reservationStatus: 'RELEASED', reservedLines: [] });
            rcLog('WEB_CHECKOUT', `EXPIRED order=${orderId}`);
            return;
        }

        // Check payment via GoPay cache
        try {
            const result = gopay.checkStatusFromCache(order.payAmount, order.createdAt, order.expiresAt);

            if (result.status === 'Paid') {
                clearInterval(poller);
                rcLog('WEB_CHECKOUT', `PAID order=${orderId} amount=${order.payAmount}`);

                // Process delivery
                await processDelivery(orderId, gopayConfig, sendWhatsAppMessage);
            }
        } catch (e) {
            console.error(`[WEB_CHECKOUT] Poller error for ${orderId}:`, e.message);
        }
    }, checkInterval);
}

// ==========================================
// DELIVERY — send account to customer WA
// ==========================================
async function processDelivery(orderId, gopayConfig, sendWhatsAppMessage) {
    const order = findTx(orderId);
    if (!order) return;

    let deliveryData = null;

    try {
        if (order.isKoalaStore) {
            // KoalaStore: auto-checkout via API
            const config = getConfig()[0] || {};
            const ks = config.koalastore || {};
            if (ks.is_active && ks.api_key) {
                const product = (await getMergedProducts()).find(p => p.productId === order.productId);
                if (product && product.variant_code) {
                    const checkoutResult = await koalaStore.checkout(ks.api_key, product.variant_code, order.quantity);
                    if (checkoutResult.success) {
                        deliveryData = {
                            type: 'koalastore',
                            accounts: checkoutResult.data || checkoutResult.items || [{ info: 'Order berhasil diproses. Cek detail di dashboard KoalaStore.' }],
                            raw: checkoutResult,
                        };
                    } else {
                        deliveryData = { type: 'error', message: checkoutResult.message || 'KoalaStore checkout gagal' };
                    }
                }
            }
        } else if (order.reservedLines && order.reservedLines.length > 0) {
            // Local stock: commit reserved lines
            await commitReservedStock(order.productName, order.reservedLines);
            deliveryData = {
                type: 'account',
                accounts: order.reservedLines,
            };
        } else {
            deliveryData = { type: 'manual', message: 'Produk akan dikirim oleh admin.' };
        }
    } catch (e) {
        console.error(`[WEB_DELIVERY] Error for ${orderId}:`, e.message);
        deliveryData = { type: 'error', message: e.message };
    }

    // Update order
    const now = Date.now();
    updateTx(orderId, {
        status: 'PAID',
        paidAt: now,
        deliveredAt: now,
        deliveryData,
        reservationStatus: 'COMMITTED',
    });

    // Send to customer WhatsApp
    try {
        await sendAccountToWA(order, deliveryData, sendWhatsAppMessage);
    } catch (e) {
        console.error(`[WEB_DELIVERY] WA send failed for ${orderId}:`, e.message);
    }

    rcLog('WEB_CHECKOUT', `DELIVERED order=${orderId} type=${deliveryData?.type}`);
}

// ==========================================
// SEND ACCOUNT + INVOICE TO CUSTOMER WA
// ==========================================
async function sendAccountToWA(order, deliveryData, sendWhatsAppMessage) {
    if (!sendWhatsAppMessage || !order.customerWA) return;

    const jid = order.customerWA + '@s.whatsapp.net';
    const formatPrice = (n) => 'Rp ' + (n || 0).toLocaleString('id-ID');
    const date = new Date(order.paidAt || Date.now()).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

    // Invoice message
    let invoiceMsg = `━━━━━━━━━━━━━━━━━━━━━\n`;
    invoiceMsg += `🧾 *INVOICE - KELONTONG CIEL*\n`;
    invoiceMsg += `━━━━━━━━━━━━━━━━━━━━━\n\n`;
    invoiceMsg += `📦 *Produk:* ${order.productName}\n`;
    invoiceMsg += `🔢 *Qty:* ${order.quantity}\n`;
    invoiceMsg += `💰 *Total:* ${formatPrice(order.payAmount)}\n`;
    invoiceMsg += `📅 *Tanggal:* ${date}\n`;
    invoiceMsg += `🆔 *Order ID:* ${order.id}\n`;
    invoiceMsg += `✅ *Status:* LUNAS\n\n`;
    invoiceMsg += `━━━━━━━━━━━━━━━━━━━━━\n`;

    // Account details
    if (deliveryData && deliveryData.type === 'account' && deliveryData.accounts) {
        invoiceMsg += `\n🔐 *DETAIL AKUN:*\n\n`;
        deliveryData.accounts.forEach((acc, i) => {
            if (typeof acc === 'string') {
                // Format: email|password or email|password|profile|pin
                const parts = acc.split('|');
                if (parts.length >= 2) {
                    invoiceMsg += `*Akun ${order.quantity > 1 ? (i + 1) : ''}:*\n`;
                    invoiceMsg += `📧 Email: \`${parts[0]}\`\n`;
                    invoiceMsg += `🔑 Password: \`${parts[1]}\`\n`;
                    if (parts[2]) invoiceMsg += `👤 Profile: \`${parts[2]}\`\n`;
                    if (parts[3]) invoiceMsg += `🔢 PIN: \`${parts[3]}\`\n`;
                    invoiceMsg += `\n`;
                } else {
                    invoiceMsg += `${acc}\n`;
                }
            } else if (typeof acc === 'object') {
                invoiceMsg += JSON.stringify(acc, null, 2) + '\n';
            }
        });
    } else if (deliveryData && deliveryData.type === 'koalastore' && deliveryData.accounts) {
        invoiceMsg += `\n🔐 *DETAIL PRODUK:*\n\n`;
        const items = Array.isArray(deliveryData.accounts) ? deliveryData.accounts : [deliveryData.accounts];
        items.forEach((item) => {
            if (typeof item === 'object') {
                if (item.credential || item.account) {
                    invoiceMsg += `${item.credential || item.account}\n`;
                } else if (item.info) {
                    invoiceMsg += `${item.info}\n`;
                } else {
                    invoiceMsg += `${JSON.stringify(item)}\n`;
                }
            } else {
                invoiceMsg += `${item}\n`;
            }
        });
    } else if (deliveryData && deliveryData.type === 'manual') {
        invoiceMsg += `\n⏳ *Produk akan dikirim oleh admin dalam 1x24 jam.*\n`;
    } else if (deliveryData && deliveryData.type === 'error') {
        invoiceMsg += `\n⚠️ *Terjadi masalah:* ${deliveryData.message}\n`;
        invoiceMsg += `Admin akan segera menghubungi Anda.\n`;
    }

    invoiceMsg += `\n━━━━━━━━━━━━━━━━━━━━━\n`;
    invoiceMsg += `Terima kasih telah berbelanja di *Kelontong Ciel* 🛒\n`;
    invoiceMsg += `Support: wa.me/6281809182368`;

    await sendWhatsAppMessage(jid, invoiceMsg);
}

export { setupWebCheckout, loadWebTx, findTx };
