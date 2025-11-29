const playwright = require('playwright');
const { safeGoto, loadCookies, loadLocalStorage } = require('./utils');

async function inspect(url, selector) {
    const browser = await playwright.chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
        await loadCookies(context).catch(err => console.warn('Failed to load cookies during inspect', err));
        await loadLocalStorage(page, url).catch(err => console.warn('Failed to load local storage during inspect', err));

        await safeGoto(page, url, { waitUntil: 'load', timeout: 30000 });
        const elements = await page.locator(selector).all();
        const count = elements.length;
        const innerTexts = await Promise.all(elements.map(el => el.innerText()));

        return {
            count,
            innerTexts
        };
    } finally {
        await browser.close();
    }
}

module.exports = {
    inspect
};
