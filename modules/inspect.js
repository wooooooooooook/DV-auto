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
        let locator;
        let isFirst = true;

        for (const part of parts) {
            const locatorMatch = part.match(/^locator\((.*)\)$/i);
            const nthMatch = part.match(/^nth\((\d+)\)$/i);

            if (locatorMatch) {
                let selectorArg = locatorMatch[1].trim();
                if ((selectorArg.startsWith("'") && selectorArg.endsWith("'")) || (selectorArg.startsWith('"') && selectorArg.endsWith('"'))) {
                    selectorArg = selectorArg.slice(1, -1);
                }

                if (isFirst) {
                    locator = page.locator(selectorArg);
                    isFirst = false;
                } else {
                    if (!locator) throw new Error("Invalid selector chain: cannot call locator here.");
                    locator = locator.locator(selectorArg);
                }
            } else if (nthMatch) {
                if (!locator) throw new Error("Invalid selector chain: 'nth' must be preceded by a locator.");
                const index = parseInt(nthMatch[1], 10);
                locator = locator.nth(index);
            } else {
                // Fallback for old syntax without locator() or nth()
                if (isFirst) {
                    locator = page.locator(part);
                    isFirst = false;
                } else {
                    if (!locator) throw new Error("Invalid selector chain.");
                    locator = locator.locator(part);
                }
            }
        }

        if (!locator) {
            throw new Error("Invalid selector provided.");
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
