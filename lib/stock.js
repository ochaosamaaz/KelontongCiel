import fs from 'fs';
import path from 'path';
import {
    writeFileAtomic,
    withProductLock,
    tgActiveReservations,
    rcLog,
    waTransactionsFile,
    STOCK_DIR
} from './foundation.js';
import { getProducts } from './config.js';
import { loadTransactions } from './transactions.js';

/**
 * Get the full path to a product's stock file inside products/ directory.
 * @param {string} productName - Product name (will be lowercased)
 * @returns {string} Absolute path to the stock .txt file
 */
const getStockPath = (productName) => path.join(STOCK_DIR, `${productName.toLowerCase()}.txt`);

/**
 * Get stock count for a product.
 * Handles both local file-based stock and KoalaStore products.
 */
const getStockCount = (p) => {
    const productName = typeof p === 'string' ? p : p.productName;
    const product = typeof p === 'object' ? p : getProducts().find(f => f.productName === productName);

    // Digiflazz PPOB — provider-side stock. Treat unlimited_stock as effectively infinite (large sentinel).
    if (product && (product.source === 'digiflazz' || (product.productId && product.productId.startsWith('df_')))) {
        if (product.unlimited_stock) return 9999;
        return product.stockCount !== undefined ? product.stockCount : 0;
    }

    // KoalaStore — provider-side stock
    if (product && (product.source === 'koalastore' || (product.productId && product.productId.startsWith('ks_')))) {
        return product.stockCount !== undefined ? product.stockCount : 0;
    }

    const filePath = getStockPath(productName);
    try {
        const fileData = fs.readFileSync(filePath, 'utf8').trim();
        return fileData ? fileData.split(/\r?\n/).length : 0;
    } catch { return 0; }
};

/**
 * Check stock accounts (read-only, does NOT remove from file).
 * Returns array of account lines, null if file empty, [] if file missing.
 */
const checkStockAccount = (name, quantity) => {
    const filePath = getStockPath(name);
    if (!fs.existsSync(filePath)) {
        console.error('File ' + name + '.txt tidak ditemukan!');
        return [];
    }

    const data = fs.readFileSync(filePath, 'utf8');
    if (data.trim() === '') {
        return null;
    }

    let accounts = data
        .trim()
        .split('\n')
        .filter(line => line.trim() !== '');

    const selectedAccounts = accounts.slice(0, quantity);
    return selectedAccounts;
};

/**
 * Load stock by format — reads lines and REMOVES them from file.
 * Returns array of selected lines, null if file empty, [] if file missing.
 */
const loadStockByFormat = (name, quantity) => {
    const filePath = getStockPath(name);
    if (!fs.existsSync(filePath)) {
        console.error('File ' + name + '.txt tidak ditemukan!');
        return [];
    }

    const data = fs.readFileSync(filePath, 'utf8');
    if (data.trim() === '') {
        return null;
    }

    let lines = data.trim().split('\n').filter(l => l.trim().length > 0);
    const selectedLines = lines.slice(0, quantity);
    const remainingLines = lines.slice(quantity);

    writeFileAtomic(filePath, remainingLines.join('\n'), 'utf8');
    return selectedLines;
};

/**
 * Load social media accounts (email|password format) — reads and REMOVES from file.
 */
const loadSosmedAccount = (name, quantity) => {
    const filePath = getStockPath(name);
    if (!fs.existsSync(filePath)) {
        console.error('File ' + name + '.txt tidak ditemukan!');
        return [];
    }

    const data = fs.readFileSync(filePath, 'utf8');
    if (data.trim() === '') {
        return null;
    }

    let accounts = data
        .trim()
        .split('\n')
        .map((line) => {
            const [email, password] = line.split('|');
            return {
                email: email.trim(),
                password: password.trim()
            };
        });

    const selectedAccounts = accounts.slice(0, quantity);
    accounts = accounts.slice(quantity);

    const updatedData = accounts
        .map((account) => `${account.email}|${account.password}`)
        .join('\n');

    writeFileAtomic(filePath, updatedData, 'utf8');
    return selectedAccounts;
};

// ==========================================
// RACE-SAFE STOCK RESERVATION SYSTEM
// ==========================================

/**
 * Get all currently HELD (reserved but unpaid/undelivered) lines for a product
 * by scanning both TG active reservations (in-memory) and WA transaction files.
 *
 * NOTE: WA file is read without withWaTxFile lock. This is safe because:
 * 1. writeFileAtomic (rename-based) guarantees we always read a complete file
 * 2. This function is always called under withProductLock (via reserveStockForTx)
 * 3. Any staleness is conservative (over-counting held = temporary stock denial, never double-sell)
 */
const getHeldReservations = (productNameLower) => {
    let held = [];
    // Check TG active reservations (per-invoice in-memory tracking)
    for (const [ref, res] of tgActiveReservations) {
        if (res.reservationStatus === 'HELD' &&
            res.productName && res.productName.toLowerCase() === productNameLower &&
            res.reservedLines && res.reservedLines.length > 0) {
            // Check if reservation expired — auto-cleanup stale entries
            if (res.reservationExpiresAt && Date.now() > res.reservationExpiresAt) {
                rcLog('RELEASE', `txId=${ref} product=${res.productName || 'unknown'} lines=${res.reservedLines.length} reason=expired-held-check`);
                res.reservedLines = [];
                res.reservationStatus = 'RELEASED';
                tgActiveReservations.delete(ref);
                continue;
            }
            held = held.concat(res.reservedLines);
        }
    }
    // Check WA transactions
    try {
        const waTxs = loadTransactions(waTransactionsFile);
        for (const tx of waTxs) {
            if (tx.reservationStatus === 'HELD' &&
                tx.productName && tx.productName.toLowerCase() === productNameLower &&
                tx.reservedLines && tx.reservedLines.length > 0) {
                if (tx.reservationExpiresAt && Date.now() > tx.reservationExpiresAt) continue;
                held = held.concat(tx.reservedLines);
            }
        }
    } catch { }
    return held;
};

/**
 * Reserve stock lines for a transaction. Runs UNDER product lock.
 * Returns { success, reservedLines, available } or { success: false, available }
 */
const _reserveStockInner = (productName, quantity, existingHeld = []) => {
    const filePath = getStockPath(productName);
    if (!fs.existsSync(filePath)) return { success: false, available: 0 };

    const data = fs.readFileSync(filePath, 'utf8');
    if (!data.trim()) return { success: false, available: 0 };

    const allLines = data.trim().split(/\r?\n/).filter(l => l.trim());

    // Compute available = allLines minus lines already held by other reservations
    const heldCounts = new Map();
    for (const h of existingHeld) {
        heldCounts.set(h, (heldCounts.get(h) || 0) + 1);
    }

    const availableLines = [];
    for (const line of allLines) {
        const hc = heldCounts.get(line) || 0;
        if (hc > 0) {
            heldCounts.set(line, hc - 1);
        } else {
            availableLines.push(line);
        }
    }

    if (availableLines.length < quantity) {
        return { success: false, available: availableLines.length };
    }

    const reservedLines = availableLines.slice(0, quantity);
    return { success: true, reservedLines, available: availableLines.length };
};

/**
 * Reserve stock for a transaction (called at order creation time).
 * Uses product lock to prevent concurrent reservation of same lines.
 */
const reserveStockForTx = async (productName, quantity) => {
    return withProductLock(productName, () => {
        const held = getHeldReservations(productName.toLowerCase());
        const result = _reserveStockInner(productName, quantity, held);
        rcLog('RESERVE', `product=${productName} qty=${quantity} success=${result.success} available=${result.available} heldBefore=${held.length}`);
        return result;
    });
};

/**
 * Commit reserved stock: remove the reserved lines from the stock file.
 * Called after payment is confirmed. Uses product lock.
 */
const commitReservedStock = async (productName, reservedLines) => {
    return withProductLock(productName, () => {
        const filePath = getStockPath(productName);
        if (!fs.existsSync(filePath)) return null;

        const data = fs.readFileSync(filePath, 'utf8');
        let lines = data.trim().split(/\r?\n/).filter(l => l.trim());

        const toRemove = new Map();
        for (const r of reservedLines) {
            toRemove.set(r, (toRemove.get(r) || 0) + 1);
        }

        const remaining = [];
        for (const line of lines) {
            const rc = toRemove.get(line) || 0;
            if (rc > 0) {
                toRemove.set(line, rc - 1);
            } else {
                remaining.push(line);
            }
        }

        writeFileAtomic(filePath, remaining.join('\n'), 'utf8');
        rcLog('COMMIT', `product=${productName} lines=${reservedLines.length} remainingStock=${remaining.length}`);
        return reservedLines;
    });
};

/**
 * Release a reservation: clear reservation fields on the transaction object.
 * The stock file is NOT modified (lines were never removed from it).
 */
const releaseReservation = (tx) => {
    rcLog('RELEASE', `txId=${tx.id || 'tg-session'} product=${tx.productName || 'unknown'} lines=${(tx.reservedLines || []).length}`);
    tx.reservedLines = [];
    tx.reservationStatus = 'RELEASED';
    tx.reservationExpiresAt = 0;
};

/**
 * Load social media accounts (Netflix format: email|password|profile|pin) — reads and REMOVES from file.
 */
const loadSosmedAccountNetflix = (name, quantity) => {
    const filePath = getStockPath(name);
    if (!fs.existsSync(filePath)) {
        console.error('File ' + name + '.txt tidak ditemukan!');
        return [];
    }

    const data = fs.readFileSync(filePath, 'utf8');
    if (data.trim() === '') {
        return null;
    }

    let accounts = data
        .trim()
        .split('\n')
        .map((line) => {
            const [email, password, profile, pin] = line.split('|');
            return {
                email: email.trim(),
                password: password.trim(),
                profile: profile.trim(),
                pin: pin.trim(),
            };
        });

    const selectedAccounts = accounts.slice(0, quantity);
    accounts = accounts.slice(quantity);

    const updatedData = accounts
        .map((account) => `${account.email}|${account.password}|${account.profile}|${account.pin}`)
        .join('\n');

    writeFileAtomic(filePath, updatedData, 'utf8');
    return selectedAccounts;
};

/**
 * Rename a product's stock file.
 */
const renameProductFile = (oldName, newName) => {
    const oldFilePath = getStockPath(oldName);
    const newFilePath = getStockPath(newName);

    if (fs.existsSync(oldFilePath)) {
        fs.renameSync(oldFilePath, newFilePath);
    } else {
        console.error(`File ${oldFilePath} tidak ditemukan.`);
    }
};

export {
    getStockPath,
    getStockCount,
    checkStockAccount,
    loadStockByFormat,
    loadSosmedAccount,
    loadSosmedAccountNetflix,
    renameProductFile,
    getHeldReservations,
    reserveStockForTx,
    commitReservedStock,
    releaseReservation,
};