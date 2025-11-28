const fs = require('fs');
const path = require('path');
const { sendNotificationToChannel, safeGoto } = require('../modules/utils');

const STORE_FILE = path.join(__dirname, '..', 'data', 'last_key_message.json');
const DEFAULT_URL = 'https://www.doctorville.co.kr/seminar/broadcastSeminarPopup?viewType=2&seminarId=4759';

function ensureDataDir() {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadLast() {
    try {
        if (!fs.existsSync(STORE_FILE)) return null;
        const raw = fs.readFileSync(STORE_FILE, 'utf8');
        return JSON.parse(raw).text || null;
    } catch (e) {
        return null;
    }
}

function saveLast(text) {
    try {
        ensureDataDir();
        fs.writeFileSync(STORE_FILE, JSON.stringify({ text, ts: Date.now() }, null, 2));
    } catch (e) {
        console.error('failed to save last key message', e && e.message ? e.message : e);
    }
}

/**
 * run monitor
 * options: { url, intervalMs, maxChecks }
 */
async function run({ page, context } = {}, options = {}) {
    const url = options.url || process.env.MONITOR_URL || DEFAULT_URL;
    const intervalMs = options.intervalMs || 30 * 1000; // default 30s
    const maxChecks = options.maxChecks || 0; // 0 = unlimited

    let last = loadLast();
    console.log('extract_key_messages: starting monitor for', url, 'lastLength=', last ? last.length : 0);

    let checks = 0;
    while (true) {
        checks++;
        try {
            await safeGoto(page, url, { waitUntil: 'domcontentloaded', timeout: 15000 }, 1);

            // grab content of .key_message .txt
            const text = await page.locator('.key_message .txt').evaluate(el => el ? el.innerText.trim() : '').catch(() => '');

            if (!text) {
                console.log('extract_key_messages: no text found on page');
            } else if (last === null) {
                // first time: save but don't notify
                last = text;
                saveLast(text);
                console.log('extract_key_messages: stored initial message (len=' + text.length + ')');
            } else if (text !== last) {
                console.log('extract_key_messages: change detected, sending notification');
                try {
                    await sendNotificationToChannel(`🔔 Key message changed:\n${text.substring(0, 800)}`);
                } catch (e) {
                    console.error('notify failed', e && e.stack ? e.stack : e);
                }
                last = text;
                saveLast(text);
            } else {
                // no change
            }
        } catch (e) {
            console.error('extract_key_messages: error during check', e && e.stack ? e.stack : e);
        }

        if (maxChecks > 0 && checks >= maxChecks) break;

        await new Promise(r => setTimeout(r, intervalMs));
    }

    return true;
}

module.exports = { run };
