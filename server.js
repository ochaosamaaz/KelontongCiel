process.env.NTBA_FIX_350 = '1'; // Fix Deprecation Warning: Content-type fallback
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import express from 'express';
import fetch from 'node-fetch';
import TelegramBot from 'node-telegram-bot-api';
import * as gopay from './lib/gopay.js';

import { chatLog } from './lib/foundation.js';
import { getConfig, setConfig, loadCache } from './lib/config.js';
import { sweepStaleTransactions } from './lib/transactions.js';

// Telegram Bot — all TG bot handlers, purchase flow, recovery
import { setupTGBot } from './lib/tg-bot.js';
import { setupRoutes } from './lib/routes.js';
import { setupWABot } from './lib/wa-bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

(async () => {
    // Load global cache from files
    loadCache();

    // Initialize Config if empty
    let GLOBAL_CONFIG = getConfig();
    if (!Array.isArray(GLOBAL_CONFIG) || GLOBAL_CONFIG.length === 0) {
        GLOBAL_CONFIG = [{}];
        setConfig(GLOBAL_CONFIG);
    }

    // Get Token from Config or use default
    const botToken = GLOBAL_CONFIG[0].botToken;

    // --- BOT WRAPPER FOR HOT RELOADING ---
    // This wrapper allows us to swap the underlying TelegramBot instance 
    // without losing the event listeners (on, onText, etc) attached by the script.

    const botListeners = []; // Store listeners here

    const bot = {
        _instance: null,

        // Custom method to swap the real bot instance
        // Async to properly await stopPolling() and prevent 409 Conflict errors
        setInstance: async function (inst) {
            if (this._instance) {
                try { await this._instance.stopPolling(); } catch (e) { }
                try { this._instance.removeAllListeners(); } catch (e) { }
                // Give Telegram API time to release the old polling session
                await new Promise(r => setTimeout(r, 500));
            }
            this._instance = inst;

            if (inst) {
                console.log('🔄 Attaching stored listeners to new Bot instance...');
                // Re-attach all stored listeners to the new instance
                botListeners.forEach(l => {
                    if (l.type === 'on') inst.on(...l.args);
                    if (l.type === 'onText') inst.onText(...l.args);
                    if (l.type === 'once') inst.once(...l.args);
                });
            }
        },

        // Event Handlers - Store them AND forward them
        on: function (e, h) {
            botListeners.push({ type: 'on', args: [e, h] });
            if (this._instance) this._instance.on(e, h);
        },
        onText: function (r, h) {
            botListeners.push({ type: 'onText', args: [r, h] });
            if (this._instance) this._instance.onText(r, h);
        },
        once: function (e, h) {
            // For 'once', we forward it. We don't store it permanently 
            // because it's meant to be one-time. If bot restarts, user retries.
            if (this._instance) this._instance.once(e, h);
        },

        // API Methods - Forward to instance or return Mock/Promise
        sendMessage: function (...a) {
            const chatId = a[0]; const text = a[1];
            const preview = typeof text === 'string' ? text.slice(0, 200) : '[non-text]';
            chatLog('TG', 'OUT', chatId, 'BOT', preview);
            if (this._instance) return this._instance.sendMessage(...a);
            return Promise.resolve({ message_id: 0 });
        },
        sendPhoto: function (...a) {
            chatLog('TG', 'OUT', a[0], 'BOT', '[PHOTO] ' + (a[2]?.caption || '').slice(0, 150));
            if (this._instance) return this._instance.sendPhoto(...a);
            return Promise.resolve({ message_id: 0 });
        },
        deleteMessage: function (...a) {
            if (this._instance) return this._instance.deleteMessage(...a);
            return Promise.resolve();
        },
        editMessageReplyMarkup: function (...a) {
            if (this._instance) return this._instance.editMessageReplyMarkup(...a);
            return Promise.resolve();
        },
        answerCallbackQuery: function (...a) {
            if (this._instance) return this._instance.answerCallbackQuery(...a);
            return Promise.resolve();
        },
        editMessageText: function (...a) {
            if (this._instance) return this._instance.editMessageText(...a);
            return Promise.resolve();
        },
        editMessageCaption: function (...a) {
            if (this._instance) return this._instance.editMessageCaption(...a);
            return Promise.resolve();
        },
        editMessageMedia: function (...a) {
            if (this._instance) return this._instance.editMessageMedia(...a);
            return Promise.resolve();
        },
        getMe: function () {
            if (this._instance) return this._instance.getMe();
            return Promise.resolve({ username: 'BotNotConfigured', first_name: 'No Token' });
        },
        getChatMember: function (...a) {
            if (this._instance) return this._instance.getChatMember(...a);
            return Promise.reject(new Error('Bot not started'));
        },
        sendDocument: function (...a) {
            chatLog('TG', 'OUT', a[0], 'BOT', '[DOCUMENT] ' + (a[2]?.caption || '').slice(0, 150));
            if (this._instance) return this._instance.sendDocument(...a);
            return Promise.resolve({ message_id: 0 });
        },
        stopPolling: function () {
            if (this._instance) return this._instance.stopPolling();
            return Promise.resolve();
        }
    };

    // Initialize Bot Immediately
    if (botToken && botToken.trim() !== '') {
        (async () => {
            try {
                console.log('🚀 Starting Telegram Bot...');
                const realBot = new TelegramBot(botToken, {
                    polling: true,
                    request: {
                        agentOptions: {
                            keepAlive: true,
                            family: 4
                        }
                    }
                });
                await bot.setInstance(realBot);
            } catch (err) {
                console.error('⚠️ Failed to start bot:', err.message);
            }
        })();
    } else {
        console.log('⚠️ Bot Token missing. Waiting for configuration...');
    }

    const sessions = new Map();

    // --- User Management Optimization ---
    let GLOBAL_USER_SET = new Set();
    let GLOBAL_USER_COUNT = 0;

    function initUserCache() {
        try {
            if (!fs.existsSync('dataUser.txt')) {
                fs.writeFileSync('dataUser.txt', '');
            }
            const data = fs.readFileSync('dataUser.txt', 'utf-8');
            const lines = data.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            GLOBAL_USER_SET = new Set(lines);
            GLOBAL_USER_COUNT = GLOBAL_USER_SET.size;
            console.log(`Loaded ${GLOBAL_USER_COUNT} users.`);
        } catch (e) {
            console.error("Error loading users:", e);
        }
    }
    initUserCache(); // Load at startup ONLY

    function getUsers() {
        // Return array from memory cache
        return Array.from(GLOBAL_USER_SET);
    }

    // Fungsi untuk menyimpan chat ID ke file (Optimized)
    function saveUser(chatId) {
        const idStr = chatId.toString().trim();
        if (GLOBAL_USER_SET.has(idStr)) return; // Cek memori dulu, kencang!

        // Jika user baru, baru tulis ke file
        GLOBAL_USER_SET.add(idStr);
        GLOBAL_USER_COUNT++;

        fs.appendFile('dataUser.txt', idStr + '\n', (err) => {
            if (err) console.error('Error appending user:', err);
        });
    }

    // Setup TG Bot — all handlers, purchase flow, recovery functions
    const { loadMasterData, isMaster, notifyAdmin, recoverReservations, recoverTGSessions, recoverStaleTransactions, dfDispatcher } = setupTGBot({
        bot,
        sessions,
        saveUser,
        gopay,
        getUsers
    });

    // ==========================================
    // WEB DASHBOARD & API (EXPRESS SERVER)
    // ==========================================
    const app = express();
    const PORT = process.env.PORT || 3000;

    // Setup all Express routes via extracted module
    setupRoutes(app, {
        bot,
        getUsers,
        loadMasterData,
        gopay,
        TelegramBot
    });

    // Register notifyAdmin globally so web-checkout can use it
    app.set('notifyAdmin', notifyAdmin);
    // Register Digiflazz webhook dispatcher (combined TG+WA — each silently ignores tx it doesn't own)
    // WA dispatcher is added below once setupWABot returns.

    // HTTP Server (needed before WA bot for Socket.IO)
    const httpServer = http.createServer(app);

    // WhatsApp Bot Engine
    const { connectToWhatsApp, io, dfDispatcher: waDfDispatcher } = setupWABot(app, httpServer, {
        notifyAdmin,
        recoverReservations,
        gopay
    });
    // Register the combined Digiflazz webhook dispatcher — calls both TG and WA dispatchers.
    // Each looks up the refId in its own pending registry and silently skips if it doesn't own the tx.
    app.set('digiflazzDispatcher', async (evt) => {
        try { await dfDispatcher(evt); } catch (e) { console.error('[DIGIFLAZZ_WEBHOOK] TG dispatcher error:', e.message); }
        try { await waDfDispatcher(evt); } catch (e) { console.error('[DIGIFLAZZ_WEBHOOK] WA dispatcher error:', e.message); }
    });

    // Start Server (using httpServer for Socket.IO support)
    httpServer.listen(PORT, '0.0.0.0', async () => {
        let hostLabel = 'localhost';
        try {
            const res = await fetch('https://api.ipify.org?format=json');
            const data = await res.json();
            if (data.ip) hostLabel = data.ip;
        } catch (e) {
            console.log('⚠️ Gagal mendeteksi IP Public, menggunakan localhost.');
        }

        if (!fs.existsSync(path.join(__dirname, 'files'))) {
            fs.mkdirSync(path.join(__dirname, 'files'));
        }

        // Startup banner
        const startTime = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });
        console.log('\n╔══════════════════════════════════════╗');
        console.log('║         🤖 STORE BOT STARTED         ║');
        console.log('╠══════════════════════════════════════╣');
        console.log(`║  🌐 Dashboard : http://${hostLabel}:${PORT}`);
        console.log(`║  🔵 Telegram  : ${botToken ? 'Active' : 'No Token'}`);
        console.log(`║  ⏰ Started   : ${startTime}`);
        console.log('╚══════════════════════════════════════╝\n');

        // Start GoPay batch poller FIRST so cache is populated before recovery pollers read it
        try {
            const gopayConf = JSON.parse(fs.readFileSync('configtelebot.json', 'utf8'));
            const gc = Array.isArray(gopayConf) ? gopayConf[0] : gopayConf;
            if (gc.payment_provider === 'gopay' && gc.gopay && gc.gopay.email && gc.gopay.password) {
                await gopay.startGopayBatchPoller(gc.gopay);
                console.log('🟢 GoPay Batch Poller: Started (cache ready)');
            } else {
                console.log('⚪ GoPay Batch Poller: Skipped (' + (gc.payment_provider !== 'gopay' ? 'provider=' + gc.payment_provider : 'not configured') + ')');
            }
        } catch (e) { console.error('[STARTUP] GoPay batch poller start failed:', e.message); }

        // Run reservation recovery on startup
        recoverReservations().catch(e => console.error('[Recovery] recoverReservations error:', e));
        // Restore TG sessions + pollers for UNPAID tx still within timeout (must run before stale check)
        recoverTGSessions();
        // Expire stale UNPAID transactions from previous crash/restart (async — checks provider APIs)
        recoverStaleTransactions().catch(e => console.error('[Recovery] recoverStaleTransactions error:', e));

        // Periodic sweep: expire orphan UNPAID transactions every 60 seconds
        // Catches txs where user left without canceling and no active poller is watching
        setInterval(() => {
            sweepStaleTransactions().catch(e => console.error('[SWEEP] Unhandled error:', e.message));
        }, 60_000);

        // Auto-start WA bot if enabled in config
        try {
            const conf = JSON.parse(fs.readFileSync('configtelebot.json', 'utf8'));
            const c = Array.isArray(conf) ? conf[0] : conf;
            if (c.whatsapp && c.whatsapp.enabled) {
                console.log('🟢 WhatsApp: Auto-starting...');
                setTimeout(() => connectToWhatsApp(), 2000);
            } else {
                console.log('⚪ WhatsApp: Disabled in config');
            }
        } catch (e) { console.error('[STARTUP] WA auto-start check failed:', e.message); }
    });
})();
