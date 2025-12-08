import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { safeGoto, loadCookies, loadLocalStorage } from './utils';

interface InspectElementData {
  innerText: string;
  id: string;
  className: string;
  attributes: Record<string, string>;
  selectorPath: string;
}

interface InspectResult {
  count: number;
  elements: InspectElementData[];
  screenshotPath: string;
  warnings: string[];
}

async function inspect(
  url: string,
  selector: string,
  options: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' } = {},
): Promise<InspectResult> {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  let screenshotPath: string | null = null;
  const warnings: string[] = [];

  try {
    await loadCookies(context).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to load cookies: ${message}`);
    });
    await loadLocalStorage(page, url).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to load local storage: ${message}`);
    });

    const { waitUntil = 'load' } = options;
    await safeGoto(page, url, { waitUntil, timeout: 30000 });

    const screenshotDir = path.join(process.cwd(), 'screenshot');
    await fs.mkdir(screenshotDir, { recursive: true });

    screenshotPath = path.join(screenshotDir, `inspect-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const parts = selector.split('>>').map((s) => s.trim());
    let locator = null as ReturnType<typeof page.locator> | null;
    let isFirst = true;

    for (const part of parts) {
      const locatorMatch = part.match(/^locator\((.*)\)$/i);
      const nthMatch = part.match(/^nth\((\d+)\)$/i);

      if (locatorMatch) {
        let selectorArg = locatorMatch[1].trim();
        if (
          (selectorArg.startsWith("'") && selectorArg.endsWith("'")) ||
          (selectorArg.startsWith('"') && selectorArg.endsWith('"'))
        ) {
          selectorArg = selectorArg.slice(1, -1);
        }

        if (isFirst) {
          locator = page.locator(selectorArg);
          isFirst = false;
        } else {
          if (!locator) throw new Error('Invalid selector chain: cannot call locator here.');
          locator = locator.locator(selectorArg);
        }
      } else if (nthMatch) {
        if (!locator) throw new Error("Invalid selector chain: 'nth' must be preceded by a locator.");
        const index = parseInt(nthMatch[1], 10);
        locator = locator.nth(index);
      } else {
        if (isFirst) {
          locator = page.locator(part);
          isFirst = false;
        } else {
          if (!locator) throw new Error('Invalid selector chain.');
          locator = locator.locator(part);
        }
      }
    }

    if (!locator) {
      throw new Error('Invalid selector provided.');
    }

    const elements = await locator.all();

    const elementsData: InspectElementData[] = await Promise.all(
      elements.map((el) =>
        el.evaluate((element) => {
          const node = element as HTMLElement;
          const attributes: Record<string, string> = {};
          for (const attr of node.attributes) {
            attributes[attr.name] = attr.value;
          }

          const buildSelectorPart = (target: Element): string => {
            const tag = target.tagName.toLowerCase();
            const id = target.id ? `#${target.id}` : '';
            const classes = target.classList.length > 0 ? `.${Array.from(target.classList).join('.')}` : '';

            if (id) return `${tag}${id}${classes}`;

            const siblings = target.parentElement
              ? Array.from(target.parentElement.children).filter((child) => child.tagName === target.tagName)
              : [];
            const nthIndex = siblings.indexOf(target);
            const nth = nthIndex >= 0 ? `:nth-of-type(${nthIndex + 1})` : '';
            return `${tag}${classes}${nth}`;
          };

          const buildSelectorPath = (target: Element): string => {
            const parts: string[] = [];
            let current: Element | null = target;

            while (current && current.tagName.toLowerCase() !== 'html') {
              parts.unshift(buildSelectorPart(current));
              current = current.parentElement;
            }

            return parts.join(' > ');
          };

          return {
            innerText: (node.innerText || '').toString(),
            id: node.id,
            className: node.className,
            attributes,
            selectorPath: buildSelectorPath(node),
          };
        }),
      ),
    );

    return {
      count: elements.length,
      elements: elementsData,
      screenshotPath: screenshotPath || '',
      warnings,
    };
  } finally {
    await browser.close();
  }
}

export { inspect, InspectResult };
