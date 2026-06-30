/**
 * Foundation module — paths, constants, locks, atomic writes, logging.
 * Extracted from server.js L1-113 (module-level code outside IIFE).
 * Zero external coupling — safe to import anywhere.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// FILE PATHS
// ==========================================
const productFile = path.join(__dirname, '..', 'product.json');
const transactionsFile = path.join(__dirname, '..', 'tele_transactions.json');
const waTransactionsFile = path.join(__dirname, '..', 'wa_transactions.json');
const waUsersFile = path.join(__dirname, '..', 'wa_users.json');
const LOGS_DIR = path.join(__dirname, '..', 'logs');
const STOCK_DIR = path.join(__dirname, '..', 'products');

// Ensure directories/files exist
if (!fs.existsSync(STOCK_DIR)) fs.mkdirSync(STOCK_DIR, { recursive: true });
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(waTransactionsFile)) fs.writeFileSync(waTransactionsFile, '[]');
if (!fs.existsSync(waUsersFile)) fs.writeFileSync(waUsersFile, '[]');
if (!fs.existsSync(productFile)) fs.writeFileSync(productFile, '[]');

const projectRoot = path.join(__dirname, '..');
const configTelebotFile = path.join(projectRoot, 'configtelebot.json');
const gopayCreds = path.join(projectRoot, 'gopay.creds.json');
const masterFile = path.join(projectRoot, 'master.json');
if (!fs.existsSync(configTelebotFile)) fs.writeFileSync(configTelebotFile, JSON.stringify([{
    botToken: "", apiKey: "", privateKey: "", merchant_code: "", merchant_ref: "",
    payment_provider: "gopay", saweria: { token: "", user_id: "", username: "", email: "" },
    admin_contact: "", pakasir: { cookie: "", token: "", project_id: "", project_slug: "", api_key: "", project_name: "" },
    dompetx: { api_key: "", method: "QRIS" },
    store_name: "KELONTONG CIEL", gatekeeper: { enabled: false, channel: { id: "", link: "" }, group: { id: "", link: "" } },
    koalastore: { api_key: "kb_live_2c97247e58b52471db6f2594f67b3c6def52e929", is_active: true },
    digiflazz: { username: "", api_key: "", webhook_secret: "", is_active: false, delivery_mode: "auto", poll_interval_seconds: 60 },
    modules: { account_enabled: true, ppob_enabled: false },
    whatsapp: { enabled: true, bot_number: "" },
    admin_contact_telegram: "", admin_contact_whatsapp: "6281809182368", operating_hours: "08.00 - 22.00 WIB",
    order_notifications: { new: true, paid: true, expired: true, cancelled: true },
    gopay: { email: "", password: "", qr_string: "", unique_min: 1, unique_max: 150 }
}], null, 2));
if (!fs.existsSync(gopayCreds)) fs.writeFileSync(gopayCreds, JSON.stringify({ GOBIZ_ACCESS_TOKEN: "", GOBIZ_REFRESH_TOKEN: "", GOBIZ_MERCHANT_ID: "" }, null, 2));
if (!fs.existsSync(masterFile)) fs.writeFileSync(masterFile, '[]');

// ==========================================
// CONSTANTS
// ==========================================
const TX_TIMEOUT_MS = 10 * 60 * 1000; // Payment transaction timeout (10 minutes)
const RESERVATION_EXPIRY_MS = TX_TIMEOUT_MS; // Reservation expiry — matches payment timeout
const POLL_INTERVAL_MS = 5000; // Payment status poll interval (5 seconds)
const BATCH_POLL_INTERVAL_MS = 60000; // GoPay batch poller interval (60 seconds)
const TX_HISTORY_CAP = 200; // Max transaction entries kept in history files
const KS_CACHE_TTL_MS = 30 * 1000; // KoalaStore product cache TTL (30 detik)
const TG_MSG_LIMIT = 4000; // Telegram message character limit (safe margin under 4096)
const FAKE_PHONE = '081234567890'; // Placeholder phone for payment APIs
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko)';
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-secret-key-change-this-in-production';

// ==========================================
// ATOMIC FILE WRITE
// ==========================================
const writeFileAtomic = (filePath, data, encoding = 'utf8') => {
    const tmpPath = filePath + '.tmp.' + process.pid + '.' + Date.now();
    fs.writeFileSync(tmpPath, data, encoding);
    fs.renameSync(tmpPath, filePath);
};

// ==========================================
// RACE CONDITION PROTECTION - Lock & Atomic Helpers
// ==========================================
const _productLocks = new Map();
const _txLocks = new Map();
const _userPurchaseLocks = new Map();

const _withLock = (lockMap, key, fn) => {
    const prev = lockMap.get(key) || Promise.resolve();
    const next = prev.then(() => fn(), () => fn());
    lockMap.set(key, next);
    next.finally(() => { if (lockMap.get(key) === next) lockMap.delete(key); });
    return next;
};

const withProductLock = (productName, fn) => _withLock(_productLocks, productName.toLowerCase(), fn);
const withTxLock = (txKey, fn) => _withLock(_txLocks, txKey, fn);
const withUserPurchaseLock = (chatId, fn) => _withLock(_userPurchaseLocks, String(chatId), fn);

// File-level lock for wa_transactions.json read-modify-write operations.
// Prevents race conditions where concurrent readers get stale data and overwrite each other's changes.
// Usage: await withWaTxFile(txs => { /* mutate txs array */ }); — file is loaded before fn, saved after.
const _waTxFileLocks = new Map();
const withWaTxFile = (fn) => _withLock(_waTxFileLocks, 'wa', async () => {
    const txs = (() => {
        try {
            if (fs.existsSync(waTransactionsFile)) {
                return JSON.parse(fs.readFileSync(waTransactionsFile, 'utf8'));
            }
        } catch (e) { /* corrupt file */ }
        return [];
    })();
    const result = await fn(txs);
    writeFileAtomic(waTransactionsFile, JSON.stringify(txs, null, 2), 'utf8');
    return result;
});

// File-level lock for tele_transactions.json read-modify-write operations.
// Same pattern as withWaTxFile — prevents concurrent readers from overwriting each other's changes.
// Usage: await withTgTxFile(txs => { /* mutate txs array */ }); — file is loaded before fn, saved after.
const _tgTxFileLocks = new Map();
const withTgTxFile = (fn) => _withLock(_tgTxFileLocks, 'tg', async () => {
    let txs = (() => {
        try {
            if (fs.existsSync(transactionsFile)) {
                return JSON.parse(fs.readFileSync(transactionsFile, 'utf8'));
            }
        } catch (e) { /* corrupt file */ }
        return [];
    })();
    const result = await fn(txs);
    writeFileAtomic(transactionsFile, JSON.stringify(txs, null, 2), 'utf8');
    return result;
});

// Per-invoice TG reservation tracking (keyed by invoice reference)
const tgActiveReservations = new Map();

// WA Poller re-entry guard
let waPollerRunning = false;
const getWaPollerRunning = () => waPollerRunning;
const setWaPollerRunning = (val) => { waPollerRunning = val; };

// ==========================================
// CHAT LOGGING - Daily rotating log files
// ==========================================
const chatLog = (platform, direction, userId, username, message) => {
    try {
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeStr = now.toISOString().slice(11, 23);
        const logFile = path.join(LOGS_DIR, `chat-${dateStr}.log`);
        const safeName = (username || 'unknown').replace(/[\r\n]/g, ' ');
        const safeMsg = (message || '').replace(/[\r\n]+/g, ' ↵ ');
        const line = `[${dateStr} ${timeStr}] [${platform}] [${direction}] [${userId}] [${safeName}] ${safeMsg}\n`;
        fs.appendFileSync(logFile, line, 'utf8');
    } catch (e) {
        // Logging should never crash the bot
    }
};

const rcLog = (event, detail) => {
    chatLog('SYS', 'EVENT', '-', event, detail);
};

// ==========================================
// SHARED DELIVERY UTILITIES
// ==========================================

/**
 * Increment totalProdukTerjual for a product in product.json.
 * Uses file-level lock to prevent concurrent read-modify-write races.
 * Silently fails — delivery should not break if sales count update fails.
 */
const _productFileLocks = new Map();
const updateSalesCount = async (productName, quantity) => {
    return _withLock(_productFileLocks, 'product.json', () => {
        try {
            const prods = JSON.parse(fs.readFileSync(productFile, 'utf8'));
            const idx = prods.findIndex(p => p.productName === productName);
            if (idx !== -1) {
                prods[idx].totalProdukTerjual = (prods[idx].totalProdukTerjual || 0) + quantity;
                writeFileAtomic(productFile, JSON.stringify(prods, null, 2));
            }
        } catch (e) {
            // Sales count update should never crash delivery
        }
    });
};

/**
 * Generate a delivery .txt filename in the format: productname_Nitem_YYYY-MM-DD-HH.MM.txt
 */
const generateDeliveryFilename = (productName, quantity) => {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2, '0');
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    return `${productName.toLowerCase()}_${quantity}item_${now.getFullYear()}-${mm}-${dd}-${hh}.${mi}.txt`;
};

/**
 * Rollback stock: restore lines back to the stock file on delivery failure.
 * Prepends lines to the file so they're available for the next purchase.
 * Uses withProductLock to prevent race conditions with concurrent reserve/commit operations.
 */
const rollbackStock = async (productName, lines) => {
    return withProductLock(productName, () => {
        try {
            const stockPath = path.join(STOCK_DIR, `${productName.toLowerCase()}.txt`);
            let existing = '';
            if (fs.existsSync(stockPath)) {
                existing = fs.readFileSync(stockPath, 'utf8').trim();
            }
            const restored = lines.join('\n') + (existing ? '\n' + existing : '');
            writeFileAtomic(stockPath, restored, 'utf8');
            rcLog('ROLLBACK', `product=${productName} restored=${lines.length} lines`);
        } catch (e) {
            console.error("Stock rollback failed:", e);
        }
    });
};

export {
    // Paths
    productFile,
    transactionsFile,
    waTransactionsFile,
    waUsersFile,
    STOCK_DIR,
    LOGS_DIR,
    // Constants
    TX_TIMEOUT_MS,
    RESERVATION_EXPIRY_MS,
    POLL_INTERVAL_MS,
    BATCH_POLL_INTERVAL_MS,
    TX_HISTORY_CAP,
    KS_CACHE_TTL_MS,
    TG_MSG_LIMIT,
    FAKE_PHONE,
    DEFAULT_USER_AGENT,
    SESSION_SECRET,
    // File helpers
    writeFileAtomic,
    // Locks
    withProductLock,
    withTxLock,
    withUserPurchaseLock,
    withWaTxFile,
    withTgTxFile,
    // Shared state
    tgActiveReservations,
    getWaPollerRunning,
    setWaPollerRunning,
    // Logging
    chatLog,
    rcLog,
    // Delivery utilities
    updateSalesCount,
    generateDeliveryFilename,
    rollbackStock,
};
