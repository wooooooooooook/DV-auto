const https = require('https');
const fs = require('fs');
const path = require('path');
const { getBot } = require('../bot_instance');

const COOKIE_FILE = path.join(__dirname, '..', 'cookies.json');
const LOCALSTORAGE_FILE = path.join(__dirname, '..', 'localstorage.json');

function maskToken(token) {
    if (!token) return '';
    return token.length > 10 ? token.slice(0, 6) + '...' + token.slice(-4) : token;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendTelegram(text, imagePath = null) {
    const bot = getBot();
    if (!bot) {
        console.error('Bot is not initialized. Cannot send message.');
        return;
    }

    const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    if (!CHAT_ID) {
        console.error('TELEGRAM_CHAT_ID is not set.');
        return;
    }

    try {
        if (imagePath) {
            await bot.telegram.sendPhoto(CHAT_ID, { source: imagePath }, { caption: text, parse_mode: 'Markdown' });
        } else {
            await bot.telegram.sendMessage(CHAT_ID, text, { parse_mode: 'Markdown' });
        }
    } catch (error) {
        console.error('Failed to send Telegram message:', error);
        // To preserve original behavior of notifying about notification failures,
        // we can try to send a simplified plain text message about the failure.
        try {
            await bot.telegram.sendMessage(CHAT_ID, `Failed to send a complex Telegram message. Error: ${error.message}`);
        } catch (nestedError) {
            console.error('Failed to send the failure notification as well:', nestedError);
        }
    }
}

async function saveCookies(context) {
    try {
        const cookies = await context.cookies();
        fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
    } catch (e) {
        console.warn('쿠키 저장 실패:', e && e.message ? e.message : e);
    }
}

async function saveLocalStorage(page) {
    try {
        const url = page.url();
        if (!url || url === 'about:blank') return;
        const origin = new URL(url).origin;
        const data = await page.evaluate(() => {
            const out = {};
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                out[key] = localStorage.getItem(key);
            }
            return out;
        });

        let all = {};
        if (fs.existsSync(LOCALSTORAGE_FILE)) {
            try { all = JSON.parse(fs.readFileSync(LOCALSTORAGE_FILE)); } catch (e) { all = {}; }
        }
        all[origin] = data;
        fs.writeFileSync(LOCALSTORAGE_FILE, JSON.stringify(all, null, 2));
    } catch (e) {
        console.warn('localStorage 저장 실패:', e && e.message ? e.message : e);
    }
}

async function loadCookies(context) {
    try {
        if (fs.existsSync(COOKIE_FILE)) {
            const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE));
            await context.addCookies(cookies);
            return true;
        }
    } catch (e) {
        console.warn('쿠키 로드 실패:', e && e.message ? e.message : e);
    }
    return false;
}

async function loadLocalStorage(page, targetUrl) {
    try {
        if (!fs.existsSync(LOCALSTORAGE_FILE)) return false;
        const all = JSON.parse(fs.readFileSync(LOCALSTORAGE_FILE));
        const origin = new URL(targetUrl).origin;
        const data = all[origin];
        if (!data) return false;

        // Ensure page is at same origin so localStorage is writable
        try {
            const cur = page.url();
            if (!cur || !cur.startsWith(origin)) {
                await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => { });
            }
        } catch (e) {
            // ignore navigation errors, we'll still try to set items
        }

        await page.evaluate(store => {
            try {
                Object.entries(store).forEach(([k, v]) => localStorage.setItem(k, v));
            } catch (e) { /* ignore */ }
        }, data);
        return true;
    } catch (e) {
        console.warn('localStorage 로드 실패:', e && e.message ? e.message : e);
    }
    return false;
}

async function safeGoto(page, url, options = {}, retries = 2) {
    let attempt = 0;
    const originalUrl = url;

    function isAbsolute(u) {
        return typeof u === 'string' && (/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(u) || u.startsWith('about:') || u.startsWith('data:'));
    }

    // Resolve relative URLs against current page or BASE_URL env
    let resolvedUrl = url;
    try {
        if (typeof url === 'string' && !isAbsolute(url)) {
            const current = page && typeof page.url === 'function' ? page.url() : null;
            if (current && current !== 'about:blank') {
                resolvedUrl = new URL(url, current).toString();
            } else if (process.env.BASE_URL) {
                resolvedUrl = new URL(url, process.env.BASE_URL).toString();
            } else {
                // leave as-is; page.goto will fail and be retried
                console.warn('safeGoto: relative URL provided but no current page URL and BASE_URL not set:', url);
            }
        }
    } catch (e) {
        console.error('safeGoto: URL resolution error for', url, e && e.stack ? e.stack : e);
    }

    while (true) {
        attempt++;
        console.debug(`safeGoto: attempt ${attempt} -> ${resolvedUrl}`);
        try {
            return await page.goto(resolvedUrl, options);
        } catch (err) {
            const meta = { originalUrl, resolvedUrl, attempt, name: err && err.name, code: err && err.code, message: err && err.message };
            console.error('safeGoto error:', meta, err && err.stack ? err.stack : err);
            try { await sendTelegram(`❗ safeGoto failed (${resolvedUrl}) attempt ${attempt}: ${err && err.name ? err.name : String(err)} ${err && err.code ? '(' + err.code + ')' : ''}`); } catch (e) { console.error('notify failed', e && e.stack ? e.stack : e); }
            if (attempt > retries) throw new Error(`safeGoto failed after ${attempt} attempts for ${resolvedUrl}: ${err && err.message ? err.message : String(err)}`);
            await sleep(1000 * attempt);
        }
    }
}

async function ensureLoggedIn({ page, context, env }) {
    const loginButtonCount = await page.locator(':text("로그인")').count();
    if (loginButtonCount > 0) {
        console.log('로그인이 필요합니다. login 태스크를 실행합니다.');
        const loginTask = require('../tasks/login');
        await loginTask.run({ page, context, env });
    }
}

module.exports = {
    sendTelegram,
    saveCookies,
    loadCookies,
    saveLocalStorage,
    loadLocalStorage,
    safeGoto,
    sleep,
    maskToken,
    ensureLoggedIn
};
