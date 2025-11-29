const playwright = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const { safeGoto, loadCookies, loadLocalStorage } = require('./utils');

async function inspect(url, selector) {
    const browser = await playwright.chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    let screenshotPath = null;

    try {
        await loadCookies(context).catch(err => console.warn('Failed to load cookies during inspect', err));
        await loadLocalStorage(page, url).catch(err => console.warn('Failed to load local storage during inspect', err));

        await safeGoto(page, url, { waitUntil: 'load', timeout: 30000 });

        const screenshotDir = path.join(__dirname, '..', 'screenshot');
        await fs.mkdir(screenshotDir, { recursive: true });

        screenshotPath = path.join(screenshotDir, `inspect-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true });

        const elements = await page.locator(selector).all();

        const elementsData = await Promise.all(elements.map(el => {
            return el.evaluate(element => {
                const attributes = {};
                for (const attr of element.attributes) {
                    attributes[attr.name] = attr.value;
                }
                return {
                    innerText: element.innerText,
                    id: element.id,
                    className: element.className,
                    attributes: attributes
                };
            });
        }));

        return {
            count: elements.length,
            elements: elementsData,
            screenshotPath: screenshotPath
        };
    } finally {
        await browser.close();
    }
}

module.exports = {
    inspect
};
