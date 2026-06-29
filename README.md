# KELONTONG CIEL - Premium Digital Store

Website toko digital premium yang terintegrasi dengan KoalaStore API.

## Setup

### 1. Konfigurasi

Edit file `config.js` dan ganti nilai-nilai berikut:

```javascript
APP_TOKEN: "YOUR_APP_TOKEN_HERE",      // API token dari KoalaStore
STORE_ID: "YOUR_STORE_ID_HERE",        // Store ID kamu di KoalaStore
WHATSAPP_NUMBER: "6281234567890",      // Nomor WhatsApp (format 62xxx)
SAWERIA_USERNAME: "YOUR_SAWERIA_USERNAME",
SAWERIA_LINK: "https://saweria.co/YOUR_USERNAME",
```

### 2. QRIS

Ganti file `assets/qris.png` dengan gambar QRIS kamu (dari GoBiz/Pak Kasir/dll).

### 3. Deploy

Upload semua file ke hosting domain `kelontongciel.my.id`:

```
index.html
styles.css
app.js
config.js
assets/
  qris.png
```

## Struktur File

```
KelontongCiel/
├── index.html       # Halaman utama
├── styles.css       # Styling
├── app.js           # Logic & API integration
├── config.js        # Konfigurasi (API key, payment, dll)
├── assets/
│   └── qris.png     # Gambar QRIS kamu
└── README.md        # Dokumentasi
```

## Fitur

- Integrasi KoalaStore API (produk otomatis dari dashboard KoalaStore)
- Filter produk berdasarkan kategori
- Pembayaran via QRIS (GoPay, OVO, DANA, ShopeePay, dll)
- Pembayaran via Saweria
- Order via WhatsApp
- Responsive design (mobile-friendly)
- Dark mode premium theme
- Animasi smooth

## API Flow

1. Authenticate via `/auth/anonymous` dengan App-Token
2. Fetch categories & products via `/places/{store_id}/categories`
3. Display products with filters
4. Order flow: pilih produk → pilih payment → konfirmasi

## Payment Flow

- **QRIS**: Tampilkan QR code → user scan & bayar → konfirmasi via WA
- **Saweria**: Redirect ke Saweria → user bayar → konfirmasi via WA
- **WhatsApp**: Langsung chat admin dengan detail order

## Hosting

Website ini static (HTML/CSS/JS) dan bisa di-host di:
- Netlify
- Vercel
- GitHub Pages
- Niagahoster / IDCloudHost
- Atau hosting apapun yang support static files

Untuk domain `kelontongciel.my.id`, arahkan DNS ke hosting yang kamu gunakan.
