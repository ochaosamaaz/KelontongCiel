let products = [];
let editingIndex = -1;
let currentStockProduct = '';
let currentProviderGlobal = 'tripay';

/* ===== Mobile Sidebar Toggle ===== */
function toggleSidebar() {
    document.querySelector('.sidebar').classList.toggle('open');
    document.querySelector('.sidebar-overlay').classList.toggle('active');
}

document.addEventListener('DOMContentLoaded', () => {
    fetchProducts();
    // Auto-refresh every 30 seconds for Real-time Koala stock & Bot Stats
    setInterval(() => {
        fetchProducts();
        fetchOverview();
    }, 30000);

    // Close sidebar when clicking a nav link on mobile
    document.querySelectorAll('.sidebar nav a').forEach(link => {
        link.addEventListener('click', () => {
            if (window.innerWidth <= 768) {
                document.querySelector('.sidebar').classList.remove('open');
                document.querySelector('.sidebar-overlay').classList.remove('active');
            }
        });
    });
});

async function fetchProducts() {
    try {
        const res = await fetch('/api/products');
        products = await res.json();
        renderTable();
    } catch (err) {
        console.error('Failed to load products', err);
    }
}

function renderTable() {
    const tbody = document.querySelector('#productTable tbody');
    tbody.innerHTML = '';

    products.forEach((p, index) => {
        const isKs = p.source === 'koalastore' || (p.productId && p.productId.startsWith('ks_'));
        const isDf = p.source === 'digiflazz' || (p.productId && p.productId.startsWith('df_'));
        const nameBadge = isKs ? `<span class="ks-badge" style="margin-left:8px;">KS</span>`
            : isDf ? `<span class="ppob-badge" style="margin-left:8px;">PPOB</span>`
            : '';
        let stockHtml;
        if (isKs) {
            stockHtml = `<span class="stock-badge${(p.stockCount || 0) === 0 ? ' low' : ''}">${(p.stockCount || 0).toLocaleString()} (KS)</span>`;
        } else if (isDf) {
            // Digiflazz: unlimited_stock → ∞; else use stockCount
            const sellerOk = p.seller_product_status !== false && p.buyer_product_status !== false;
            if (!sellerOk) {
                stockHtml = `<span class="stock-badge low" title="SKU non-aktif di Digiflazz">non-aktif</span>`;
            } else if (p.unlimited_stock) {
                stockHtml = `<span class="stock-badge" style="background: rgba(16,185,129,0.15); color:#10b981;">∞ (PPOB)</span>`;
            } else {
                const stk = parseInt(p.stockCount) || 0;
                stockHtml = `<span class="stock-badge${stk === 0 ? ' low' : ''}">${stk.toLocaleString()} (PPOB)</span>`;
            }
        } else {
            stockHtml = `<span class="stock-badge" id="stock-count-${index}">...</span>`;
        }

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>
                <div style="font-weight: 600; font-size: 15px;">${p.productName}${nameBadge}</div>
                <div style="color: var(--primary); font-size: 11px; font-weight: 700; text-transform: uppercase;">${p.category || 'Lainnya'}</div>
            </td>
            <td><code>${p.productId}</code></td>
            <td>Rp ${p.priceProduct.toLocaleString()}</td>
            <td style="color: #10b981;">Rp ${p.profit.toLocaleString()}</td>
            <td>${stockHtml}</td>
            <td>
                <div class="actions-cell">
                    ${(isKs || isDf) ? '' : `<button class="btn-icon-small" title="Manage Stock" onclick="openStockModal('${p.productName}', ${index})">
                        <i class="fa-solid fa-boxes-stacked"></i>
                    </button>`}
                    <button class="btn-icon-small" title="Edit Info" onclick="editProduct(${index})">
                        <i class="fa-solid fa-pen"></i>
                    </button>
                    <button class="btn-icon-small danger" title="Delete Product" onclick="deleteProduct(${index})">
                        <i class="fa-solid fa-trash"></i>
                    </button>
                </div>
            </td>
        `;
        tbody.appendChild(tr);
        if (!isKs && !isDf) fetchStockCount(p.productName, index);
    });
}

async function fetchStockCount(name, index) {
    const el = document.getElementById(`stock-count-${index}`);
    
    try {
        const res = await fetch(`/api/stock/${encodeURIComponent(name)}`);
        const data = await res.json();
        const count = data.content ? (data.content.trim() ? data.content.trim().split(/\r?\n/).filter(l => l.trim()).length : 0) : 0;
        
        el.textContent = `${count} ${(window.t ? window.t('stock.items', 'Items') : 'Items')}`;
        if (count === 0) el.classList.add('low');
        else el.classList.remove('low');
    } catch (e) {
        el.textContent = 'Err';
    }
}

function openAddModal() {
    editingIndex = -1;
    document.getElementById('modalTitle').textContent = (window.t ? window.t('prod.modal.new', 'New Product') : 'New Product');
    document.getElementById('productForm').reset();
    
    // Reset product type UI
    document.getElementById('pIsFile').checked = false;
    toggleProductTypeFields();

    // Clear bulk discount tiers
    populateBulkTiers([]);
    
    openModal('productModal');
    // Set focus
    setTimeout(() => document.getElementById('pName').focus(), 100);
}

function toggleProductTypeFields() {
    const isFile = document.getElementById('pIsFile').checked;
    const accountFields = document.querySelectorAll('.account-only');
    const typeLabel = document.getElementById('typeLabel');
    
    typeLabel.textContent = isFile
        ? (window.t ? window.t('prod.type.file', 'File/Session') : 'File/Session')
        : (window.t ? window.t('prod.type.account', 'Account') : 'Account');
    typeLabel.style.color = isFile ? 'var(--primary)' : 'var(--text-primary)';

    accountFields.forEach(el => {
        if (isFile) {
            el.classList.add('hidden');
        } else {
            el.classList.remove('hidden');
        }
    });
}

function editProduct(index) {
    editingIndex = index;
    const p = products[index];
    document.getElementById('modalTitle').textContent = (window.t ? window.t('prod.modal.edit', 'Edit Product') : 'Edit Product');
    document.getElementById('pName').value = p.productName;
    document.getElementById('pId').value = p.productId;
    document.getElementById('pCategory').value = p.category || '';
    document.getElementById('pDescription').value = p.description || '';
    document.getElementById('pWarranty').value = p.warranty || '';
    document.getElementById('pActivation').value = p.activation || '';
    document.getElementById('pEmail').value = p.email || '';
    document.getElementById('pUsage').value = p.usage || '';
    document.getElementById('pFormat').value = p.format || '';
    document.getElementById('pPrice').value = p.priceProduct;
    document.getElementById('pProfit').value = p.profit;

    // Populate bulk discount tiers
    populateBulkTiers(p.bulkDiscounts || []);

    // Set Product Type
    const isFile = p.format && p.format.toLowerCase() === 'file';
    document.getElementById('pIsFile').checked = isFile;
    toggleProductTypeFields();

    openModal('productModal');
}

document.getElementById('productForm').onsubmit = async (e) => {
    e.preventDefault();
    const isFile = document.getElementById('pIsFile').checked;
    const basePrice = parseInt(document.getElementById('pPrice').value) || 0;
    const baseProfit = parseInt(document.getElementById('pProfit').value) || 0;
    const tiers = collectBulkTiers();

    // Validate: profit cannot exceed price
    if (baseProfit > basePrice) {
        alert('Profit tidak boleh lebih besar dari harga produk!');
        document.getElementById('pProfit').focus();
        return;
    }

    // Validate bulk tier profits and prices
    if (tiers) {
        for (const t of tiers) {
            if (t.price >= basePrice) {
                alert(`Harga tier (min ${t.minQty} pcs) harus lebih murah dari harga dasar!\nHarga dasar: Rp${basePrice.toLocaleString()}, Harga tier: Rp${t.price.toLocaleString()}`);
                return;
            }
            if (t.profit > t.price) {
                alert(`Profit tier (min ${t.minQty} pcs) tidak boleh lebih besar dari harga tier!\nHarga: Rp${t.price.toLocaleString()}, Profit: Rp${t.profit.toLocaleString()}`);
                return;
            }
        }
    }

    const newProduct = {
        productName: document.getElementById('pName').value,
        productId: document.getElementById('pId').value || document.getElementById('pName').value.toLowerCase().replace(/\s+/g, '_'),
        category: document.getElementById('pCategory').value,
        description: document.getElementById('pDescription').value,
        warranty: document.getElementById('pWarranty').value,
        format: isFile ? 'file' : document.getElementById('pFormat').value,
        priceProduct: basePrice,
        profit: baseProfit,
        bulkDiscounts: tiers
    };

    if (!isFile) {
        newProduct.activation = document.getElementById('pActivation').value;
        newProduct.email = document.getElementById('pEmail').value;
        newProduct.usage = document.getElementById('pUsage').value;
    }

    // Build updated array WITHOUT mutating current state yet
    const updatedProducts = [...products];
    if (editingIndex > -1) {
        updatedProducts[editingIndex] = { ...products[editingIndex], ...newProduct };
    } else {
        newProduct.totalProdukTerjual = 0;
        updatedProducts.push(newProduct);
    }

    const saved = await saveProductsToServer(updatedProducts);
    if (saved) {
        products = updatedProducts; // Only mutate after server confirms
        closeModal('productModal');
        renderTable();
    }
};

// --- Bulk Discount Tier Management ---

function populateBulkTiers(tiers) {
    const container = document.getElementById('bulkTierRows');
    container.innerHTML = '';
    if (Array.isArray(tiers) && tiers.length > 0) {
        tiers.sort((a, b) => (a.minQty || 0) - (b.minQty || 0)).forEach(t => {
            addBulkTierRow(t.minQty, t.price, t.profit);
        });
    }
}

function addBulkTierRow(minQty, price, profit) {
    const container = document.getElementById('bulkTierRows');
    const row = document.createElement('div');
    row.className = 'bulk-tier-row';
    row.innerHTML = `
        <input type="number" placeholder="Min Qty" min="2" value="${minQty != null && minQty !== '' ? minQty : ''}" class="tier-minqty">
        <input type="number" placeholder="Price/unit" min="0" value="${price != null && price !== '' ? price : ''}" class="tier-price">
        <input type="number" placeholder="Profit/unit" min="0" value="${profit != null && profit !== '' ? profit : ''}" class="tier-profit">
        <button type="button" class="btn-remove-tier" onclick="this.parentElement.remove()" title="Remove tier">&times;</button>
    `;
    container.appendChild(row);
}

function collectBulkTiers() {
    const rows = document.querySelectorAll('#bulkTierRows .bulk-tier-row');
    const tiers = [];
    const seenQtys = new Set();
    rows.forEach(row => {
        const minQty = parseInt(row.querySelector('.tier-minqty').value);
        const price = parseInt(row.querySelector('.tier-price').value);
        const profit = parseInt(row.querySelector('.tier-profit').value);
        if (!minQty || minQty < 2) return;
        if (isNaN(price) || price < 0) return;
        if (seenQtys.has(minQty)) return;
        seenQtys.add(minQty);
        tiers.push({ minQty, price, profit: !isNaN(profit) ? profit : 0 });
    });
    return tiers.length > 0 ? tiers : undefined;
}

document.getElementById('settingsForm').onsubmit = async (e) => {
    e.preventDefault();
    await saveSettings();
};

async function deleteProduct(index) {
    if (!confirm('Are you sure you want to delete this product? Action cannot be undone.')) return;
    const updatedProducts = products.filter((_, i) => i !== index);
    const saved = await saveProductsToServer(updatedProducts);
    if (saved) {
        products = updatedProducts;
        renderTable();
    }
}

async function saveProductsToServer(data) {
    try {
        const res = await fetch('/api/products', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data || products)
        });
        if (!res.ok) {
            const errText = await res.text().catch(() => 'Unknown error');
            alert(`Gagal menyimpan produk: ${errText}`);
            return false;
        }
        return true;
    } catch (err) {
        alert(`Gagal menyimpan produk: ${err.message}`);
        return false;
    }
}

function openStockModal(productName, index) {
    currentStockProduct = productName;
    document.getElementById('stockTitle').textContent = productName;
    
    const product = products[index];
    const isFile = product.format && product.format.toLowerCase() === 'file';

    const accContainer = document.getElementById('accountStockContainer');
    const fileContainer = document.getElementById('fileStockContainer');
    const badge = document.querySelector('#stockModal .info-badge');

    if (isFile) {
        accContainer.classList.add('hidden');
        fileContainer.classList.remove('hidden');
        badge.textContent = 'Upload .zip sessions';
        badge.style.background = 'rgba(16, 185, 129, 0.2)';
        badge.style.color = '#10b981';
        badge.style.border = '1px solid rgba(16, 185, 129, 0.5)';
        
        // Clear previous selection
        document.getElementById('stockFileInput').value = '';
        document.getElementById('fileUploadList').innerHTML = '';
        currentSelectedFiles = [];
    } else {
        accContainer.classList.remove('hidden');
        fileContainer.classList.add('hidden');
        
        const hint = product && product.format ? `Format: ${product.format}` : 'One item per line';
        badge.textContent = hint;
        
        if (product && product.format) {
            badge.style.background = 'rgba(99, 102, 241, 0.2)';
            badge.style.color = '#818cf8';
            badge.style.border = '1px solid rgba(99, 102, 241, 0.5)';
        } else {
            badge.style.background = '';
            badge.style.color = '';
            badge.style.border = '';
        }

        const formatExample = product && product.format ? product.format : 'email|password';
        document.getElementById('stockContent').placeholder = `${formatExample}\n${formatExample}`;
        document.getElementById('stockContent').value = 'Loading accounts...';
    }

    openModal('stockModal');

    if (!isFile) {
        fetch(`/api/stock/${encodeURIComponent(productName)}`)
            .then(res => res.json())
            .then(data => {
                document.getElementById('stockContent').value = data.content;
            })
            .catch(() => {
                document.getElementById('stockContent').value = '';
            });
    } else {
        // For files, maybe show currently available files in the list
        fetch(`/api/stock/${encodeURIComponent(productName)}`)
            .then(res => res.json())
            .then(data => {
                const files = data.content.trim() ? data.content.split('\n') : [];
                const list = document.getElementById('fileUploadList');
                list.innerHTML = `<p style="font-weight: 700; margin-bottom: 8px; color: var(--text-primary);">Current Stock (${files.length}):</p>`;
                files.forEach(f => {
                    if (f.trim()) {
                        list.innerHTML += `<div style="padding: 4px 8px; background: rgba(255,255,255,0.05); margin-bottom: 4px; font-size: 12px; border-radius: 4px; display: flex; justify-content: space-between;">
                            <span><i class="fa-solid fa-file-zipper" style="color: var(--primary); margin-right: 6px;"></i> ${f}</span>
                            <span style="color: #10b981;"><i class="fa-solid fa-check"></i> On Server</span>
                        </div>`;
                    }
                });
            });
    }
}

let currentSelectedFiles = [];
function handleStockFileUpload(files) {
    const list = document.getElementById('fileUploadList');
    // If it's the first time selecting after opening modal, we can clear or append
    // User probably expects to APPEND to existing stock, but API usually replaces.
    // Let's just show what's being uploaded now.
    
    currentSelectedFiles = Array.from(files);
    
    let html = `<p style="font-weight: 700; margin-top: 15px; margin-bottom: 8px; color: var(--primary);">To be uploaded (${files.length}):</p>`;
    currentSelectedFiles.forEach(f => {
        html += `<div style="padding: 4px 8px; background: rgba(255,255,255,0.1); margin-bottom: 4px; font-size: 12px; border-radius: 4px; border: 1px solid var(--primary);">
            <i class="fa-solid fa-file-circle-plus" style="margin-right: 6px;"></i> ${f.name} (${(f.size/1024).toFixed(1)} KB)
        </div>`;
    });
    
    list.insertAdjacentHTML('beforeend', html);
}

async function saveStock() {
    const btn = document.querySelector('#stockModal .btn-primary');
    const originalText = btn.textContent;
    btn.textContent = (window.t ? window.t('btn.saving', 'Saving...') : 'Saving...');

    console.log('Saving stock for product:', currentStockProduct);
    const product = products.find(p => p.productName === currentStockProduct);
    
    if (!product) {
        console.error('Product not found in local cache:', currentStockProduct);
        alert('Internal Error: Product context lost. Please refresh dashboard.');
        btn.textContent = originalText;
        return;
    }

    const isFile = product.format && product.format.toLowerCase() === 'file';
    console.log('Product Type:', isFile ? 'FILE' : 'ACCOUNT');

    try {
        if (isFile) {
            if (currentSelectedFiles.length === 0) {
                 // If no new files, maybe they just want to keep existing? 
                 // But typically "Update Stock" means replace.
                 // For safety, let's warn.
                 if (!confirm("No new files selected. Do you want to keep existing stock? Click Cancel to go back and select files.")) {
                    btn.textContent = originalText;
                    return;
                 }
                 closeModal('stockModal');
                 return;
            }

            const formData = new FormData();
            currentSelectedFiles.forEach(file => {
                formData.append('files', file);
            });

            const res = await fetch(`/api/stock-upload/${encodeURIComponent(currentStockProduct)}`, {
                method: 'POST',
                body: formData
            });
            const data = await res.json();
            if (!data.success) throw new Error(data.error);

        } else {
            const content = document.getElementById('stockContent').value;
            await fetch(`/api/stock/${encodeURIComponent(currentStockProduct)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content })
            });
        }
        
        closeModal('stockModal');
        fetchProducts(); // refresh counts
    } catch (e) {
        alert('Failed to save stock: ' + e.message);
    } finally {
        btn.textContent = originalText;
    }
}

async function uploadImage() {
    const fileInput = document.getElementById('imageInput');
    if (!fileInput.files[0]) return;

    const formData = new FormData();
    formData.append('image', fileInput.files[0]);

    try {
        const res = await fetch('/api/upload-image', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.success) {
            alert('Banner updated successfully!');
        } else {
            alert('Upload failed.');
        }
    } catch (e) {
        console.error(e);
        alert('Error uploading image.');
    }
}

// Store Name Management
// Store Name Management
function editStoreName() {
    const el = document.getElementById('storeName');
    // Prevent double click/input creation
    if (el.querySelector('input')) return;

    const currentName = el.textContent;
    
    // Replace text with input
    el.innerHTML = `<input type="text" id="tempStoreInput" value="${currentName}" 
        style="background: var(--input-bg, #333); color: var(--text-primary, #fff); border: 1px solid var(--border-color, #555); padding: 4px 8px; border-radius: 4px; width: 140px; font-size: inherit; font-family: inherit;">`;
    
    const input = document.getElementById('tempStoreInput');
    input.focus();
    
    // Save Function (Server Side)
    const save = async () => {
        const val = input.value.trim();
        if(val) {
             // Show saving state (optional, or just update UI optimistically)
             el.textContent = val; 
             
             try {
                 await fetch('/api/settings', {
                     method: 'POST',
                     headers: { 'Content-Type': 'application/json' },
                     body: JSON.stringify({ store_name: val })
                 });
             } catch(e) {
                 alert('Failed to save store name');
                 el.textContent = currentName;
             }
        } else {
             el.textContent = currentName; // Revert if empty
        }
    };

    // Events
    input.onblur = save;
    input.onkeydown = (e) => {
        if(e.key === 'Enter') {
            input.blur(); // Triggers save
        }
        if(e.key === 'Escape') {
            el.textContent = currentName; // Revert
        }
    };
}

// Load Name on Start
document.addEventListener('DOMContentLoaded', () => {

    fetchOverview();
    fetchProducts();
    loadTheme();
});

// Theme Logic
function toggleTheme() {
    const body = document.body;
    body.classList.toggle('dark-mode');
    
    // Save preference
    const isDark = body.classList.contains('dark-mode');
    localStorage.setItem('ryuji_theme', isDark ? 'dark' : 'light');
    
    updateThemeIcon(isDark);
}

function loadTheme() {
    const savedTheme = localStorage.getItem('ryuji_theme');
    if (savedTheme === 'dark') {
        document.body.classList.add('dark-mode');
        updateThemeIcon(true);
    }
}

function updateThemeIcon(isDark) {
    const icon = document.getElementById('themeIcon');
    if (isDark) {
        icon.classList.remove('fa-moon');
        icon.classList.add('fa-sun');
    } else {
        icon.classList.remove('fa-sun');
        icon.classList.add('fa-moon');
    }
}

let salesChartInstance = null;

// ─────────────────────────────────────────────────────────
// RESET STATS
// ─────────────────────────────────────────────────────────
async function resetStats() {
    // Custom confirm dialog
    const confirmed = await showResetConfirm();
    if (!confirmed) return;

    try {
        const res = await fetch('/api/reset-stats', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            // Langsung update angka di UI ke 0
            document.getElementById('totalRevenue').textContent = 'Rp 0';
            document.getElementById('totalProfit').textContent = 'Rp 0';
            document.getElementById('totalSales').textContent = '0';
            showResetToast('✅ Statistik berhasil direset!');
            // Refresh data dari server
            setTimeout(() => fetchOverview(), 800);
        } else {
            showResetToast('❌ Gagal reset: ' + (data.error || 'Unknown error'), true);
        }
    } catch (e) {
        showResetToast('❌ Error: ' + e.message, true);
    }
}

function showResetConfirm() {
    return new Promise((resolve) => {
        // Buat modal konfirmasi
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;
            display:flex;align-items:center;justify-content:center;
            backdrop-filter:blur(4px);animation:fadeIn .2s ease;
        `;
        overlay.innerHTML = `
            <div style="background:linear-gradient(135deg,#1e1e2e,#16213e);border:1px solid rgba(255,255,255,0.1);border-radius:16px;padding:32px;max-width:380px;width:90%;text-align:center;box-shadow:0 25px 60px rgba(0,0,0,0.5);">
                <div style="font-size:48px;margin-bottom:16px;">🔄</div>
                <h3 style="color:#fff;font-size:18px;margin-bottom:8px;">Reset Semua Statistik?</h3>
                <p style="color:#94a3b8;font-size:13px;margin-bottom:24px;line-height:1.6;">
                    Ini akan mereset <strong style="color:#f59e0b;">Total Revenue</strong>, 
                    <strong style="color:#10b981;">Total Profit</strong>, dan 
                    <strong style="color:#8b5cf6;">Total Sales</strong> ke 0.<br><br>
                    <span style="color:#ef4444;font-size:12px;">⚠️ Data transaksi akan dibackup sebelum dihapus.</span>
                </p>
                <div style="display:flex;gap:12px;justify-content:center;">
                    <button id="resetCancelBtn" style="flex:1;padding:10px 20px;border-radius:10px;border:1px solid rgba(255,255,255,0.2);background:transparent;color:#fff;cursor:pointer;font-size:14px;font-weight:500;transition:all .2s;">
                        Batal
                    </button>
                    <button id="resetConfirmBtn" style="flex:1;padding:10px 20px;border-radius:10px;border:none;background:linear-gradient(135deg,#ef4444,#dc2626);color:#fff;cursor:pointer;font-size:14px;font-weight:600;transition:all .2s;box-shadow:0 4px 15px rgba(239,68,68,0.3);">
                        🔄 Reset Sekarang
                    </button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
        overlay.querySelector('#resetCancelBtn').onclick = () => { overlay.remove(); resolve(false); };
        overlay.querySelector('#resetConfirmBtn').onclick = () => { overlay.remove(); resolve(true); };
        overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(false); } };
    });
}

function showResetToast(message, isError = false) {
    const toast = document.createElement('div');
    toast.style.cssText = `
        position:fixed;bottom:24px;right:24px;z-index:9999;
        padding:14px 20px;border-radius:12px;font-size:14px;font-weight:500;
        color:#fff;box-shadow:0 8px 25px rgba(0,0,0,0.3);
        background:${isError ? 'linear-gradient(135deg,#ef4444,#dc2626)' : 'linear-gradient(135deg,#10b981,#059669)'};
        animation:slideInRight .3s ease;max-width:320px;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
}

async function fetchOverview() {
    try {
        const res = await fetch('/api/overview');
        const data = await res.json();
        
        document.getElementById('botName').textContent = data.botName || 'Dashboard';
        document.getElementById('botName').textContent = data.botName || 'Dashboard';
        document.getElementById('botUsername').textContent = data.botUsername || 'Admin';
        
        // Update Store Name
        if(data.storeName) {
            document.getElementById('storeName').textContent = data.storeName;
        }
        
        // Populate Stats
        document.getElementById('totalUsers').textContent = data.totalUsers || 0;
        document.getElementById('totalProducts').textContent = data.totalProducts || 0;
        document.getElementById('totalProducts').textContent = data.totalProducts || 0;
        document.getElementById('merchantCode').textContent = data.merchantCode || '-';
        
        // Update Payment Provider & Button Text
        currentProviderGlobal = data.paymentProvider || 'tripay';
        let providerLabel = 'Tripay';
        if (currentProviderGlobal === 'saweria') providerLabel = 'Saweria';
        if (currentProviderGlobal === 'pakasir') providerLabel = 'Pakasir';
        if (currentProviderGlobal === 'gopay') providerLabel = 'GoPay';
        if (currentProviderGlobal === 'dompetx') providerLabel = 'DompetX';

        const btn = document.getElementById('btnTransactions');
        if (btn) btn.innerHTML = `<i class="fa-solid fa-list"></i> ${providerLabel} Transactions`;
        
        document.getElementById('totalRevenue').textContent = formatRupiah(data.totalRevenue || 0);
        document.getElementById('totalProfit').textContent = formatRupiah(data.totalProfit || 0);
        document.getElementById('totalSales').textContent = (data.totalSales || 0).toLocaleString();
        document.getElementById('totalStock').textContent = (data.totalStock || 0).toLocaleString();
        
        // Render Chart
        if (data.salesGraph) {
            renderSalesChart(data.salesGraph);
        }

    } catch (err) {
        console.error('Failed to load overview', err);
    }
}

function formatRupiah(num) {
    return 'Rp ' + num.toLocaleString('id-ID');
}

function renderSalesChart(data) {
    const ctx = document.getElementById('salesChart').getContext('2d');
    
    // Destroy previous chart if exists
    if (salesChartInstance) {
        salesChartInstance.destroy();
    }

    const labels = data.map(item => item.name);
    const values = data.map(item => item.sold);

    salesChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Units Sold',
                data: values,
                backgroundColor: 'rgba(99, 102, 241, 0.6)',
                borderColor: '#6366f1',
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                   backgroundColor: 'rgba(15, 23, 42, 0.9)',
                   titleColor: '#fff',
                   bodyColor: '#cbd5e1',
                   borderColor: 'rgba(99, 102, 241, 0.2)',
                   borderWidth: 1
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: { color: '#94a3b8' }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8' }
                }
            }
        }
    });
}

// Modal Utils
function openModal(id) {
    const el = document.getElementById(id);
    el.classList.remove('hidden');
    // Animate in
    requestAnimationFrame(() => {
        el.style.opacity = '1';
        el.querySelector('.modal-glass').style.transform = 'scale(1)';
    });
}

function closeModal(id) {
    const el = document.getElementById(id);
    el.style.opacity = '0';
    el.querySelector('.modal-glass').style.transform = 'scale(0.95)';
    setTimeout(() => {
        el.classList.add('hidden');
    }, 300);
}

// Close on outside click
window.onclick = function(e) {
    if (e.target.classList.contains('modal-backdrop')) {
        closeModal(e.target.id);
    }
}
// --- Settings ---
function selectProvider(provider) {
    // Update Hidden Input
    document.getElementById('paymentProvider').value = provider;

    // Update Cards UI
    document.querySelectorAll('.provider-card').forEach(el => { el.classList.remove('active'); });
    document.getElementById(`card_${provider}`).classList.add('active');

    // Toggle Config Visibility
    const tripayConfig = document.getElementById('tripayConfig');
    const saweriaConfig = document.getElementById('saweriaConfig');
    const pakasirConfig = document.getElementById('pakasirConfig');
    const dompetxConfig = document.getElementById('dompetxConfig');

    tripayConfig.classList.add('hidden');
    saweriaConfig.classList.add('hidden');
    pakasirConfig.classList.add('hidden');
    if (dompetxConfig) dompetxConfig.classList.add('hidden');
    const gopayConfig = document.getElementById('gopayConfig');
    if (gopayConfig) gopayConfig.classList.add('hidden');

    if (provider === 'saweria') {
        saweriaConfig.classList.remove('hidden');
    } else if (provider === 'pakasir') {
        pakasirConfig.classList.remove('hidden');
    } else if (provider === 'gopay') {
        if (gopayConfig) gopayConfig.classList.remove('hidden');
    } else if (provider === 'dompetx') {
        if (dompetxConfig) dompetxConfig.classList.remove('hidden');
    } else {
        tripayConfig.classList.remove('hidden');
    }
}

async function openSettingsModal() {
    try {
        const res = await fetch('/api/settings');
        const settings = await res.json();
        
        // Load Bot Token (handle both camelCase from Node and snake_case intent)
        document.getElementById('botToken').value = settings.botToken || settings.bot_token || '';
        document.getElementById('adminContactTelegram').value = settings.admin_contact_telegram || '';
        document.getElementById('adminContactWhatsapp').value = settings.admin_contact_whatsapp || '';
        document.getElementById('operatingHours').value = settings.operating_hours || '';
        
        // Load Koala Config
        const ks = settings.koalastore || {};
        document.getElementById('koala_active').checked = !!ks.is_active;
        document.getElementById('koala_api_key').value = ks.api_key || '';
        if(ks.api_key) checkKoalaBalance();

        // Load Digiflazz Config
        const df = settings.digiflazz || {};
        document.getElementById('digiflazz_active').checked = !!df.is_active;
        document.getElementById('digiflazz_username').value = df.username || '';
        document.getElementById('digiflazz_api_key').value = df.api_key || '';
        document.getElementById('digiflazz_webhook_secret').value = df.webhook_secret || '';
        document.getElementById('digiflazz_delivery_mode').value = df.delivery_mode || 'auto';
        document.getElementById('digiflazz_poll_interval_seconds').value = df.poll_interval_seconds || 60;
        updateDigiflazzModeLabel();
        // Build absolute webhook URL hint (helps admin copy into Digiflazz dashboard)
        try {
            const u = window.location.origin + '/webhook/digiflazz';
            document.getElementById('digiflazz_webhook_url').textContent = u;
        } catch {}
        if (df.username && df.api_key) checkDigiflazzBalance();

        // Load Modules toggles (PPOB vs Beli Akun)
        const modules = settings.modules || { account_enabled: true, ppob_enabled: false };
        document.getElementById('module_account_enabled').checked = modules.account_enabled !== false;
        document.getElementById('module_ppob_enabled').checked = !!modules.ppob_enabled;

        // Load Payment Provider
        const provider = settings.payment_provider || 'tripay';
        selectProvider(provider); // Use new visual selector
        
        // Load Tripay
        document.getElementById('apiKey').value = settings.apiKey || settings.api_key || '';
        document.getElementById('privateKey').value = settings.privateKey || settings.private_key || '';
        document.getElementById('merchant_code').value = settings.merchant_code || '';
        document.getElementById('merchant_ref').value = settings.merchant_ref || '';
        document.getElementById('settings_store_name').value = settings.store_name || '';

        // Load Gatekeeper
        const gk = settings.gatekeeper || {};
        document.getElementById('gatekeeper_enabled').checked = !!gk.enabled;
        document.getElementById('gatekeeper_channel_id').value = (gk.channel && gk.channel.id) || '';
        document.getElementById('gatekeeper_channel_link').value = (gk.channel && gk.channel.link) || '';
        document.getElementById('gatekeeper_group_id').value = (gk.group && gk.group.id) || '';
        document.getElementById('gatekeeper_group_link').value = (gk.group && gk.group.link) || '';

        // Load Order Notifications (per-type)
        const notifCfg = settings.order_notifications || {};
        const isLegacyBool = typeof notifCfg === 'boolean';
        document.getElementById('notif_new').checked = isLegacyBool ? notifCfg : !!notifCfg.new;
        document.getElementById('notif_paid').checked = isLegacyBool ? notifCfg : !!notifCfg.paid;
        document.getElementById('notif_expired').checked = isLegacyBool ? notifCfg : !!notifCfg.expired;
        document.getElementById('notif_cancelled').checked = isLegacyBool ? notifCfg : !!notifCfg.cancelled;
        
        // Load Saweria
        const saweriaData = settings.saweria || {};
        document.getElementById('saweria_token').value = saweriaData.token || settings.saweria_token || '';
        
        // Reset Saweria Info (initially hidden)
        document.getElementById('saweria_info').classList.add('hidden');

        // Load GoPay
        const gopayData = settings.gopay || {};
        const gopayEmailEl = document.getElementById('gopayEmail');
        const gopayPasswordEl = document.getElementById('gopayPassword');
        const gopayMerchantIdEl = document.getElementById('gopayMerchantId');
        const gopayQrStringEl = document.getElementById('gopayQrString');
        if (gopayEmailEl) gopayEmailEl.value = gopayData.email || '';
        if (gopayPasswordEl) gopayPasswordEl.value = gopayData.password || '';
        if (gopayMerchantIdEl) gopayMerchantIdEl.value = gopayData.merchant_id || '';
        if (gopayQrStringEl) gopayQrStringEl.value = gopayData.qr_string || '';
        const gopayUniqueMinEl = document.getElementById('gopayUniqueMin');
        const gopayUniqueMaxEl = document.getElementById('gopayUniqueMax');
        if (gopayUniqueMinEl) gopayUniqueMinEl.value = gopayData.unique_min != null ? gopayData.unique_min : 0;
        if (gopayUniqueMaxEl) gopayUniqueMaxEl.value = gopayData.unique_max != null ? gopayData.unique_max : 200;

        // Load Pakasir (slug + apikey only)
        const pakasirData = settings.pakasir || {};
        document.getElementById('pakasir_proj_slug').value = pakasirData.project_slug || '';
        document.getElementById('pakasir_proj_apikey').value = pakasirData.api_key || '';
        document.getElementById('pakasir_proj_name').value = pakasirData.project_name || '';

        // Load DompetX
        const dompetxData = settings.dompetx || {};
        const dpxApiKeyEl = document.getElementById('dompetx_api_key');
        const dpxMethodEl = document.getElementById('dompetx_method');
        if (dpxApiKeyEl) dpxApiKeyEl.value = dompetxData.api_key || '';
        if (dpxMethodEl) dpxMethodEl.value = dompetxData.method || 'QRIS';



        // Load Admin (Master) list
        loadMasters();

        const modal = document.getElementById('settingsModal');
        modal.classList.remove('hidden');
        
        // Fix: Ensure opacity is reset to 1 (closeModal sets it to 0)
        requestAnimationFrame(() => {
            modal.style.opacity = '1';
            modal.querySelector('.modal-glass').style.transform = "scale(1)";
        });

        // Auto-Check Saweria if token exists (so user doesn't have to click check again)
        const currentSaweriaToken = document.getElementById('saweria_token').value;
        if (currentSaweriaToken) {
            checkSaweriaToken(true); 
        }

    } catch (e) {
        alert('Failed to load settings');
    }
}

// --- Admin (Master) Management ---
async function loadMasters() {
    const container = document.getElementById('masterList');
    if (!container) return;
    try {
        const res = await fetch('/api/masters');
        const masters = await res.json();
        if (!Array.isArray(masters) || masters.length === 0) {
            container.innerHTML = '<small style="color: var(--text-muted);">Belum ada admin terdaftar.</small>';
            return;
        }
        container.innerHTML = masters.map(id => `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: rgba(0,0,0,0.2); border-radius: 6px; border: 1px solid var(--border-color);">
                <div style="display: flex; align-items: center; gap: 8px;">
                    <i class="fa-solid fa-user-shield" style="color: #ef4444; font-size: 13px;"></i>
                    <span style="font-family: monospace; font-size: 14px;">${id}</span>
                </div>
                <button type="button" onclick="removeMaster('${id}')" style="background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #ef4444; padding: 4px 10px; border-radius: 4px; cursor: pointer; font-size: 12px; transition: all 0.2s;" onmouseover="this.style.background='rgba(239,68,68,0.3)'" onmouseout="this.style.background='rgba(239,68,68,0.15)'">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `).join('');
    } catch (e) {
        container.innerHTML = '<small style="color: #ef4444;">Gagal memuat data admin.</small>';
    }
}

async function addMaster() {
    const input = document.getElementById('masterIdInput');
    const id = input.value.trim();
    if (!id) return;
    try {
        const res = await fetch('/api/masters', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (data.success) {
            input.value = '';
            loadMasters();
        } else {
            alert(data.error || 'Gagal menambahkan admin');
        }
    } catch (e) {
        alert('Gagal menambahkan admin');
    }
}

async function removeMaster(id) {
    if (!confirm(`Hapus admin ${id}?`)) return;
    try {
        const res = await fetch(`/api/masters/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            loadMasters();
        } else {
            alert(data.error || 'Gagal menghapus admin');
        }
    } catch (e) {
        alert('Gagal menghapus admin');
    }
}

// Debounce for input validation
let saweriaCheckTimeout;
function validateSaweriaInput() {
    clearTimeout(saweriaCheckTimeout);
    saweriaCheckTimeout = setTimeout(() => {
        checkSaweriaToken(true);
    }, 800);
}

async function checkSaweriaToken(silent = false) {
    const token = document.getElementById('saweria_token').value;
    const statusEl = document.getElementById('saweria_status');
    
    // Reset Status
    statusEl.textContent = 'Checking...';
    statusEl.style.color = '#fbbf24'; // Amber (Loading)

    if (!token) {
        statusEl.textContent = '';
        document.getElementById('saweria_info').classList.add('hidden');
        return;
    }

    try {
        const res = await fetch('/api/saweria/check-user', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token })
        });
        const data = await res.json();
        
        if (res.ok) {
            // SUCCESS
            statusEl.textContent = '✅ Valid Token';
            statusEl.style.color = '#10b981'; // Green

            document.getElementById('saweria_info').classList.remove('hidden');
            document.getElementById('saweria_id').value = data.id;
            document.getElementById('saweria_username').value = data.username;
            document.getElementById('saweria_email').value = data.email;
        } else {
            // FAILED
            statusEl.textContent = '❌ Invalid Token';
            statusEl.style.color = '#ef4444'; // Red

            document.getElementById('saweria_info').classList.add('hidden');
        }
    } catch (e) {
        statusEl.textContent = '❌ Error';
        statusEl.style.color = '#ef4444';
    } 
}

// Koala Store Balance Check
let koalaCheckTimeout;
function validateKoalaInput() {
    clearTimeout(koalaCheckTimeout);
    koalaCheckTimeout = setTimeout(() => {
        checkKoalaBalance();
    }, 800);
}

async function checkKoalaBalance() {
    const apiKey = document.getElementById('koala_api_key').value.trim();
    const statusEl = document.getElementById('koala_balance_status');
    
    if(!apiKey) {
        statusEl.textContent = '';
        return;
    }

    statusEl.innerHTML = '<i class="fa-solid fa-sync fa-spin"></i> Checking...';
    statusEl.style.color = '#fbbf24';

    try {
        const res = await fetch('/api/koala/balance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ apiKey })
        });
        const data = await res.json();
        
        if (res.ok && data.success) {
            statusEl.textContent = `✅ Berhasil! Saldo: Rp ${data.balance.toLocaleString()}`;
            statusEl.style.color = '#10b981';
        } else {
            statusEl.textContent = `❌ ${data.error || 'Invalid API Key'}`;
            statusEl.style.color = '#ef4444';
        }
    } catch (e) {
        statusEl.textContent = '❌ Error';
        statusEl.style.color = '#ef4444';
    }
}

// Pakasir — no cookie validation needed, just slug + apikey fields
// (Legacy functions removed — settings are now simple text inputs)


// --- Transactions Logic ---
const TXN_PER_PAGE = 10;
let txnAllData = [];
let txnCurrentPage = 1;
let txnTotalPages = 1;
let txnServerPaginated = false; // All providers use client-side pagination

async function openTransactionsModal() {
    openModal('transactionsModal');
    txnCurrentPage = 1;
    txnAllData = [];
    txnServerPaginated = false; // All providers now use client-side pagination
    
    // Update Title
    let providerLabel = 'Tripay';
    if (currentProviderGlobal === 'saweria') providerLabel = 'Saweria';
    if (currentProviderGlobal === 'pakasir') providerLabel = 'Pakasir';
    if (currentProviderGlobal === 'gopay') providerLabel = 'GoPay';
    if (currentProviderGlobal === 'dompetx') providerLabel = 'DompetX';

    document.getElementById('txnModalTitle').textContent = `${providerLabel} Transactions`;

    const tbody = document.getElementById('transactionsTableBody');
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading...</td></tr>';
    document.getElementById('txnPagination').style.display = 'none';

    if (txnServerPaginated) {
        // Pakasir: server-side pagination — fetch page 1
        await fetchTxnPage(1);
    } else {
        // All providers: fetch all, paginate client-side
        let apiUrl = '/api/tripay/transactions';
        if (currentProviderGlobal === 'saweria') apiUrl = '/api/saweria/transactions';
        if (currentProviderGlobal === 'pakasir') apiUrl = '/api/pakasir/transactions';
        if (currentProviderGlobal === 'gopay') apiUrl = '/api/gopay/transactions';
        if (currentProviderGlobal === 'dompetx') apiUrl = '/api/dompetx/transactions';

        try {
            const res = await fetch(apiUrl);
            const data = await res.json();
            // GoPay returns { total, transactions }, others return flat array
            txnAllData = Array.isArray(data) ? data : (Array.isArray(data.transactions) ? data.transactions : []);
            
            if (txnAllData.length === 0) {
                tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No transactions found.</td></tr>';
                return;
            }

            txnTotalPages = Math.ceil(txnAllData.length / TXN_PER_PAGE);
            renderTxnPage();
        } catch (e) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:red;">Failed to load data. API might not be configured.</td></tr>';
        }
    }
}

let txnPerPageServer = 0; // detected per-page size from first Pakasir response

async function fetchTxnPage(page) {
    const tbody = document.getElementById('transactionsTableBody');
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Loading...</td></tr>';

    try {
        const res = await fetch(`/api/pakasir/transactions?page=${page}`);
        const data = await res.json();
        
        const transactions = (data && Array.isArray(data.transactions)) ? data.transactions : [];
        const total = data.total || transactions.length;

        // Detect per-page size from first non-empty response
        if (transactions.length > 0 && txnPerPageServer === 0) {
            txnPerPageServer = transactions.length;
        }

        const perPage = txnPerPageServer || transactions.length || 1;
        txnTotalPages = Math.ceil(total / perPage);

        // Edge case: page beyond actual data — go back to last valid page
        if (transactions.length === 0 && page > 1) {
            txnCurrentPage = txnTotalPages;
            fetchTxnPage(txnTotalPages);
            return;
        }

        txnCurrentPage = page;
        txnAllData = transactions;

        if (transactions.length === 0) {
            tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No transactions found.</td></tr>';
            document.getElementById('txnPagination').style.display = 'none';
            return;
        }

        renderTxnPage();
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center; color:red;">Failed to load data. API might not be configured.</td></tr>';
    }
}

function renderTxnPage() {
    const tbody = document.getElementById('transactionsTableBody');
    tbody.innerHTML = '';
    
    // For server-side pagination, txnAllData IS the current page data
    // For client-side pagination, slice from full dataset
    let pageData, startIndex;
    if (txnServerPaginated) {
        pageData = txnAllData;
        startIndex = (txnCurrentPage - 1) * pageData.length;
    } else {
        const start = (txnCurrentPage - 1) * TXN_PER_PAGE;
        const end = Math.min(start + TXN_PER_PAGE, txnAllData.length);
        pageData = txnAllData.slice(start, end);
        startIndex = start;
    }

    pageData.forEach((tx, i) => {
        const index = startIndex + i;
        let date, donator, message, amount, status;

        if (currentProviderGlobal === 'saweria') {
            date = new Date(tx.created_at).toLocaleString('id-ID');
            donator = `<strong>${tx.donator_name || 'Anonymous'}</strong><br><small>${tx.donator_email || ''}</small>`;
            message = tx.message || '-';
            amount = parseInt(tx.amount_raw).toLocaleString('id-ID');
            status = tx.status === 'SUCCESS' ? '<span class="stock-badge">SUCCESS</span>' : `<span class="stock-badge low">${tx.status}</span>`;
        } else if (currentProviderGlobal === 'pakasir') {
            date = tx.timestamp ? new Date(tx.timestamp).toLocaleString('id-ID') : '-';
            const payerName = tx.name || tx.username || 'Guest';
            donator = `<strong>${payerName}</strong><br><small>${tx.productName || '-'}</small>`;
            message = `<span style="font-family:monospace">Ref: ${tx.reference || tx.id || '-'}</span><br><small>Qty: ${tx.quantity || 1}</small>`;
            const val = tx.totalPrice || 0;
            amount = parseInt(val).toLocaleString('id-ID');
            let badgeClass = 'low';
            if(tx.status === 'PAID') badgeClass = 'stock-badge';
            else if(tx.status === 'EXPIRED' || tx.status === 'CANCELLED') badgeClass = 'low';
            status = `<span class="${badgeClass}">${tx.status || 'UNKNOWN'}</span>`;
        } else if (currentProviderGlobal === 'dompetx') {
            date = tx.timestamp ? new Date(tx.timestamp).toLocaleString('id-ID') : '-';
            const payerName = tx.name || tx.username || (tx.jid ? tx.jid.split('@')[0] : 'Guest');
            donator = `<strong>${payerName}</strong><br><small>${tx.productName || '-'}</small>`;
            const methodLabel = tx.dompetxMethod || 'QRIS';
            message = `<span style="font-family:monospace">Ref: ${tx.reference || tx.id || '-'}</span><br><small>${methodLabel} · Qty: ${tx.quantity || 1}</small>`;
            const val = tx.totalPrice || 0;
            amount = parseInt(val).toLocaleString('id-ID');
            let badgeClass = 'low';
            if (tx.status === 'PAID') badgeClass = 'stock-badge';
            else if (tx.status === 'EXPIRED' || tx.status === 'CANCELLED') badgeClass = 'low';
            status = `<span class="${badgeClass}">${tx.status || 'UNKNOWN'}</span>`;
        } else if (currentProviderGlobal === 'gopay') {
            date = tx.time ? new Date(tx.time).toLocaleString('id-ID') : '-';
            donator = `<strong>QRIS</strong><br><small>Source: ${tx.source || '-'}</small>`;
            message = `<span style="font-family:monospace">ID: ${tx.id || '-'}</span><br><small>Type: ${tx.type || '-'}</small>`;
            amount = parseInt(tx.amount || 0).toLocaleString('id-ID');
            status = '<span class="stock-badge">COMPLETED</span>';
        } else {
            date = new Date(tx.created_at * 1000).toLocaleString('id-ID');
            donator = `<strong>${tx.customer_name}</strong><br><small>${tx.payment_method}</small>`;
            message = `Ref: ${tx.merchant_ref}<br><small>${tx.reference}</small>`;
            amount = parseInt(tx.amount).toLocaleString('id-ID');
            let badgeClass = 'low';
            if (tx.status === 'PAID') badgeClass = 'stock-badge';
            status = `<span class="${badgeClass}">${tx.status}</span>`;
        }

        tbody.innerHTML += `
            <tr>
                <td>${index + 1}</td>
                <td>${date}</td>
                <td>${donator}</td>
                <td>${message}</td>
                <td>Rp ${amount}</td>
                <td>${status}</td>
            </tr>
        `;
    });

    // Update pagination controls — numbered buttons
    const paginationEl = document.getElementById('txnPagination');
    if (txnTotalPages > 1) {
        paginationEl.style.display = 'flex';
        paginationEl.innerHTML = buildTxnPaginationHTML(txnCurrentPage, txnTotalPages);
    } else {
        paginationEl.style.display = 'none';
        paginationEl.innerHTML = '';
    }
}

function buildTxnPaginationHTML(current, total) {
    let html = '';

    // Prev arrow
    html += `<button type="button" class="txn-page-btn txn-page-arrow" onclick="goToTxnPage(${current - 1})" ${current <= 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>`;

    // Build page number list with ellipsis
    const pages = getTxnPageRange(current, total);
    pages.forEach(p => {
        if (p === '...') {
            html += `<span class="txn-page-ellipsis">…</span>`;
        } else {
            const active = p === current ? ' txn-page-active' : '';
            html += `<button type="button" class="txn-page-btn txn-page-num${active}" onclick="goToTxnPage(${p})">${p}</button>`;
        }
    });

    // Next arrow
    html += `<button type="button" class="txn-page-btn txn-page-arrow" onclick="goToTxnPage(${current + 1})" ${current >= total ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button>`;

    return html;
}

function getTxnPageRange(current, total) {
    // Always show: first, last, current, and 1 neighbor each side
    // Use ellipsis for gaps
    if (total <= 7) {
        return Array.from({ length: total }, (_, i) => i + 1);
    }

    const pages = [];
    const rangeStart = Math.max(2, current - 1);
    const rangeEnd = Math.min(total - 1, current + 1);

    pages.push(1);
    if (rangeStart > 2) pages.push('...');
    for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i);
    if (rangeEnd < total - 1) pages.push('...');
    pages.push(total);

    return pages;
}

function goToTxnPage(page) {
    if (page < 1 || page > txnTotalPages || page === txnCurrentPage) return;

    if (txnServerPaginated) {
        fetchTxnPage(page);
    } else {
        txnCurrentPage = page;
        renderTxnPage();
    }

    const scrollContainer = document.querySelector('#transactionsModal .modal-glass > div[style*="overflow-y"]');
    if (scrollContainer) scrollContainer.scrollTop = 0;
}

function changeTxnPage(delta) {
    goToTxnPage(txnCurrentPage + delta);
}

// --- Sales History (Unified Transaction List) ---
const SALES_PER_PAGE = 15;
let salesAllData = [];
let salesFilteredData = [];
let salesCurrentPage = 1;
let salesTotalPages = 1;

function switchPage(page) {
    const dashboardContent = document.getElementById('dashboardContent');
    const salesSection = document.getElementById('salesHistorySection');
    const koalaSection = document.getElementById('koalaStoreSection');
    const digiflazzSection = document.getElementById('digiflazzSection');
    const navLinks = document.querySelectorAll('.sidebar nav a');

    navLinks.forEach(link => { link.classList.remove('active'); });

    const hideAll = () => {
        dashboardContent.style.display = 'none';
        salesSection.style.display = 'none';
        if (koalaSection) koalaSection.style.display = 'none';
        if (digiflazzSection) digiflazzSection.style.display = 'none';
    };

    const markActive = (label) => navLinks.forEach(link => {
        if (link.textContent.trim().includes(label)) link.classList.add('active');
    });

    if (page === 'salesHistory') {
        hideAll();
        salesSection.style.display = 'block';
        markActive('Sales History');
        loadSalesHistory();
    } else if (page === 'koalaStore') {
        hideAll();
        if (koalaSection) koalaSection.style.display = 'block';
        markActive('Koala Store');
        (async () => {
            await checkKoalaActive();
            loadKoalaCatalog(false);
            loadKoalaBalanceBadge();
        })();
    } else if (page === 'digiflazz') {
        hideAll();
        if (digiflazzSection) digiflazzSection.style.display = 'block';
        markActive('Digiflazz');
        (async () => {
            await checkDigiflazzActive();
            loadDigiflazzCatalog(false);
            loadDigiflazzBalanceBadge();
            startDfStatusTimer();
        })();
    } else {
        hideAll();
        dashboardContent.style.display = '';
        navLinks[0].classList.add('active');
    }
    if (page !== 'digiflazz') stopDfStatusTimer();

    if (window.innerWidth <= 768) {
        document.querySelector('.sidebar').classList.remove('open');
        document.querySelector('.sidebar-overlay').classList.remove('active');
    }
}

async function loadSalesHistory() {
    const tbody = document.getElementById('salesTableBody');
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding: 40px; color: var(--text-secondary);">Loading transactions...</td></tr>';
    document.getElementById('salesPagination').style.display = 'none';

    try {
        const res = await fetch('/api/all-transactions');
        const data = await res.json();
        salesAllData = Array.isArray(data) ? data : [];
        applySalesFilters();
    } catch (e) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; color: var(--error); padding: 40px;">Failed to load transactions.</td></tr>';
    }
}

function applySalesFilters() {
    const source = document.getElementById('salesFilterSource').value;
    const status = document.getElementById('salesFilterStatus').value;
    const dateFrom = document.getElementById('salesFilterDateFrom').value;
    const dateTo = document.getElementById('salesFilterDateTo').value;
    const search = document.getElementById('salesFilterSearch').value.toLowerCase().trim();

    // Convert date inputs to timestamp boundaries
    const dateFromTs = dateFrom ? new Date(dateFrom + 'T00:00:00').getTime() : 0;
    const dateToTs = dateTo ? new Date(dateTo + 'T23:59:59.999').getTime() : Infinity;

    salesFilteredData = salesAllData.filter(tx => {
        if (source !== 'all' && tx.source !== source) return false;
        if (status !== 'all' && tx.status !== status) return false;
        if (dateFrom && tx.timestamp < dateFromTs) return false;
        if (dateTo && tx.timestamp > dateToTs) return false;
        if (search) {
            const haystack = [tx.buyer, tx.product, tx.id].join(' ').toLowerCase();
            if (!haystack.includes(search)) return false;
        }
        return true;
    });

    salesCurrentPage = 1;
    salesTotalPages = Math.max(1, Math.ceil(salesFilteredData.length / SALES_PER_PAGE));
    updateSalesSummary();
    renderSalesPage();
}

function updateSalesSummary() {
    document.getElementById('salesTotalCount').textContent = salesAllData.length.toLocaleString('id-ID');
    document.getElementById('salesFilteredCount').textContent = salesFilteredData.length.toLocaleString('id-ID');

    const totalRevenue = salesFilteredData.reduce((sum, tx) => sum + (tx.amount || 0), 0);
    document.getElementById('salesTotalRevenue').textContent = formatRupiah(totalRevenue);

    renderRevenueCharts();
}

let revenueLineChartInstance = null;
let revenuePieChartInstance = null;
let chartShowProfit = false;

function toggleChartMode(showProfit) {
    chartShowProfit = showProfit;
    const lineTitle = document.getElementById('lineChartTitle');
    const pieTitle = document.getElementById('pieChartTitle');
    if (lineTitle) lineTitle.textContent = showProfit ? 'Daily Profit' : 'Daily Revenue';
    if (pieTitle) pieTitle.textContent = showProfit ? 'Profit by Product' : 'Revenue by Product';
    renderRevenueCharts();
}

function renderRevenueCharts() {
    const data = salesFilteredData;
    const valueKey = chartShowProfit ? 'profit' : 'amount';

    // --- Build daily values grouped by source ---
    const dailyMap = {};
    data.forEach(tx => {
        if (!tx.timestamp) return;
        const val = Number(tx[valueKey]) || 0;
        if (val === 0 && !chartShowProfit) return;
        const d = new Date(tx.timestamp);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (!dailyMap[key]) dailyMap[key] = { wa: 0, tele: 0 };
        if (tx.source === 'whatsapp') dailyMap[key].wa += val;
        else dailyMap[key].tele += val;
    });

    const sortedDays = Object.keys(dailyMap).sort();
    const waDaily = sortedDays.map(d => dailyMap[d].wa);
    const teleDaily = sortedDays.map(d => dailyMap[d].tele);
    const dayLabels = sortedDays.map(d => {
        const parts = d.split('-');
        return `${parts[2]}/${parts[1]}`;
    });

    // --- Line Chart ---
    const lineCtx = document.getElementById('revenueLineChart').getContext('2d');
    if (revenueLineChartInstance) revenueLineChartInstance.destroy();

    revenueLineChartInstance = new Chart(lineCtx, {
        type: 'line',
        data: {
            labels: dayLabels,
            datasets: [
                {
                    label: 'WhatsApp',
                    data: waDaily,
                    borderColor: '#22c55e',
                    backgroundColor: 'rgba(34, 197, 94, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 3,
                    pointBackgroundColor: '#22c55e'
                },
                {
                    label: 'Telegram',
                    data: teleDaily,
                    borderColor: '#3b82f6',
                    backgroundColor: 'rgba(59, 130, 246, 0.1)',
                    borderWidth: 2,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 3,
                    pointBackgroundColor: '#3b82f6'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    labels: { color: '#94a3b8', usePointStyle: true, pointStyle: 'circle', padding: 16 }
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.9)',
                    titleColor: '#fff',
                    bodyColor: '#cbd5e1',
                    borderColor: 'rgba(99, 102, 241, 0.2)',
                    borderWidth: 1,
                    callbacks: {
                        label: function(ctx) {
                            return `${ctx.dataset.label}: ${formatRupiah(ctx.parsed.y)}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: { color: 'rgba(255, 255, 255, 0.05)' },
                    ticks: {
                        color: '#94a3b8',
                        callback: function(val) {
                            if (val >= 1000000) return 'Rp ' + (val / 1000000).toFixed(1) + 'jt';
                            if (val >= 1000) return 'Rp ' + (val / 1000).toFixed(0) + 'rb';
                            return 'Rp ' + val;
                        }
                    }
                },
                x: {
                    grid: { display: false },
                    ticks: { color: '#94a3b8', maxRotation: 45 }
                }
            }
        }
    });

    // --- Pie/Doughnut Chart ---
    const productMap = {};
    data.forEach(tx => {
        if (!tx.product || tx.product === '-') return;
        const val = Number(tx[valueKey]) || 0;
        if (val === 0) return;
        if (!productMap[tx.product]) productMap[tx.product] = 0;
        productMap[tx.product] += val;
    });
    // Sort desc, take top 8, group rest as "Others"
    const sorted = Object.entries(productMap).sort((a, b) => b[1] - a[1]);
    const topProducts = sorted.slice(0, 8);
    const othersTotal = sorted.slice(8).reduce((s, e) => s + e[1], 0);
    if (othersTotal > 0) topProducts.push(['Others', othersTotal]);

    const productLabels = topProducts.map(e => e[0]);
    const productValues = topProducts.map(e => e[1]);
    const productColors = [
        'rgba(99, 102, 241, 0.7)', 'rgba(34, 197, 94, 0.7)', 'rgba(249, 115, 22, 0.7)',
        'rgba(236, 72, 153, 0.7)', 'rgba(14, 165, 233, 0.7)', 'rgba(168, 85, 247, 0.7)',
        'rgba(234, 179, 8, 0.7)', 'rgba(20, 184, 166, 0.7)', 'rgba(148, 163, 184, 0.7)'
    ];
    const productBorders = [
        '#6366f1', '#22c55e', '#f97316', '#ec4899', '#0ea5e9', '#a855f7', '#eab308', '#14b8a6', '#94a3b8'
    ];

    const pieCtx = document.getElementById('revenuePieChart').getContext('2d');
    if (revenuePieChartInstance) revenuePieChartInstance.destroy();

    revenuePieChartInstance = new Chart(pieCtx, {
        type: 'doughnut',
        data: {
            labels: productLabels,
            datasets: [{
                data: productValues,
                backgroundColor: productColors.slice(0, productLabels.length),
                borderColor: productBorders.slice(0, productLabels.length),
                borderWidth: 2,
                hoverOffset: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '60%',
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: { color: '#94a3b8', usePointStyle: true, pointStyle: 'circle', padding: 16 }
                },
                tooltip: {
                    backgroundColor: 'rgba(15, 23, 42, 0.9)',
                    titleColor: '#fff',
                    bodyColor: '#cbd5e1',
                    callbacks: {
                        label: function(ctx) {
                            const total = ctx.dataset.data.reduce((a, b) => a + b, 0);
                            const pct = total > 0 ? ((ctx.parsed / total) * 100).toFixed(1) : 0;
                            return `${ctx.label}: ${formatRupiah(ctx.parsed)} (${pct}%)`;
                        }
                    }
                }
            }
        }
    });
}

function renderSalesPage() {
    const tbody = document.getElementById('salesTableBody');
    tbody.innerHTML = '';

    if (salesFilteredData.length === 0) {
        tbody.innerHTML = '<tr><td colspan="10" style="text-align:center; padding: 40px; color: var(--text-secondary);">No transactions found.</td></tr>';
        document.getElementById('salesPagination').style.display = 'none';
        return;
    }

    const start = (salesCurrentPage - 1) * SALES_PER_PAGE;
    const end = Math.min(start + SALES_PER_PAGE, salesFilteredData.length);
    const pageData = salesFilteredData.slice(start, end);

    pageData.forEach((tx, i) => {
        const index = start + i;
        const sourceIcon = tx.source === 'whatsapp'
            ? '<span class="source-badge source-wa"><i class="fa-brands fa-whatsapp"></i> WA</span>'
            : '<span class="source-badge source-tg"><i class="fa-brands fa-telegram"></i> TELE</span>';

        const statusClass = tx.status === 'PAID' ? 'status-paid'
            : tx.status === 'EXPIRED' ? 'status-expired'
            : tx.status === 'CANCELLED' ? 'status-cancelled'
            : 'status-unpaid';

        const dateStr = tx.timestamp
            ? new Date(tx.timestamp).toLocaleString('id-ID', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
            : tx.date || '-';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${index + 1}</td>
            <td class="sales-date-cell">${dateStr}</td>
            <td>${sourceIcon}</td>
            <td class="sales-buyer-cell" title="${escapeHtml(tx.buyer || '-')}">${escapeHtml(tx.buyer || '-')}</td>
            <td class="sales-invoice-cell"><code>${escapeHtml(tx.id || '-')}</code></td>
            <td>${escapeHtml(tx.product || '-')}</td>
            <td style="text-align:center;">${tx.quantity || 1}</td>
            <td class="text-right">${tx.amount ? formatRupiah(tx.amount) : '-'}</td>
            <td class="text-right" style="color: #10b981;">${tx.profit ? formatRupiah(tx.profit) : '-'}</td>
            <td><span class="sales-status ${statusClass}">${tx.status || '-'}</span></td>
        `;
        tbody.appendChild(tr);
    });

    // Pagination
    const paginationEl = document.getElementById('salesPagination');
    if (salesTotalPages > 1) {
        paginationEl.style.display = 'flex';
        paginationEl.innerHTML = buildSalesPaginationHTML(salesCurrentPage, salesTotalPages);
    } else {
        paginationEl.style.display = 'none';
        paginationEl.innerHTML = '';
    }
}

function buildSalesPaginationHTML(current, total) {
    let html = '';
    html += `<button type="button" class="txn-page-btn txn-page-arrow" onclick="goToSalesPage(${current - 1})" ${current <= 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-left"></i></button>`;

    const pages = getTxnPageRange(current, total);
    pages.forEach(p => {
        if (p === '...') {
            html += `<span class="txn-page-ellipsis">…</span>`;
        } else {
            const active = p === current ? ' txn-page-active' : '';
            html += `<button type="button" class="txn-page-btn txn-page-num${active}" onclick="goToSalesPage(${p})">${p}</button>`;
        }
    });

    html += `<button type="button" class="txn-page-btn txn-page-arrow" onclick="goToSalesPage(${current + 1})" ${current >= total ? 'disabled' : ''}><i class="fa-solid fa-chevron-right"></i></button>`;
    return html;
}

function goToSalesPage(page) {
    if (page < 1 || page > salesTotalPages || page === salesCurrentPage) return;
    salesCurrentPage = page;
    renderSalesPage();
    // Scroll to top of table
    document.getElementById('salesTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function exportSalesCSV() {
    const data = salesFilteredData.length > 0 ? salesFilteredData : salesAllData;
    if (data.length === 0) return alert('No data to export.');

    const headers = ['No', 'Date', 'Source', 'Buyer', 'Invoice', 'Product', 'Qty', 'Amount', 'Profit', 'Status'];
    const rows = data.map((tx, i) => [
        i + 1,
        tx.date || '',
        tx.source || '',
        (tx.buyer || '').replace(/"/g, '""'),
        (tx.id || '').replace(/"/g, '""'),
        (tx.product || '').replace(/"/g, '""'),
        tx.quantity || 1,
        tx.amount || 0,
        tx.profit || 0,
        tx.status || ''
    ]);

    let csv = headers.join(',') + '\n';
    rows.forEach(row => {
        csv += row.map(cell => `"${cell}"`).join(',') + '\n';
    });

    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sales-history-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
}

// --- Broadcast Logic ---
function openBroadcastModal() {
    document.getElementById('broadcastMsg').value = '';
    openModal('broadcastModal');
    setTimeout(() => document.getElementById('broadcastMsg').focus(), 100);
}

async function sendBroadcast() {
    const msg = document.getElementById('broadcastMsg').value;
    if (!msg || msg.trim() === '') return alert('Message cannot be empty!');
    
    if (!confirm('Are you sure you want to send this message to ALL users?')) return;

    const btn = document.querySelector('#broadcastModal .btn-primary');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sending...';
    btn.disabled = true;

    try {
        const res = await fetch('/api/broadcast', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg })
        });
        
        const data = await res.json();
        
        if (res.ok) {
            alert(data.message);
            closeModal('broadcastModal');
        } else {
            alert('Error: ' + data.error);
        }

    } catch (e) {
        alert('Failed to send broadcast. Check server console.');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

// --- Logout Logic ---
async function logout() {
    if (!confirm('Are you sure you want to logout?')) return;
    
    try {
        const res = await fetch('/api/logout', { method: 'POST' });
        if (res.ok) {
            window.location.href = '/login';
        } else {
            alert('Logout failed');
            window.location.href = '/login';
        }
    } catch (e) {
        window.location.href = '/login';
    }
}
// --- KOALA STORE PAGE LOGIC ---
let ksCatalog = [];          // last fetched catalog from /api/koala/catalog
let ksFilter = 'all';        // 'all' | 'imported' | 'available'
let ksSelected = new Set();  // variant_codes selected for bulk import
let ksActive = null;         // tri-state: null=unknown, true=active, false=inactive

async function checkKoalaActive() {
    try {
        const res = await fetch('/api/settings');
        const settings = await res.json();
        const ks = settings.koalastore || {};
        ksActive = !!(ks.is_active && ks.api_key);
    } catch {
        ksActive = false;
    }
    applyKsActiveState();
    return ksActive;
}

function applyKsActiveState() {
    const buttons = document.querySelectorAll('#koalaStoreSection .section-title button');
    buttons.forEach(b => { b.disabled = !ksActive; b.style.opacity = ksActive ? '' : '0.5'; b.style.cursor = ksActive ? '' : 'not-allowed'; });
    const badge = document.getElementById('ksPageBalance');
    if (badge && !ksActive) badge.innerText = 'KS Belum Aktif';
}

function renderKsInactivePrompt() {
    const status = document.getElementById('ksCatalogStatus');
    const grid = document.getElementById('ksCatalogGrid');
    if (!status || !grid) return;
    grid.style.display = 'none';
    status.style.display = 'block';
    status.innerHTML = `
        <i class="fa-solid fa-circle-info fa-2x" style="color:#f59e0b;"></i>
        <p style="margin-top:12px; font-weight:600;">Koala Store belum aktif</p>
        <p style="margin-top:4px; color:var(--text-muted);">Aktifkan integrasi & masukkan API Key di Settings dulu untuk mulai browse katalog.</p>
        <button type="button" onclick="openSettingsModal()" class="btn-primary" style="margin-top:16px; background:#10b981; border:none; padding:10px 20px;">
            <i class="fa-solid fa-cog"></i> Buka Settings
        </button>
    `;
}

async function loadKoalaBalanceBadge() {
    const el = document.getElementById('ksPageBalance');
    if (!el) return;
    if (ksActive === false) { el.innerText = 'KS Belum Aktif'; return; }
    el.innerText = 'Saldo: ...';
    try {
        const res = await fetch('/api/koala/balance');
        const data = await res.json();
        if (res.ok && data.success) el.innerText = `Saldo: Rp ${Number(data.balance).toLocaleString()}`;
        else el.innerText = `Saldo: ${data.error || 'Err'}`;
    } catch {
        el.innerText = 'Saldo: Err';
    }
}

async function loadKoalaCatalog(forceFetch) {
    const status = document.getElementById('ksCatalogStatus');
    const grid = document.getElementById('ksCatalogGrid');
    if (!status || !grid) return;

    // Ensure we know active state first
    if (ksActive === null) await checkKoalaActive();
    if (ksActive === false) { renderKsInactivePrompt(); return; }

    // Show prompt only if never fetched & not forced
    if (!forceFetch && ksCatalog.length === 0) {
        status.style.display = 'block';
        grid.style.display = 'none';
        status.innerHTML = `<i class="fa-solid fa-store fa-2x"></i><p style="margin-top:12px;">Klik <b>Fetch Catalog</b> untuk memuat produk dari Koala Store.</p>`;
        return;
    }

    status.style.display = 'block';
    status.innerHTML = `<i class="fa-solid fa-spinner fa-spin fa-2x"></i><p style="margin-top:12px;">Memuat katalog Koala Store...</p>`;
    grid.style.display = 'none';

    try {
        const res = await fetch('/api/koala/catalog');
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || 'Gagal fetch');
        ksCatalog = data.items || [];
        ksSelected.clear();
        renderKoalaCatalog();
    } catch (e) {
        status.style.display = 'block';
        grid.style.display = 'none';
        status.innerHTML = `<i class="fa-solid fa-triangle-exclamation fa-2x" style="color:var(--error);"></i><p style="margin-top:12px;color:var(--error);">${e.message}</p>`;
    }
}

function setKsFilter(filter) {
    ksFilter = filter;
    document.querySelectorAll('.ks-filter-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.filter === filter);
    });
    renderKoalaCatalog();
}

function renderKoalaCatalog() {
    const status = document.getElementById('ksCatalogStatus');
    const grid = document.getElementById('ksCatalogGrid');
    if (!status || !grid) return;

    if (ksCatalog.length === 0) {
        status.style.display = 'block';
        grid.style.display = 'none';
        status.innerHTML = `<i class="fa-solid fa-store fa-2x"></i><p style="margin-top:12px;">Klik <b>Fetch Catalog</b> untuk memuat produk dari Koala Store.</p>`;
        return;
    }

    const search = (document.getElementById('ksSearchInput')?.value || '').toLowerCase().trim();
    const filtered = ksCatalog.filter(it => {
        if (ksFilter === 'imported' && !it.isImported) return false;
        if (ksFilter === 'available' && it.isImported) return false;
        if (search && !it.displayName.toLowerCase().includes(search)) return false;
        return true;
    });

    if (filtered.length === 0) {
        status.style.display = 'block';
        grid.style.display = 'none';
        status.innerHTML = `<i class="fa-solid fa-magnifying-glass fa-2x"></i><p style="margin-top:12px;">Tidak ada produk cocok dengan filter.</p>`;
        return;
    }

    status.style.display = 'none';
    grid.style.display = 'grid';
    grid.innerHTML = filtered.map(it => renderKoalaCard(it)).join('');
    updateKsBulkBar();
}

function renderKoalaCard(it) {
    const outOfStock = !it.stock || it.stock <= 0;
    const cls = ['ks-card'];
    if (it.isImported) cls.push('imported');
    if (ksSelected.has(it.variant_code)) cls.push('selected');
    if (outOfStock) cls.push('outofstock');

    const badge = it.isImported
        ? '<span class="ks-badge imported"><i class="fa-solid fa-check"></i> Imported</span>'
        : (outOfStock ? '<span class="ks-badge empty">Habis</span>' : '<span class="ks-badge">Tersedia</span>');

    const escName = it.displayName.replace(/"/g, '&quot;');
    const codeAttr = it.variant_code.replace(/"/g, '&quot;');
    const action = it.isImported
        ? `<button type="button" class="ks-card-btn ks-card-btn-remove" title="Hapus produk ini dari toko" onclick="removeKoalaImported('${codeAttr}')">
              <i class="fa-solid fa-trash"></i> <span>Remove</span>
           </button>`
        : `<label class="ks-card-pick" title="Pilih untuk import massal">
              <input type="checkbox" ${ksSelected.has(it.variant_code) ? 'checked' : ''} onchange="toggleKsSelect('${codeAttr}', this.checked)">
              <span>Pilih</span>
           </label>
           <button type="button" class="ks-card-btn ks-card-btn-import" onclick="importKoalaOne('${codeAttr}')" ${outOfStock ? 'disabled' : ''}>
              <i class="fa-solid fa-download"></i> <span>Import</span>
           </button>`;

    return `
        <div class="${cls.join(' ')}" data-code="${codeAttr}">
            <div style="display:flex; justify-content:space-between; gap:8px; align-items:flex-start;">
                <div style="font-weight:700; font-size:14px; line-height:1.3;" title="${escName}">${it.displayName}</div>
                ${badge}
            </div>
            <div style="font-size:11px; color:var(--text-muted); font-family:monospace;">${it.variant_code}</div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:auto;">
                <div>
                    <div style="color:#10b981; font-weight:700; font-size:15px;">Rp ${Number(it.price).toLocaleString()}</div>
                    <div style="font-size:11px; color:var(--text-muted);">Stok KS: ${Number(it.stock).toLocaleString()}</div>
                </div>
                <div style="display:flex; align-items:center; gap:8px;">${action}</div>
            </div>
        </div>
    `;
}

function toggleKsSelect(code, checked) {
    if (checked) ksSelected.add(code); else ksSelected.delete(code);
    updateKsBulkBar();
    const card = document.querySelector(`.ks-card[data-code="${code.replace(/"/g, '&quot;')}"]`);
    if (card) card.classList.toggle('selected', checked);
}

function updateKsBulkBar() {
    const bar = document.getElementById('ksBulkBar');
    const count = document.getElementById('ksSelectedCount');
    if (!bar || !count) return;
    if (ksSelected.size > 0) {
        bar.style.display = 'flex';
        count.textContent = `${ksSelected.size} dipilih`;
    } else {
        bar.style.display = 'none';
    }
}

async function importKoalaOne(code) {
    const it = ksCatalog.find(x => x.variant_code === code);
    if (!it) return;
    await postKoalaImport([it]);
}

async function importSelectedKoala() {
    if (ksSelected.size === 0) return;
    const items = ksCatalog.filter(it => ksSelected.has(it.variant_code) && !it.isImported);
    if (items.length === 0) return;
    await postKoalaImport(items);
}

async function postKoalaImport(items) {
    try {
        const res = await fetch('/api/koala/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items })
        });
        const data = await res.json();
        if (!res.ok || !data.success) {
            alert('Gagal import: ' + (data.error || res.statusText));
            return;
        }
        ksSelected.clear();
        // Mark imported locally so we don't need to re-fetch catalog
        items.forEach(it => {
            const ref = ksCatalog.find(x => x.variant_code === it.variant_code);
            if (ref) ref.isImported = true;
        });
        renderKoalaCatalog();
        await fetchProducts();
    } catch (e) {
        alert('Gagal import: ' + e.message);
    }
}

async function removeKoalaImported(code) {
    const productId = `ks_${code}`;
    const idx = products.findIndex(p => p.productId === productId);
    if (idx === -1) {
        alert('Produk tidak ditemukan di inventory.');
        return;
    }
    if (!confirm('Hapus produk Koala ini dari toko Anda? Produk tidak akan muncul kembali sampai di-import ulang.')) return;
    const updated = products.filter(p => p.productId !== productId);
    const saved = await saveProductsToServer(updated);
    if (!saved) return;
    products = updated;
    renderTable();
    const ref = ksCatalog.find(x => x.variant_code === code);
    if (ref) ref.isImported = false;
    renderKoalaCatalog();
}

async function refreshKoalaStock() {
    try {
        const res = await fetch('/api/koala/refresh-stock', { method: 'POST' });
        const data = await res.json();
        if (!res.ok || !data.success) {
            alert('Gagal refresh: ' + (data.error || res.statusText));
            return;
        }
        await fetchProducts();
        if (ksCatalog.length > 0) await loadKoalaCatalog(true);
    } catch (e) {
        alert('Gagal refresh: ' + e.message);
    }
}

async function saveSettings() {
    const form = document.getElementById('settingsForm');
    const saveBtn = form.querySelector('button[type="submit"]');
    const saveBtnOriginalHTML = saveBtn ? saveBtn.innerHTML : '';
    const gkEnabled = document.getElementById('gatekeeper_enabled').checked;

    // Disable button + show spinner to prevent spam clicks
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Saving...';
    }

    const body = {
        bot_token: document.getElementById('botToken').value,
        admin_contact_telegram: document.getElementById('adminContactTelegram').value,
        admin_contact_whatsapp: document.getElementById('adminContactWhatsapp').value,
        operating_hours: document.getElementById('operatingHours').value,
        store_name: document.getElementById('settings_store_name').value,
        payment_provider: document.getElementById('paymentProvider').value,
        api_key: document.getElementById('apiKey').value,
        private_key: document.getElementById('privateKey').value,
        merchant_code: document.getElementById('merchant_code').value,
        merchant_ref: document.getElementById('merchant_ref').value,
        saweria_token: document.getElementById('saweria_token').value,
        pakasir_project_slug: document.getElementById('pakasir_proj_slug').value || '',
        pakasir_api_key: document.getElementById('pakasir_proj_apikey').value || '',
        pakasir_project_name: document.getElementById('pakasir_proj_name').value || '',
        dompetx_api_key: (document.getElementById('dompetx_api_key') || {}).value || '',
        dompetx_method: (document.getElementById('dompetx_method') || {}).value || 'QRIS',
        gopay_email: (document.getElementById('gopayEmail') || {}).value || '',
        gopay_password: (document.getElementById('gopayPassword') || {}).value || '',
        gopay_merchant_id: (document.getElementById('gopayMerchantId') || {}).value || '',
        gopay_qr_string: (document.getElementById('gopayQrString') || {}).value || '',
        gopay_unique_min: parseInt((document.getElementById('gopayUniqueMin') || {}).value) || 0,
        gopay_unique_max: parseInt((document.getElementById('gopayUniqueMax') || {}).value) || 200,
        gatekeeper_enabled: gkEnabled,
        gatekeeper_channel_id: document.getElementById('gatekeeper_channel_id').value,
        gatekeeper_channel_link: document.getElementById('gatekeeper_channel_link').value,
        gatekeeper_group_id: document.getElementById('gatekeeper_group_id').value,
        gatekeeper_group_link: document.getElementById('gatekeeper_group_link').value,
        // Koala Config
        koala_active: document.getElementById('koala_active').checked,
        koala_api_key: document.getElementById('koala_api_key').value,
        // Digiflazz Config
        digiflazz_active: document.getElementById('digiflazz_active').checked,
        digiflazz_username: document.getElementById('digiflazz_username').value,
        digiflazz_api_key: document.getElementById('digiflazz_api_key').value,
        digiflazz_webhook_secret: document.getElementById('digiflazz_webhook_secret').value,
        digiflazz_delivery_mode: document.getElementById('digiflazz_delivery_mode').value,
        digiflazz_poll_interval_seconds: document.getElementById('digiflazz_poll_interval_seconds').value,
        // Modules (PPOB vs Beli Akun)
        module_account_enabled: document.getElementById('module_account_enabled').checked,
        module_ppob_enabled: document.getElementById('module_ppob_enabled').checked,
        // Order Notifications (per-type)
        order_notifications: {
            new: document.getElementById('notif_new').checked,
            paid: document.getElementById('notif_paid').checked,
            expired: document.getElementById('notif_expired').checked,
            cancelled: document.getElementById('notif_cancelled').checked
        }
    };

    try {
        const res = await fetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();
        if (data.success) {
            alert('Settings saved!');
            closeModal('settingsModal');
            ksActive = null; // invalidate cached KS active flag
            fetchOverview(); // Refresh provider label etc
        } else {
            alert('Error: ' + data.error);
        }
    } catch (e) {
        alert('Failed to save settings');
    } finally {
        // Re-enable button regardless of outcome
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = saveBtnOriginalHTML;
        }
    }
}

// --- Koala Management Functions ---

function openKoalaProfitModal() {
    openModal('koalaProfitModal');
}

// Ensure the form listener is only added once
const profitForm = document.getElementById('koalaProfitForm');
if (profitForm) {
    profitForm.addEventListener('submit', async (e) => {
        const amountEl = document.getElementById('ks_profit_amount');
        const typeEl = document.getElementById('ks_profit_type');
        if(!amountEl || !typeEl) return;

        e.preventDefault();
        const amount = amountEl.value;
        const type = typeEl.value;

        const btn = e.target.querySelector('button[type="submit"]');
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Applying...';

        try {
            const res = await fetch('/api/koala/bulk-profit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount, type })
            });
            const data = await res.json();
            if (data.success) {
                alert(data.message);
                closeModal('koalaProfitModal');
                fetchProducts();
            } else {
                alert('Error: ' + data.error);
            }
        } catch (err) {
            alert('Gagal menyimpan profit masal.');
        } finally {
            btn.disabled = false;
            btn.textContent = originalText;
        }
    });
}

// ==========================================
// WHATSAPP BOT MANAGEMENT (Socket.IO)
// ==========================================
let waSocket = null;
let waCurrentEnabled = false;

function initWASocket() {
    if (waSocket) return;
    waSocket = io();

    waSocket.on('wa-qr', (dataUrl) => {
        const qrImg = document.getElementById('waQrImage');
        const qrSection = document.getElementById('waQrSection');
        if (qrImg) { qrImg.src = dataUrl; qrSection.style.display = 'block'; }
    });

    waSocket.on('wa-status', (status) => {
        updateWAStatus(status.isConnected, status.user);
    });

    waSocket.on('wa-error', (err) => {
        showWAError(err.type, err.message);
    });
}

function showWAError(type, message) {
    const errorSection = document.getElementById('waErrorSection');
    const errorTitle = document.getElementById('waErrorTitle');
    const errorMsg = document.getElementById('waErrorMessage');
    const qrSection = document.getElementById('waQrSection');
    const title = document.getElementById('waStatusTitle');
    const sub = document.getElementById('waStatusSub');
    const icon = document.getElementById('waStatusIcon');

    if (errorSection) {
        errorSection.style.display = 'block';
        if (type === 'banned') {
            errorTitle.textContent = '🚫 Akun WhatsApp Terkena Banned';
            errorMsg.textContent = message || 'Nomor ini tidak bisa digunakan lagi. Reset sesi dan gunakan nomor lain.';
        } else {
            errorTitle.textContent = '⚠️ Sesi WhatsApp Berakhir';
            errorMsg.textContent = message || 'Silakan scan QR ulang.';
        }
    }
    if (qrSection) qrSection.style.display = 'none';
    if (title) title.textContent = type === 'banned' ? '🚫 Akun Banned' : '⚠️ Sesi Berakhir';
    if (sub) sub.textContent = message || 'Terjadi error pada koneksi WhatsApp';
    if (icon) icon.style.color = '#ef4444';
}

function updateWAStatus(connected, user) {
    // Sidebar indicator
    const dot = document.getElementById('waDot');
    const text = document.getElementById('waStatusText');
    if (dot) dot.style.background = connected ? '#25d366' : '#555';
    if (text) text.textContent = connected ? 'WA: Online' : 'WA: Offline';

    // Panel UI
    const title = document.getElementById('waStatusTitle');
    const sub = document.getElementById('waStatusSub');
    const icon = document.getElementById('waStatusIcon');
    const qrSection = document.getElementById('waQrSection');
    const connectedSection = document.getElementById('waConnectedSection');
    const errorSection = document.getElementById('waErrorSection');
    const btn = document.getElementById('btnWaToggle');
    const numEl = document.getElementById('waConnectedNumber');

    if (!title) return;

    if (connected) {
        title.textContent = '✅ WhatsApp Terhubung';
        sub.textContent = 'Bot aktif & siap menerima pesan';
        icon.style.color = '#25d366';
        if (qrSection) qrSection.style.display = 'none';
        if (errorSection) errorSection.style.display = 'none';
        if (connectedSection) connectedSection.style.display = 'block';
        if (btn) { btn.innerHTML = '<i class="fa-solid fa-power-off"></i> Nonaktifkan'; btn.style.background = '#ef4444'; }
        if (user && numEl) numEl.textContent = user.id || user.phone || 'Terhubung';
    } else {
        title.textContent = 'Belum Terhubung';
        sub.textContent = 'Tunggu QR muncul lalu scan dengan WhatsApp';
        icon.style.color = '#555';
        if (connectedSection) connectedSection.style.display = 'none';
        if (btn) { btn.innerHTML = '<i class="fa-solid fa-power-off"></i> Aktifkan'; btn.style.background = 'linear-gradient(135deg, #25d366, #128c7e)'; }
    }
}

async function openWAPanel() {
    initWASocket();
    openModal('waPanelModal');
    await refreshWAStats();

    // Fetch current status
    try {
        const res = await fetch('/api/wa/status');
        const data = await res.json();
        updateWAStatus(data.isConnected, data.user);
        if (data.error) {
            showWAError(data.error, data.error === 'banned'
                ? 'Nomor WhatsApp ini terkena banned. Gunakan nomor lain.'
                : 'Sesi WhatsApp berakhir. Silakan scan QR ulang.');
        } else if (data.qr) {
            const qrImg = document.getElementById('waQrImage');
            const qrSection = document.getElementById('waQrSection');
            if (qrImg) { qrImg.src = data.qr; qrSection.style.display = 'block'; }
        }
    } catch (e) {
        console.error('[WA] Gagal fetch status:', e);
    }
}

async function refreshWAStats() {
    try {
        const [usersRes, txRes] = await Promise.all([
            fetch('/api/wa/users'),
            fetch('/api/wa/transactions')
        ]);
        const users = await usersRes.json();
        const txs = await txRes.json();
        if (document.getElementById('waUserCount')) document.getElementById('waUserCount').textContent = users.length;
        if (document.getElementById('waActiveTransactions')) {
            document.getElementById('waActiveTransactions').textContent = txs.filter(t => t.status === 'UNPAID').length;
        }
        if (document.getElementById('waTotalTx')) document.getElementById('waTotalTx').textContent = txs.length;
    } catch (e) { console.warn('[WA] Stats fetch failed:', e.message); }
}

async function toggleWABot(enabled) {
    try {
        const res = await fetch('/api/wa/toggle', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
        });
        const data = await res.json();
        if (data.success) {
            const connectBtn = document.getElementById('waConnectSection');
            if (connectBtn) connectBtn.style.display = enabled ? 'block' : 'none';
            if (!enabled) updateWAStatus(false);
        }
    } catch (e) {
        alert('Gagal mengubah status WA bot');
    }
}

async function toggleWABotPanel() {
    try {
        const statusRes = await fetch('/api/wa/status');
        const status = await statusRes.json();
        const toEnable = !status.isConnected;
        await toggleWABot(toEnable);
    } catch (e) {
        console.error('[WA] toggleWABotPanel error:', e);
        alert('Gagal mengubah status WhatsApp. Coba lagi.');
    }
}

async function logoutWABot() {
    if (!confirm('Logout dari WhatsApp? Anda perlu scan QR lagi.')) return;
    try {
        await fetch('/api/wa/logout', { method: 'POST' });
        updateWAStatus(false);
        document.getElementById('waQrSection').style.display = 'none';
        document.getElementById('waConnectedSection').style.display = 'none';
        document.getElementById('waStatusTitle').textContent = 'Memulai ulang...';
    } catch (e) { alert('Gagal logout'); }
}

async function sendWABroadcast() {
    const msg = document.getElementById('waBroadcastMsg').value.trim();
    if (!msg) { alert('Tulis pesan broadcast terlebih dahulu!'); return; }
    if (!confirm(`Kirim broadcast ke semua WA users?\n\nPesan: "${msg.substring(0, 100)}..."`)) return;
    try {
        const res = await fetch('/api/wa/broadcast', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: msg })
        });
        const data = await res.json();
        if (data.success) {
            alert(`✅ Broadcast dikirim ke ${data.count} pengguna WA!`);
            document.getElementById('waBroadcastMsg').value = '';
        } else {
            alert('❌ ' + (data.error || 'Gagal kirim broadcast'));
        }
    } catch (e) { alert('Gagal mengirim broadcast'); }
}

// Load WA enabled status in Settings (patch existing function)
const _origOpenSettingsRef = typeof openSettingsModal !== 'undefined' ? openSettingsModal : null;
function loadWASettingsState() {
    try {
        fetch('/api/settings').then(r => r.json()).then(settings => {
            const waEnabled = settings.whatsapp && settings.whatsapp.enabled;
            const waCheckbox = document.getElementById('wa_enabled');
            if (waCheckbox) waCheckbox.checked = !!waEnabled;
            const section = document.getElementById('waConnectSection');
            if (section) section.style.display = waEnabled ? 'block' : 'none';
        }).catch((err) => { console.warn('[WA] Settings fetch failed:', err.message); });
    } catch (e) { console.warn('[WA] initWASettings error:', e.message); }
}

// Init Socket.IO on page load for sidebar indicator
document.addEventListener('DOMContentLoaded', () => {
    initWASocket();
    // Fetch initial WA status for sidebar
    fetch('/api/wa/status').then(r => r.json()).then(d => updateWAStatus(d.isConnected, d.user)).catch(() => {});

    // Patch settings modal open button to also load WA state
    document.querySelector('a[onclick*="openSettingsModal"]')?.addEventListener('click', () => {
        setTimeout(loadWASettingsState, 400);
    });
});

// =========================================================================
// DIGIFLAZZ PPOB — settings widget + catalog page
// Mirrors the Koala Store pattern (cek aktif, badge saldo, fetch+render katalog,
// import per-item with profit input, refresh).
// =========================================================================
let dfActive = null;
let dfCatalog = [];
let dfFilter = 'all';
let dfCheckTimeout;

// --- Live label for delivery mode (mirrors digiflazz.js describeDeliveryMode + getEffectivePollIntervalMs) ---
function updateDigiflazzModeLabel() {
    const labelEl = document.getElementById('digiflazz_mode_label_text');
    const wrap = document.getElementById('digiflazz_mode_label');
    if (!labelEl || !wrap) return;
    const mode = (document.getElementById('digiflazz_delivery_mode').value || 'auto').toLowerCase();
    const hasSecret = !!document.getElementById('digiflazz_webhook_secret').value.trim();
    const rawPoll = parseInt(document.getElementById('digiflazz_poll_interval_seconds').value) || 60;
    const clampedPoll = Math.max(10, Math.min(300, rawPoll));

    // Resolve effective interval (must mirror backend)
    let effSec, headline, color;
    if (mode === 'webhook') {
        effSec = 300;
        headline = hasSecret
            ? 'Webhook only — real-time, polling 5min hanya safety-net'
            : '⚠️ Webhook only TANPA secret — webhook gak akan ter-verifikasi! Isi secret atau ganti ke Polling.';
        color = hasSecret ? 'rgba(16,185,129,0.2)' : 'rgba(239,68,68,0.3)';
    } else if (mode === 'polling') {
        effSec = (rawPoll === 60) ? 20 : clampedPoll;
        headline = `Polling only — re-check Digiflazz tiap ${effSec}s. Zero setup webhook diperlukan.`;
        color = 'rgba(245,158,11,0.2)';
    } else {
        // auto
        if (hasSecret) {
            effSec = Math.max(60, clampedPoll);
            headline = `Auto — webhook primary (real-time), polling tiap ${effSec}s sebagai safety-net.`;
            color = 'rgba(99,102,241,0.2)';
        } else {
            effSec = (rawPoll === 60) ? 20 : clampedPoll;
            headline = `Auto → fallback ke polling tiap ${effSec}s (webhook_secret kosong).`;
            color = 'rgba(245,158,11,0.2)';
        }
    }
    labelEl.textContent = headline;
    wrap.style.background = color;
    wrap.style.borderColor = color.replace('0.2', '0.4').replace('0.3', '0.5');
}

// --- Settings card: inline balance check on credential typed ---
function validateDigiflazzInput() {
    clearTimeout(dfCheckTimeout);
    dfCheckTimeout = setTimeout(() => { checkDigiflazzBalance(); }, 600);
}

async function checkDigiflazzBalance() {
    const username = document.getElementById('digiflazz_username').value.trim();
    const apiKey = document.getElementById('digiflazz_api_key').value.trim();
    const statusEl = document.getElementById('digiflazz_balance_status');
    if (!username || !apiKey) { statusEl.innerHTML = '<span style="color: var(--text-muted);">Isi username & API key</span>'; return; }
    statusEl.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Mengecek saldo...';
    try {
        const res = await fetch('/api/digiflazz/balance', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, apiKey })
        });
        const data = await res.json();
        if (data.success) {
            statusEl.innerHTML = `<span style="color:#10b981;">✅ Saldo: Rp ${Number(data.balance).toLocaleString('id-ID')}</span>`;
        } else {
            statusEl.innerHTML = `<span style="color:#ef4444;">❌ ${data.error || 'Gagal cek saldo'}${data.rc ? ' (rc=' + data.rc + ')' : ''}</span>`;
        }
    } catch (e) {
        statusEl.innerHTML = '<span style="color:#ef4444;">❌ Connection error</span>';
    }
}

// --- Digiflazz page: aktif-check, badge, fetch, render, import ---
async function checkDigiflazzActive() {
    try {
        const r = await fetch('/api/settings');
        const settings = await r.json();
        const df = settings.digiflazz || {};
        dfActive = !!(df.is_active && df.username && df.api_key);
    } catch { dfActive = false; }
    const status = document.getElementById('dfCatalogStatus');
    const grid = document.getElementById('dfCatalogGrid');
    if (!dfActive) {
        grid.style.display = 'none';
        status.style.display = 'block';
        status.innerHTML = `
            <i class="fa-solid fa-triangle-exclamation fa-2x" style="color:#f59e0b;"></i>
            <p style="margin-top:12px; font-weight:600;">Digiflazz belum aktif</p>
            <p style="font-size:13px; color: var(--text-muted);">Aktifkan & isi kredensial di <b>Settings → Digiflazz PPOB Integration</b>.</p>`;
    }
    return dfActive;
}

async function loadDigiflazzBalanceBadge() {
    const el = document.getElementById('dfPageBalance');
    if (!el) return;
    el.textContent = 'Saldo: ...';
    try {
        const res = await fetch('/api/digiflazz/balance');
        const data = await res.json();
        if (data.success) el.textContent = 'Saldo: Rp ' + Number(data.balance).toLocaleString('id-ID');
        else el.textContent = 'Saldo: error';
    } catch { el.textContent = 'Saldo: offline'; }
}

async function loadDigiflazzCatalog(forceFetch) {
    if (dfActive === null) await checkDigiflazzActive();
    if (!dfActive) return;
    const status = document.getElementById('dfCatalogStatus');
    const grid = document.getElementById('dfCatalogGrid');
    // Always fetch when called — server-side cache (warmed by auto-sync) handles efficiency.
    // forceFetch=true → ?force=1 (bypass server cache, costs 5-min cooldown slot).
    // forceFetch=false → use server cache (instant if auto-sync ran recently).
    status.style.display = 'block';
    grid.style.display = 'none';
    status.innerHTML = `<i class="fa-solid fa-spinner fa-spin fa-2x"></i><p style="margin-top:12px;">${forceFetch ? 'Force-refresh dari Digiflazz...' : 'Memuat katalog (cached)...'}</p>`;
    try {
        const url = '/api/digiflazz/catalog' + (forceFetch ? '?force=1' : '');
        const res = await fetch(url);
        const data = await res.json();
        if (!data.success) {
            // Friendly error for rate-limit + auto-retry when cooldown expires
            if (data.rate_limited && data.cooldown_remaining_ms > 0) {
                const sec = Math.ceil(data.cooldown_remaining_ms / 1000);
                const txt = sec >= 60 ? `${Math.floor(sec/60)}m ${sec%60}s` : sec + 's';
                status.innerHTML = `
                    <i class="fa-solid fa-hourglass-half fa-2x" style="color:#f59e0b;"></i>
                    <p style="margin-top: 12px; color: #f59e0b;"><b>Digiflazz cooldown aktif</b></p>
                    <p style="font-size: 13px; color: var(--text-muted);">Auto-retry dalam <b id="dfRetryCountdown">${txt}</b>. Halaman akan refresh otomatis saat cooldown habis.</p>
                    <p style="font-size: 11px; color: var(--text-muted); margin-top: 8px;">${escapeHtml(data.hint || '')}</p>`;
                // schedule auto-retry once cooldown expires (+2s buffer)
                setTimeout(() => loadDigiflazzCatalog(false), data.cooldown_remaining_ms + 2000);
                return;
            }
            throw new Error(data.error || 'Failed');
        }
        dfCatalog = data.items || [];
        // Populate filter dropdowns
        const catSel = document.getElementById('dfCategoryFilter');
        const brandSel = document.getElementById('dfBrandFilter');
        const prevCat = catSel.value, prevBrand = brandSel.value;
        catSel.innerHTML = '<option value="">Semua Kategori</option>' + (data.categories || []).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
        brandSel.innerHTML = '<option value="">Semua Brand</option>' + (data.brands || []).map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
        catSel.value = prevCat;
        brandSel.value = prevBrand;
        renderDigiflazzCatalog();
    } catch (e) {
        status.innerHTML = `<i class="fa-solid fa-circle-exclamation fa-2x" style="color:#ef4444;"></i><p style="margin-top:12px; color:#ef4444;">Gagal memuat: ${escapeHtml(e.message)}</p>`;
    }
}

function setDfFilter(filter) {
    dfFilter = filter;
    document.querySelectorAll('#digiflazzSection .ks-filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    renderDigiflazzCatalog();
}

function renderDigiflazzCatalog() {
    const status = document.getElementById('dfCatalogStatus');
    const grid = document.getElementById('dfCatalogGrid');
    const search = (document.getElementById('dfSearchInput').value || '').trim().toLowerCase();
    const cat = (document.getElementById('dfCategoryFilter').value || '').toLowerCase();
    const brand = (document.getElementById('dfBrandFilter').value || '').toLowerCase();

    if (!dfCatalog || dfCatalog.length === 0) {
        status.style.display = 'block';
        grid.style.display = 'none';
        status.innerHTML = `<i class="fa-solid fa-triangle-exclamation fa-2x" style="color:#f59e0b;"></i><p style="margin-top:12px;">Katalog Digiflazz kosong / response invalid. Coba klik <b>Sync Catalog</b> untuk force-refresh.</p>`;
        return;
    }

    let filtered = dfCatalog;
    if (dfFilter === 'imported') filtered = filtered.filter(x => x.isImported);
    else if (dfFilter === 'available') filtered = filtered.filter(x => !x.isImported);
    if (cat) filtered = filtered.filter(x => (x.category || '').toLowerCase() === cat);
    if (brand) filtered = filtered.filter(x => (x.brand || '').toLowerCase() === brand);
    if (search) filtered = filtered.filter(x =>
        (x.product_name || '').toLowerCase().includes(search) ||
        (x.buyer_sku_code || '').toLowerCase().includes(search));

    if (filtered.length === 0) {
        status.style.display = 'block';
        grid.style.display = 'none';
        status.innerHTML = `<i class="fa-solid fa-magnifying-glass fa-2x"></i><p style="margin-top:12px;">Tidak ada produk yang cocok dengan filter.</p>`;
        return;
    }
    status.style.display = 'none';
    grid.style.display = 'grid';
    grid.innerHTML = filtered.slice(0, 500).map(it => renderDigiflazzCard(it)).join('');
    if (filtered.length > 500) {
        grid.insertAdjacentHTML('beforeend',
            `<div class="glass-panel" style="grid-column: 1/-1; text-align:center; padding: 16px; color: var(--text-muted);">
                Menampilkan 500 dari ${filtered.length} produk. Perketat filter untuk lihat lebih spesifik.
             </div>`);
    }
}

function renderDigiflazzCard(it) {
    const sku = escapeHtml(it.buyer_sku_code);
    const name = escapeHtml(it.product_name);
    const brand = escapeHtml(it.brand || '');
    const category = escapeHtml(it.category || '');
    const type = escapeHtml(it.type || '');
    const price = Number(it.price || 0).toLocaleString('id-ID');
    const stock = it.unlimited_stock ? '∞' : Number(it.stock || 0).toLocaleString('id-ID');
    const sellerOk = it.seller_product_status && it.buyer_product_status;
    const cutOff = (it.start_cut_off && it.end_cut_off) ? `${it.start_cut_off}–${it.end_cut_off}` : '';
    const action = it.isImported
        ? `<button type="button" class="ks-card-btn ks-card-btn-remove" onclick="removeDigiflazzImported('${sku}')">
              <i class="fa-solid fa-trash"></i> Remove
           </button>`
        : `<div style="display:flex; gap:6px; align-items:center;">
              <input type="number" id="df_profit_${sku}" placeholder="Profit (Rp)" min="0" value="0"
                  style="width: 100px; padding: 6px 8px; background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12); color:#fff; border-radius: 6px; font-size: 12px;">
              <button type="button" class="ks-card-btn ks-card-btn-import" onclick="importDigiflazzOne('${sku}')" ${!sellerOk ? 'disabled' : ''}>
                  <i class="fa-solid fa-download"></i> Import
              </button>
           </div>`;

    return `
    <div class="glass-panel" style="padding: 14px; display: flex; flex-direction: column; gap: 8px; border: 1px solid ${it.isImported ? 'rgba(16,185,129,0.4)' : 'rgba(255,255,255,0.08)'};">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 8px;">
            <div style="flex:1; min-width: 0;">
                <div style="font-weight: 600; font-size: 13px; line-height: 1.3;">${name}</div>
                <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;"><code>${sku}</code></div>
            </div>
            ${it.isImported ? '<span class="badge-success" style="font-size: 10px; padding: 3px 8px;">IMPORTED</span>' : ''}
        </div>
        <div style="display: flex; flex-wrap: wrap; gap: 4px;">
            ${category ? `<span style="font-size: 10px; padding: 2px 6px; background: rgba(99,102,241,0.15); border-radius: 4px; color: #a5b4fc;">${category}</span>` : ''}
            ${brand ? `<span style="font-size: 10px; padding: 2px 6px; background: rgba(245,158,11,0.15); border-radius: 4px; color: #fcd34d;">${brand}</span>` : ''}
            ${type ? `<span style="font-size: 10px; padding: 2px 6px; background: rgba(168,85,247,0.15); border-radius: 4px; color: #c4b5fd;">${type}</span>` : ''}
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 12px;">
            <span>Harga: <b style="color:#10b981;">Rp ${price}</b></span>
            <span>Stok: <b>${stock}</b></span>
        </div>
        ${cutOff ? `<div style="font-size: 11px; color: var(--text-muted);">⏰ Cut-off: ${cutOff}</div>` : ''}
        ${!sellerOk ? '<div style="font-size: 11px; color: #ef4444;">⚠️ Seller/Buyer non-aktif</div>' : ''}
        <div style="margin-top: 4px;">${action}</div>
    </div>`;
}

async function importDigiflazzOne(sku) {
    const profitEl = document.getElementById('df_profit_' + sku);
    const profit = Math.max(0, parseInt(profitEl?.value) || 0);
    await postDigiflazzImport([{ buyer_sku_code: sku, profit }]);
}

async function postDigiflazzImport(items) {
    try {
        const res = await fetch('/api/digiflazz/import', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items })
        });
        const data = await res.json();
        if (!data.success) { alert('❌ ' + (data.error || 'Gagal import')); return; }
        // Update local catalog flag
        const skus = new Set(items.map(i => i.buyer_sku_code));
        dfCatalog = dfCatalog.map(x => skus.has(x.buyer_sku_code) ? { ...x, isImported: true } : x);
        renderDigiflazzCatalog();
    } catch (e) { alert('Connection error: ' + e.message); }
}

async function removeDigiflazzImported(sku) {
    if (!confirm('Hapus produk PPOB ini dari toko? Tidak akan muncul lagi sampai di-import ulang.')) return;
    const productId = 'df_' + sku;
    try {
        const res = await fetch('/api/digiflazz/import/' + encodeURIComponent(productId), { method: 'DELETE' });
        const data = await res.json();
        if (!data.success) { alert('❌ ' + (data.error || 'Gagal hapus')); return; }
        dfCatalog = dfCatalog.map(x => x.buyer_sku_code === sku ? { ...x, isImported: false } : x);
        renderDigiflazzCatalog();
    } catch (e) { alert('Connection error: ' + e.message); }
}

// --- Refresh Imported: kick background job, poll progress, render in modal ---
let _dfRefreshPollTimer = null;
async function refreshDigiflazzStock() {
    openModal('digiflazzRefreshModal');
    document.getElementById('dfRefreshSummary').style.display = 'none';
    document.getElementById('dfRefreshErrorsList').innerHTML = '';
    document.getElementById('dfRefreshBar').style.width = '0%';
    document.getElementById('dfRefreshProgress').textContent = '0 / 0';
    document.getElementById('dfRefreshCurrentSku').textContent = '-';
    document.getElementById('dfRefreshUpdated').textContent = '0';
    document.getElementById('dfRefreshStale').textContent = '0';
    document.getElementById('dfRefreshErrors').textContent = '0';
    document.getElementById('dfRefreshEta').textContent = '-';
    try {
        const res = await fetch('/api/digiflazz/refresh', { method: 'POST' });
        const data = await res.json();
        if (!data.success) {
            document.getElementById('dfRefreshSummary').style.display = 'block';
            document.getElementById('dfRefreshSummary').style.background = 'rgba(239,68,68,0.08)';
            document.getElementById('dfRefreshSummary').style.borderColor = 'rgba(239,68,68,0.25)';
            document.getElementById('dfRefreshSummary').textContent = '❌ ' + (data.error || 'Gagal refresh');
            return;
        }
        _pollRefreshStatus();
    } catch (e) {
        document.getElementById('dfRefreshSummary').style.display = 'block';
        document.getElementById('dfRefreshSummary').textContent = 'Connection error: ' + e.message;
    }
}

function _pollRefreshStatus() {
    if (_dfRefreshPollTimer) clearTimeout(_dfRefreshPollTimer);
    const tick = async () => {
        try {
            const r = await fetch('/api/digiflazz/refresh/status');
            const d = await r.json();
            if (!d.success) return;
            const j = d.job || {};
            const pct = j.total > 0 ? Math.round((j.done / j.total) * 100) : 0;
            document.getElementById('dfRefreshBar').style.width = pct + '%';
            document.getElementById('dfRefreshProgress').textContent = `${j.done} / ${j.total}`;
            document.getElementById('dfRefreshCurrentSku').textContent = j.current_sku || '-';
            document.getElementById('dfRefreshUpdated').textContent = j.updated || 0;
            document.getElementById('dfRefreshStale').textContent = j.stale || 0;
            document.getElementById('dfRefreshErrors').textContent = (j.errors || []).length;

            // ETA: remaining SKUs * 1.1s
            const remaining = (j.total || 0) - (j.done || 0);
            if (remaining > 0 && j.status === 'running') {
                const etaSec = Math.ceil(remaining * 1.1);
                document.getElementById('dfRefreshEta').textContent = etaSec > 60 ? `${Math.floor(etaSec/60)}m ${etaSec%60}s` : etaSec + 's';
            } else {
                document.getElementById('dfRefreshEta').textContent = '-';
            }

            // Errors list (last 5)
            if (j.errors && j.errors.length > 0) {
                const last = j.errors.slice(-5).map(e => `<div>• <code>${escapeHtml(e.sku)}</code>: ${escapeHtml(e.reason)}</div>`).join('');
                document.getElementById('dfRefreshErrorsList').innerHTML = last;
            }

            if (j.status === 'done' || j.status === 'error') {
                const sumEl = document.getElementById('dfRefreshSummary');
                sumEl.style.display = 'block';
                if (j.status === 'done') {
                    sumEl.style.background = 'rgba(16,185,129,0.08)';
                    sumEl.style.borderColor = 'rgba(16,185,129,0.25)';
                    const dur = Math.round(((j.finished_at || Date.now()) - j.started_at) / 1000);
                    sumEl.innerHTML = `✅ Selesai dalam <b>${dur}s</b>. Updated: <b>${j.updated}</b>, Stale: <b>${j.stale}</b>, Errors: <b>${(j.errors||[]).length}</b>.`;
                    if (dfCatalog.length > 0) loadDigiflazzCatalog(false);
                } else {
                    sumEl.style.background = 'rgba(239,68,68,0.08)';
                    sumEl.style.borderColor = 'rgba(239,68,68,0.25)';
                    sumEl.textContent = '❌ Job error — cek logs server.';
                }
                return; // stop polling
            }
            _dfRefreshPollTimer = setTimeout(tick, 1500);
        } catch (e) {
            _dfRefreshPollTimer = setTimeout(tick, 3000);
        }
    };
    tick();
}

function closeDigiflazzRefreshModal() {
    if (_dfRefreshPollTimer) { clearTimeout(_dfRefreshPollTimer); _dfRefreshPollTimer = null; }
    closeModal('digiflazzRefreshModal');
}

// --- Sync status strip: cooldown countdown + last sync + auto-sync info ---
let _dfStatusTimer = null;
async function _loadDfSyncStatus() {
    try {
        const r = await fetch('/api/digiflazz/status');
        const d = await r.json();
        if (!d.success) return;
        const lastSync = d.last_full_sync_at || 0;
        const lastLabel = document.getElementById('dfLastSyncLabel');
        const cooldownLabel = document.getElementById('dfCooldownLabel');
        const autoLabel = document.getElementById('dfAutoSyncLabel');
        const deliveryLabel = document.getElementById('dfDeliveryLabel');
        const btn = document.getElementById('btnDfSyncCatalog');

        if (lastSync > 0) {
            const ago = Math.round((Date.now() - lastSync) / 1000);
            lastLabel.textContent = ago < 60 ? `${ago}s lalu` : `${Math.floor(ago/60)}m ${ago%60}s lalu`;
        } else {
            lastLabel.textContent = 'belum pernah';
        }

        const next = d.next_full_sync_allowed_in_ms || 0;
        if (next > 0) {
            const sec = Math.ceil(next / 1000);
            const txt = sec >= 60 ? `${Math.floor(sec/60)}m ${sec%60}s` : sec + 's';
            cooldownLabel.innerHTML = `<span style="color:#f59e0b;">${txt}</span>`;
            if (btn) { btn.disabled = true; btn.style.opacity = '0.55'; btn.title = `Cooldown 5 menit (tersedia lagi dalam ${txt})`; }
        } else {
            cooldownLabel.innerHTML = '<span style="color:#10b981;">tersedia</span>';
            if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.title = 'Sync full price list dari Digiflazz'; }
        }

        const autoMin = Math.floor((d.auto_sync_interval_ms || 0) / 60000);
        const autoSec = Math.floor(((d.auto_sync_interval_ms || 0) % 60000) / 1000);
        if (autoLabel) autoLabel.textContent = `tiap ${autoMin}m ${autoSec}s • ${d.is_active ? 'aktif' : 'mati'}`;

        if (deliveryLabel && d.delivery) deliveryLabel.textContent = d.delivery.label || d.delivery.mode || '-';
    } catch {}
}

function startDfStatusTimer() {
    stopDfStatusTimer();
    _loadDfSyncStatus();
    _dfStatusTimer = setInterval(_loadDfSyncStatus, 5000);
}
function stopDfStatusTimer() {
    if (_dfStatusTimer) { clearInterval(_dfStatusTimer); _dfStatusTimer = null; }
}

// (escapeHtml utility is defined earlier in this file at L1718; no shadowing here.)

// Re-render dynamic UI when the dashboard language changes.
window.addEventListener('languagechange', () => {
    try {
        // Refresh inventory rows (stock-count "N Items" suffix + buttons rendered in renderTable).
        if (Array.isArray(products) && products.length > 0 && typeof renderTable === 'function') {
            renderTable();
        }
        // Refresh modal-typed labels if a product modal is open.
        const typeLabel = document.getElementById('typeLabel');
        if (typeLabel && typeof toggleProductTypeFields === 'function') {
            toggleProductTypeFields();
        }
        // Re-render Koala / Digiflazz catalogs if visible.
        if (document.getElementById('koalaStoreSection')?.style.display !== 'none' && typeof renderKoalaCatalog === 'function') {
            try { renderKoalaCatalog(); } catch {}
        }
        if (document.getElementById('digiflazzSection')?.style.display !== 'none' && typeof renderDigiflazzCatalog === 'function') {
            try { renderDigiflazzCatalog(); } catch {}
        }
    } catch (e) {
        console.warn('[i18n] re-render on languagechange failed:', e);
    }
});

