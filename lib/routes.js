import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import express from 'express';
import multer from 'multer';
import cors from 'cors';
import session from 'express-session';
import SessionFileStore from 'session-file-store';

const FileStore = SessionFileStore(session);

import { productFile, transactionsFile, waTransactionsFile, writeFileAtomic, withWaTxFile, withTgTxFile, STOCK_DIR, SESSION_SECRET, rcLog } from './foundation.js';
import { getProducts, setProducts, saveProducts, getConfig, setConfig, getMergedProducts, getKoalaProductsCached, koalaStore, isKsProduct } from './config.js';
import { loadTransactions, saveTransactionFile } from './transactions.js';
import { getStockPath } from './stock.js';
import * as digiflazz from './digiflazz.js';

import { getLoginPageHTML } from './login-page.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

/**
 * Sets up all Express routes on the given app.
 *
 * @param {import('express').Express} app - Express app instance
 * @param {object} deps - Runtime dependencies injected from server.js
 * @param {object} deps.bot - Telegram bot wrapper (hot-reloadable)
 * @param {Function} deps.getUsers - Returns array of TG user chat IDs
 * @param {Function} deps.loadMasterData - Reloads GLOBAL_MASTERS from master.json
 * @param {object} deps.gopay - GoPay module
 * @param {object} deps.TelegramBot - TelegramBot constructor (for token validation)
 */
let botSwapInProgress = false;

function setupRoutes(app, deps) {
    const { bot, getUsers, loadMasterData, gopay, TelegramBot } = deps;
    // WEB DASHBOARD & API (EXPRESS SERVER)
    // ==========================================

    app.use(cors());
    // Capture rawBody for HMAC signature verification (Digiflazz webhook).
    // verify callback runs before body is parsed; rawBody used only when needed.
    app.use(express.json({
        verify: (req, _res, buf) => { req.rawBody = buf && buf.length ? buf.toString('utf8') : ''; }
    }));
    app.use(express.urlencoded({ extended: true }));

    // Session Configuration
    app.use(session({
        store: new FileStore({
            path: './.sessions',
            ttl: 30 * 24 * 60 * 60, // 30 Hari
            retries: 0
        }),
        secret: SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
            secure: false, // Set to true if using HTTPS
            maxAge: 30 * 24 * 60 * 60 * 1000 // 30 Hari
        }
    }));

    // License Validation Middleware
    async function checkAuth(req, res, next) {
        // No authentication required — direct access for owner
        return next();
    }

    // ==========================================
    // LOGIN ROUTES — Disabled (no license needed)
    // ==========================================

    // Public API: Get products for customer landing page (no auth required)
    app.get('/api/store/products', async (req, res) => {
        try {
            const merged = await getMergedProducts();
            // Return only public-safe fields for customers
            const publicProducts = merged.map(p => ({
                id: p.productId,
                name: p.productName,
                category: p.category || 'Digital',
                price: p.priceProduct,
                description: p.description || '',
                source: p.source || 'local',
                available: p.source === 'koalastore' || p.source === 'digiflazz'
                    ? (p.stockCount || 0) > 0
                    : true
            })).filter(p => p.available);
            res.json({ success: true, products: publicProducts });
        } catch (err) {
            res.status(500).json({ success: false, error: 'Failed to load products' });
        }
    });

    // Redirect /login to admin dashboard directly
    app.get('/login', (req, res) => {
        res.redirect('/admin');
    });

    // API: Login (no-op, always success)
    app.post('/api/login', async (req, res) => {
        req.session.user = { userId: 'owner', license: 'none', fullName: 'Admin' };
        return res.json({ success: true, message: 'Login successful' });
    });

    // API: Logout
    app.post('/api/logout', (req, res) => {
        req.session.destroy((err) => {
            if (err) {
                return res.status(500).json({ success: false, error: 'Logout failed' });
            }
            res.json({ success: true, message: 'Logged out successfully' });
        });
    });

    // Protect all routes with Auth (except login routes)
    app.use(checkAuth);

    // Serve customer-facing store landing page at root
    app.get('/', (req, res) => {
        res.sendFile(path.join(projectRoot, 'public', 'store.html'));
    });

    // Serve admin dashboard at /admin
    app.get('/admin', (req, res) => {
        res.sendFile(path.join(projectRoot, 'public', 'index.html'));
    });

    app.use(express.static(path.join(projectRoot, 'public')));

    // Multer Storage for Image Upload
    const storage = multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, projectRoot);
        },
        filename: function (req, file, cb) {
            cb(null, 'imagetele.jpg'); // Force filename to imagetele.jpg
        }
    });
    const upload = multer({ storage: storage });

    const stockStorage = multer.diskStorage({
        destination: function (req, file, cb) {
            cb(null, path.join(projectRoot, 'files'));
        },
        filename: function (req, file, cb) {
            cb(null, file.originalname);
        }
    });
    const uploadStock = multer({ storage: stockStorage });

    // API: Get All Products
    app.get('/api/products', async (req, res) => {
        try {
            const merged = await getMergedProducts();
            setProducts(merged); // Update bot cache
            res.json(merged);
        } catch (err) {
            res.status(500).json({ error: 'Failed to read products' });
        }
    });

    // API: Save All Products (Add/Edit/Delete handled by saving list)
    app.post('/api/products', (req, res) => {
        try {
            const products = req.body;
            if (!Array.isArray(products)) return res.status(400).json({ error: 'Invalid data' });

            // Validate: profit cannot exceed price (base + bulk tiers)
            for (const p of products) {
                const price = parseInt(p.priceProduct) || 0;
                const profit = parseInt(p.profit) || 0;
                if (profit > price) {
                    return res.status(400).json({ error: `Profit (${profit}) melebihi harga (${price}) pada produk "${p.productName}"` });
                }
                if (Array.isArray(p.bulkDiscounts)) {
                    for (const t of p.bulkDiscounts) {
                        const tMinQty = parseInt(t.minQty) || 0;
                        if (tMinQty < 2) {
                            return res.status(400).json({ error: `Min qty tier harus ≥ 2 pada produk "${p.productName}" (ditemukan: ${tMinQty})` });
                        }
                        const tPrice = parseInt(t.price) || 0;
                        const tProfit = parseInt(t.profit) || 0;
                        if (tPrice >= price) {
                            return res.status(400).json({ error: `Harga tier (${tPrice}) harus lebih murah dari harga dasar (${price}) pada produk "${p.productName}" (min ${t.minQty} pcs)` });
                        }
                        if (tProfit > tPrice) {
                            return res.status(400).json({ error: `Profit tier (${tProfit}) melebihi harga tier (${tPrice}) pada produk "${p.productName}" (min ${t.minQty} pcs)` });
                        }
                    }
                }
            }

            saveProducts(products); // Use existing helper function (now filters KS)
            res.json({ success: true, message: 'Products saved' });
        } catch (err) {
            res.status(500).json({ error: 'Failed to save products' });
        }
    });

    // API: Upload Image (imagetele.jpg)
    app.post('/api/upload-image', upload.single('image'), (req, res) => {
        if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });
        res.json({ success: true, message: 'Image updated successfully' });
    });

    // API: Upload Stock Files (multiple files)
    app.post('/api/stock-upload/:productName', uploadStock.array('files'), (req, res) => {
        try {
            const productName = req.params.productName.toLowerCase();
            if (!req.files || req.files.length === 0) {
                return res.status(400).json({ success: false, message: 'No files uploaded' });
            }

            const uploadedFileNames = req.files.map(file => file.originalname);
            const filePath = getStockPath(productName);

            // Append new filenames to the stock file
            const newContent = uploadedFileNames.join('\n') + '\n';
            fs.appendFileSync(filePath, newContent);

            console.log(`✅ Uploaded ${req.files.length} stock files for product '${productName}':`, uploadedFileNames);

            res.json({
                success: true,
                message: `${req.files.length} stock files uploaded successfully for ${productName}`,
                files: uploadedFileNames
            });
        } catch (err) {
            console.error('Error in stock-upload:', err);
            res.status(500).json({ success: false, message: 'Failed to upload stock files' });
        }
    });

    // API: Get Stock Content (read .txt file)
    app.get('/api/stock/:productName', async (req, res) => {
        try {
            const nameParam = req.params.productName;
            const nameLower = nameParam.toLowerCase();

            // 1. First, check if this is a Koala Store product in our cache/list
            const target = getProducts().find(p => p.productName.toLowerCase() === nameLower);

            if (target && (target.source === 'koalastore' || target.productId.startsWith('ks_'))) {
                const config = getConfig()[0];
                const ks = config.koalastore || {};
                if (ks.is_active && ks.api_key) {
                    const ksRes = await getKoalaProductsCached(ks.api_key);
                    if (ksRes.success && ksRes.data) {
                        for (const kp of ksRes.data) {
                            // Variant search
                            const variant = kp.variants.find(vx => vx.code_variant === target.variant_code);
                            if (variant) {
                                const count = variant.available_stock !== undefined ? variant.available_stock : (variant.stock !== undefined ? variant.stock : 0);
                                // Return as mock text content so frontend can split it
                                return res.json({ content: new Array(count).fill('x').join('\n') });
                            }
                        }
                    }
                }
            }

            // Security check: prevent directory traversal for local files
            if (nameLower.includes('..') || nameLower.includes('/')) return res.status(400).json({ error: 'Invalid filename' });

            const filePath = getStockPath(nameLower);
            if (!fs.existsSync(filePath)) {
                return res.json({ content: '' }); // Return empty if file not exists
            }
            const content = fs.readFileSync(filePath, 'utf8');
            res.json({ content });
        } catch (err) {
            console.error("Stock fetch error:", err);
            res.status(500).json({ error: 'Failed to read stock file' });
        }
    });

    // API: Save Stock Content (write .txt file)
    app.post('/api/stock/:productName', (req, res) => {
        try {
            const productName = req.params.productName.toLowerCase();
            // Security check
            if (productName.includes('..') || productName.includes('/')) return res.status(400).json({ error: 'Invalid filename' });

            const { content } = req.body;
            const filePath = getStockPath(productName);

            writeFileAtomic(filePath, content || '');
            res.json({ success: true, message: 'Stock updated' });
        } catch (err) {
            res.status(500).json({ error: 'Failed to save stock file' });
        }
    });

    // API: Check Saweria User
    app.post('/api/saweria/check-user', async (req, res) => {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Token is required' });

        try {
            const fetchRes = await fetch('https://backend.saweria.co/users', {
                headers: {
                    'Authorization': token,
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                }
            });

            if (!fetchRes.ok) {
                return res.status(fetchRes.status).json({ error: 'Invalid Token or Saweria API Error' });
            }

            const data = await fetchRes.json();
            // Return relevant data
            if (data.data) {
                res.json({
                    id: data.data.id,
                    username: data.data.username,
                    email: data.data.email
                });
            } else {
                res.status(400).json({ error: 'User data not found in response' });
            }
        } catch (err) {
            console.error("Saweria Check Error:", err);
            res.status(500).json({ error: 'Connection Error' });
        }
    });

    // Helper: read configured KS api_key (returns null if not active/configured)
    const getKoalaApiKey = () => {
        const config = getConfig()[0] || {};
        const ks = config.koalastore || {};
        return (ks.is_active && ks.api_key) ? ks.api_key : null;
    };

    // Helper: read product.json safely
    const readLocalProducts = () => {
        if (!fs.existsSync(productFile)) return [];
        try { return JSON.parse(fs.readFileSync(productFile, 'utf8')); } catch { return []; }
    };

    // API: Check Koala Balance (GET uses configured key, POST validates an unsaved key)
    const handleKoalaBalance = async (apiKey, res) => {
        try {
            const data = await koalaStore.getBalance(apiKey);
            if (data && data.success) return res.json({ success: true, balance: data.data.balance });
            console.warn("Koala Balance Fail Response:", data);
            return res.status(400).json({ error: (data && data.message) ? data.message : 'Invalid API Key' });
        } catch (err) {
            console.error("Koala Balance error", err);
            return res.status(500).json({ error: 'Connection failure' });
        }
    };
    app.get('/api/koala/balance', async (req, res) => {
        const apiKey = getKoalaApiKey();
        if (!apiKey) return res.status(400).json({ error: 'Koala Store belum aktif / API Key kosong' });
        await handleKoalaBalance(apiKey, res);
    });
    app.post('/api/koala/balance', async (req, res) => {
        const apiKey = (req.body.apiKey || '').trim();
        if (!apiKey) return res.status(400).json({ error: 'API Key is required' });
        await handleKoalaBalance(apiKey, res);
    });

    // API: Browse KS catalog — flat list of variants with isImported flag.
    // No write side effects. Used by the Koala Store dashboard page.
    app.get('/api/koala/catalog', async (req, res) => {
        const apiKey = getKoalaApiKey();
        if (!apiKey) return res.status(400).json({ error: 'Koala Store belum aktif / API Key kosong' });

        try {
            const ksRes = await getKoalaProductsCached(apiKey);
            if (!ksRes.success || !ksRes.data) return res.status(400).json({ error: ksRes.message || 'Gagal fetch katalog' });

            const importedIds = new Set(readLocalProducts().filter(isKsProduct).map(p => p.productId));
            const items = [];
            ksRes.data.forEach(p => {
                (p.variants || []).forEach(v => {
                    const stock = v.available_stock !== undefined ? v.available_stock : (v.stock !== undefined ? v.stock : 0);
                    const productId = `ks_${v.code_variant}`;
                    items.push({
                        productId,
                        variant_code: v.code_variant,
                        groupName: p.name,
                        variantName: v.name || '',
                        displayName: v.name ? `${p.name} - ${v.name}` : p.name,
                        price: parseFloat(v.price) || 0,
                        stock,
                        description: p.description || '',
                        isImported: importedIds.has(productId)
                    });
                });
            });
            res.json({ success: true, items });
        } catch (err) {
            console.error("Koala Catalog error", err);
            res.status(500).json({ error: 'Connection failure' });
        }
    });

    // API: Import selected KS variants into product.json.
    // Body: { items: [{ variant_code, displayName, price, description, stock, profit? }] }
    app.post('/api/koala/import', (req, res) => {
        const items = Array.isArray(req.body.items) ? req.body.items : null;
        if (!items || items.length === 0) return res.status(400).json({ error: 'items array required' });

        try {
            const current = readLocalProducts();
            const existingIds = new Set(current.map(p => p.productId));
            const toAdd = [];
            for (const it of items) {
                if (!it.variant_code) continue;
                const productId = `ks_${it.variant_code}`;
                if (existingIds.has(productId)) continue; // skip duplicates
                const basePrice = parseFloat(it.price) || 0;
                const profit = parseFloat(it.profit) || 0;
                toAdd.push({
                    productName: String(it.displayName || it.variant_code).trim(),
                    productId,
                    category: 'Koala',
                    ks_base_price: basePrice,
                    priceProduct: basePrice + profit,
                    profit,
                    description: it.description || '',
                    source: 'koalastore',
                    variant_code: it.variant_code,
                    stockCount: parseInt(it.stock) || 0,
                    totalProdukTerjual: 0
                });
                existingIds.add(productId);
            }
            if (toAdd.length === 0) return res.json({ success: true, added: 0, message: 'Tidak ada produk baru (semua sudah di-import)' });

            saveProducts([...current, ...toAdd]);
            res.json({ success: true, added: toAdd.length, message: `${toAdd.length} produk di-import` });
        } catch (err) {
            console.error("Koala Import error", err);
            res.status(500).json({ error: 'Failed to import products' });
        }
    });

    // API: Refresh stockCount + ks_base_price for already-imported KS products.
    app.post('/api/koala/refresh-stock', async (req, res) => {
        const apiKey = getKoalaApiKey();
        if (!apiKey) return res.status(400).json({ error: 'Koala Store belum aktif / API Key kosong' });

        try {
            const ksRes = await getKoalaProductsCached(apiKey);
            if (!ksRes.success || !ksRes.data) return res.status(400).json({ error: ksRes.message || 'Gagal fetch katalog' });

            const variantMap = new Map();
            ksRes.data.forEach(p => {
                (p.variants || []).forEach(v => {
                    const stock = v.available_stock !== undefined ? v.available_stock : (v.stock !== undefined ? v.stock : 0);
                    variantMap.set(v.code_variant, { price: parseFloat(v.price) || 0, stock });
                });
            });

            const current = readLocalProducts();
            let updated = 0;
            const next = current.map(p => {
                if (!isKsProduct(p)) return p;
                const fresh = variantMap.get(p.variant_code);
                if (!fresh) return { ...p, stockCount: 0 };
                updated++;
                const profit = parseFloat(p.profit) || 0;
                return { ...p, ks_base_price: fresh.price, priceProduct: fresh.price + profit, stockCount: fresh.stock };
            });
            saveProducts(next);
            res.json({ success: true, updated, message: `Refreshed ${updated} produk` });
        } catch (err) {
            console.error("Koala Refresh Stock error", err);
            res.status(500).json({ error: 'Failed to refresh stock' });
        }
    });

    // API: Bulk Set Koala Profit (only affects already-imported KS products)
    app.post('/api/koala/bulk-profit', async (req, res) => {
        const { amount, type } = req.body;
        if (amount === undefined || !type) return res.status(400).json({ error: 'amount dan type wajib diisi' });
        const amountNum = parseFloat(amount);
        if (isNaN(amountNum)) return res.status(400).json({ error: 'amount harus angka' });

        try {
            const current = readLocalProducts();
            const ksItems = current.filter(isKsProduct);
            if (ksItems.length === 0) return res.status(400).json({ error: 'Belum ada produk Koala yang di-import' });

            const next = current.map(p => {
                if (!isKsProduct(p)) return p;
                const basePrice = parseFloat(p.ks_base_price) || parseFloat(p.priceProduct) || 0;
                const profitValue = type === 'percent'
                    ? Math.floor(basePrice * (amountNum / 100))
                    : Math.floor(amountNum);
                return { ...p, profit: profitValue, priceProduct: basePrice + profitValue };
            });
            saveProducts(next);
            res.json({ success: true, message: `Update profit pada ${ksItems.length} produk Koala` });
        } catch (err) {
            console.error("Bulk Profit error:", err);
            res.status(500).json({ error: `Internal error: ${err.message}` });
        }
    });

    // ==========================================
    // DIGIFLAZZ PPOB (prepaid only — v1)
    // ==========================================
    const isDfProduct = (p) => p && (p.source === 'digiflazz' || (p.productId && p.productId.startsWith('df_')));

    const getDigiflazzCreds = () => {
        const config = getConfig()[0] || {};
        const df = config.digiflazz || {};
        if (!df.is_active || !df.username || !df.api_key) return null;
        return { username: df.username, apiKey: df.api_key };
    };

    // GET uses configured creds, POST validates an unsaved pair (for inline UI check)
    const handleDfBalance = async (creds, res) => {
        const r = await digiflazz.cekSaldo(creds);
        if (r.ok) return res.json({ success: true, balance: r.deposit });
        return res.status(400).json({ error: r.error || 'Gagal cek saldo', rc: r.rc });
    };
    app.get('/api/digiflazz/balance', async (req, res) => {
        const creds = getDigiflazzCreds();
        if (!creds) return res.status(400).json({ error: 'Digiflazz belum aktif / kredensial kosong' });
        await handleDfBalance(creds, res);
    });
    app.post('/api/digiflazz/balance', async (req, res) => {
        const username = String(req.body.username || '').trim();
        const apiKey = String(req.body.apiKey || req.body.api_key || '').trim();
        if (!username || !apiKey) return res.status(400).json({ error: 'username & apiKey wajib' });
        await handleDfBalance({ username, apiKey }, res);
    });

    // Browse catalog (cached price-list, decorated with isImported flag).
    // Optional query: category, brand, search, force=1
    app.get('/api/digiflazz/catalog', async (req, res) => {
        const creds = getDigiflazzCreds();
        if (!creds) return res.status(400).json({ error: 'Digiflazz belum aktif / kredensial kosong' });
        const force = req.query.force === '1' || req.query.force === 'true';

        const r = await digiflazz.getPriceList({ ...creds, force });
        if (!r.ok) {
            // Rate-limited & no cache to fall back on → enrich error with cooldown info so UI can guide user
            const remaining = Math.max(0, FULL_SYNC_COOLDOWN_MS - (Date.now() - _lastFullSyncAt));
            const isRateLimit = r.rc === '83' || (r.error || '').toLowerCase().includes('limitasi');
            return res.status(400).json({
                error: r.error || 'Gagal fetch price list',
                rc: r.rc,
                rate_limited: isRateLimit,
                cooldown_remaining_ms: remaining,
                hint: isRateLimit ? `Cooldown Digiflazz aktif (~${Math.ceil(remaining / 1000)}s lagi). Auto-sync akan retry otomatis tiap 60s sampai berhasil — refresh halaman setelah cooldown habis.` : null,
            });
        }

        const importedIds = new Set(readLocalProducts().filter(isDfProduct).map(p => p.productId));
        const qCategory = (req.query.category || '').toString().toLowerCase();
        const qBrand = (req.query.brand || '').toString().toLowerCase();
        const qSearch = (req.query.search || '').toString().toLowerCase();

        let items = r.items.map(it => ({
            productId: `df_${it.buyer_sku_code}`,
            buyer_sku_code: it.buyer_sku_code,
            product_name: it.product_name,
            category: it.category,
            brand: it.brand,
            type: it.type,
            seller_name: it.seller_name,
            price: parseFloat(it.price) || 0,
            buyer_product_status: !!it.buyer_product_status,
            seller_product_status: !!it.seller_product_status,
            unlimited_stock: !!it.unlimited_stock,
            stock: parseInt(it.stock) || 0,
            multi: !!it.multi,
            start_cut_off: it.start_cut_off || '',
            end_cut_off: it.end_cut_off || '',
            desc: it.desc || '',
            isImported: importedIds.has(`df_${it.buyer_sku_code}`),
        }));

        if (qCategory) items = items.filter(x => (x.category || '').toLowerCase() === qCategory);
        if (qBrand) items = items.filter(x => (x.brand || '').toLowerCase() === qBrand);
        if (qSearch) items = items.filter(x =>
            (x.product_name || '').toLowerCase().includes(qSearch) ||
            (x.buyer_sku_code || '').toLowerCase().includes(qSearch));

        // Distinct facets for filters
        const categories = Array.from(new Set(r.items.map(x => x.category).filter(Boolean))).sort();
        const brands = Array.from(new Set(r.items.map(x => x.brand).filter(Boolean))).sort();

        res.json({ success: true, items, total: r.items.length, cached: r.cached, categories, brands });
    });

    // Import selected SKUs into product.json.
    // Body: { items: [{ buyer_sku_code, profit }] }
    // Resolution strategy (avoid burning the 5-min broad pricelist cooldown):
    //   1. Try cached pricelist (no force) — instant, no API call if cache warm.
    //   2. If cache miss / item not in cache, fall back to per-SKU getSinglePrice
    //      (1/sec rate limit, isolated from broad pricelist limit).
    app.post('/api/digiflazz/import', async (req, res) => {
        const creds = getDigiflazzCreds();
        if (!creds) return res.status(400).json({ error: 'Digiflazz belum aktif / kredensial kosong' });
        const items = Array.isArray(req.body.items) ? req.body.items : null;
        if (!items || items.length === 0) return res.status(400).json({ error: 'items array required' });

        // Try cache-first (won't hit API if warm). Pass force=false → returns cached if valid.
        let skuMap = new Map();
        const pl = await digiflazz.getPriceList(creds);
        if (pl.ok && Array.isArray(pl.items)) {
            skuMap = new Map(pl.items.map(x => [x.buyer_sku_code, x]));
        }
        // Per-SKU fallback for missing items — uses separate 1/sec rate limit, not the 5-min broad limit.
        const needLookup = items.filter(it => it.buyer_sku_code && !skuMap.has(it.buyer_sku_code));
        for (const it of needLookup) {
            const r = await digiflazz.getSinglePrice({ ...creds, code: it.buyer_sku_code });
            if (r.ok && r.item) skuMap.set(r.item.buyer_sku_code, r.item);
            if (needLookup.length > 1) await new Promise(x => setTimeout(x, 1100));
        }
        if (skuMap.size === 0) return res.status(400).json({ error: pl.error || 'Tidak bisa fetch detail SKU. Coba klik Sync Catalog dulu.' });

        const current = readLocalProducts();
        const existingIds = new Set(current.map(p => p.productId));
        const toAdd = [];
        for (const it of items) {
            const sku = String(it.buyer_sku_code || '').trim();
            if (!sku) continue;
            const productId = `df_${sku}`;
            if (existingIds.has(productId)) continue;
            const src = skuMap.get(sku);
            if (!src) continue;
            const basePrice = parseFloat(src.price) || 0;
            const profit = Math.max(0, parseInt(it.profit) || 0);
            toAdd.push({
                productName: src.product_name,
                productId,
                category: src.category || 'PPOB',
                brand: src.brand || '',
                type: src.type || '',
                source: 'digiflazz',
                productType: 'ppob_prepaid',
                buyer_sku_code: sku,
                df_base_price: basePrice,
                priceProduct: basePrice + profit,
                profit,
                description: src.desc || '',
                stockCount: src.unlimited_stock ? 9999 : (parseInt(src.stock) || 0),
                unlimited_stock: !!src.unlimited_stock,
                multi: !!src.multi,
                start_cut_off: src.start_cut_off || '',
                end_cut_off: src.end_cut_off || '',
                seller_name: src.seller_name || '',
                totalProdukTerjual: 0,
            });
            existingIds.add(productId);
        }
        if (toAdd.length === 0) return res.json({ success: true, added: 0, message: 'Tidak ada produk baru (semua sudah di-import)' });

        saveProducts([...current, ...toAdd]);
        res.json({ success: true, added: toAdd.length, message: `${toAdd.length} produk Digiflazz di-import` });
    });

    // Remove an imported Digiflazz product (does NOT touch Digiflazz catalog).
    app.delete('/api/digiflazz/import/:productId', (req, res) => {
        const id = req.params.productId;
        const current = readLocalProducts();
        const next = current.filter(p => p.productId !== id);
        if (next.length === current.length) return res.status(404).json({ error: 'Produk tidak ditemukan' });
        saveProducts(next);
        res.json({ success: true, removed: id });
    });

    // ---------------------------------------------------------------------
    // REFRESH IMPORTED — per-SKU price lookup (separate Digiflazz rate limit: 1/sec)
    // Runs as background job to avoid blocking the HTTP request. Progress polled via
    // /api/digiflazz/refresh/status. Spaces calls by 1100ms.
    // ---------------------------------------------------------------------
    let _refreshJob = {
        id: null, status: 'idle', total: 0, done: 0, updated: 0, stale: 0,
        errors: [], current_sku: '', started_at: 0, finished_at: 0,
    };

    const _runRefreshJob = async (creds) => {
        const current = readLocalProducts();
        const dfProducts = current.filter(isDfProduct);
        _refreshJob = {
            id: 'rj-' + Date.now(), status: 'running', total: dfProducts.length, done: 0,
            updated: 0, stale: 0, errors: [], current_sku: '',
            started_at: Date.now(), finished_at: 0,
        };
        rcLog('DIGIFLAZZ_REFRESH', `START job=${_refreshJob.id} skus=${dfProducts.length}`);

        for (const p of dfProducts) {
            _refreshJob.current_sku = p.buyer_sku_code;
            try {
                const r = await digiflazz.getSinglePrice({ ...creds, code: p.buyer_sku_code });
                if (r.ok && r.item) {
                    const basePrice = parseFloat(r.item.price) || 0;
                    const profit = parseFloat(p.profit) || 0;
                    // Atomic per-SKU mutation on disk — re-read latest to avoid clobbering admin edits
                    const list = readLocalProducts();
                    const idx = list.findIndex(x => x.productId === p.productId);
                    if (idx !== -1) {
                        list[idx] = {
                            ...list[idx],
                            df_base_price: basePrice,
                            priceProduct: basePrice + profit,
                            stockCount: r.item.unlimited_stock ? 9999 : (parseInt(r.item.stock) || 0),
                            unlimited_stock: !!r.item.unlimited_stock,
                            seller_product_status: !!r.item.seller_product_status,
                            buyer_product_status: !!r.item.buyer_product_status,
                            multi: !!r.item.multi,
                            start_cut_off: r.item.start_cut_off || '',
                            end_cut_off: r.item.end_cut_off || '',
                        };
                        saveProducts(list);
                    }
                    _refreshJob.updated++;
                } else {
                    // SKU gone or rejected
                    const list = readLocalProducts();
                    const idx = list.findIndex(x => x.productId === p.productId);
                    if (idx !== -1) {
                        list[idx] = { ...list[idx], stockCount: 0, seller_product_status: false };
                        saveProducts(list);
                    }
                    _refreshJob.stale++;
                    _refreshJob.errors.push({ sku: p.buyer_sku_code, reason: r.error || ('rc=' + r.rc) });
                }
            } catch (e) {
                _refreshJob.errors.push({ sku: p.buyer_sku_code, reason: e.message });
            }
            _refreshJob.done++;
            // Throttle to comply with Digiflazz 1/sec per-code limit
            await new Promise(r => setTimeout(r, 1100));
        }

        _refreshJob.status = 'done';
        _refreshJob.finished_at = Date.now();
        _refreshJob.current_sku = '';
        rcLog('DIGIFLAZZ_REFRESH', `DONE job=${_refreshJob.id} updated=${_refreshJob.updated} stale=${_refreshJob.stale} errors=${_refreshJob.errors.length} duration=${Math.round((_refreshJob.finished_at - _refreshJob.started_at)/1000)}s`);
    };

    app.post('/api/digiflazz/refresh', async (req, res) => {
        const creds = getDigiflazzCreds();
        if (!creds) return res.status(400).json({ error: 'Digiflazz belum aktif / kredensial kosong' });
        if (_refreshJob.status === 'running') {
            return res.json({ success: true, already_running: true, job: _refreshJob });
        }
        // Fire and forget — runs in background. Reply immediately so client can poll status.
        _runRefreshJob(creds).catch(e => {
            console.error('[DIGIFLAZZ_REFRESH] job crashed:', e);
            _refreshJob.status = 'error';
            _refreshJob.finished_at = Date.now();
            _refreshJob.errors.push({ sku: '*', reason: e.message });
        });
        res.json({ success: true, started: true, job: _refreshJob });
    });

    app.get('/api/digiflazz/refresh/status', (req, res) => {
        res.json({ success: true, job: _refreshJob });
    });

    // ---------------------------------------------------------------------
    // SYNC STATUS — last full pricelist sync timestamp + cooldown window (for UI cooldown badge)
    // Persisted to disk so server restarts don't reset the cooldown clock and accidentally
    // re-trigger Digiflazz's 5-min rate limit (rc=83). Without persistence each restart would
    // fire a fresh auto-sync within the prior cooldown window, perpetually rate-limited.
    // ---------------------------------------------------------------------
    const _syncStateFile = path.join(projectRoot, 'digiflazz_sync_state.json');
    let _lastFullSyncAt = 0;
    let _lastFullSyncOk = false;
    let _lastFullSyncMsg = '';
    // 5m 15s — Digiflazz spec is 5m, we add 15s buffer to avoid edge-case rejection
    // (Digiflazz seems to reset cooldown clock on every received request, including failed ones).
    const FULL_SYNC_COOLDOWN_MS = 5 * 60 * 1000 + 15 * 1000;

    // Load persisted state on boot — covers restart-during-cooldown scenarios.
    try {
        if (fs.existsSync(_syncStateFile)) {
            const s = JSON.parse(fs.readFileSync(_syncStateFile, 'utf8'));
            if (s && typeof s.last_full_sync_at === 'number') {
                _lastFullSyncAt = s.last_full_sync_at;
                _lastFullSyncOk = !!s.last_full_sync_ok;
                _lastFullSyncMsg = String(s.last_full_sync_msg || '');
                const ageSec = Math.round((Date.now() - _lastFullSyncAt) / 1000);
                console.log(`[DIGIFLAZZ] Loaded sync state: last sync ${ageSec}s ago (ok=${_lastFullSyncOk}). Cooldown ${Math.max(0, 300 - ageSec)}s remaining.`);
            }
        }
    } catch (e) { console.error('[DIGIFLAZZ] Failed to load sync state:', e.message); }

    const _persistSyncState = () => {
        try {
            writeFileAtomic(_syncStateFile, JSON.stringify({
                last_full_sync_at: _lastFullSyncAt,
                last_full_sync_ok: _lastFullSyncOk,
                last_full_sync_msg: _lastFullSyncMsg,
            }, null, 2));
        } catch (e) { console.error('[DIGIFLAZZ] Failed to persist sync state:', e.message); }
    };

    app.get('/api/digiflazz/status', (req, res) => {
        const cfg = getConfig()[0] || {};
        const df = cfg.digiflazz || {};
        const now = Date.now();
        const next = _lastFullSyncAt > 0 ? Math.max(0, FULL_SYNC_COOLDOWN_MS - (now - _lastFullSyncAt)) : 0;
        res.json({
            success: true,
            is_active: !!(df.is_active && df.username && df.api_key),
            delivery: digiflazz.describeDeliveryMode(df),
            poll_interval_ms: digiflazz.getEffectivePollIntervalMs(df),
            last_full_sync_at: _lastFullSyncAt,
            last_full_sync_ok: _lastFullSyncOk,
            last_full_sync_msg: _lastFullSyncMsg,
            next_full_sync_allowed_in_ms: next,
            full_sync_cooldown_ms: FULL_SYNC_COOLDOWN_MS,
            auto_sync_interval_ms: 5 * 60 * 1000 + 30 * 1000,
            refresh_job: _refreshJob,
        });
    });

    // Patch the existing catalog endpoint to track admin-initiated force sync
    // (We do this by wrapping a small helper — actual /api/digiflazz/catalog route was added earlier.)
    // Effective tracking happens inside the autoSync function + we also mark when client requests force=1.
    // The route already calls getPriceList; we attach a tap via getCachedPricelistFetchedAt below.
    const _markFullSyncAttempt = (ok, msg) => {
        _lastFullSyncAt = Date.now();
        _lastFullSyncOk = ok;
        _lastFullSyncMsg = msg || '';
        _persistSyncState();
    };

    // ---------------------------------------------------------------------
    // AUTO-SYNC POLLER — every 5min 30s, force-refresh full pricelist so internal cache is warm
    // and admin's "Sync Catalog" button on the catalog page returns instantly. Skips if Digiflazz
    // not configured or if a manual sync was done within the cooldown window.
    // ---------------------------------------------------------------------
    const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1000 + 30 * 1000; // 5m30s
    const _autoSyncTick = async () => {
        try {
            const creds = getDigiflazzCreds();
            if (!creds) return;
            // Skip if last sync within the Digiflazz 5-min cooldown — safety net
            if (Date.now() - _lastFullSyncAt < FULL_SYNC_COOLDOWN_MS) {
                return;
            }
            // DO NOT call invalidatePriceList() here. force:true already bypasses cache,
            // and on success the cache is replaced atomically inside getPriceList. If the
            // call FAILS (rate-limited / network), we want the old cache preserved as
            // fallback — invalidating first would orphan the UI with empty results.
            const r = await digiflazz.getPriceList({ ...creds, force: true });
            if (r.ok) {
                _markFullSyncAttempt(true, `auto-sync OK (${r.items.length} SKUs)`);
                rcLog('DIGIFLAZZ_AUTOSYNC', `OK skus=${r.items.length}`);
            } else {
                // Only mark timestamp if it was a Digiflazz-side rate limit (rc=83) — that
                // genuinely consumes our cooldown slot. Network / connection errors should
                // not advance the cooldown clock (we want to retry sooner).
                if (r.rc === '83' || (r.error || '').toLowerCase().includes('limitasi')) {
                    _markFullSyncAttempt(false, r.error || 'rate limited');
                }
                rcLog('DIGIFLAZZ_AUTOSYNC', `FAIL ${r.error || 'unknown'} rc=${r.rc || '-'}`);
            }
        } catch (e) {
            console.error('[DIGIFLAZZ_AUTOSYNC] error:', e.message);
        }
    };
    // Self-rescheduling auto-sync: success → wait full interval (5m30s); failure → retry in 60s
    // until either success or genuine Digiflazz cooldown elapses.
    const _scheduleNextAutoSync = (delayMs) => setTimeout(async () => {
        let nextDelay = AUTO_SYNC_INTERVAL_MS;
        try {
            // Check Digiflazz-side cooldown enforced by _autoSyncTick's internal guard. If we
            // recently synced (success or rate-limited fail), back off accordingly.
            const sinceLast = Date.now() - _lastFullSyncAt;
            if (sinceLast < FULL_SYNC_COOLDOWN_MS) {
                nextDelay = FULL_SYNC_COOLDOWN_MS - sinceLast + 5_000; // wait until cooldown + buffer
            } else {
                await _autoSyncTick();
                // If after the tick we still don't have fresh data, retry in 60s
                const stillNoFresh = (Date.now() - _lastFullSyncAt) >= FULL_SYNC_COOLDOWN_MS;
                nextDelay = stillNoFresh ? 60_000 : AUTO_SYNC_INTERVAL_MS;
            }
        } catch (e) {
            nextDelay = 60_000;
        }
        _scheduleNextAutoSync(nextDelay);
    }, Math.max(1_000, delayMs));

    // Initial sync 3s after boot — populate cache ASAP for fresh dashboard visits
    _scheduleNextAutoSync(3_000);

    // Hook the catalog endpoint to record EVERY actual API fetch (fresh, not cached) so the
    // auto-sync poller knows when Digiflazz was last contacted — prevents auto-sync from firing
    // immediately after a page-open fetch and hitting the 5-min rate limit.
    //
    // Strategy: tap response.json, inspect body.cached flag (only set on fresh API hit).
    app.use('/api/digiflazz/catalog', (req, res, next) => {
        if (req.method !== 'GET') return next();
        const origJson = res.json.bind(res);
        res.json = (body) => {
            if (body && body.success && Array.isArray(body.items)) {
                // body.cached === false means we just hit Digiflazz API → mark cooldown.
                // body.cached === true means we returned from internal cache → don't mark.
                if (body.cached === false) {
                    const tag = (req.query.force === '1' || req.query.force === 'true') ? 'manual sync' : 'page-open fetch';
                    _markFullSyncAttempt(true, `${tag} (${body.total} SKUs)`);
                }
            } else if (body && body.error && (req.query.force === '1' || req.query.force === 'true')) {
                _markFullSyncAttempt(false, body.error);
            }
            return origJson(body);
        };
        next();
    });

    // Set/override profit for an imported Digiflazz SKU.
    app.post('/api/digiflazz/profit', (req, res) => {
        const id = String(req.body.productId || '').trim();
        const profit = Math.max(0, parseInt(req.body.profit) || 0);
        if (!id) return res.status(400).json({ error: 'productId wajib' });

        const current = readLocalProducts();
        const idx = current.findIndex(p => p.productId === id && isDfProduct(p));
        if (idx === -1) return res.status(404).json({ error: 'Produk tidak ditemukan' });
        const basePrice = parseFloat(current[idx].df_base_price) || 0;
        current[idx].profit = profit;
        current[idx].priceProduct = basePrice + profit;
        saveProducts(current);
        res.json({ success: true, profit, priceProduct: current[idx].priceProduct });
    });

    // ==========================================
    // DIGIFLAZZ WEBHOOK — incoming async tx status
    // Headers:
    //   X-Hub-Signature: sha1=<HMAC-SHA1(rawBody, webhook_secret)>
    //   X-Digiflazz-Event: create | update
    //   User-Agent: Digiflazz-Hookshot (prepaid)
    // Body: { data: { ref_id, customer_no, buyer_sku_code, status, rc, message, sn, price, buyer_last_saldo, ... } }
    //
    // We always 200 OK after recording, even on bad signature (best practice: never 500 on a webhook
    // unless you genuinely want a retry). For security, we just ignore bad signatures.
    // ==========================================
    app.post('/webhook/digiflazz', async (req, res) => {
        const config = getConfig()[0] || {};
        const df = config.digiflazz || {};
        const secret = df.webhook_secret || '';
        const sigHeader = req.header('X-Hub-Signature') || req.header('x-hub-signature') || '';
        const eventType = req.header('X-Digiflazz-Event') || req.header('x-digiflazz-event') || '';
        const raw = req.rawBody || JSON.stringify(req.body || {});

        if (!secret) {
            rcLog('DIGIFLAZZ_WEBHOOK', `WARN no webhook_secret configured — accepting unverified payload (event=${eventType})`);
        } else if (!digiflazz.verifyWebhookSignature(raw, sigHeader, secret)) {
            rcLog('DIGIFLAZZ_WEBHOOK', `REJECT invalid signature (event=${eventType}, header="${sigHeader.slice(0, 20)}...")`);
            return res.status(401).json({ ok: false, error: 'invalid signature' });
        }

        const payload = (req.body && req.body.data) ? req.body.data : req.body;
        const refId = payload && payload.ref_id;
        if (!refId) {
            rcLog('DIGIFLAZZ_WEBHOOK', `REJECT missing ref_id (event=${eventType})`);
            return res.status(400).json({ ok: false, error: 'missing ref_id' });
        }

        const bucket = digiflazz.classifyRc(payload.rc, payload.status);
        rcLog('DIGIFLAZZ_WEBHOOK', `event=${eventType} ref=${refId} sku=${payload.buyer_sku_code} rc=${payload.rc} status=${payload.status} → ${bucket}`);

        // Hand off to the bot dispatcher (registered by tg-bot.js / wa-bot.js via global hook).
        // If no dispatcher is registered yet, we still persist the result on the tx for later replay.
        let dispatched = false;
        try {
            const dispatcher = app.get('digiflazzDispatcher');
            if (typeof dispatcher === 'function') {
                await dispatcher({ refId, payload, bucket, eventType });
                dispatched = true;
            }
        } catch (e) {
            console.error('[DIGIFLAZZ_WEBHOOK] dispatcher error:', e.message);
        }

        // Persist webhook result onto the matching tx (TG file first, then WA) so it survives restart.
        const persist = async (txs) => {
            const idx = txs.findIndex(t => t.reference === refId || t.id === refId);
            if (idx === -1) return false;
            const tx = txs[idx];
            tx.digiflazz = tx.digiflazz || {};
            tx.digiflazz.last_event = eventType;
            tx.digiflazz.rc = payload.rc;
            tx.digiflazz.status = payload.status;
            tx.digiflazz.message = payload.message;
            tx.digiflazz.sn = payload.sn || tx.digiflazz.sn || '';
            tx.digiflazz.buyer_last_saldo = payload.buyer_last_saldo;
            tx.digiflazz.bucket = bucket;
            tx.digiflazz.last_webhook_at = Date.now();
            // Only collapse to terminal states; never overwrite PAID/EXPIRED status field
            // (delivery state is what bot uses to know if SN was sent).
            if (bucket === 'SUCCESS') tx.deliveryState = 'DELIVERED';
            else if (bucket === 'FAILED') tx.deliveryState = 'FAILED';
            else tx.deliveryState = 'PROCESSING';
            return true;
        };
        let persisted = false;
        try { await withTgTxFile(async (txs) => { persisted = await persist(txs); }); } catch {}
        if (!persisted) { try { await withWaTxFile(async (txs) => { persisted = await persist(txs); }); } catch {} }

        res.json({ ok: true, dispatched, persisted });
    });

    // API: Get Saweria Transactions
    app.get('/api/saweria/transactions', async (req, res) => {
        try {
            let token = '';
            if (fs.existsSync(path.join(projectRoot, 'configtelebot.json'))) {
                const conf = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json')));
                const c = Array.isArray(conf) ? conf[0] : conf;
                token = c.saweria ? c.saweria.token : '';
            }

            if (!token) return res.status(400).json({ error: 'Saweria Token not configured' });

            const fetchRes = await fetch('https://backend.saweria.co/transactions?page=1&page_size=15', {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:146.0) Gecko/20100101 Firefox/146.0',
                    'Accept-Encoding': 'gzip, deflate, br, zstd',
                    'accept-language': 'id,en-US;q=0.7,en;q=0.3',
                    'referer': 'https://saweria.co/',
                    'authorization': token,
                    'origin': 'https://saweria.co',
                    'sec-fetch-dest': 'empty',
                    'sec-fetch-mode': 'cors',
                    'sec-fetch-site': 'same-site',
                    'priority': 'u=4',
                    'te': 'trailers'
                }
            });

            if (!fetchRes.ok) return res.status(fetchRes.status).json([]);

            const data = await fetchRes.json();
            const transactions = data.data.transactions || [];
            const donations = transactions.filter(tx => tx.type === 'donation');
            res.json(donations);

        } catch (err) {
            console.error("Saweria Transaction Error:", err);
            res.status(500).json({ error: 'Failed' });
        }
    });

    // API: Get Settings
    app.get('/api/settings', (req, res) => {
        try {
            let currentConfig = {};
            if (fs.existsSync(path.join(projectRoot, 'configtelebot.json'))) {
                try {
                    const existing = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json'), 'utf8'));
                    currentConfig = Array.isArray(existing) ? existing[0] : existing;
                } catch (e) { currentConfig = {}; }
            }
            // Return config directly (ensure frontend handles potentially missing keys)
            res.json(currentConfig);
        } catch (err) {
            res.status(500).json({ error: 'Failed to load settings' });
        }
    });

    // API: Update Settings (FIXED)
    app.post('/api/settings', async (req, res) => {
        try {
            // 1. Baca Config Lama dulu agar tidak tertimpa
            let currentConfig = {};
            if (fs.existsSync(path.join(projectRoot, 'configtelebot.json'))) {
                try {
                    const existing = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json'), 'utf8'));
                    currentConfig = Array.isArray(existing) ? existing[0] : existing;
                } catch (e) { currentConfig = {}; }
            }

            const body = req.body;
            let broadcaster = bot; // Default to global bot

            // 2. Update Bot Token (only if token actually CHANGED)
            const newToken = (body.bot_token || '').trim();
            const oldToken = (currentConfig.botToken || '').trim();
            const tokenChanged = newToken !== '' && newToken !== oldToken;

            if (tokenChanged) {
                // Mutex: prevent concurrent bot swaps
                if (botSwapInProgress) {
                    return res.status(429).json({ error: 'Bot sedang di-restart, tunggu sebentar.' });
                }
                botSwapInProgress = true;

                try {
                    // 1. Create new bot instance WITHOUT polling to validate first
                    const tempBot = new TelegramBot(newToken, {
                        polling: false,
                        request: {
                            agentOptions: {
                                keepAlive: true,
                                family: 4
                            }
                        }
                    });

                    // 2. Validate token via getMe (no polling needed)
                    const botIdentity = await tempBot.getMe();
                    console.log(`✅ Token Validated. Bot: @${botIdentity.username}`);

                    // 3. Update Config
                    currentConfig.botToken = newToken;

                    // 4. Save config FIRST so response can be sent quickly
                    const configToSave = [currentConfig];
                    fs.writeFileSync(path.join(projectRoot, 'configtelebot.json'), JSON.stringify(configToSave, null, 2));
                    setConfig(configToSave);

                    // 5. Respond immediately — bot swap continues in background
                    res.json({ success: true, message: 'Settings saved! Bot sedang di-restart...' });

                    // 6. Hot Swap in background (async, non-blocking)
                    try {
                        await bot.setInstance(tempBot);
                        await tempBot.startPolling();
                        console.log('✅ New bot polling started successfully.');
                    } catch (pollErr) {
                        console.error('⚠️ CRITICAL: Bot swapped but polling failed! Retrying...', pollErr.message);
                        await new Promise(r => setTimeout(r, 1000));
                        try {
                            await tempBot.startPolling();
                            console.log('✅ Bot polling started on retry.');
                        } catch (retryErr) {
                            console.error('❌ Bot polling retry also failed:', retryErr.message);
                        }
                    }

                    return; // Response already sent above

                } catch (e) {
                    console.error("Token Validation Error:", e.message);
                    return res.status(400).json({ error: '❌ Token Telegram Bot TIDAK VALID!' });
                } finally {
                    botSwapInProgress = false;
                }
            }

            // 3. Update Payment Providers (Partial Update & Broadcast)
            const oldProvider = currentConfig.payment_provider || 'tripay';
            const newProvider = body.payment_provider;

            if (newProvider) {
                // Update Config
                currentConfig.payment_provider = newProvider;

                // Auto-start/stop GoPay batch poller on provider switch
                if (newProvider === 'gopay' && oldProvider !== 'gopay') {
                    if (currentConfig.gopay && currentConfig.gopay.email && currentConfig.gopay.password) {
                        gopay.startGopayBatchPoller(currentConfig.gopay);
                        console.log('🟢 GoPay Batch Poller: Auto-started (provider switched to gopay)');
                    }
                } else if (newProvider !== 'gopay' && oldProvider === 'gopay') {
                    gopay.stopGopayBatchPoller();
                    console.log('⚪ GoPay Batch Poller: Auto-stopped (provider switched to ' + newProvider + ')');
                }

                // Allow broadcast even if provider same (User Request)
                const shouldBroadcast = false;

                if (shouldBroadcast) {
                    const users = getUsers();
                    const providerName = newProvider === 'saweria' ? 'Saweria' : (newProvider === 'pakasir' ? 'Pakasir' : (newProvider === 'gopay' ? 'GoPay' : (newProvider === 'dompetx' ? 'DompetX' : 'Tripay')));
                    const broadcastMessage = `📢 *Update Sistem*\n\nMetode pembayaran telah diperbarui menggunakan: *${providerName}*.\nSilakan cek /info atau lakukan pembelian sekarang! 🛒`;

                    console.log(`[BROADCAST] Sending payment update to ${users.length} users...`);

                    // Send to all users using the valid broadcaster
                    users.forEach(chatId => {
                        broadcaster.sendMessage(chatId, broadcastMessage, { parse_mode: 'Markdown' }).catch(err => {
                            // console.error(`Failed to send to ${chatId}:`, err.message);
                        });
                    });
                }
            }

            // Tripay (Mapping snake_case dari frontend ke camelCase/mixed variable backend)
            if (body.api_key && body.api_key.trim() !== '') currentConfig.apiKey = body.api_key;
            if (body.private_key && body.private_key.trim() !== '') currentConfig.privateKey = body.private_key;
            if (body.merchant_code && body.merchant_code.trim() !== '') currentConfig.merchant_code = body.merchant_code;
            if (body.merchant_ref && body.merchant_ref.trim() !== '') currentConfig.merchant_ref = body.merchant_ref;

            // Saweria Config
            if (!currentConfig.saweria) currentConfig.saweria = {};
            if (body.saweria_token && body.saweria_token.trim() !== '') {
                currentConfig.saweria.token = body.saweria_token;
            }
            if (body.saweria_user_id) currentConfig.saweria.user_id = body.saweria_user_id;
            if (body.saweria_username) currentConfig.saweria.username = body.saweria_username;
            if (body.saweria_user_email) currentConfig.saweria.email = body.saweria_user_email;

            // Admin Contact (Telegram & WhatsApp)
            if (body.admin_contact_telegram !== undefined) {
                currentConfig.admin_contact_telegram = body.admin_contact_telegram.trim().replace(/^@/, '');
            }
            if (body.admin_contact_whatsapp !== undefined) {
                currentConfig.admin_contact_whatsapp = body.admin_contact_whatsapp.trim().replace(/[^0-9]/g, '');
            }
            if (body.operating_hours !== undefined) {
                currentConfig.operating_hours = body.operating_hours.trim();
            }

            // Pakasir Config (slug + api_key only, no cookie needed)
            if (!currentConfig.pakasir) currentConfig.pakasir = {};
            if (body.pakasir_project_slug) currentConfig.pakasir.project_slug = body.pakasir_project_slug;
            if (body.pakasir_api_key) currentConfig.pakasir.api_key = body.pakasir_api_key;
            if (body.pakasir_project_name) currentConfig.pakasir.project_name = body.pakasir_project_name;
            // Clean up legacy cookie/token fields if present
            delete currentConfig.pakasir.cookie;
            delete currentConfig.pakasir.token;
            delete currentConfig.pakasir.project_id;

            // DompetX Config (api_key + channel method)
            if (!currentConfig.dompetx) currentConfig.dompetx = {};
            if (body.dompetx_api_key !== undefined && body.dompetx_api_key.trim() !== '') currentConfig.dompetx.api_key = body.dompetx_api_key.trim();
            if (body.dompetx_method !== undefined && body.dompetx_method.trim() !== '') currentConfig.dompetx.method = body.dompetx_method.trim();

            // GoPay Config
            if (!currentConfig.gopay) currentConfig.gopay = {};
            const oldGopayEmail = currentConfig.gopay.email || '';
            const oldGopayPassword = currentConfig.gopay.password || '';
            if (body.gopay_email) currentConfig.gopay.email = body.gopay_email;
            if (body.gopay_password) currentConfig.gopay.password = body.gopay_password;
            if (body.gopay_merchant_id) currentConfig.gopay.merchant_id = body.gopay_merchant_id;
            if (body.gopay_qr_string) currentConfig.gopay.qr_string = body.gopay_qr_string;
            if (body.gopay_unique_min != null) currentConfig.gopay.unique_min = parseInt(body.gopay_unique_min) || 0;
            if (body.gopay_unique_max != null) currentConfig.gopay.unique_max = parseInt(body.gopay_unique_max) || 200;

            // Re-authenticate GoPay if credentials changed
            const newGopayEmail = currentConfig.gopay.email || '';
            const newGopayPassword = currentConfig.gopay.password || '';
            const gopayCredsChanged = (body.gopay_email || body.gopay_password) &&
                (newGopayEmail !== oldGopayEmail || newGopayPassword !== oldGopayPassword);

            if (gopayCredsChanged && newGopayEmail && newGopayPassword) {
                try {
                    console.log('🔄 GoPay credentials changed — clearing old tokens and re-authenticating...');
                    // 1. Clear stale tokens from gopay.creds.json
                    gopay.setCred('GOBIZ_ACCESS_TOKEN', '');
                    gopay.setCred('GOBIZ_REFRESH_TOKEN', '');
                    // 2. Clear in-memory cached token
                    gopay.clearCachedToken();
                    // 3. Re-authenticate with new credentials (writes fresh tokens to gopay.creds.json)
                    await gopay.authenticate(newGopayEmail, newGopayPassword);
                    console.log('✅ GoPay re-authentication successful with new credentials');
                    // 4. Restart batch poller if gopay is active provider
                    if ((currentConfig.payment_provider || '') === 'gopay') {
                        gopay.stopGopayBatchPoller();
                        gopay.startGopayBatchPoller(currentConfig.gopay);
                        console.log('🔄 GoPay Batch Poller: Restarted with new credentials');
                    }
                } catch (gopayErr) {
                    console.error('⚠️ GoPay re-auth failed after credential change:', gopayErr.message);
                    // Don't fail the whole save — config is already written, auth can be retried
                }
            }

            // Store Name
            if (body.store_name && body.store_name.trim() !== '') {
                currentConfig.store_name = body.store_name.trim();
            }

            // Gatekeeper Config
            if (!currentConfig.gatekeeper) currentConfig.gatekeeper = { enabled: false, channel: {}, group: {} };
            if (body.gatekeeper_enabled !== undefined) currentConfig.gatekeeper.enabled = body.gatekeeper_enabled === true || body.gatekeeper_enabled === 'true';

            if (body.gatekeeper_channel_id !== undefined) currentConfig.gatekeeper.channel.id = body.gatekeeper_channel_id;
            if (body.gatekeeper_channel_link !== undefined) currentConfig.gatekeeper.channel.link = body.gatekeeper_channel_link;
            if (body.gatekeeper_group_id !== undefined) currentConfig.gatekeeper.group.id = body.gatekeeper_group_id;
            if (body.gatekeeper_group_link !== undefined) currentConfig.gatekeeper.group.link = body.gatekeeper_group_link;

            // Koala Store Config
            if (!currentConfig.koalastore) currentConfig.koalastore = {};
            if (body.koala_api_key) currentConfig.koalastore.api_key = body.koala_api_key;
            if (body.koala_active !== undefined) currentConfig.koalastore.is_active = body.koala_active === true || body.koala_active === 'true';

            // Digiflazz Config (PPOB)
            if (!currentConfig.digiflazz) currentConfig.digiflazz = { username: '', api_key: '', webhook_secret: '', is_active: false, delivery_mode: 'auto', poll_interval_seconds: 60 };
            if (body.digiflazz_username !== undefined) currentConfig.digiflazz.username = String(body.digiflazz_username || '').trim();
            if (body.digiflazz_api_key !== undefined) currentConfig.digiflazz.api_key = String(body.digiflazz_api_key || '').trim();
            if (body.digiflazz_webhook_secret !== undefined) currentConfig.digiflazz.webhook_secret = String(body.digiflazz_webhook_secret || '').trim();
            if (body.digiflazz_active !== undefined) currentConfig.digiflazz.is_active = body.digiflazz_active === true || body.digiflazz_active === 'true';
            if (body.digiflazz_delivery_mode !== undefined) {
                const m = String(body.digiflazz_delivery_mode || 'auto').toLowerCase();
                currentConfig.digiflazz.delivery_mode = ['auto', 'webhook', 'polling'].includes(m) ? m : 'auto';
            }
            if (body.digiflazz_poll_interval_seconds !== undefined) {
                const n = parseInt(body.digiflazz_poll_interval_seconds);
                if (!isNaN(n)) currentConfig.digiflazz.poll_interval_seconds = Math.max(10, Math.min(300, n));
            }

            // Modules toggle (PPOB vs Beli Akun). Both true → user sees 2-button menu.
            // Either disabled → that branch hidden and menu skipped.
            if (!currentConfig.modules) currentConfig.modules = { account_enabled: true, ppob_enabled: false };
            if (body.module_account_enabled !== undefined) currentConfig.modules.account_enabled = body.module_account_enabled === true || body.module_account_enabled === 'true';
            if (body.module_ppob_enabled !== undefined) currentConfig.modules.ppob_enabled = body.module_ppob_enabled === true || body.module_ppob_enabled === 'true';
            // Guard: at least one module must be enabled
            if (!currentConfig.modules.account_enabled && !currentConfig.modules.ppob_enabled) {
                currentConfig.modules.account_enabled = true;
            }

            // Order Notifications Config (per-type object)
            if (body.order_notifications !== undefined) {
                const n = body.order_notifications;
                if (typeof n === 'object' && n !== null) {
                    currentConfig.order_notifications = {
                        new: n.new === true || n.new === 'true',
                        paid: n.paid === true || n.paid === 'true',
                        expired: n.expired === true || n.expired === 'true',
                        cancelled: n.cancelled === true || n.cancelled === 'true'
                    };
                }
            }

            // 4. Simpan kembali format Array [{...}]
            const configToSave = [currentConfig];

            fs.writeFileSync(path.join(projectRoot, 'configtelebot.json'), JSON.stringify(configToSave, null, 2));
            setConfig(configToSave);

            const gopayNote = gopayCredsChanged ? ' GoPay credentials updated and re-authenticated.' : '';
            res.json({ success: true, message: 'Settings saved!' + gopayNote });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Failed to save settings: ' + err.message });
        }
    });

    // API: Get Masters (Admin IDs)
    app.get('/api/masters', (req, res) => {
        try {
            if (!fs.existsSync(path.join(projectRoot, 'master.json'))) fs.writeFileSync(path.join(projectRoot, 'master.json'), '[]');
            const masters = JSON.parse(fs.readFileSync(path.join(projectRoot, 'master.json'), 'utf8'));
            res.json(masters);
        } catch (err) {
            res.status(500).json({ error: 'Failed to load masters' });
        }
    });

    // API: Add Master
    app.post('/api/masters', (req, res) => {
        try {
            const { id } = req.body;
            if (!id || !/^\d+$/.test(String(id).trim())) {
                return res.status(400).json({ error: 'ID harus berupa angka' });
            }
            const masterId = String(id).trim();
            if (!fs.existsSync(path.join(projectRoot, 'master.json'))) fs.writeFileSync(path.join(projectRoot, 'master.json'), '[]');
            const masters = JSON.parse(fs.readFileSync(path.join(projectRoot, 'master.json'), 'utf8'));
            if (masters.includes(masterId) || masters.includes(Number(masterId))) {
                return res.status(400).json({ error: 'ID sudah terdaftar' });
            }
            masters.push(masterId);
            fs.writeFileSync(path.join(projectRoot, 'master.json'), JSON.stringify(masters, null, 2));
            loadMasterData();
            res.json({ success: true, masters });
        } catch (err) {
            res.status(500).json({ error: 'Failed to add master: ' + err.message });
        }
    });

    // API: Remove Master
    app.delete('/api/masters/:id', (req, res) => {
        try {
            const removeId = req.params.id;
            if (!fs.existsSync(path.join(projectRoot, 'master.json'))) return res.status(404).json({ error: 'master.json not found' });
            let masters = JSON.parse(fs.readFileSync(path.join(projectRoot, 'master.json'), 'utf8'));
            const newMasters = masters.filter(m => String(m) !== String(removeId));
            if (newMasters.length === masters.length) {
                return res.status(404).json({ error: 'ID tidak ditemukan' });
            }
            fs.writeFileSync(path.join(projectRoot, 'master.json'), JSON.stringify(newMasters, null, 2));
            loadMasterData();
            res.json({ success: true, masters: newMasters });
        } catch (err) {
            res.status(500).json({ error: 'Failed to remove master: ' + err.message });
        }
    });

    // API: Reset All Stats (Revenue, Profit, Sales)
    app.post('/api/reset-stats', async (req, res) => {
        try {
            // 1. Reset totalProdukTerjual di semua produk lokal ke 0
            if (fs.existsSync(productFile)) {
                const prods = JSON.parse(fs.readFileSync(productFile, 'utf8'));
                prods.forEach(p => { p.totalProdukTerjual = 0; });
                writeFileAtomic(productFile, JSON.stringify(prods, null, 2));
            }

            // 2. Reset WA transactions — tandai semua PAID sebagai sudah dihitung
            // (sehingga tidak lagi dihitung di overview)
            await withWaTxFile(waTxs => {
                waTxs.forEach(tx => {
                    if (tx.status === 'PAID') tx.wa_revenue_counted = true;
                });
            });

            // 3. Clear transactions history log (opsional: simpan backup dulu)
            const backupFile = path.join(projectRoot, `transactions_backup_${Date.now()}.json`);
            if (fs.existsSync(transactionsFile)) {
                fs.copyFileSync(transactionsFile, backupFile);
            }
            await withTgTxFile(tgTxs => {
                tgTxs.splice(0, tgTxs.length); // clear array in-place
            });

            console.log('[RESET] All stats reset by admin.');
            res.json({ success: true, message: 'Semua statistik berhasil direset.' });
        } catch (err) {
            console.error('[RESET] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // API: Get System Overview
    // API: Get System Overview (Enhanced with Finance & Graphs)
    app.get('/api/overview', async (req, res) => {
        try {
            // 1. Get Bot Info
            const botInfo = await bot.getMe();

            // 2. Get User Count
            let userCount = 0;
            if (fs.existsSync(path.join(projectRoot, 'dataUser.txt'))) {
                const content = fs.readFileSync(path.join(projectRoot, 'dataUser.txt'), 'utf8');
                userCount = content.split('\n').filter(l => l.trim()).length;
            }

            // 3. Calculate Stats from Products
            let totalRevenue = 0;
            let totalProfit = 0;
            let totalSales = 0;
            let totalStock = 0;
            let productCount = 0;
            let salesData = []; // For Graph

            if (fs.existsSync(productFile)) {
                const pData = fs.readFileSync(productFile, 'utf8');
                const products = JSON.parse(pData);
                productCount = products.length;

                products.forEach(p => {
                    const price = parseInt(p.priceProduct) || 0;
                    const sold = parseInt(p.totalProdukTerjual) || 0;

                    totalRevenue += (price * sold);
                    totalSales += sold;

                    // Calculate Stock from .txt file
                    const stockPath = getStockPath(p.productName);
                    if (fs.existsSync(stockPath)) {
                        const stockContent = fs.readFileSync(stockPath, 'utf8');
                        const stockLines = stockContent.split('\n').filter(l => l.trim()).length;
                        totalStock += stockLines;
                    }

                    if (sold > 0) {
                        salesData.push({ name: p.productName, sold: sold });
                    }
                });
            }

            // Sort sales data for graph (Top 5)
            salesData.sort((a, b) => b.sold - a.sold);
            const topSales = salesData.slice(0, 5);

            // 3b. Calculate totalProfit from transaction logs (accurate per-tier profit)
            // Also add uncounted WA revenue/sales
            try {
                const tgTxs = loadTransactions(transactionsFile);
                tgTxs.forEach(tx => {
                    if (tx.status === 'PAID' && tx.profit) {
                        totalProfit += Number(tx.profit) || 0;
                    }
                });
            } catch (e) { console.error('[ROUTES] TG transaction load failed for dashboard:', e.message); }
            try {
                const waTxs = loadTransactions(waTransactionsFile);
                waTxs.forEach(tx => {
                    if (tx.status === 'PAID') {
                        if (tx.profit) totalProfit += Number(tx.profit) || 0;
                        if (!tx.wa_revenue_counted) {
                            const txRevenue = Number(tx.totalPrice) || (Number(tx.price) * (tx.quantity || 1));
                            if (txRevenue > 0) totalRevenue += txRevenue;
                            if (tx.quantity) totalSales += tx.quantity;
                        }
                    }
                });
            } catch (e) { console.error('[ROUTES] WA transaction load failed for dashboard:', e.message); }

            // 4. Get Merchant Info & Payment Provider
            let merchantCode = '-';
            let paymentProvider = 'tripay';
            let storeName = 'Dower Store';
            if (fs.existsSync(path.join(projectRoot, 'configtelebot.json'))) {
                const cData = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json'), 'utf8'));
                if (Array.isArray(cData) && cData.length > 0) {
                    merchantCode = cData[0].merchant_code || '-';
                    paymentProvider = cData[0].payment_provider || 'tripay';
                    storeName = cData[0].store_name || 'Ryuji Store'; // Default Name
                }
            }

            res.json({
                botName: botInfo.first_name,
                botUsername: botInfo.username,
                totalUsers: userCount,
                totalProducts: productCount,
                totalRevenue: totalRevenue,
                totalProfit: totalProfit,
                totalSales: totalSales,
                totalStock: totalStock,
                salesGraph: topSales,
                merchantCode: merchantCode,
                paymentProvider: paymentProvider,
                storeName: storeName
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Failed' });
        }
    });

    // API: Get Tripay Transactions
    app.get('/api/tripay/transactions', async (req, res) => {
        try {
            let apiKey = '';
            if (fs.existsSync(path.join(projectRoot, 'configtelebot.json'))) {
                const conf = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json')));
                const c = Array.isArray(conf) ? conf[0] : conf;
                apiKey = c.apiKey || '';
            }

            if (!apiKey) return res.status(400).json({ error: 'Tripay API Key not configured' });

            const fetchRes = await fetch('https://tripay.co.id/api/merchant/transactions?page=1&per_page=15', {
                headers: {
                    'Authorization': `Bearer ${apiKey}`
                }
            });

            if (!fetchRes.ok) return res.status(fetchRes.status).json([]);

            const data = await fetchRes.json();
            const transactions = data.data || [];
            res.json(transactions);

        } catch (err) {
            console.error("Tripay Transaction Error:", err);
            res.status(500).json({ error: 'Failed' });
        }
    });


    // API: Get DompetX Transactions (from local tele_transactions.json & wa_transactions.json)
    app.get('/api/dompetx/transactions', async (req, res) => {
        try {
            const allTx = loadTransactions(transactionsFile).concat(loadTransactions(waTransactionsFile));
            const dompetxTxs = allTx
                .filter(tx => tx.provider === 'dompetx')
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

            res.json({ total: dompetxTxs.length, transactions: dompetxTxs });
        } catch (err) {
            console.error("DompetX Transaction Error:", err);
            res.status(500).json({ error: 'Failed' });
        }
    });

    // API: Get Pakasir Transactions (from local tele_transactions.json & wa_transactions.json)
    app.get('/api/pakasir/transactions', async (req, res) => {
        try {
            const allTx = loadTransactions(transactionsFile).concat(loadTransactions(waTransactionsFile));
            // Filter only pakasir provider transactions, sort newest first
            const pakasirTxs = allTx
                .filter(tx => tx.provider === 'pakasir')
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

            res.json({ total: pakasirTxs.length, transactions: pakasirTxs });
        } catch (err) {
            console.error("Pakasir Transaction Error:", err);
            res.status(500).json({ error: 'Failed' });
        }
    });

    // API: Get GoPay Transactions (from GoBiz journals)
    app.get('/api/gopay/transactions', async (req, res) => {
        try {
            let configData = null;
            if (fs.existsSync(path.join(projectRoot, 'configtelebot.json'))) {
                configData = JSON.parse(fs.readFileSync(path.join(projectRoot, 'configtelebot.json')));
            }
            const config = Array.isArray(configData) ? configData[0] : configData;
            const gopayConfig = config && config.gopay ? config.gopay : {};

            if (!gopayConfig.email || !gopayConfig.password) {
                return res.status(400).json({ error: 'GoPay belum dikonfigurasi (email/password kosong).' });
            }

            const hoursBack = parseInt(req.query.hours) || 24;
            const hits = await gopay.getRecentTransactions(gopayConfig, hoursBack);

            const transactions = hits.map(hit => {
                const txMeta = hit.metadata?.transaction || {};
                const innerMeta = txMeta.metadata || {};
                return {
                    id: txMeta.id || hit.id || '-',
                    time: txMeta.transaction_time || hit.time || '-',
                    amount: txMeta.gross_amount ? (txMeta.gross_amount / 100) : 0,
                    merchant_id: txMeta.merchant_id || '-',
                    type: txMeta.type || hit.type || '-',
                    source: innerMeta.aspi_qr_issuer || hit.metadata?.issuer || '-',
                    status: 'completed'
                };
            });

            res.json({ total: transactions.length, transactions });
        } catch (err) {
            console.error("GoPay Transaction Error:", err);
            res.status(500).json({ error: err.message || 'Failed to fetch GoPay transactions' });
        }
    });

    // API: GoPay Batch Poller Status (Debug Visibility)
    app.get('/api/gopay/poller-status', (req, res) => {
        try {
            const status = gopay.getGopayPollerStatus();
            res.json(status);
        } catch (err) {
            console.error('GoPay Poller Status Error:', err);
            res.status(500).json({ error: err.message || 'Failed to get poller status' });
        }
    });

    // API: Broadcast Message
    app.post('/api/broadcast', async (req, res) => {
        const { message } = req.body;
        if (!message || message.trim() === '') {
            return res.status(400).json({ error: 'Message content is required' });
        }

        try {
            const users = getUsers();
            let successCount = 0;
            let failCount = 0;

            console.log(`[BROADCAST WEB] Sending to ${users.length} users...`);

            // Send concurrently but not all at once to avoid flooding? 
            // For simplicity and small user base, Promise.all is okay, but purely sequential for safety:
            for (const chatId of users) {
                try {
                    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
                    successCount++;
                } catch (err) {
                    // console.error(`Failed to send to ${chatId}:`, err.message);
                    failCount++;
                }
            }

            res.json({
                success: true,
                message: `Broadcast sent to ${successCount} users. Failed: ${failCount}`,
                stats: { total: users.length, sent: successCount, failed: failCount }
            });

        } catch (err) {
            console.error("Broadcast Error:", err);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // ==========================================
}

export { setupRoutes };