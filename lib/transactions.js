/**
 * Transaction storage — read/write helpers for TG and WA transaction files.
 * Pure file I/O operations with no bot or session dependencies.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { transactionsFile, waTransactionsFile, writeFileAtomic, TX_HISTORY_CAP, TX_TIMEOUT_MS, rcLog, withWaTxFile, withTgTxFile } from './foundation.js';
import { calculateBulkPrice } from './config.js';
import { cancelDompetxPayment } from './payments.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

// Best-effort load of dompetx API key from config (fresh each sweep — picks up settings changes).
const _loadDompetxApiKey = () => {
    try {
        const conf = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json'), 'utf8'));
        const cfg = Array.isArray(conf) ? conf[0] : conf;
        return cfg?.dompetx?.api_key || '';
    } catch { return ''; }
};

// Fire-and-forget DompetX cancel — never throws, never blocks the sweep.
const _sweepCancelDompetx = (tx, apiKey, reason) => {
    if (tx.provider !== 'dompetx' || !apiKey || !tx.dompetxTxId) return;
    cancelDompetxPayment(apiKey, tx.dompetxTxId).then(r => {
        rcLog('DOMPETX_CANCEL', `tx=${tx.dompetxTxId} reason=${reason} status=${r.status}${r.message ? ' msg=' + r.message : ''}`);
    }).catch(() => { /* swallow */ });
};

// ==========================================
// COMMON READ/WRITE
// ==========================================

/**
 * Load transactions from a JSON file. Returns [] on any error.
 */
const loadTransactions = (filePath) => {
    try {
        if (fs.existsSync(filePath)) {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        }
    } catch (e) { /* corrupt file — return empty */ }
    return [];
};

/**
 * Save transactions array to a JSON file atomically.
 */
const saveTransactionFile = (filePath, data) => {
    writeFileAtomic(filePath, JSON.stringify(data, null, 2), 'utf8');
};

/**
 * Load all transactions (TG + WA merged).
 */
const loadAllTransactions = () => {
    let all = [];
    try { all = all.concat(loadTransactions(transactionsFile)); } catch {}
    try { all = all.concat(loadTransactions(waTransactionsFile)); } catch {}
    return all;
};

// ==========================================
// TG TRANSACTION HELPERS
// ==========================================

/**
 * Save a new TG transaction entry (UNPAID) to tele_transactions.json.
 */
const saveTgTransaction = async (reference, product, quantity, userInfo, paymentProvider, paidAmount, extraData) => {
    try {
        await withTgTxFile(history => {
            const fullName = (userInfo.first_name || "") + (userInfo.last_name ? " " + userInfo.last_name : "");
            const displayName = fullName.trim() || userInfo.username || userInfo.id || "Anonymous";
            const parsedPaidAmount = paidAmount ? parseInt(paidAmount) : 0;
            const txBulk = calculateBulkPrice(product, quantity);
            const totalPrice = parsedPaidAmount || txBulk.totalPrice;

            const entry = {
                id: reference,
                reference: reference,
                chatId: userInfo.id || null,
                name: displayName,
                username: userInfo.username || '',
                productId: product.productId || '',
                productName: product.productName,
                price: txBulk.unitPrice,
                quantity: quantity,
                totalPrice: totalPrice,
                profit: txBulk.totalProfit,
                status: 'UNPAID',
                provider: paymentProvider || 'unknown',
                source: product.source || 'local',
                timestamp: Date.now(),
                processing: false,
                delivered: false,
                deliveryState: 'NONE'
            };
            // Merge extra data (e.g. gopayExpiresAt for GoPay recovery)
            if (extraData && typeof extraData === 'object') Object.assign(entry, extraData);
            history.push(entry);
            // Trim to cap inside the lock — mutate in-place via splice
            if (history.length > TX_HISTORY_CAP) history.splice(0, history.length - TX_HISTORY_CAP);
        });
    } catch (e) { console.error("[TG] Error saving UNPAID transaction:", e); }
};

/**
 * Update an existing TG transaction status by reference.
 * Optional paidAmount: if provided, also corrects the stored amount.
 */
const updateTgTransactionStatus = async (reference, newStatus, paidAmount) => {
    try {
        await withTgTxFile(history => {
            const idx = history.findIndex(tx => tx.reference === reference);
            if (idx !== -1) {
                history[idx].status = newStatus;
                if (paidAmount && parseInt(paidAmount) > 0) {
                    history[idx].totalPrice = parseInt(paidAmount);
                }
            }
        });
    } catch (e) { console.error(`[TG] Error updating transaction ${reference} to ${newStatus}:`, e); }
};

// ==========================================
// PERIODIC SWEEP — expire orphan UNPAID transactions
// ==========================================

/**
 * Sweep both TG and WA transaction files for UNPAID entries older than TX_TIMEOUT_MS.
 * Marks them EXPIRED and releases any held reservations.
 *
 * This is a lightweight, idempotent sweep — it does NOT check provider APIs
 * (that's the startup recovery's job). It only catches orphan transactions
 * where the user left without canceling and no active poller is watching.
 *
 * Safe to run concurrently with TG/WA pollers because:
 * - Setting EXPIRED on an already-PAID tx is impossible (pollers set PAID first, sweep skips non-UNPAID)
 * - Sweep only targets txs past TX_TIMEOUT_MS — pollers handle txs within the timeout window
 * - writeFileAtomic ensures no partial writes
 */
const sweepStaleTransactions = async () => {
    const now = Date.now();
    let totalExpired = 0;
    const dompetxApiKey = _loadDompetxApiKey();
    const toCancel = []; // collect DompetX txs to cancel post-lock (no API calls inside lock)

    // --- TG Transactions (uses withTgTxFile lock to prevent race with poller/order creation) ---
    try {
        await withTgTxFile(tgTxs => {
            for (const tx of tgTxs) {
                if (tx.status !== 'UNPAID') continue;
                const txTime = tx.timestamp || 0;
                if (txTime > 0 && (now - txTime) > TX_TIMEOUT_MS) {
                    tx.status = 'EXPIRED';
                    if (tx.reservationStatus === 'HELD') {
                        // Inline release (avoids circular dep with stock.js)
                        rcLog('RELEASE', `txId=${tx.id || tx.reference} product=${tx.productName || 'unknown'} lines=${(tx.reservedLines || []).length} reason=sweep`);
                        tx.reservedLines = [];
                        tx.reservationStatus = 'RELEASED';
                        tx.reservationExpiresAt = 0;
                    }
                    if (tx.provider === 'dompetx' && tx.dompetxTxId) toCancel.push({ ...tx });
                    totalExpired++;
                    rcLog('SWEEP', `Expired orphan TG tx ref=${tx.reference || tx.id} provider=${tx.provider || 'unknown'} age=${Math.round((now - txTime) / 1000)}s`);
                }
            }
        });
    } catch (e) {
        console.error('[SWEEP] Failed to sweep TG transactions:', e.message);
    }

    // --- WA Transactions (uses withWaTxFile lock to prevent race with poller/order creation) ---
    try {
        await withWaTxFile(waTxs => {
            for (const tx of waTxs) {
                if (tx.status !== 'UNPAID') continue;
                const txTime = tx.timestamp || 0;
                if (txTime > 0 && (now - txTime) > TX_TIMEOUT_MS) {
                    tx.status = 'EXPIRED';
                    if (tx.reservationStatus === 'HELD') {
                        // Inline release (avoids circular dep with stock.js)
                        rcLog('RELEASE', `txId=${tx.id || tx.reference} product=${tx.productName || 'unknown'} lines=${(tx.reservedLines || []).length} reason=sweep`);
                        tx.reservedLines = [];
                        tx.reservationStatus = 'RELEASED';
                        tx.reservationExpiresAt = 0;
                    }
                    if (tx.provider === 'dompetx' && tx.dompetxTxId) toCancel.push({ ...tx });
                    totalExpired++;
                    rcLog('SWEEP', `Expired orphan WA tx ref=${tx.reference || tx.id} provider=${tx.provider || 'unknown'} age=${Math.round((now - txTime) / 1000)}s`);
                }
            }
        });
    } catch (e) {
        console.error('[SWEEP] Failed to sweep WA transactions:', e.message);
    }

    // Cancel DompetX transactions outside the file lock (fire-and-forget — no need to await)
    if (toCancel.length > 0 && dompetxApiKey) {
        for (const tx of toCancel) _sweepCancelDompetx(tx, dompetxApiKey, 'sweep-orphan');
    }

    if (totalExpired > 0) {
        console.log(`[SWEEP] Expired ${totalExpired} orphan transaction(s)`);
    }

    return totalExpired;
};

export {
    loadTransactions,
    saveTransactionFile,
    loadAllTransactions,
    saveTgTransaction,
    updateTgTransactionStatus,
    sweepStaleTransactions,
};
