/**
 * GoPay/GoBiz Payment Module for Storebot
 * 
 * Handles:
 * - GoBiz API authentication (3-tier fallback)
 * - QRIS static → dynamic conversion
 * - Collision detection
 * - Payment status checking via journals/search
 */

import fetch from 'node-fetch';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { BATCH_POLL_INTERVAL_MS } from './foundation.js';
import { loadAllTransactions } from './transactions.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GOBIZ_BASE_URL = 'https://api.gobiz.co.id';
const CREDS_FILE = path.join(__dirname, '..', 'gopay.creds.json');

// ─────────────────────────────────────────────
// In-Memory Auth Token Cache
// ─────────────────────────────────────────────
const AUTH_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes
let _cachedAccessToken = null;
let _cachedTokenExpiry = 0;

function getCachedToken() {
    if (_cachedAccessToken && Date.now() < _cachedTokenExpiry) {
        return _cachedAccessToken;
    }
    return null;
}

function setCachedToken(token) {
    _cachedAccessToken = token;
    _cachedTokenExpiry = Date.now() + AUTH_TOKEN_TTL_MS;
}

function clearCachedToken() {
    _cachedAccessToken = null;
    _cachedTokenExpiry = 0;
}

// ─────────────────────────────────────────────
// In-Memory Journal Cache (Batch Poller)
// ─────────────────────────────────────────────
// Map<amountSen, { hit, cachedAt }> — keyed by amount for payment matching
const _journalCache = new Map();
// Raw hits array — full journal entries for dashboard/collision detection
let _journalHitsRaw = [];
let _lastPollTime = null;
let _lastPollError = null;
let _pollCount = 0;
let _pollHitCount = 0;
let _batchPollerTimer = null;
let _batchPollerRunning = false;

// Generate a persistent unique ID per instance
let instanceUniqueId = null;
function getUniqueId() {
    if (!instanceUniqueId) {
        instanceUniqueId = crypto.randomUUID();
    }
    return instanceUniqueId;
}

// ─────────────────────────────────────────────
// Credential Storage (JSON file key-value store)
// ─────────────────────────────────────────────

function loadCreds() {
    try {
        if (fs.existsSync(CREDS_FILE)) {
            return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
        }
    } catch (e) {
        console.error('[GoPay] Failed to load creds:', e.message);
    }
    return {};
}

function saveCreds(creds) {
    try {
        const tmpFile = CREDS_FILE + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(creds, null, 2));
        fs.renameSync(tmpFile, CREDS_FILE);
    } catch (e) {
        console.error('[GoPay] Failed to save creds:', e.message);
    }
}

function getCred(key) {
    return loadCreds()[key] || null;
}

function setCred(key, value) {
    const creds = loadCreds();
    creds[key] = value;
    saveCreds(creds);
}

function persistTokens(tokens) {
    const creds = loadCreds();
    if (tokens.access_token) creds.GOBIZ_ACCESS_TOKEN = tokens.access_token;
    if (tokens.refresh_token) creds.GOBIZ_REFRESH_TOKEN = tokens.refresh_token;
    saveCreds(creds);
}

// ─────────────────────────────────────────────
// HTTP Headers
// ─────────────────────────────────────────────

function buildHeaders(accessToken, endpoint) {
    const isTokenEndpoint = endpoint === '/goid/token';
    const origin = isTokenEndpoint ? 'https://app.gobiz.com' : 'https://portal.gofoodmerchant.co.id';
    const referer = isTokenEndpoint ? 'https://app.gobiz.com/' : 'https://portal.gofoodmerchant.co.id/';

    const headers = {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'id',
        'Authentication-Type': 'go-id',
        'Authorization': accessToken ? `Bearer ${accessToken}` : 'Bearer',
        'Connection': 'keep-alive',
        'Content-Type': 'application/json',
        'Gojek-Country-Code': 'ID',
        'Gojek-Timezone': 'Asia/Jakarta',
        'Origin': origin,
        'Referer': referer,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
        'X-AppVersion': 'platform-v3.101.0-8918927d',
        'X-PhoneMake': 'Apple',
        'X-PhoneModel': 'iPhone',
        'X-Platform': 'Web',
        'X-User-Locale': 'en-US',
        'X-User-Type': 'merchant',
        'sec-ch-ua': '"Google Chrome";v="147", "Not.A/Brand";v="8", "Chromium";v="147"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"iOS"',
        'x-DeviceOS': 'Web',
        'x-appId': 'go-biz-web-dashboard',
        'x-uniqueid': getUniqueId()
    };

    return headers;
}

function buildJournalHeaders(accessToken) {
    const headers = buildHeaders(accessToken, '/journals/search');
    headers['Accept'] = 'application/json, text/plain, */*, application/vnd.journal.v1+json';
    return headers;
}

// ─────────────────────────────────────────────
// GoBiz API Methods
// ─────────────────────────────────────────────

async function loginRequest(email) {
    const res = await fetch(`${GOBIZ_BASE_URL}/goid/login/request`, {
        method: 'POST',
        headers: buildHeaders(null, '/goid/login/request'),
        body: JSON.stringify({
            email: email,
            login_type: 'password',
            client_id: 'go-biz-web-new'
        })
    });
    return res.json();
}

async function getTokenByPassword(email, password) {
    const res = await fetch(`${GOBIZ_BASE_URL}/goid/token`, {
        method: 'POST',
        headers: buildHeaders(null, '/goid/token'),
        body: JSON.stringify({
            client_id: 'go-biz-web-new',
            grant_type: 'password',
            data: { email, password }
        })
    });
    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`GoBiz password login failed (${res.status}): ${errBody}`);
    }
    return res.json();
}

async function getTokenByRefresh(refreshToken) {
    const res = await fetch(`${GOBIZ_BASE_URL}/goid/token`, {
        method: 'POST',
        headers: buildHeaders(null, '/goid/token'),
        body: JSON.stringify({
            client_id: 'go-biz-web-new',
            grant_type: 'refresh_token',
            data: { refresh_token: refreshToken }
        })
    });
    if (!res.ok) return null;
    return res.json();
}

async function getMe(accessToken) {
    try {
        const res = await fetch(`${GOBIZ_BASE_URL}/v1/users/me`, {
            method: 'GET',
            headers: buildHeaders(accessToken, '/v1/users/me')
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data && data.user && data.user.expired !== true) {
            return data;
        }
        return null;
    } catch (e) {
        return null;
    }
}

async function searchJournals(accessToken, startMs, endMs, amountRupiah, merchantId) {
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    const amountSen = amountRupiah * 100;

    const payload = {
        from: 0,
        size: 50,
        sort: { time: { order: 'desc' } },
        query: [{
            clauses: [
                { field: 'metadata.transaction.transaction_time', op: 'gte', value: startIso },
                { field: 'metadata.transaction.transaction_time', op: 'lte', value: endIso },
                { field: 'metadata.transaction.merchant_id', op: 'equal', value: merchantId },
                { field: 'metadata.transaction.gross_amount', op: 'equal', value: amountSen }
            ],
            op: 'and'
        }]
    };

    const res = await fetch(`${GOBIZ_BASE_URL}/journals/search`, {
        method: 'POST',
        headers: buildJournalHeaders(accessToken),
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`GoBiz journals/search failed (${res.status}): ${errBody}`);
    }

    return res.json();
}

// ─────────────────────────────────────────────
// Authentication (Lazy Invalidation)
// ─────────────────────────────────────────────

/**
 * Get a usable access token. Does NOT validate via API — callers handle 401 via refreshAuth().
 *
 * Priority: in-memory cache → disk (gopay.creds.json) → refresh token → password login.
 * Password login only happens when no tokens exist at all (first run).
 *
 * @param {string} email - GoBiz email
 * @param {string} password - GoBiz password/PIN
 * @returns {Promise<string>} Access token (assumed valid — caller retries on 401)
 */
async function authenticate(email, password) {
    // 1. In-memory cache (zero cost)
    const cached = getCachedToken();
    if (cached) return cached;

    // 2. Disk token — trust it, no getMe() validation
    const access = getCred('GOBIZ_ACCESS_TOKEN');
    if (access) {
        setCachedToken(access);
        return access;
    }

    // 3. No access token on disk — try refresh token
    const refresh = getCred('GOBIZ_REFRESH_TOKEN');
    if (refresh) {
        console.log('[GoPay] No access token, trying refresh token...');
        const refreshed = await getTokenByRefresh(refresh);
        if (refreshed && refreshed.access_token) {
            persistTokens(refreshed);
            setCachedToken(refreshed.access_token);
            return refreshed.access_token;
        }
    }

    // 4. No tokens at all — full password login (first run only)
    console.log('[GoPay] No tokens found, logging in with password...');
    await loginRequest(email);
    const tokens = await getTokenByPassword(email, password);
    persistTokens(tokens);
    // Fetch merchant_id on first login
    try {
        const me = await getMe(tokens.access_token);
        if (me && me.user && me.user.merchant_id) {
            setCred('GOBIZ_MERCHANT_ID', me.user.merchant_id);
        }
    } catch (_) { /* merchant_id can also come from config */ }
    setCachedToken(tokens.access_token);
    return tokens.access_token;
}

/**
 * Handle 401/403 — refresh or re-login, return new valid token.
 * Called by API callers when they get an auth error.
 *
 * @param {string} email - GoBiz email
 * @param {string} password - GoBiz password/PIN
 * @returns {Promise<string>} Fresh access token
 */
async function refreshAuth(email, password) {
    clearCachedToken();

    // Try refresh token first (cheap — no password needed)
    const refresh = getCred('GOBIZ_REFRESH_TOKEN');
    if (refresh) {
        console.log('[GoPay] 401 received, trying refresh token...');
        const refreshed = await getTokenByRefresh(refresh);
        if (refreshed && refreshed.access_token) {
            persistTokens(refreshed);
            setCachedToken(refreshed.access_token);
            return refreshed.access_token;
        }
    }

    // Refresh failed — full password login
    console.log('[GoPay] Refresh failed, logging in with password...');
    await loginRequest(email);
    const tokens = await getTokenByPassword(email, password);
    persistTokens(tokens);
    try {
        const me = await getMe(tokens.access_token);
        if (me && me.user && me.user.merchant_id) {
            setCred('GOBIZ_MERCHANT_ID', me.user.merchant_id);
        }
    } catch (_) { /* merchant_id can also come from config */ }
    setCachedToken(tokens.access_token);
    return tokens.access_token;
}

// ─────────────────────────────────────────────
// QRIS Static → Dynamic Conversion
// ─────────────────────────────────────────────

/**
 * CRC-16/CCITT calculation
 * @param {string} str - Input string
 * @returns {string} 4-char uppercase hex CRC
 */
function crc16ccitt(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
        crc ^= (str.charCodeAt(i) << 8);
        for (let j = 0; j < 8; j++) {
            if (crc & 0x8000) {
                crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
            } else {
                crc = (crc << 1) & 0xFFFF;
            }
        }
    }
    return (crc & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Convert static QRIS string to dynamic QRIS with embedded amount.
 * @param {string} qrString - Static QRIS string from merchant
 * @param {number} amount - Amount in Rupiah
 * @returns {string} Dynamic QRIS string
 */
function staticToDynamicQris(qrString, amount) {
    // 1. Strip CRC (last 4 chars)
    let result = qrString.substring(0, qrString.length - 4);

    // 2. Change static → dynamic (010211 → 010212)
    result = result.replace('010211', '010212');

    // 3. Insert tag 54 (transaction amount) before "5802ID"
    const amountStr = String(amount);
    const lengthStr = String(amountStr.length).padStart(2, '0');
    const tag54 = '54' + lengthStr + amountStr;

    const parts = result.split('5802ID');
    if (parts.length < 2) {
        throw new Error('Invalid QRIS: cannot find "5802ID" marker');
    }
    result = parts[0] + tag54 + '5802ID' + parts.slice(1).join('5802ID');

    // 4. Calculate CRC-16/CCITT
    // Note: result already ends with "6304" (CRC indicator tag) from the original QRIS
    // after stripping only the 4-char CRC value. So we calculate CRC on result as-is.
    const crc = crc16ccitt(result);

    // 5. Final QRIS = result (ending with 6304) + CRC hex
    return result + crc;
}

/**
 * Generate QR image URL from QRIS string via quickchart.io
 * @param {string} qrisString - Dynamic QRIS string
 * @returns {string} URL to QR image
 */
function generateQrImageUrl(qrisString) {
    const params = new URLSearchParams({
        text: qrisString,
        size: '512',
        ecLevel: 'Q',
        dark: '000000',
        light: 'fff9db',
        margin: '2',
        centerImageWidth: '120',
        centerImageHeight: '120'
    });
    return `https://quickchart.io/qr?${params.toString()}`;
}

// ─────────────────────────────────────────────
// Collision Detection
// ─────────────────────────────────────────────

/**
 * Find a unique payment amount that doesn't collide with existing pending transactions.
 * 
 * @param {number} baseAmount - Original price in Rupiah
 * @param {string} accessToken - Valid GoBiz access token
 * @param {string} merchantId - GoBiz merchant ID
 * @param {number} windowMinutes - Payment expiry window in minutes (default 5)
 * @param {Function} getPendingTxAmounts - Function that returns array of pending tx amounts from local DB
 * @returns {Promise<number>} Unique amount (may differ from baseAmount)
 */
async function detectCollision(baseAmount, accessToken, merchantId, windowMinutes, getPendingTxAmounts, uniqueMin = 0, uniqueMax = 200) {
    const MAX_OFFSET = Math.max(uniqueMax, uniqueMin);

    // Build set of candidate offsets (uniqueMin–uniqueMax), then shuffle randomly
    const MIN_OFFSET = Math.min(uniqueMin, uniqueMax);
    const offsets = Array.from({ length: MAX_OFFSET - MIN_OFFSET + 1 }, (_, i) => MIN_OFFSET + i);
    for (let i = offsets.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [offsets[i], offsets[j]] = [offsets[j], offsets[i]];
    }

    const pendingAmounts = getPendingTxAmounts();
    const useCache = _batchPollerRunning && _lastPollTime;

    for (const offset of offsets) {
        const amount = baseAmount + offset;

        // Check 1: Local DB collision
        if (pendingAmounts.includes(amount)) continue;

        // Check 2: GoBiz journals collision — use cache if poller running, else API
        const amountSen = amount * 100;
        if (useCache) {
            // Zero API cost — check in-memory cache from batch poller
            if (_journalCache.has(amountSen)) continue;
        } else {
            // Poller not running — fallback to direct API
            try {
                const windowMs = windowMinutes * 60 * 1000;
                const now = Date.now();
                const journalResult = await searchJournals(accessToken, now - windowMs, now, amount, merchantId);
                if (journalResult && journalResult.hits && journalResult.hits.length > 0) continue;
            } catch (e) {
                console.error('[GoPay] Collision check journal error:', e.message);
            }
        }

        // No collision
        return amount;
    }

    // All slots occupied — reset: use base amount (force override)
    console.warn(`[GoPay] All ${MAX_OFFSET + 1} unique code slots full for amount ${baseAmount}. Resetting to base.`);
    return baseAmount;
}

// ─────────────────────────────────────────────
// Payment Status Check
// ─────────────────────────────────────────────

/**
 * Check if a payment has been received for a given amount within a time window.
 * 
 * @param {string} accessToken - Valid GoBiz access token
 * @param {string} merchantId - GoBiz merchant ID
 * @param {number} amountRupiah - Expected payment amount in Rupiah
 * @param {number} createdAtMs - Transaction creation timestamp (ms)
 * @param {number} expiresAtMs - Transaction expiry timestamp (ms)
 * @returns {Promise<{status: string, providerRef: string|null}>}
 */
async function checkPaymentStatus(accessToken, merchantId, amountRupiah, createdAtMs, expiresAtMs) {
    const result = { status: 'Unpaid', providerRef: null };

    // Check expired first
    if (Date.now() > expiresAtMs) {
        result.status = 'Failed'; // Maps to 'EXPIRED' in storebot convention
    }

    // Hit GoBiz API regardless (payment might have come in at the last second)
    try {
        const journalResult = await searchJournals(accessToken, createdAtMs, expiresAtMs, amountRupiah, merchantId);
        if (journalResult && journalResult.hits && journalResult.hits.length > 0) {
            const hit = journalResult.hits[0];
            // Extract provider reference
            const txMeta = hit.metadata?.transaction?.metadata || {};
            const provMeta = hit.metadata?.provider_metadata?.metadata || {};
            result.providerRef = txMeta.INTERNAL_CHALLENGE_ID || provMeta.retrieval_reference_number || null;
            result.status = 'Paid'; // Override expired — payment at last second still counts
        }
    } catch (e) {
        console.error('[GoPay] Payment check error:', e.message);
        // Don't change status on API error — keep current state
    }

    return result;
}

// ─────────────────────────────────────────────
// High-Level API (used by server.js)
// ─────────────────────────────────────────────

/**
 * Create a GoPay QRIS payment.
 * 
 * @param {Object} gopayConfig - { email, password, merchant_id, qr_string }
 * @param {number} baseAmount - Product price × quantity in Rupiah
 * @param {Function} getPendingTxAmounts - Returns array of pending tx amounts from local DB
 * @param {number} [expiryMinutes=5] - Payment expiry in minutes
 * @param {string} [invoicePrefix='WAINV'] - Invoice prefix (e.g. 'WAINV' or 'TELEINV')
 * @returns {Promise<{reference: string, paymentRupiah: number, qrcode: string, imageQr: string}>}
 */
async function createPayment(gopayConfig, baseAmount, getPendingTxAmounts, expiryMinutes = 5, invoicePrefix = 'WAINV') {
    const { email, password, merchant_id, qr_string, unique_min, unique_max } = gopayConfig;
    const uMin = (unique_min != null && unique_min >= 0) ? unique_min : 0;
    const uMax = (unique_max != null && unique_max >= 1) ? unique_max : 200;

    if (!email || !password) throw new Error('GoPay belum dikonfigurasi (email/password kosong).');
    if (!qr_string) throw new Error('GoPay QR String (QRIS statis) belum diisi.');

    // 1. Authenticate (lazy — no validation, just get token)
    let accessToken = await authenticate(email, password);

    // 2. Get merchant ID (from config or from creds file)
    const merchantId = merchant_id || getCred('GOBIZ_MERCHANT_ID');
    if (!merchantId) throw new Error('GoPay Merchant ID tidak ditemukan. Pastikan login berhasil.');

    // 3. Collision detection — find unique amount (random offset between uMin–uMax)
    //    Retry once on auth error (lazy invalidation)
    let uniqueAmount;
    try {
        uniqueAmount = await detectCollision(baseAmount, accessToken, merchantId, expiryMinutes, getPendingTxAmounts, uMin, uMax);
    } catch (e) {
        if (e.message && (e.message.includes('401') || e.message.includes('403'))) {
            accessToken = await refreshAuth(email, password);
            uniqueAmount = await detectCollision(baseAmount, accessToken, merchantId, expiryMinutes, getPendingTxAmounts, uMin, uMax);
        } else {
            throw e;
        }
    }

    // 4. Generate dynamic QRIS
    const dynamicQris = staticToDynamicQris(qr_string, uniqueAmount);

    // 5. Generate reference ID with caller-specified prefix
    const reference = `${invoicePrefix}-${Date.now()}${crypto.randomBytes(4).toString('hex')}`;

    // 6. Generate QR image URL
    const imageQrUrl = generateQrImageUrl(dynamicQris);

    return {
        reference,
        paymentRupiah: uniqueAmount,
        qrcode: dynamicQris,
        imageQr: imageQrUrl
    };
}

/**
 * Check payment status for a GoPay transaction.
 * 
 * @param {Object} gopayConfig - { email, password, merchant_id }
 * @param {number} amountRupiah - Payment amount in Rupiah
 * @param {number} createdAtMs - Transaction creation timestamp (ms)
 * @param {number} expiresAtMs - Transaction expiry timestamp (ms)
 * @returns {Promise<{status: string, providerRef: string|null}>} status: 'Paid'|'Failed'|'Unpaid'
 */
async function checkStatus(gopayConfig, amountRupiah, createdAtMs, expiresAtMs) {
    const { email, password, merchant_id } = gopayConfig;

    let accessToken = await authenticate(email, password);
    const merchantId = merchant_id || getCred('GOBIZ_MERCHANT_ID');
    if (!merchantId) throw new Error('GoPay Merchant ID tidak ditemukan.');

    try {
        return await checkPaymentStatus(accessToken, merchantId, amountRupiah, createdAtMs, expiresAtMs);
    } catch (e) {
        // Lazy invalidation: retry once with fresh token on auth error
        if (e.message && (e.message.includes('401') || e.message.includes('403'))) {
            accessToken = await refreshAuth(email, password);
            return checkPaymentStatus(accessToken, merchantId, amountRupiah, createdAtMs, expiresAtMs);
        }
        throw e;
    }
}

/**
 * Fetch recent GoPay transactions (for dashboard).
 * 
 * @param {Object} gopayConfig - { email, password, merchant_id }
 * @param {number} [hoursBack=24] - How many hours back to search
 * @returns {Promise<Array>} Array of transaction hits
 */
async function getRecentTransactions(gopayConfig, hoursBack = 24) {
    // If batch poller is running, return cached hits (zero API cost)
    // Cache covers last 15 minutes — sufficient for real-time dashboard
    if (_batchPollerRunning && _lastPollTime) {
        return [..._journalHitsRaw];
    }

    // Poller not running — fallback to direct API call
    const { email, password, merchant_id } = gopayConfig;

    let accessToken = await authenticate(email, password);
    const merchantId = merchant_id || getCred('GOBIZ_MERCHANT_ID');
    if (!merchantId) return [];

    const now = Date.now();
    const startMs = now - (hoursBack * 60 * 60 * 1000);

    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(now).toISOString();

    const payload = {
        from: 0,
        size: 50,
        sort: { time: { order: 'desc' } },
        query: [{
            clauses: [
                { field: 'metadata.transaction.transaction_time', op: 'gte', value: startIso },
                { field: 'metadata.transaction.transaction_time', op: 'lte', value: endIso },
                { field: 'metadata.transaction.merchant_id', op: 'equal', value: merchantId }
            ],
            op: 'and'
        }]
    };

    let res = await fetch(`${GOBIZ_BASE_URL}/journals/search`, {
        method: 'POST',
        headers: buildJournalHeaders(accessToken),
        body: JSON.stringify(payload)
    });

    if (res.status === 401 || res.status === 403) {
        accessToken = await refreshAuth(email, password);
        res = await fetch(`${GOBIZ_BASE_URL}/journals/search`, {
            method: 'POST',
            headers: buildJournalHeaders(accessToken),
            body: JSON.stringify(payload)
        });
    }

    if (!res.ok) return [];
    const data = await res.json();
    return data.hits || [];
}

// ─────────────────────────────────────────────
// Batch Poller — Single global poll loop
// ─────────────────────────────────────────────

/**
 * Execute one batch poll cycle:
 * 1. Authenticate once (using cached token if valid)
 * 2. searchJournals once WITHOUT amount filter (all recent txs)
 * 3. Populate _journalCache keyed by amount_in_sen
 *
 * @param {Object} gopayConfig - { email, password, merchant_id }
 */
async function _doBatchPoll(gopayConfig) {
    const { email, password, merchant_id } = gopayConfig;
    if (!email || !password) return;

    // Skip API call if no pending GoPay transactions — prevents unnecessary hits
    try {
        const allTx = loadAllTransactions();
        // Also check web_transactions.json
        let webTxs = [];
        try {
            const webTxFile = path.join(__dirname, '..', 'web_transactions.json');
            if (fs.existsSync(webTxFile)) webTxs = JSON.parse(fs.readFileSync(webTxFile, 'utf8'));
        } catch {}
        const combined = [...allTx, ...webTxs];
        const hasPending = combined.some(t => t.status === 'UNPAID' && (t.provider === 'gopay' || t.paymentProvider === 'gopay'));
        if (!hasPending) {
            console.log('[GoPay Batch] No pending GoPay transactions — skipping poll.');
            return;
        }
    } catch (e) {
        // If tx file read fails, proceed with poll as safety fallback
    }

    try {
        let accessToken = await authenticate(email, password);

        const merchantId = merchant_id || getCred('GOBIZ_MERCHANT_ID');
        if (!merchantId) {
            _lastPollError = 'Merchant ID not found';
            return;
        }

        // Query last 15 minutes of journals (covers any pending tx window)
        const now = Date.now();
        const startMs = now - (15 * 60 * 1000);
        const startIso = new Date(startMs).toISOString();
        const endIso = new Date(now).toISOString();

        const payload = {
            from: 0,
            size: 50,
            sort: { time: { order: 'desc' } },
            query: [{
                clauses: [
                    { field: 'metadata.transaction.transaction_time', op: 'gte', value: startIso },
                    { field: 'metadata.transaction.transaction_time', op: 'lte', value: endIso },
                    { field: 'metadata.transaction.merchant_id', op: 'equal', value: merchantId }
                ],
                op: 'and'
            }]
        };

        let res = await fetch(`${GOBIZ_BASE_URL}/journals/search`, {
            method: 'POST',
            headers: buildJournalHeaders(accessToken),
            body: JSON.stringify(payload)
        });

        // Lazy invalidation: 401/403 → refresh auth → retry once
        if (res.status === 401 || res.status === 403) {
            console.log('[GoPay Batch] Token expired, refreshing...');
            accessToken = await refreshAuth(email, password);
            res = await fetch(`${GOBIZ_BASE_URL}/journals/search`, {
                method: 'POST',
                headers: buildJournalHeaders(accessToken),
                body: JSON.stringify(payload)
            });
        }

        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            _lastPollError = `HTTP ${res.status}: ${errBody.slice(0, 200)}`;
            return;
        }

        const data = await res.json();
        const hits = data.hits || [];

        // Rebuild caches
        _journalCache.clear();
        _journalHitsRaw = hits; // raw hits for dashboard & collision detection
        for (const hit of hits) {
            const amountSen = hit.metadata?.transaction?.gross_amount;
            if (amountSen != null) {
                // Store first (most recent) hit per amount — for payment matching
                if (!_journalCache.has(amountSen)) {
                    _journalCache.set(amountSen, { hit, cachedAt: now });
                }
            }
        }

        _lastPollTime = now;
        _lastPollError = null;
        _pollCount++;
        _pollHitCount = hits.length;

        console.log(`[GoPay Batch] Poll #${_pollCount}: ${hits.length} hits cached, ${_journalCache.size} unique amounts`);
    } catch (e) {
        _lastPollError = e.message;
        console.error('[GoPay Batch] Poll error:', e.message);
    }
}

/**
 * Start the global batch poller.
 * Runs immediately once, then every BATCH_POLL_INTERVAL_MS.
 *
 * @param {Object} gopayConfig - { email, password, merchant_id }
 */
async function startGopayBatchPoller(gopayConfig) {
    if (_batchPollerRunning) {
        console.log('[GoPay Batch] Poller already running, skipping start.');
        return;
    }

    console.log(`[GoPay Batch] Starting batch poller (interval: ${BATCH_POLL_INTERVAL_MS}ms)...`);
    _batchPollerRunning = true;

    // Immediate first poll — await so cache is ready before callers proceed
    try {
        await _doBatchPoll(gopayConfig);
    } catch (e) {
        console.error('[GoPay Batch] Initial poll error:', e.message);
    }

    // Recurring poll
    _batchPollerTimer = setInterval(() => {
        _doBatchPoll(gopayConfig).catch(e => console.error('[GoPay Batch] Poll error:', e.message));
    }, BATCH_POLL_INTERVAL_MS);
}

/**
 * Stop the global batch poller.
 */
function stopGopayBatchPoller() {
    if (_batchPollerTimer) {
        clearInterval(_batchPollerTimer);
        _batchPollerTimer = null;
    }
    _batchPollerRunning = false;
    _journalCache.clear();
    _journalHitsRaw = [];
    console.log('[GoPay Batch] Poller stopped.');
}

/**
 * Check payment status from the in-memory journal cache.
 * Called by WA/TG pollers instead of hitting GoBiz API directly.
 *
 * @param {number} amountRupiah - Expected payment amount in Rupiah
 * @param {number} createdAtMs - Transaction creation timestamp (ms)
 * @param {number} expiresAtMs - Transaction expiry timestamp (ms)
 * @returns {{status: string, providerRef: string|null}}
 */
function checkStatusFromCache(amountRupiah, createdAtMs, expiresAtMs) {
    const result = { status: 'Unpaid', providerRef: null };

    // Check expired first
    if (Date.now() > expiresAtMs) {
        result.status = 'Failed';
    }

    // Look up in cache by amount (in sen, matching GoBiz format)
    const amountSen = amountRupiah * 100;
    const cached = _journalCache.get(amountSen);

    if (cached && cached.hit) {
        const hit = cached.hit;
        const txTime = hit.metadata?.transaction?.transaction_time;

        // Validate: journal entry must fall within the tx time window
        if (txTime) {
            const txTimeMs = new Date(txTime).getTime();
            if (txTimeMs >= createdAtMs && txTimeMs <= expiresAtMs) {
                const txMeta = hit.metadata?.transaction?.metadata || {};
                const provMeta = hit.metadata?.provider_metadata?.metadata || {};
                result.providerRef = txMeta.INTERNAL_CHALLENGE_ID || provMeta.retrieval_reference_number || null;
                result.status = 'Paid';
            }
        }
    }

    return result;
}

/**
 * Debug endpoint data: returns poller status and cache contents.
 * @returns {Object} Poller status info
 */
function getGopayPollerStatus() {
    const cacheEntries = [];
    for (const [amountSen, entry] of _journalCache.entries()) {
        const hit = entry.hit;
        const txMeta = hit.metadata?.transaction || {};
        cacheEntries.push({
            amountRupiah: amountSen / 100,
            amountSen,
            transactionTime: txMeta.transaction_time || null,
            merchantId: txMeta.merchant_id || null,
            type: txMeta.type || null,
            cachedAt: new Date(entry.cachedAt).toISOString()
        });
    }

    return {
        running: _batchPollerRunning,
        intervalMs: BATCH_POLL_INTERVAL_MS,
        lastPollTime: _lastPollTime ? new Date(_lastPollTime).toISOString() : null,
        lastPollError: _lastPollError,
        pollCount: _pollCount,
        lastPollHitCount: _pollHitCount,
        cacheSize: _journalCache.size,
        authTokenCached: !!getCachedToken(),
        authTokenExpiresAt: _cachedTokenExpiry ? new Date(_cachedTokenExpiry).toISOString() : null,
        cache: cacheEntries
    };
}

export {
    createPayment,
    checkStatus,
    getRecentTransactions,
    authenticate,
    searchJournals,
    staticToDynamicQris,
    crc16ccitt,
    generateQrImageUrl,
    detectCollision,
    getCred,
    setCred,
    clearCachedToken,
    // Batch poller
    startGopayBatchPoller,
    stopGopayBatchPoller,
    checkStatusFromCache,
    getGopayPollerStatus
};
