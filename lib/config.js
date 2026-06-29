/**
 * Config store — global cache management with getter/setter accessors.
 * Manages GLOBAL_PRODUCTS, GLOBAL_CONFIG, GLOBAL_IMAGE_ID.
 * Also includes KoalaStore integration and getMergedProducts.
 */

import fs from 'fs';
import fetch from 'node-fetch';
import { productFile, writeFileAtomic, KS_CACHE_TTL_MS } from './foundation.js';
import * as digiflazz from './digiflazz.js';

// ==========================================
// GLOBAL STATE (private — access via getters/setters)
// ==========================================
let GLOBAL_PRODUCTS = [];
let GLOBAL_CONFIG = [];
let GLOBAL_IMAGE_ID = null;

// ==========================================
// ACCESSORS
// ==========================================
const getProducts = () => GLOBAL_PRODUCTS;
const setProducts = (val) => { GLOBAL_PRODUCTS = val; };
const getConfig = () => GLOBAL_CONFIG;
const setConfig = (val) => { GLOBAL_CONFIG = val; };
const getImageId = () => GLOBAL_IMAGE_ID;
const setImageId = (val) => { GLOBAL_IMAGE_ID = val; };

// ==========================================
// CACHE LOADING
// ==========================================
const loadCache = () => {
    try { GLOBAL_PRODUCTS = JSON.parse(fs.readFileSync(productFile, 'utf8')); } catch { GLOBAL_PRODUCTS = []; }
    try { GLOBAL_CONFIG = JSON.parse(fs.readFileSync('configtelebot.json', 'utf8')); } catch { GLOBAL_CONFIG = []; }
};

// ==========================================
// SAVE PRODUCTS
// ==========================================
const saveProducts = (products) => {
    GLOBAL_PRODUCTS = products;
    writeFileAtomic(productFile, JSON.stringify(products, null, 2));
};

// ==========================================
// KOALASTORE INTEGRATION
// ==========================================
const koalaStore = {
    baseUrl: 'https://koalastore.digital/api/v1',
    getProducts: async (apiKey) => {
        try {
            const response = await fetch(`${koalaStore.baseUrl}/products?page=1&per_page=50`, {
                headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' }
            });
            const data = await response.json();
            return data;
        } catch (e) { return { success: false, message: e.message }; }
    },
    getBalance: async (apiKey) => {
        try {
            const response = await fetch(`${koalaStore.baseUrl}/balance`, {
                headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' }
            });
            return await response.json();
        } catch (e) { return { success: false, message: e.message }; }
    },
    checkout: async (apiKey, variantCode, quantity) => {
        try {
            const response = await fetch(`${koalaStore.baseUrl}/checkout`, {
                method: 'POST',
                headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ items: [{ variant_code: variantCode, quantity: parseInt(quantity) }] })
            });
            return await response.json();
        } catch (e) {
            console.error("Koala API Fetch Error:", e);
            return { success: false, message: e.message };
        }
    }
};

// Cache for Koala Products to prevent rate-limiting during dashboard polling
let ksProductCache = { data: null, lastFetch: 0 };
const getKoalaProductsCached = async (apiKey) => {
    const now = Date.now();
    if (ksProductCache.data && (now - ksProductCache.lastFetch < KS_CACHE_TTL_MS)) {
        return { success: true, data: ksProductCache.data };
    }
    const res = await koalaStore.getProducts(apiKey);
    if (res.success) {
        ksProductCache.data = res.data;
        ksProductCache.lastFetch = now;
    }
    return res;
};

// ==========================================
// MERGED PRODUCTS — enrich-only model
// KS products only appear if seller explicitly imported them (saved in product.json).
// API call refreshes ks_base_price + stockCount for already-imported items; never
// adds new ones. If KS API fails, imported KS items keep their last known values.
// ==========================================
const isKsProduct = (p) => p && (p.source === 'koalastore' || (p.productId && p.productId.startsWith('ks_')));
const isDfProduct = (p) => p && (p.source === 'digiflazz' || (p.productId && p.productId.startsWith('df_')));

// Enrich imported Digiflazz SKUs with FRESH price + stock from the in-memory pricelist cache
// (kept warm by the auto-sync poller every 5m30s). Profit margin is preserved so admin's markup
// stays intact: priceProduct = fresh_base + profit. Falls back to stored values if cache empty.
const _enrichDigiflazz = (dfProducts) => {
    if (!dfProducts || dfProducts.length === 0) return dfProducts;
    const cache = digiflazz.getCachedPricelist();
    if (!cache) return dfProducts; // cold cache — bot uses stored values until first auto-sync
    const skuMap = new Map(cache.items.map(x => [x.buyer_sku_code, x]));
    return dfProducts.map(lp => {
        const fresh = skuMap.get(lp.buyer_sku_code);
        if (!fresh) return { ...lp, seller_product_status: false, stockCount: 0 }; // SKU vanished from Digiflazz
        const basePrice = parseFloat(fresh.price) || 0;
        const profit = parseFloat(lp.profit) || 0;
        return {
            ...lp,
            df_base_price: basePrice,
            priceProduct: basePrice + profit,
            stockCount: fresh.unlimited_stock ? 9999 : (parseInt(fresh.stock) || 0),
            unlimited_stock: !!fresh.unlimited_stock,
            seller_product_status: !!fresh.seller_product_status,
            buyer_product_status: !!fresh.buyer_product_status,
            multi: !!fresh.multi,
            start_cut_off: fresh.start_cut_off || '',
            end_cut_off: fresh.end_cut_off || '',
        };
    });
};

const getMergedProducts = async () => {
    try {
        let localProducts = [];
        if (fs.existsSync(productFile)) {
            try {
                localProducts = JSON.parse(fs.readFileSync(productFile, 'utf8'));
            } catch { localProducts = []; }
        }

        const ksLocal = localProducts.filter(isKsProduct);
        const dfLocal = localProducts.filter(isDfProduct);
        const nonKsLocal = localProducts.filter(p => !isKsProduct(p));
        // Auto-enrich Digiflazz products with fresh cached prices (preserves admin profit)
        const dfEnriched = _enrichDigiflazz(dfLocal);
        // Replace df entries inside nonKsLocal with enriched copies (same order)
        const dfByIdEnriched = new Map(dfEnriched.map(p => [p.productId, p]));
        for (let i = 0; i < nonKsLocal.length; i++) {
            if (isDfProduct(nonKsLocal[i])) {
                const enriched = dfByIdEnriched.get(nonKsLocal[i].productId);
                if (enriched) nonKsLocal[i] = enriched;
            }
        }

        if (ksLocal.length === 0) return nonKsLocal;

        let config = {};
        if (fs.existsSync('configtelebot.json')) {
            try {
                const conf = JSON.parse(fs.readFileSync('configtelebot.json', 'utf8'));
                config = Array.isArray(conf) ? conf[0] : conf;
            } catch { }
        }
        const ks = config.koalastore || {};

        // KS not configured → return imported KS with stored values (frozen)
        if (!ks.is_active || !ks.api_key) return [...nonKsLocal, ...ksLocal];

        // Build variant_code → {price, stock} map from API
        let variantMap = null;
        try {
            const ksRes = await getKoalaProductsCached(ks.api_key);
            if (ksRes.success && ksRes.data) {
                variantMap = new Map();
                ksRes.data.forEach(p => {
                    (p.variants || []).forEach(v => {
                        const stock = v.available_stock !== undefined ? v.available_stock : (v.stock !== undefined ? v.stock : 0);
                        variantMap.set(v.code_variant, { price: parseFloat(v.price) || 0, stock });
                    });
                });
            }
        } catch (e) {
            console.error("KS Fetch error during merge", e);
        }

        const enrichedKs = ksLocal.map(lp => {
            if (!variantMap) return lp; // API failed → keep stored values
            const fresh = variantMap.get(lp.variant_code);
            if (!fresh) return { ...lp, stockCount: 0 }; // variant gone from KS → out of stock
            const profit = parseFloat(lp.profit) || 0;
            return {
                ...lp,
                ks_base_price: fresh.price,
                priceProduct: fresh.price + profit,
                stockCount: fresh.stock
            };
        });

        return [...nonKsLocal, ...enrichedKs];
    } catch (e) {
        console.error("MergedProducts Critical Fail", e);
        return GLOBAL_PRODUCTS || [];
    }
};

// ==========================================
// BULK PRICE CALCULATOR (pure function)
// ==========================================
const calculateBulkPrice = (product, quantity) => {
    const qty = Math.max(1, parseInt(quantity) || 1);
    const basePrice = parseInt(product.priceProduct) || 0;
    const baseProfit = parseInt(product.profit) || 0;
    const tiers = Array.isArray(product.bulkDiscounts)
        ? product.bulkDiscounts.filter(t => t.minQty && t.price != null && t.price !== '')
        : [];

    // Sort tiers descending by minQty to find highest qualifying tier
    const sorted = [...tiers].sort((a, b) => Number(b.minQty) - Number(a.minQty));
    const matchedTier = sorted.find(t => qty >= Number(t.minQty));

    const rawPrice = matchedTier != null ? parseInt(matchedTier.price) : NaN;
    const rawProfit = matchedTier != null ? parseInt(matchedTier.profit) : NaN;
    const unitPrice = !isNaN(rawPrice) ? rawPrice : basePrice;
    const unitProfit = !isNaN(rawProfit) ? rawProfit : baseProfit;

    return {
        unitPrice,
        totalPrice: unitPrice * qty,
        unitProfit,
        totalProfit: unitProfit * qty
    };
};

export {
    // Accessors
    getProducts,
    setProducts,
    getConfig,
    setConfig,
    getImageId,
    setImageId,
    // Cache
    loadCache,
    saveProducts,
    // KoalaStore
    koalaStore,
    getKoalaProductsCached,
    getMergedProducts,
    isKsProduct,
    // Pricing
    calculateBulkPrice,
};
