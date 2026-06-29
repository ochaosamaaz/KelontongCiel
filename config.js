// ============================================
// KONFIGURASI KELONTONG CIEL
// Ganti nilai-nilai di bawah sesuai akun kamu
// ============================================

const CONFIG = {
  // === KoalaStore API Settings ===
  BASE_URL: "https://api.koalastore.digital/v1", // Base URL API KoalaStore
  APP_TOKEN: "YOUR_APP_TOKEN_HERE", // App-Token dari KoalaStore
  STORE_ID: "YOUR_STORE_ID_HERE", // Store ID kamu di KoalaStore

  // === Store Info ===
  STORE_NAME: "KELONTONG CIEL",
  STORE_TAGLINE: "Premium Digital Store",
  STORE_DESCRIPTION: "Jual Produk Digital Premium Termurah & Terpercaya",
  STORE_DOMAIN: "kelontongciel.my.id",

  // === Payment Settings ===
  WHATSAPP_NUMBER: "6281234567890", // Nomor WhatsApp (format: 62xxx)
  WHATSAPP_MESSAGE: "Halo KelontongCiel! Saya mau order:", // Pesan default WA

  SAWERIA_USERNAME: "YOUR_SAWERIA_USERNAME", // Username Saweria (tanpa @)
  SAWERIA_LINK: "https://saweria.co/YOUR_SAWERIA_USERNAME", // Link Saweria

  // QRIS / GoBiz / Pak Kasir - Upload gambar QRIS kamu
  QRIS_IMAGE: "assets/qris.png", // Path ke gambar QRIS kamu
  PAYMENT_INSTRUCTION:
    "Scan QRIS di atas untuk pembayaran via GoPay, OVO, DANA, ShopeePay, dll.",

  // === Social Media ===
  SOCIAL_LINKS: {
    telegram: "https://t.me/YOUR_TELEGRAM",
    instagram: "https://instagram.com/YOUR_INSTAGRAM",
    tiktok: "https://tiktok.com/@YOUR_TIKTOK",
  },

  // === Display Settings ===
  CURRENCY: "IDR",
  CURRENCY_SYMBOL: "Rp",
  SHOW_UNAVAILABLE_PRODUCTS: false, // Tampilkan produk yang tidak tersedia?
};
