# KELONTONG CIEL - Premium Digital Store Bot

Full-featured store bot system with Telegram Bot, WhatsApp Bot, and Web Admin Dashboard.
Integrated with KoalaStore API for product sourcing and GoPay/QRIS for automatic payment processing.

## Features

- **Telegram Bot** — customers buy products via Telegram
- **WhatsApp Bot** — customers buy products via WhatsApp (Baileys)
- **Web Admin Dashboard** — manage products, stock, transactions, settings
- **Payment Gateways**: GoPay QRIS (dynamic), Saweria, Tripay, Pak Kasir, DompetX
- **KoalaStore Integration** — import products, auto-checkout, real-time stock
- **Digiflazz PPOB** — pulsa, data, token listrik
- **GoPay Dynamic QRIS** — auto-generate unique QRIS per transaction, collision detection
- **Stock Management** — file-based stock with reservation system
- **Broadcast** — send messages to all users (TG + WA)
- **Sales History** — full transaction tracking with charts

## Requirements

- Node.js 18+ 
- VPS/Server (for running the bot 24/7)
- Domain (kelontongciel.my.id) pointed to your server

## Quick Start

```bash
# 1. Clone repo
git clone https://github.com/ochaosamaaz/KelontongCiel.git
cd KelontongCiel

# 2. Install dependencies
npm install

# 3. Start the server
npm start

# 4. Open dashboard
# Go to http://your-server-ip:3000
# Login with your license key
```

## Configuration

After first start, edit `configtelebot.json` (auto-created):

| Setting | Description |
|---------|-------------|
| `botToken` | Telegram Bot Token from @BotFather |
| `payment_provider` | `gopay` / `saweria` / `tripay` / `pakasir` / `dompetx` |
| `koalastore.api_key` | Your KoalaStore API key |
| `koalastore.is_active` | `true` to enable KoalaStore |
| `gopay.email` | GoBiz email |
| `gopay.password` | GoBiz password |
| `gopay.qr_string` | Static QRIS string from GoBiz |
| `admin_contact_whatsapp` | Admin WA number (62xxx) |
| `whatsapp.enabled` | `true` to enable WA bot |

## Pre-configured

- **Store Name**: KELONTONG CIEL
- **KoalaStore API Key**: Already set
- **WhatsApp Admin**: +62 818-0918-2368
- **WhatsApp Bot**: Enabled by default
- **Payment Provider**: GoPay (QRIS)

## Deployment (VPS)

```bash
# Install Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
sudo apt install -y nodejs

# Clone and setup
git clone https://github.com/ochaosamaaz/KelontongCiel.git
cd KelontongCiel
npm install

# Run with PM2 (process manager)
npm install -g pm2
pm2 start server.js --name kelontong-ciel
pm2 save
pm2 startup

# Setup reverse proxy (Nginx) for domain
sudo apt install nginx
```

### Nginx Config (for kelontongciel.my.id):

```nginx
server {
    listen 80;
    server_name kelontongciel.my.id;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Then setup SSL:
```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d kelontongciel.my.id
```

## File Structure

```
KelontongCiel/
├── server.js              # Main entry point
├── package.json           # Dependencies
├── lib/
│   ├── foundation.js      # Paths, constants, utilities
│   ├── config.js          # Product & KoalaStore config
│   ├── gopay.js           # GoPay/GoBiz QRIS integration
│   ├── payments.js        # All payment providers
│   ├── routes.js          # Express API routes & dashboard
│   ├── stock.js           # Stock management & reservations
│   ├── tg-bot.js          # Telegram bot handlers
│   ├── wa-bot.js          # WhatsApp bot handlers
│   ├── digiflazz.js       # Digiflazz PPOB integration
│   ├── transactions.js    # Transaction storage
│   ├── login-page.js      # Dashboard login page
│   └── foundation.js      # Core utilities
├── public/
│   ├── index.html         # Admin dashboard
│   ├── app.js             # Dashboard frontend logic
│   ├── style.css          # Dashboard styles
│   └── i18n.js            # Internationalization
├── products/              # Stock files (.txt)
└── product.json           # Product catalog
```

## License

Private use only.
