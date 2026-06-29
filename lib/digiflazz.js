/**
 * Digiflazz Buyer API client — prepaid PPOB only (v1).
 *
 * API contract:
 *   - Base: https://api.digiflazz.com/v1
 *   - Method: POST, Content-Type: application/json
 *   - Auth: md5 signature per endpoint (different concat formula each)
 *   - All responses wrapped as { data: { ... } }
 *   - Webhook signature: X-Hub-Signature: sha1=<HMAC-SHA1(rawBody, webhook_secret)>
 *
 * Reference: https://developer.digiflazz.com/api/buyer/
 */

import crypto from 'crypto';
import fetch from 'node-fetch';

const BASE_URL = 'https://api.digiflazz.com/v1';

// In-memory price-list cache (TTL 10 min). Catalog rarely changes intra-day.
const PRICELIST_CACHE_TTL_MS = 10 * 60 * 1000;
let _pricelistCache = { data: null, lastFetch: 0, key: '' };

// ==========================================
// SIGNATURE HELPERS
// ==========================================
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

const signCekSaldo = (username, apiKey) => md5(username + apiKey + 'depo');
const signPriceList = (username, apiKey) => md5(username + apiKey + 'pricelist');
const signTransaction = (username, apiKey, refId) => md5(username + apiKey + refId);
const signDeposit = (username, apiKey) => md5(username + apiKey + 'deposit');

// ==========================================
// LOW-LEVEL POST  — with 15s hard timeout to prevent indefinite hangs on Digiflazz outages
// ==========================================
const REQUEST_TIMEOUT_MS = 15_000;

const _post = async (path, body) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
        const res = await fetch(`${BASE_URL}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        if (!res.ok) {
            return { ok: false, status: res.status, error: (json && json.data && json.data.message) || text.slice(0, 200) };
        }
        const data = (json && json.data !== undefined) ? json.data : json;
        return { ok: true, data };
    } catch (e) {
        const msg = e.name === 'AbortError' ? `Digiflazz timeout (>${REQUEST_TIMEOUT_MS/1000}s)` : e.message;
        return { ok: false, status: 0, error: msg };
    } finally {
        clearTimeout(timer);
    }
};

// ==========================================
// CEK SALDO  (POST /v1/cek-saldo)
// ==========================================
const cekSaldo = async ({ username, apiKey }) => {
    if (!username || !apiKey) return { ok: false, error: 'username/apiKey kosong' };
    const r = await _post('/cek-saldo', {
        cmd: 'deposit',
        username,
        sign: signCekSaldo(username, apiKey),
    });
    if (!r.ok) return r;
    // r.data shape: { deposit: <number> } or { message, rc } on error
    if (typeof r.data.deposit === 'number') return { ok: true, deposit: r.data.deposit };
    return { ok: false, error: r.data.message || 'Unexpected response', rc: r.data.rc };
};

// ==========================================
// PRICE LIST  (POST /v1/price-list)
// Returns array of prepaid SKUs. Cached 10 min per credential.
// ==========================================
const getPriceList = async ({ username, apiKey, force = false }) => {
    if (!username || !apiKey) return { ok: false, error: 'username/apiKey kosong' };
    const cacheKey = username;
    const now = Date.now();
    if (!force && _pricelistCache.data && _pricelistCache.key === cacheKey && (now - _pricelistCache.lastFetch < PRICELIST_CACHE_TTL_MS)) {
        return { ok: true, items: _pricelistCache.data, cached: true };
    }
    const r = await _post('/price-list', {
        cmd: 'prepaid',
        username,
        sign: signPriceList(username, apiKey),
    });
    if (!r.ok) return r;
    // Successful response: { data: [ { buyer_sku_code, product_name, category, brand, type, seller_name,
    //   price, buyer_product_status, seller_product_status, unlimited_stock, stock, multi, start_cut_off,
    //   end_cut_off, desc } ] }
    if (!Array.isArray(r.data)) {
        return { ok: false, error: (r.data && r.data.message) || 'Unexpected response', rc: r.data && r.data.rc };
    }
    _pricelistCache = { data: r.data, lastFetch: now, key: cacheKey };
    return { ok: true, items: r.data, cached: false };
};

// Reset cache (e.g. after admin "Sync" button)
const invalidatePriceList = () => { _pricelistCache = { data: null, lastFetch: 0, key: '' }; };

// Read-only access to the in-memory pricelist cache — used by config.getMergedProducts()
// to auto-enrich imported Digiflazz SKUs with fresh price/stock without hitting the API.
// Returns null if cache is empty (e.g. cold start before first auto-sync succeeds).
const getCachedPricelist = () => {
    if (!_pricelistCache.data || !Array.isArray(_pricelistCache.data)) return null;
    return { items: _pricelistCache.data, lastFetch: _pricelistCache.lastFetch };
};

// Per-SKU price lookup — separate rate limit (Digiflazz: 1 req/sec per code).
// NOT cached — caller is responsible for spacing requests (sleep ~1100ms between calls).
// Returns the matched SKU row, or null if not found.
const getSinglePrice = async ({ username, apiKey, code }) => {
    if (!username || !apiKey) return { ok: false, error: 'username/apiKey kosong' };
    if (!code) return { ok: false, error: 'code wajib' };
    const r = await _post('/price-list', {
        cmd: 'prepaid',
        username,
        code,
        sign: signPriceList(username, apiKey),
    });
    if (!r.ok) return r;
    if (Array.isArray(r.data)) {
        const item = r.data.find(x => x.buyer_sku_code === code) || r.data[0] || null;
        return { ok: true, item };
    }
    // Error envelope from Digiflazz (e.g. rc=43 SKU not found)
    return { ok: false, error: (r.data && r.data.message) || 'Unexpected response', rc: r.data && r.data.rc };
};

// ==========================================
// CREATE TRANSACTION  (POST /v1/transaction)
// Prepaid topup. ref_id MUST be unique (use our tx.reference).
// ==========================================
const createTransaction = async ({ username, apiKey, buyerSkuCode, customerNo, refId, testing = false, maxPrice, cbUrl, allowDot = false, msg }) => {
    if (!username || !apiKey) return { ok: false, error: 'username/apiKey kosong' };
    if (!buyerSkuCode || !customerNo || !refId) return { ok: false, error: 'buyerSkuCode/customerNo/refId wajib' };

    const body = {
        username,
        buyer_sku_code: buyerSkuCode,
        customer_no: customerNo,
        ref_id: refId,
        sign: signTransaction(username, apiKey, refId),
    };
    if (testing) body.testing = true;
    if (maxPrice != null) body.max_price = parseInt(maxPrice);
    if (cbUrl) body.cb_url = cbUrl;
    if (allowDot) body.allow_dot = true;
    if (msg) body.msg = msg;

    const r = await _post('/transaction', body);
    if (!r.ok) return r;
    // r.data: { ref_id, customer_no, buyer_sku_code, message, status, rc, sn, buyer_last_saldo, price, tele, wa }
    return { ok: true, ...r.data };
};

// Re-call transaction with same ref_id for prepaid status lookup (idempotent).
// Digiflazz returns last known state for that ref_id.
const checkTransactionStatus = async ({ username, apiKey, buyerSkuCode, customerNo, refId }) => {
    return createTransaction({ username, apiKey, buyerSkuCode, customerNo, refId });
};

// ==========================================
// INQUIRY PLN PRABAYAR  (POST /v1/inquiry-pln)
// Used to validate the customer/meter number BEFORE collecting payment.
// Returns subscriber name, meter no, segment/power so the user can confirm
// they're topping up the correct account.
//
// Sign formula: md5(username + apiKey + customer_no)
// Response (success): { message: "Transaksi Sukses", status: "Sukses", rc: "00",
//   customer_no, meter_no, subscriber_id, name, segment_power }
// ==========================================
const signInquiryPln = (username, apiKey, customerNo) => md5(username + apiKey + customerNo);

const inquiryPln = async ({ username, apiKey, customerNo }) => {
    if (!username || !apiKey) return { ok: false, error: 'username/apiKey kosong' };
    if (!customerNo) return { ok: false, error: 'customer_no wajib' };
    const r = await _post('/inquiry-pln', {
        username,
        customer_no: String(customerNo),
        sign: signInquiryPln(username, apiKey, customerNo),
    });
    if (!r.ok) return r;
    // Digiflazz returns status=Sukses on valid customer, otherwise rc indicates the reason
    const rcStr = String(r.data.rc || '').padStart(2, '0');
    const okFlag = rcStr === '00' || String(r.data.status || '').toLowerCase() === 'sukses';
    // Digiflazz pads the customer name and segment_power with leading/trailing '*'
    // and runs of spaces (raw shape, e.g. '*LISTIYAWATI                    *' or
    // 'R1   /1300'). Strip the asterisks, trim, and collapse internal whitespace
    // so downstream messages render clean.
    const cleanField = (v) => {
        if (v == null) return v;
        return String(v).replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    };
    return {
        ok: okFlag,
        rc: r.data.rc,
        status: r.data.status,
        message: r.data.message,
        customer_no: r.data.customer_no,
        meter_no: r.data.meter_no,
        subscriber_id: r.data.subscriber_id,
        name: cleanField(r.data.name),
        segment_power: cleanField(r.data.segment_power),
        error: !okFlag ? (r.data.message || 'Inquiry gagal') : undefined,
    };
};

// ==========================================
// WEBHOOK SIGNATURE VERIFY
// X-Hub-Signature header: "sha1=<hex>" (HMAC-SHA1 of raw body, key = webhook_secret)
// Pass the raw body string (NOT parsed JSON) — order/whitespace matters for HMAC.
// ==========================================
const verifyWebhookSignature = (rawBody, signatureHeader, secret) => {
    if (!secret) return false;
    if (!signatureHeader || typeof signatureHeader !== 'string') return false;
    const expected = 'sha1=' + crypto.createHmac('sha1', secret).update(rawBody).digest('hex');
    // timing-safe compare
    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
};

// ==========================================
// STATUS CLASSIFICATION
// rc → bucket: SUCCESS | PENDING | FAILED  (per Digiflazz response code table)
// ==========================================
const PENDING_RC = new Set(['03', '99']);
const SUCCESS_RC = new Set(['00']);

const classifyRc = (rc, status) => {
    const rcStr = String(rc || '').padStart(2, '0');
    if (SUCCESS_RC.has(rcStr)) return 'SUCCESS';
    if (PENDING_RC.has(rcStr)) return 'PENDING';
    // Fallback to status string if rc unknown
    const st = String(status || '').toLowerCase();
    if (st === 'sukses') return 'SUCCESS';
    if (st === 'pending') return 'PENDING';
    return 'FAILED';
};

// ==========================================
// EFFECTIVE POLL INTERVAL
// Resolves the polling cadence for pending PPOB tx based on delivery_mode + admin's
// configured poll_interval_seconds. Single source of truth used by both TG & WA pollers.
//
//   delivery_mode='webhook'  → very loose safety net (300s) regardless of poll setting
//   delivery_mode='polling'  → tighten to admin's poll_interval (clamped 10..300, default 20s if 60-default)
//   delivery_mode='auto'     → if webhook_secret set, 60s safety net; else tighten like polling mode
//
// Returns ms (number). Always ≥10_000, ≤300_000.
// ==========================================
const POLL_MIN_MS = 10_000;
const POLL_MAX_MS = 300_000;

const getEffectivePollIntervalMs = ({ delivery_mode, poll_interval_seconds, webhook_secret } = {}) => {
    const mode = (delivery_mode || 'auto').toLowerCase();
    const userPoll = Math.max(POLL_MIN_MS, Math.min(POLL_MAX_MS, (parseInt(poll_interval_seconds) || 60) * 1000));
    const hasSecret = !!(webhook_secret && String(webhook_secret).trim());

    if (mode === 'webhook') return POLL_MAX_MS; // safety net only
    if (mode === 'polling') {
        // If admin kept default 60s but switched to polling-only, tighten to 20s for snappier UX.
        if (poll_interval_seconds == null || parseInt(poll_interval_seconds) === 60) return 20_000;
        return userPoll;
    }
    // auto
    if (hasSecret) return Math.max(60_000, userPoll); // webhook is primary; safety net loose
    // auto without secret → behave like polling mode
    if (poll_interval_seconds == null || parseInt(poll_interval_seconds) === 60) return 20_000;
    return userPoll;
};

// Human label for current effective mode (for UI hints + admin notification)
const describeDeliveryMode = ({ delivery_mode, webhook_secret } = {}) => {
    const mode = (delivery_mode || 'auto').toLowerCase();
    const hasSecret = !!(webhook_secret && String(webhook_secret).trim());
    if (mode === 'webhook') return { mode: 'webhook', label: 'Webhook only (real-time)', warn: !hasSecret ? 'Webhook secret kosong — webhook gak akan ter-verifikasi!' : null };
    if (mode === 'polling') return { mode: 'polling', label: 'Polling only (no webhook setup needed)', warn: null };
    // auto
    if (hasSecret) return { mode: 'auto-webhook', label: 'Auto: Webhook primary + polling safety-net', warn: null };
    return { mode: 'auto-polling', label: 'Auto: Polling (webhook_secret kosong → fallback ke polling)', warn: null };
};

export {
    BASE_URL,
    cekSaldo,
    getPriceList,
    getSinglePrice,
    getCachedPricelist,
    invalidatePriceList,
    createTransaction,
    checkTransactionStatus,
    inquiryPln,
    verifyWebhookSignature,
    classifyRc,
    getEffectivePollIntervalMs,
    describeDeliveryMode,
    POLL_MIN_MS,
    POLL_MAX_MS,
    // Exposed for tests / debugging
    signCekSaldo,
    signPriceList,
    signTransaction,
    signInquiryPln,
    signDeposit,
};
