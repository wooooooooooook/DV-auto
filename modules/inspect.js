const playwright = require('playwright');
const fs = require('fs/promises');
const path = require('path');
const { safeGoto, loadCookies, loadLocalStorage } = require('./utils');

async function inspect(url, selector) {
    const browser = await playwright.chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    let screenshotPath = null;
    const warnings = [];

    try {
        await loadCookies(context).catch(err => warnings.push(`Failed to load cookies: ${err.message}`));
        await loadLocalStorage(page, url).catch(err => warnings.push(`Failed to load local storage: ${err.message}`));

        await safeGoto(page, url, { waitUntil: 'load', timeout: 30000 });

        const screenshotDir = path.join(__dirname, '..', 'screenshot');
        await fs.mkdir(screenshotDir, { recursive: true });

        screenshotPath = path.join(screenshotDir, `inspect-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });

        const parts = selector.split('>>').map(s => s.trim());
        let locator = page.locator(parts[0]);
        for (let i = 1; i < parts.length; i++) {
            locator = locator.locator(parts[i]);
        }
        const elements = await locator.all();

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
            screenshotPath: screenshotPath,
            warnings: warnings
        };
    } finally {
        await browser.close();
    }
}

module.exports = {
    inspect
};
