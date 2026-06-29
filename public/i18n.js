// Lightweight i18n runtime for the admin dashboard.
// - Dictionary-based (en, id), persisted in localStorage('dashboardLang').
// - Applies translations via data-i18n / data-i18n-placeholder / data-i18n-title / data-i18n-aria.
// - Exposes window.t(key, fallback) and emits 'languagechange' so JS-rendered UI can re-render.

(function () {
    const STORAGE_KEY = 'dashboardLang';
    const DEFAULT_LANG = 'id';

    const dict = {
        en: {
            // --- Sidebar / nav ---
            'nav.dashboard': 'Dashboard',
            'nav.salesHistory': 'Sales History',
            'nav.koalaStore': 'Koala Store',
            'nav.digiflazz': 'Digiflazz PPOB',
            'nav.settings': 'Settings',
            'nav.whatsappBot': 'WhatsApp Bot',
            'nav.updateBanner': 'Update Banner',
            'nav.logout': 'Logout',
            'sidebar.systemOnline': 'System Online',
            'sidebar.wa.offline': 'WA: Offline',
            'sidebar.wa.online': 'WA: Online',

            // --- Header ---
            'header.welcome': 'Welcome back,',
            'header.transactions': 'Transactions',
            'header.newProduct': 'New Product',
            'header.theme.toggle': 'Toggle Theme',
            'header.lang.toggle': 'Switch Language',

            // --- Stats cards ---
            'stat.totalRevenue': 'Total Revenue',
            'stat.totalProfit': 'Total Profit',
            'stat.totalSales': 'Total Sales',
            'stat.totalStock': 'Total Stock',
            'stat.totalUsers': 'Total Users',
            'stat.activeProducts': 'Active Products',
            'stat.merchantCode': 'Merchant Code',
            'stat.reset': 'Reset',
            'stat.reset.title': 'Reset Revenue & Profit',

            // --- Panels ---
            'panel.topSelling': 'Top Selling Products',
            'panel.broadcast.cta': 'Send Broadcast Message',
            'panel.inventory': 'Inventory',

            // --- Inventory table ---
            'table.productName': 'Product Name',
            'table.id': 'ID',
            'table.price': 'Price',
            'table.profit': 'Profit',
            'table.stock': 'Stock',
            'table.actions': 'Actions',

            // --- Broadcast modal ---
            'broadcast.title': 'Send Broadcast',
            'broadcast.message': 'Message (Markdown supported)',
            'broadcast.placeholder': 'e.g. 📢 *PROMO ALERT*\n\nGet 50% discount today!',
            'broadcast.hint': 'Will be sent to all active users.',
            'broadcast.send': 'Send Now',

            // --- Transactions modal ---
            'txn.title': 'Saweria Transactions',
            'txn.col.no': 'No',
            'txn.col.date': 'Date',
            'txn.col.gateway': 'Gateway',
            'txn.col.invoice': 'Invoice',
            'txn.col.amount': 'Amount',
            'txn.col.status': 'Status',

            // --- Sales history ---
            'sales.title': 'Sales History',
            'sales.export': 'Export CSV',
            'sales.filter.source': 'Source',
            'sales.filter.source.all': 'All Sources',
            'sales.filter.status': 'Status',
            'sales.filter.status.all': 'All Status',
            'sales.filter.status.paid': 'Paid',
            'sales.filter.status.unpaid': 'Unpaid',
            'sales.filter.status.expired': 'Expired',
            'sales.filter.status.cancelled': 'Cancelled',
            'sales.filter.from': 'From',
            'sales.filter.to': 'To',
            'sales.filter.search': 'Search',
            'sales.filter.search.placeholder': 'Buyer, product, invoice...',
            'sales.summary.total': 'Total Transactions',
            'sales.summary.revenue': 'Total Revenue',
            'sales.summary.filtered': 'Filtered',
            'sales.chart.daily': 'Daily Revenue',
            'sales.chart.byProduct': 'Revenue by Product',
            'sales.chart.revenue': 'Revenue',
            'sales.chart.profit': 'Profit',
            'sales.chart.toggleTitle': 'Switch Revenue / Profit',
            'sales.col.buyer': 'Buyer',
            'sales.col.product': 'Product',
            'sales.col.qty': 'Qty',
            'sales.loading': 'Loading...',

            // --- Koala Store ---
            'ks.title': 'Koala Store',
            'ks.balance': 'Balance:',
            'ks.fetchCatalog': 'Fetch Catalog',
            'ks.fetchCatalog.title': 'Re-fetch catalog from Koala API',
            'ks.refreshStock': 'Refresh Stock',
            'ks.refreshStock.title': 'Update stock & base price of imported products',
            'ks.bulkProfit': 'Bulk Profit',
            'ks.bulkProfit.title': 'Set bulk profit for imported Koala products',
            'ks.search.placeholder': 'Search products...',
            'ks.filter.all': 'All',
            'ks.filter.imported': 'Imported',
            'ks.filter.available': 'Not Imported',
            'ks.selected': 'selected',
            'ks.importSelected': 'Import Selected',
            'ks.empty.hint': 'Click **Fetch Catalog** to load products from Koala Store.',

            // --- Digiflazz ---
            'df.title': 'Digiflazz PPOB',
            'df.balance': 'Balance:',
            'df.syncCatalog': 'Sync Catalog',
            'df.syncCatalog.title': 'Sync full price list from Digiflazz (rate limit 1× per 5 minutes)',
            'df.refreshImported': 'Refresh Imported',
            'df.refreshImported.title': 'Update price & stock of imported products (per-SKU, 1 sec/product)',
            'df.lastSync': 'Last sync:',
            'df.cooldown': 'Cooldown:',
            'df.autoSync': 'Auto-sync:',
            'df.autoSync.value': 'every 5m 30s',
            'df.delivery': 'Delivery:',
            'df.search.placeholder': 'Search product / SKU...',
            'df.allCategories': 'All Categories',
            'df.allBrands': 'All Brands',
            'df.empty.hint': 'Click **Sync Catalog** to load price list from Digiflazz.',
            'df.refresh.title': 'Refresh Imported',
            'df.refresh.desc': 'Per-SKU price & stock refresh via Digiflazz (1 sec per product to obey rate limit). Safe to run any time — does not affect the 5-minute cooldown from Sync Catalog.',
            'df.refresh.currentSku': 'Current SKU:',
            'df.refresh.updated': 'Updated:',
            'df.refresh.stale': 'Stale:',
            'df.refresh.errors': 'Errors:',
            'df.refresh.eta': 'ETA:',

            // --- Product modal ---
            'prod.modal.new': 'New Product',
            'prod.modal.edit': 'Edit Product',
            'prod.type': 'Product Type:',
            'prod.type.account': 'Account',
            'prod.type.file': 'File/Session',
            'prod.name': 'Product Name',
            'prod.name.placeholder': 'e.g. Netflix Premium',
            'prod.id': 'Product ID',
            'prod.id.placeholder': 'e.g. netflix_1m',
            'prod.category': 'Category',
            'prod.category.placeholder': 'e.g. Netflix',
            'prod.description': 'Description',
            'prod.description.placeholder': 'Detailed product description...',
            'prod.warranty': 'Warranty',
            'prod.warranty.placeholder': 'e.g. 30 Days Full',
            'prod.activation': 'Activation Method',
            'prod.activation.placeholder': 'e.g. Direct Login',
            'prod.email': 'Email Access',
            'prod.email.placeholder': 'e.g. From Us (Sharing)',
            'prod.usage': 'Usage Rules',
            'prod.usage.placeholder': 'e.g. Max 1 Device',
            'prod.format': 'Format Guide / Delimiter',
            'prod.format.optional': '(Optional)',
            'prod.format.placeholder': 'e.g. email|password|profile|pin (for your reference)',
            'prod.price': 'Price (IDR)',
            'prod.profit': 'Profit (IDR)',
            'prod.bulkTier': 'Bulk Discount Tiers',
            'prod.bulkTier.hint': 'Set tiered pricing — buy more, pay less per unit.',
            'prod.bulkTier.add': '+ Add Tier',

            // --- Stock modal ---
            'stock.title': 'Manage Stock',
            'stock.badge.oneItem': 'One item per line',
            'stock.upload.title': 'Upload Session Files (.zip)',
            'stock.upload.hint': 'Drag and drop or click to select files. Each file counts as 1 stock.',
            'stock.upload.select': 'Select Files',
            'stock.save': 'Update Stock',
            'stock.close': 'Close',
            'stock.items': 'Items',

            // --- Settings modal ---
            'set.title': 'System Settings',
            'set.botToken': 'Telegram Bot Token',
            'set.botToken.hint': 'Changes require bot restart.',
            'set.adminTg': 'Admin Telegram',
            'set.adminTg.placeholder': 'username (no @)',
            'set.adminWa': 'Admin WhatsApp',
            'set.storeName': 'Store Name',
            'set.opHours': 'Operating Hours',
            'set.opHours.hint': 'Shown on the bot contact page',
            'set.gatekeeper': 'Gatekeeper (Join Required)',
            'set.gatekeeper.channelId': 'Channel ID',
            'set.gatekeeper.channelLink': 'Channel Link',
            'set.gatekeeper.groupId': 'Group ID',
            'set.gatekeeper.groupLink': 'Group Link',
            'set.gatekeeper.hint': 'Users must join these to use the bot.',
            'set.paymentProvider': 'Payment Provider',
            'set.master': 'Admin (Master)',
            'set.master.hint': 'Manage Telegram User IDs with admin access. Get the ID via',
            'set.master.add': 'Add',
            'set.master.placeholder': 'Telegram User ID (numbers)',
            'set.master.loading': 'Loading...',
            'set.koala': 'Koala Store Integration',
            'set.koala.apiKey': 'Koala API Key',
            'set.koala.apiKey.placeholder': 'Enter your Koala API Key',
            'set.modules': 'Bot Modules',
            'set.modules.hint': 'Pick the menus shown in the bot. If only one is active, users go directly to that module.',
            'set.modules.account': '🛒 Buy Account',
            'set.modules.ppob': '📲 PPOB / Pulsa',
            'set.modules.minOne': 'At least one module must be active. PPOB requires valid Digiflazz credentials in the card below.',
            'set.digi': 'Digiflazz PPOB Integration',
            'set.digi.username': 'Username',
            'set.digi.username.placeholder': 'Digiflazz Username',
            'set.digi.apiKey': 'API Key',
            'set.digi.apiKey.placeholder': 'API Key (Production / Development)',
            'set.digi.webhookSecret': 'Webhook Secret',
            'set.digi.webhookSecret.opt': '(optional if using polling)',
            'set.digi.deliveryMode': 'Delivery Mode',
            'set.digi.delivery.auto': 'Auto (recommended)',
            'set.digi.delivery.webhook': 'Webhook only',
            'set.digi.delivery.polling': 'Polling only',
            'set.digi.pollInterval': 'Poll Interval (seconds)',
            'set.wa': 'WhatsApp Bot',
            'set.wa.hint': 'Activate the WhatsApp Store Bot. Uses the same products & payments as Telegram.',
            'set.wa.setup': 'Setup / Manage WhatsApp',
            'set.wa.formatNote': 'Bot messages (menu, products) use WhatsApp-style formatting with emoji & box art.',
            'set.notif': 'Order Notifications',
            'set.notif.hint': 'Choose order statuses to notify the admin/master via Telegram Bot.',
            'set.notif.new': '🛒 New Order',
            'set.notif.paid': '✅ Paid',
            'set.notif.expired': '⏰ Expired',
            'set.notif.cancelled': '❌ Cancelled',
            'set.notif.minOne': 'Make sure at least 1 master is registered in master.json for notifications to be delivered.',
            'set.save': 'Save Settings',

            // --- Koala profit modal ---
            'koalaProfit.title': 'Set Global Koala Profit',
            'koalaProfit.desc': 'Bulk-update prices of all Koala Store products based on the profit setting below.',
            'koalaProfit.amount': 'Profit Amount',
            'koalaProfit.amount.placeholder': 'e.g. 1000 or 10',
            'koalaProfit.type': 'Profit Type',
            'koalaProfit.type.fixed': 'Fixed Rupiah (Rp)',
            'koalaProfit.type.percent': 'Percentage (%)',
            'koalaProfit.apply': 'Apply to All Koala',

            // --- WhatsApp panel modal ---
            'wa.title': 'WhatsApp Store Bot',
            'wa.notConnected': 'Not Connected',
            'wa.notConnected.sub': 'Enable the bot in Settings and scan the QR',
            'wa.activate': 'Activate',
            'wa.error': 'Error',
            'wa.reset': 'Reset & Try Another Number',
            'wa.qr.title': '📱 Scan QR to Log In',
            'wa.qr.hint': 'Open WhatsApp → Settings → Linked Devices → Link a Device',
            'wa.qr.refresh': 'QR auto-refreshes. Scan quickly!',
            'wa.connected': '✅ WhatsApp Connected',
            'wa.logout': 'Logout WA',
            'wa.stats.users': 'WA Users',
            'wa.stats.active': 'Active Transactions',
            'wa.stats.total': 'Total Transactions',
            'wa.broadcast.title': 'Broadcast to WA Users',
            'wa.broadcast.placeholder': 'Send a broadcast message to all WhatsApp users...',
            'wa.broadcast.send': 'Send Broadcast',

            // --- Common ---
            'btn.cancel': 'Cancel',
            'btn.save': 'Save Changes',
            'btn.saving': 'Saving...',
        },

        id: {
            // --- Sidebar / nav ---
            'nav.dashboard': 'Dasbor',
            'nav.salesHistory': 'Riwayat Penjualan',
            'nav.koalaStore': 'Koala Store',
            'nav.digiflazz': 'Digiflazz PPOB',
            'nav.settings': 'Pengaturan',
            'nav.whatsappBot': 'Bot WhatsApp',
            'nav.updateBanner': 'Ubah Banner',
            'nav.logout': 'Keluar',
            'sidebar.systemOnline': 'Sistem Online',
            'sidebar.wa.offline': 'WA: Offline',
            'sidebar.wa.online': 'WA: Online',

            // --- Header ---
            'header.welcome': 'Selamat datang kembali,',
            'header.transactions': 'Transaksi',
            'header.newProduct': 'Produk Baru',
            'header.theme.toggle': 'Ganti Tema',
            'header.lang.toggle': 'Ganti Bahasa',

            // --- Stats cards ---
            'stat.totalRevenue': 'Total Pendapatan',
            'stat.totalProfit': 'Total Profit',
            'stat.totalSales': 'Total Penjualan',
            'stat.totalStock': 'Total Stok',
            'stat.totalUsers': 'Total Pengguna',
            'stat.activeProducts': 'Produk Aktif',
            'stat.merchantCode': 'Kode Merchant',
            'stat.reset': 'Reset',
            'stat.reset.title': 'Reset Pendapatan & Profit',

            // --- Panels ---
            'panel.topSelling': 'Produk Terlaris',
            'panel.broadcast.cta': 'Kirim Pesan Broadcast',
            'panel.inventory': 'Inventori',

            // --- Inventory table ---
            'table.productName': 'Nama Produk',
            'table.id': 'ID',
            'table.price': 'Harga',
            'table.profit': 'Profit',
            'table.stock': 'Stok',
            'table.actions': 'Aksi',

            // --- Broadcast modal ---
            'broadcast.title': 'Kirim Broadcast',
            'broadcast.message': 'Pesan (mendukung Markdown)',
            'broadcast.placeholder': 'cth. 📢 *PROMO ALERT*\n\nDapatkan diskon 50% hari ini!',
            'broadcast.hint': 'Akan dikirim ke semua pengguna aktif.',
            'broadcast.send': 'Kirim Sekarang',

            // --- Transactions modal ---
            'txn.title': 'Transaksi Saweria',
            'txn.col.no': 'No',
            'txn.col.date': 'Tanggal',
            'txn.col.gateway': 'Gateway',
            'txn.col.invoice': 'Invoice',
            'txn.col.amount': 'Jumlah',
            'txn.col.status': 'Status',

            // --- Sales history ---
            'sales.title': 'Riwayat Penjualan',
            'sales.export': 'Ekspor CSV',
            'sales.filter.source': 'Sumber',
            'sales.filter.source.all': 'Semua Sumber',
            'sales.filter.status': 'Status',
            'sales.filter.status.all': 'Semua Status',
            'sales.filter.status.paid': 'Lunas',
            'sales.filter.status.unpaid': 'Belum Bayar',
            'sales.filter.status.expired': 'Kedaluwarsa',
            'sales.filter.status.cancelled': 'Dibatalkan',
            'sales.filter.from': 'Dari',
            'sales.filter.to': 'Ke',
            'sales.filter.search': 'Cari',
            'sales.filter.search.placeholder': 'Pembeli, produk, invoice...',
            'sales.summary.total': 'Total Transaksi',
            'sales.summary.revenue': 'Total Pendapatan',
            'sales.summary.filtered': 'Terfilter',
            'sales.chart.daily': 'Pendapatan Harian',
            'sales.chart.byProduct': 'Pendapatan per Produk',
            'sales.chart.revenue': 'Pendapatan',
            'sales.chart.profit': 'Profit',
            'sales.chart.toggleTitle': 'Ganti Pendapatan / Profit',
            'sales.col.buyer': 'Pembeli',
            'sales.col.product': 'Produk',
            'sales.col.qty': 'Qty',
            'sales.loading': 'Memuat...',

            // --- Koala Store ---
            'ks.title': 'Koala Store',
            'ks.balance': 'Saldo:',
            'ks.fetchCatalog': 'Tarik Katalog',
            'ks.fetchCatalog.title': 'Tarik ulang katalog dari API Koala',
            'ks.refreshStock': 'Refresh Stok',
            'ks.refreshStock.title': 'Update stok & harga dasar produk yang sudah di-import',
            'ks.bulkProfit': 'Profit Massal',
            'ks.bulkProfit.title': 'Set profit massal untuk produk Koala yang di-import',
            'ks.search.placeholder': 'Cari produk...',
            'ks.filter.all': 'Semua',
            'ks.filter.imported': 'Sudah Import',
            'ks.filter.available': 'Belum Import',
            'ks.selected': 'dipilih',
            'ks.importSelected': 'Import Terpilih',
            'ks.empty.hint': 'Klik **Tarik Katalog** untuk memuat produk dari Koala Store.',

            // --- Digiflazz ---
            'df.title': 'Digiflazz PPOB',
            'df.balance': 'Saldo:',
            'df.syncCatalog': 'Sync Katalog',
            'df.syncCatalog.title': 'Sync full price list dari Digiflazz (rate limit 1× per 5 menit)',
            'df.refreshImported': 'Refresh Imported',
            'df.refreshImported.title': 'Update harga & stok produk yang sudah di-import (per-SKU, 1 detik/produk)',
            'df.lastSync': 'Sync terakhir:',
            'df.cooldown': 'Cooldown:',
            'df.autoSync': 'Auto-sync:',
            'df.autoSync.value': 'tiap 5m 30s',
            'df.delivery': 'Delivery:',
            'df.search.placeholder': 'Cari produk / SKU...',
            'df.allCategories': 'Semua Kategori',
            'df.allBrands': 'Semua Brand',
            'df.empty.hint': 'Klik **Sync Katalog** untuk memuat price list dari Digiflazz.',
            'df.refresh.title': 'Refresh Imported',
            'df.refresh.desc': 'Per-SKU price & stock refresh via Digiflazz (1 detik per produk untuk patuhi rate limit). Aman dijalankan kapan pun — tidak mempengaruhi cooldown 5 menit dari Sync Catalog.',
            'df.refresh.currentSku': 'SKU saat ini:',
            'df.refresh.updated': 'Berhasil:',
            'df.refresh.stale': 'Stale:',
            'df.refresh.errors': 'Error:',
            'df.refresh.eta': 'Estimasi:',

            // --- Product modal ---
            'prod.modal.new': 'Produk Baru',
            'prod.modal.edit': 'Edit Produk',
            'prod.type': 'Jenis Produk:',
            'prod.type.account': 'Akun',
            'prod.type.file': 'File/Session',
            'prod.name': 'Nama Produk',
            'prod.name.placeholder': 'cth. Netflix Premium',
            'prod.id': 'ID Produk',
            'prod.id.placeholder': 'cth. netflix_1m',
            'prod.category': 'Kategori',
            'prod.category.placeholder': 'cth. Netflix',
            'prod.description': 'Deskripsi',
            'prod.description.placeholder': 'Deskripsi detail produk...',
            'prod.warranty': 'Garansi',
            'prod.warranty.placeholder': 'cth. 30 Hari Full',
            'prod.activation': 'Metode Aktivasi',
            'prod.activation.placeholder': 'cth. Login Langsung',
            'prod.email': 'Akses Email',
            'prod.email.placeholder': 'cth. Dari Kami (Sharing)',
            'prod.usage': 'Aturan Penggunaan',
            'prod.usage.placeholder': 'cth. Maks 1 Perangkat',
            'prod.format': 'Panduan Format / Delimiter',
            'prod.format.optional': '(Opsional)',
            'prod.format.placeholder': 'cth. email|password|profile|pin (untuk referensi)',
            'prod.price': 'Harga (IDR)',
            'prod.profit': 'Profit (IDR)',
            'prod.bulkTier': 'Tier Diskon Massal',
            'prod.bulkTier.hint': 'Atur harga bertingkat — beli lebih banyak, bayar lebih murah per unit.',
            'prod.bulkTier.add': '+ Tambah Tier',

            // --- Stock modal ---
            'stock.title': 'Kelola Stok',
            'stock.badge.oneItem': 'Satu item per baris',
            'stock.upload.title': 'Upload File Session (.zip)',
            'stock.upload.hint': 'Drag & drop atau klik untuk memilih file. Tiap file = 1 stok.',
            'stock.upload.select': 'Pilih File',
            'stock.save': 'Update Stok',
            'stock.close': 'Tutup',
            'stock.items': 'Item',

            // --- Settings modal ---
            'set.title': 'Pengaturan Sistem',
            'set.botToken': 'Token Bot Telegram',
            'set.botToken.hint': 'Perubahan butuh restart bot.',
            'set.adminTg': 'Admin Telegram',
            'set.adminTg.placeholder': 'username (tanpa @)',
            'set.adminWa': 'Admin WhatsApp',
            'set.storeName': 'Nama Toko',
            'set.opHours': 'Jam Operasional',
            'set.opHours.hint': 'Ditampilkan di halaman kontak bot',
            'set.gatekeeper': 'Gatekeeper (Wajib Join)',
            'set.gatekeeper.channelId': 'Channel ID',
            'set.gatekeeper.channelLink': 'Link Channel',
            'set.gatekeeper.groupId': 'Group ID',
            'set.gatekeeper.groupLink': 'Link Group',
            'set.gatekeeper.hint': 'Pengguna wajib join untuk pakai bot.',
            'set.paymentProvider': 'Penyedia Pembayaran',
            'set.master': 'Admin (Master)',
            'set.master.hint': 'Kelola Telegram User ID yang punya akses admin. Dapatkan ID via',
            'set.master.add': 'Tambah',
            'set.master.placeholder': 'Telegram User ID (angka)',
            'set.master.loading': 'Memuat...',
            'set.koala': 'Integrasi Koala Store',
            'set.koala.apiKey': 'Koala API Key',
            'set.koala.apiKey.placeholder': 'Masukkan Koala API Key',
            'set.modules': 'Modul Bot',
            'set.modules.hint': 'Pilih menu yang muncul di bot. Jika hanya satu yang aktif, user langsung masuk ke modul itu tanpa pertanyaan menu.',
            'set.modules.account': '🛒 Beli Akun',
            'set.modules.ppob': '📲 PPOB / Pulsa',
            'set.modules.minOne': 'Minimal satu modul harus aktif. PPOB memerlukan kredensial Digiflazz yang valid di card di bawah.',
            'set.digi': 'Integrasi Digiflazz PPOB',
            'set.digi.username': 'Username',
            'set.digi.username.placeholder': 'Username Digiflazz',
            'set.digi.apiKey': 'API Key',
            'set.digi.apiKey.placeholder': 'API Key (Production / Development)',
            'set.digi.webhookSecret': 'Webhook Secret',
            'set.digi.webhookSecret.opt': '(opsional jika pakai polling)',
            'set.digi.deliveryMode': 'Mode Delivery',
            'set.digi.delivery.auto': 'Auto (rekomendasi)',
            'set.digi.delivery.webhook': 'Webhook saja',
            'set.digi.delivery.polling': 'Polling saja',
            'set.digi.pollInterval': 'Poll Interval (detik)',
            'set.wa': 'Bot WhatsApp',
            'set.wa.hint': 'Aktifkan WhatsApp Store Bot. Pakai produk & payment yang sama dengan Telegram.',
            'set.wa.setup': 'Setup / Kelola WhatsApp',
            'set.wa.formatNote': 'Pesan bot (menu, produk) memakai format WhatsApp-style dengan emoji & box art.',
            'set.notif': 'Notifikasi Order',
            'set.notif.hint': 'Pilih status order yang dikirim notifikasinya ke admin/master via Bot Telegram.',
            'set.notif.new': '🛒 Order Baru',
            'set.notif.paid': '✅ Terbayar',
            'set.notif.expired': '⏰ Kedaluwarsa',
            'set.notif.cancelled': '❌ Dibatalkan',
            'set.notif.minOne': 'Pastikan minimal 1 master terdaftar di master.json agar notifikasi terkirim.',
            'set.save': 'Simpan Pengaturan',

            // --- Koala profit modal ---
            'koalaProfit.title': 'Set Profit Global Koala',
            'koalaProfit.desc': 'Ubah harga semua produk Koala Store secara massal berdasarkan pengaturan profit di bawah.',
            'koalaProfit.amount': 'Jumlah Profit',
            'koalaProfit.amount.placeholder': 'Contoh: 1000 atau 10',
            'koalaProfit.type': 'Tipe Profit',
            'koalaProfit.type.fixed': 'Rupiah Tetap (Rp)',
            'koalaProfit.type.percent': 'Persentase (%)',
            'koalaProfit.apply': 'Terapkan ke Semua Koala',

            // --- WhatsApp panel modal ---
            'wa.title': 'Bot WhatsApp Store',
            'wa.notConnected': 'Belum Terhubung',
            'wa.notConnected.sub': 'Aktifkan bot di Pengaturan dan scan QR',
            'wa.activate': 'Aktifkan',
            'wa.error': 'Error',
            'wa.reset': 'Reset & Coba Nomor Lain',
            'wa.qr.title': '📱 Scan QR untuk Login',
            'wa.qr.hint': 'Buka WhatsApp → Setelan → Perangkat Tertaut → Tautkan Perangkat',
            'wa.qr.refresh': 'QR akan refresh otomatis. Scan segera!',
            'wa.connected': '✅ WhatsApp Terhubung',
            'wa.logout': 'Logout WA',
            'wa.stats.users': 'WA Users',
            'wa.stats.active': 'Transaksi Aktif',
            'wa.stats.total': 'Total Transaksi',
            'wa.broadcast.title': 'Broadcast ke WA Users',
            'wa.broadcast.placeholder': 'Kirim pesan broadcast ke semua pengguna WhatsApp...',
            'wa.broadcast.send': 'Kirim Broadcast',

            // --- Common ---
            'btn.cancel': 'Batal',
            'btn.save': 'Simpan Perubahan',
            'btn.saving': 'Menyimpan...',
        },
    };

    let currentLang = (function () {
        try {
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved && dict[saved]) return saved;
        } catch (e) { /* ignore */ }
        // Fall back to <html lang> or browser preference, default to ID
        const htmlLang = (document.documentElement.getAttribute('lang') || '').toLowerCase().slice(0, 2);
        if (dict[htmlLang]) return htmlLang;
        const nav = (navigator.language || '').toLowerCase().slice(0, 2);
        if (dict[nav]) return nav;
        return DEFAULT_LANG;
    })();

    function t(key, fallback) {
        const bag = dict[currentLang] || dict[DEFAULT_LANG];
        if (bag && Object.prototype.hasOwnProperty.call(bag, key)) return bag[key];
        const fb = dict[DEFAULT_LANG];
        if (fb && Object.prototype.hasOwnProperty.call(fb, key)) return fb[key];
        return fallback != null ? fallback : key;
    }

    // Render markdown-style **bold** as <b> while keeping safe text otherwise.
    function renderBold(s) {
        if (s == null) return '';
        const escaped = String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
        return escaped.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    }

    function applyOne(el) {
        const key = el.getAttribute('data-i18n');
        if (key) {
            const val = t(key);
            const mode = el.getAttribute('data-i18n-mode');
            if (mode === 'html') {
                el.innerHTML = renderBold(val);
            } else if (mode === 'append') {
                // Preserve leading icon/markup, replace trailing text node
                const last = el.lastChild;
                if (last && last.nodeType === Node.TEXT_NODE) {
                    last.textContent = ' ' + val;
                } else {
                    el.appendChild(document.createTextNode(' ' + val));
                }
            } else {
                el.textContent = val;
            }
        }
        const ph = el.getAttribute('data-i18n-placeholder');
        if (ph) el.setAttribute('placeholder', t(ph));
        const ti = el.getAttribute('data-i18n-title');
        if (ti) el.setAttribute('title', t(ti));
        const ar = el.getAttribute('data-i18n-aria');
        if (ar) el.setAttribute('aria-label', t(ar));
    }

    function applyAll(root) {
        const scope = root || document;
        scope.querySelectorAll('[data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-aria]')
            .forEach(applyOne);
    }

    function setLanguage(lang) {
        if (!dict[lang]) return;
        currentLang = lang;
        try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* ignore */ }
        document.documentElement.setAttribute('lang', lang);
        applyAll();
        updateToggleLabel();
        window.dispatchEvent(new CustomEvent('languagechange', { detail: { lang } }));
    }

    function toggleLanguage() {
        setLanguage(currentLang === 'id' ? 'en' : 'id');
    }

    function getLanguage() { return currentLang; }

    function updateToggleLabel() {
        const lbl = document.getElementById('langToggleLabel');
        if (lbl) lbl.textContent = currentLang === 'id' ? 'ID' : 'EN';
    }

    function init() {
        document.documentElement.setAttribute('lang', currentLang);
        applyAll();
        updateToggleLabel();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    window.t = t;
    window.i18n = {
        t,
        setLanguage,
        toggleLanguage,
        getLanguage,
        applyAll,
        applyOne,
    };
})();
