const https = require('https');
const fs = require('fs');
const path = require('path');

const COOKIE_FILE = path.join(__dirname, '..', 'cookies.json');
const LOCALSTORAGE_FILE = path.join(__dirname, '..', 'localstorage.json');

function maskToken(token) {
    if (!token) return '';
    return token.length > 10 ? token.slice(0, 6) + '...' + token.slice(-4) : token;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendTelegramHttps(text, imagePath = null) {
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
    if (!BOT_TOKEN || !CHAT_ID) {
        console.error('BOT_TOKEN 또는 CHAT_ID가 설정되지 않았습니다.');
        return Promise.reject(new Error('Missing Telegram config'));
    }
    const safeToken = encodeURIComponent(BOT_TOKEN);
    console.log(`sendTelegramHttps to chat_id=${CHAT_ID} text=${text ? text.slice(0, 50) : ''}... using bot=${maskToken(BOT_TOKEN)}${imagePath ? ' with image' : ''}`);

    if (!imagePath) {
        // Send text message
        const payload = JSON.stringify({ chat_id: String(CHAT_ID), text, parse_mode: 'Markdown' });
        return new Promise((resolve, reject) => {
            const options = {
                hostname: 'api.telegram.org',
                path: `/bot${safeToken}/sendMessage`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
                timeout: 10000
            };
            const req = https.request(options, res => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 400) {
                        const err = new Error(`Request Failed. Status Code: ${res.statusCode}`);
                        err.raw = body;
                        return reject(err);
                    }
                    try { resolve(JSON.parse(body)); }
                    catch (e) { e.raw = body; reject(e); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('request timeout')));
            req.write(payload);
            req.end();
        });
    } else {
        // Send photo
        return new Promise((resolve, reject) => {
            if (!fs.existsSync(imagePath)) {
                return reject(new Error(`Image file not found: ${imagePath}`));
            }

            const boundary = '--------------------------' + Date.now().toString(16);
            const options = {
                hostname: 'api.telegram.org',
                path: `/bot${safeToken}/sendPhoto`,
                method: 'POST',
                headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
                timeout: 30000
            };

            const req = https.request(options, res => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode >= 400) {
                        const err = new Error(`Request Failed. Status Code: ${res.statusCode}`);
                        err.raw = body;
                        return reject(err);
                    }
                    try { resolve(JSON.parse(body)); }
                    catch (e) { e.raw = body; reject(e); }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('request timeout')));

            const CRLF = '\r\n';
            function addField(name, value) {
                req.write(`--${boundary}${CRLF}`);
                req.write(`Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}`);
                req.write(`${value}${CRLF}`);
            }

            addField('chat_id', String(CHAT_ID));
            if (text) {
                addField('caption', text);
                addField('parse_mode', 'Markdown');
            }

            const filename = path.basename(imagePath);
            req.write(`--${boundary}${CRLF}`);
            req.write(`Content-Disposition: form-data; name="photo"; filename="${filename}"${CRLF}`);
            const mimeType = 'image/png';
            req.write(`Content-Type: ${mimeType}${CRLF}${CRLF}`);

            const fileStream = fs.createReadStream(imagePath);
            fileStream.on('error', readErr => {
                req.destroy(readErr);
                // reject(readErr) is not needed because req.destroy will emit 'error'
            });

            fileStream.pipe(req, { end: false });
            fileStream.on('end', () => {
                req.write(`${CRLF}--${boundary}--${CRLF}`);
                req.end();
            });
        });
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
            try { await sendTelegramHttps(`❗ safeGoto failed (${resolvedUrl}) attempt ${attempt}: ${err && err.name ? err.name : String(err)} ${err && err.code ? '(' + err.code + ')' : ''}`); } catch (e) { console.error('notify failed', e && e.stack ? e.stack : e); }
            if (attempt > retries) throw new Error(`safeGoto failed after ${attempt} attempts for ${resolvedUrl}: ${err && err.message ? err.message : String(err)}`);
            await sleep(1000 * attempt);
        }
    }
}

module.exports = {
    sendTelegramHttps,
    saveCookies,
    loadCookies,
    saveLocalStorage,
    loadLocalStorage,
    safeGoto,
    sleep,
    maskToken
};
