import fetch from 'node-fetch';
import crypto from 'crypto';
import { Pakasir } from 'pakasir-sdk';
import { DEFAULT_USER_AGENT } from './foundation.js';

// ==========================================
// DompetX — HMAC-signed REST client
// Docs: https://docs.dompetx.com/api-reference/introduction
// ==========================================
const DOMPETX_BASE_URL = 'https://api.dompetx.com';

function dompetxHeaders(apiKey, body) {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto
        .createHmac('sha256', apiKey)
        .update(`${timestamp}.${body}`)
        .digest('hex');
    return {
        'Content-Type': 'application/json',
        'X-DOMPAY-API-Key': apiKey,
        'X-DOMPAY-Signature': signature,
        'X-DOMPAY-Timestamp': timestamp,
    };
}

// Recursively find the first non-empty string value whose key matches any of the names (case-insensitive).
function _deepFind(obj, names, seen = new Set()) {
    if (obj == null || typeof obj !== 'object' || seen.has(obj)) return null;
    seen.add(obj);
    const lower = names.map(n => n.toLowerCase());
    if (Array.isArray(obj)) {
        for (const item of obj) {
            const r = _deepFind(item, names, seen);
            if (r) return r;
        }
        return null;
    }
    for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.length > 0 && lower.includes(k.toLowerCase())) return v;
        if (typeof v === 'number' && lower.includes(k.toLowerCase())) return String(v);
    }
    for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') {
            const r = _deepFind(v, names, seen);
            if (r) return r;
        }
    }
    return null;
}

/**
 * DompetX: create payment (default method QRIS).
 * Returns a normalized object with order_id, qrcode (QR string), payment_url, total_payment, raw.
 * @param {string} apiKey
 * @param {string} reference - merchant order ID
 * @param {number} amount - IDR amount
 * @param {string} [method='QRIS'] - channel code (QRIS, GOPAY, OVO, VA_BCA, etc)
 * @returns {Promise<{order_id: string, qrcode: string, payment_url: string, total_payment: number, raw: object}>}
 */
async function createDompetxPayment(apiKey, reference, amount, method = 'QRIS') {
    if (!apiKey) throw new Error('DompetX API Key kosong');
    const bodyObj = {
        method: method || 'QRIS',
        amount: Number(amount),
        currency: 'IDR',
        reference: String(reference),
    };
    const body = JSON.stringify(bodyObj);
    const headers = dompetxHeaders(apiKey, body);
    headers['Idempotency-Key'] = `${reference}-${Date.now()}`;

    const res = await fetch(`${DOMPETX_BASE_URL}/v1/payments`, {
        method: 'POST',
        headers,
        body,
    });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!res.ok) {
        const msg = (data && (data.message || data.error)) || text || `HTTP ${res.status}`;
        throw new Error(`DompetX createPayment: ${msg}`);
    }
    if (!data) throw new Error('DompetX createPayment: empty response');

    // Optional debug log of raw response — enable with DEBUG_DOMPETX=1
    if (process.env.DEBUG_DOMPETX === '1') {
        console.log('[DompetX] createPayment raw:', JSON.stringify(data));
    }

    const id = data.id || data.transaction_id || data.transactionId || data.reference || reference;

    // Known shape (observed): { id, paymentUrl, qrData: { qrString, qrImage }, amount, totalAmount, ... }
    // Use direct field access first, then deep search as fallback for future API shape changes.
    let qrcode = (data.qrData && (data.qrData.qrString || data.qrData.qr_string)) || '';
    if (!qrcode) qrcode = _deepFind(data, [
        'qr_string', 'qris_string', 'qr_code', 'qrcode', 'qr_data',
        'qr_content', 'qris_content', 'qrCode', 'qrString'
    ]) || '';

    let payment_url = data.paymentUrl || data.payment_url || data.checkoutUrl || data.checkout_url || '';
    if (!payment_url) payment_url = _deepFind(data, [
        'payment_url', 'checkout_url', 'redirect_url', 'redirectUrl',
        'paymentUrl', 'checkoutUrl', 'pay_url', 'payUrl', 'qr_image_url', 'qrImageUrl', 'url'
    ]) || '';

    let va_number = data.vaNumber || data.va_number || data.virtual_account || '';
    if (!va_number) va_number = _deepFind(data, [
        'va_number', 'vaNumber', 'virtual_account', 'virtualAccount', 'account_number', 'accountNumber'
    ]) || '';

    // Fee breakdown — DompetX charges a percentage/flat `fee` plus a dynamic `additionalFee`
    // (configured per-merchant in dashboard). Both can change per transaction, so we capture
    // the values from THIS response rather than computing them locally.
    const baseAmount = Number(data.amount || amount);                  // what we requested
    const dompetxFee = Number(data.fee || 0);                           // DompetX channel fee
    const additionalFee = Number(data.additionalFee || data.additional_fee || 0); // dynamic
    const totalAmount = Number(
        data.totalAmount || data.total_amount ||
        (baseAmount + dompetxFee + additionalFee) || baseAmount
    );
    const merchantReceive = Number(data.getBalance || data.get_balance || baseAmount);

    // Fallback: fetch payment detail if create response did not include the channel-specific payload
    if (!qrcode && !payment_url && !va_number && id) {
        try {
            const detailHeaders = dompetxHeaders(apiKey, '');
            const detailRes = await fetch(`${DOMPETX_BASE_URL}/v1/payments/${encodeURIComponent(id)}`, {
                method: 'GET',
                headers: detailHeaders,
            });
            if (detailRes.ok) {
                const detailData = await detailRes.json().catch(() => null);
                if (detailData) {
                    console.log('[DompetX] detail fallback raw:', JSON.stringify(detailData));
                    qrcode = qrcode || _deepFind(detailData, ['qr_string', 'qris_string', 'qr_code', 'qrcode', 'qr_data', 'qr_content']) || '';
                    payment_url = payment_url || _deepFind(detailData, ['payment_url', 'checkout_url', 'redirect_url', 'qr_image_url', 'url']) || '';
                    va_number = va_number || _deepFind(detailData, ['va_number', 'virtual_account', 'account_number']) || '';
                }
            } else {
                console.log('[DompetX] detail fallback HTTP', detailRes.status);
            }
        } catch (e) {
            console.log('[DompetX] detail fallback error:', e.message);
        }
    }

    return {
        order_id: String(id),
        qrcode,
        payment_url,
        va_number,
        total_payment: totalAmount,
        base_amount: baseAmount,
        dompetx_fee: dompetxFee,
        additional_fee: additionalFee,
        merchant_receive: merchantReceive,
        raw: data,
    };
}

/**
 * DompetX: cancel a pending transaction (fire-and-forget, idempotent).
 * Returns {ok: boolean, status: 'Cancelled'|'AlreadyFinal'|'Error', message?: string}.
 * Safe to call on already-paid/cancelled transactions — the API will just respond accordingly.
 * @param {string} apiKey
 * @param {string} transactionId - DompetX transaction id
 * @returns {Promise<{ok: boolean, status: string, message?: string}>}
 */
async function cancelDompetxPayment(apiKey, transactionId) {
    if (!apiKey || !transactionId) return { ok: false, status: 'Error', message: 'missing apiKey/transactionId' };
    try {
        const headers = dompetxHeaders(apiKey, '');
        const res = await fetch(`${DOMPETX_BASE_URL}/v1/payments/cancel/${encodeURIComponent(transactionId)}`, {
            method: 'POST',
            headers,
        });
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { /* non-JSON */ }
        if (res.ok) return { ok: true, status: 'Cancelled', message: (data && (data.message || data.status)) || 'ok' };
        // 400/409 typically means "already paid" or "already cancelled" — treat as benign
        if (res.status === 400 || res.status === 409 || res.status === 422) {
            return { ok: false, status: 'AlreadyFinal', message: (data && (data.message || data.error)) || `HTTP ${res.status}` };
        }
        return { ok: false, status: 'Error', message: (data && (data.message || data.error)) || text || `HTTP ${res.status}` };
    } catch (e) {
        return { ok: false, status: 'Error', message: e.message };
    }
}

/**
 * DompetX: check payment status by transaction id.
 * @param {string} apiKey
 * @param {string} transactionId - DompetX transaction id (from createPayment response)
 * @returns {Promise<{status: 'Paid'|'Failed'|'Unpaid', raw?: object}>}
 */
async function checkDompetxPayment(apiKey, transactionId) {
    if (!apiKey || !transactionId) return { status: 'Unpaid' };
    const body = '';
    const headers = dompetxHeaders(apiKey, body);

    const res = await fetch(`${DOMPETX_BASE_URL}/v1/payments/check-status/${encodeURIComponent(transactionId)}`, {
        method: 'GET',
        headers,
    });
    if (!res.ok) return { status: 'Unpaid' };
    let data = null;
    try { data = await res.json(); } catch { return { status: 'Unpaid' }; }

    const raw = (data && data.data) ? data.data : data;
    const status = String((raw && (raw.status || raw.payment_status)) || '').toLowerCase();
    if (['paid', 'completed', 'success', 'settled'].includes(status)) return { status: 'Paid', raw };
    if (['failed', 'expired', 'canceled', 'cancelled'].includes(status)) return { status: 'Failed', raw };
    return { status: 'Unpaid', raw };
}

/**
 * Tripay: check transaction status by reference
 * @param {string} apiKey - Tripay API key
 * @param {string} reference - Transaction reference
 * @returns {Promise<object|null>}
 */
function checkTransactionStatus(apiKey, reference) {
    const url = `https://tripay.co.id/api/transaction/check-status?reference=${encodeURIComponent(reference)}`;
    return fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': 'Bearer ' + apiKey
        }
    })
        .then(async res => {
            if (!res.ok) {
                throw new Error(`HTTP error! Status: ${res.status}`);
            }
            const data = await res.json();
            return data;
        })
        .catch(err => {
            console.error('Error:', err);
            return null;
        });
}

/**
 * Saweria: check QRIS payment status
 * @param {string} saweriaId - Saweria donation ID
 * @returns {Promise<'PAID'|'PENDING'>}
 */
const checkSaweriaPayment = async (saweriaId) => {
    try {
        const res = await fetch(`https://backend.saweria.co/donations/qris/snap/${saweriaId}`, {
            headers: { 'User-Agent': DEFAULT_USER_AGENT, 'Origin': 'https://saweria.co', 'Referer': 'https://saweria.co/' }
        });
        if (!res.ok) return 'PENDING';
        const data = await res.json();
        const status = data?.data?.transaction_status;
        if (!status || status === 'pending' || status === 'Pending') return 'PENDING';
        return 'PAID';
    } catch { return 'PENDING'; }
};


/**
 * Pakasir: check transaction status via SDK (slug + apiKey, no cookie needed)
 * @param {string} slug - Pakasir project slug
 * @param {string} apiKey - Pakasir API key
 * @param {string} orderId - Order/reference ID
 * @param {number} amount - Transaction amount
 * @returns {Promise<{status: 'Paid'|'Failed'|'Unpaid'}>}
 */
async function checkPakasirPayment(slug, apiKey, orderId, amount) {
    const pakasir = new Pakasir({ slug, apikey: apiKey });
    const detail = await pakasir.detailPayment(orderId, amount);
    if (detail.status === 'completed') return { status: 'Paid' };
    if (detail.status === 'canceled') return { status: 'Failed' };
    return { status: 'Unpaid' };
}

/**
 * Unified payment status check across all providers.
 * @param {string} provider - 'tripay'|'saweria'|'pakasir'|'gopay'|'dompetx'
 * @param {object} opts
 * @param {string} opts.reference - Invoice/order reference
 * @param {object} opts.config - Parsed configtelebot.json[0]
 * @param {string} [opts.saweriaId] - Saweria donation UUID
 * @param {number} [opts.payAmount] - GoPay payment amount
 * @param {number} [opts.createdAt] - GoPay tx creation timestamp
 * @param {number} [opts.expiresAt] - GoPay tx expiry timestamp
 * @param {object} [opts.gopayModule] - GoPay module (injected dependency)
 * @param {string} [opts.dompetxTxId] - DompetX provider transaction id (returned from createPayment)
 * @returns {Promise<{status: 'Paid'|'Failed'|'Unpaid', providerRef?: string}>}
 */
async function checkPaymentByProvider(provider, opts = {}) {
    const { reference, config, saweriaId, payAmount, pakasirBaseAmount, createdAt, expiresAt, gopayModule, dompetxTxId } = opts;
    const result = { status: 'Unpaid' };

    try {
        if (provider === 'saweria') {
            const saweriaStatus = await checkSaweriaPayment(saweriaId || reference);
            if (saweriaStatus === 'PAID') result.status = 'Paid';
        } else if (provider === 'pakasir') {
            const pakasirCfg = config.pakasir || {};
            const slug = pakasirCfg.project_slug || '';
            const apiKey = pakasirCfg.api_key || '';
            if (slug && apiKey && reference) {
                // detailPayment requires the BASE amount (before fees), not total_payment
                const checkAmount = pakasirBaseAmount || payAmount || 0;
                const pakResult = await checkPakasirPayment(slug, apiKey, reference, checkAmount);
                result.status = pakResult.status;
            }
        } else if (provider === 'dompetx') {
            const dpxCfg = config.dompetx || {};
            const apiKey = dpxCfg.api_key || '';
            const txId = dompetxTxId || reference;
            if (apiKey && txId) {
                const dpxResult = await checkDompetxPayment(apiKey, txId);
                result.status = dpxResult.status;
            }
        } else if (provider === 'gopay') {
            if (!gopayModule) throw new Error('gopayModule required for gopay provider');
            // Use batch poller cache instead of per-tx API call
            const gpResult = gopayModule.checkStatusFromCache(payAmount || 0, createdAt, expiresAt);
            if (gpResult.status === 'Paid') {
                result.status = 'Paid';
                if (gpResult.providerRef) result.providerRef = gpResult.providerRef;
            } else if (gpResult.status === 'Failed') {
                result.status = 'Failed';
            }
        } else {
            // Tripay (default)
            const tripayResult = await checkTransactionStatus(config.apiKey, reference);
            if (tripayResult && tripayResult.message) {
                const msgUpper = tripayResult.message.toUpperCase();
                if (msgUpper.includes('PAID')) result.status = 'Paid';
                else if (msgUpper.includes('FAILED') || msgUpper.includes('EXPIRED')) result.status = 'Failed';
            }
        }
    } catch (err) {
        console.error(`[PAYMENT] ${provider} check error for ref=${reference}:`, err.message);
    }

    return result;
}

export {
    checkTransactionStatus,
    checkSaweriaPayment,
    checkPakasirPayment,
    createDompetxPayment,
    checkDompetxPayment,
    cancelDompetxPayment,
    checkPaymentByProvider
};
