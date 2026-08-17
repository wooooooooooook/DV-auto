import assert from 'node:assert';
import { chromium, type Page, type BrowserContext } from 'playwright';
import path from 'node:path';
import { collectTodaySeminarMessage } from '../src/tasks/today_links';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'seminar_main.html');
const FIXTURE_URL = `file://${FIXTURE_PATH}`;

async function runTests() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const testCases = [
    { dateInput: '2026-08-18', expectedLunch: 3, expectedDinner: 5 },
    { dateInput: '8/19', expectedLunch: 4, expectedDinner: 4 },
    { dateInput: '2026-08-20', expectedLunch: 2, expectedDinner: 3 },
    { dateInput: '8/21', expectedLunch: 2, expectedDinner: 1 },
    { dateInput: '8/28', expectedLunch: 1, expectedDinner: 0 },
    { dateInput: '9/1', expectedLunch: 1, expectedDinner: 0 },
    { dateInput: '9/2', expectedLunch: 0, expectedDinner: 1 },
    { dateInput: '2026-08-16', expectedLunch: 0, expectedDinner: 0 },
  ];

  for (const tc of testCases) {
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    const result = await collectTodaySeminarMessage(page as any, tc.dateInput);
    console.log(`[${tc.dateInput}] lunch=${result.lunchSeminarIds.length}, dinner=${result.dinnerSeminarIds.length}`);
    assert.strictEqual(result.lunchSeminarIds.length, tc.expectedLunch, 'Lunch count mismatch');
    assert.strictEqual(result.dinnerSeminarIds.length, tc.expectedDinner, 'Dinner count mismatch');
    if (tc.expectedLunch > 0 || tc.expectedDinner > 0) {
      assert.ok(result.message.includes('세미나 리스트:'), 'Message should contain list');
    } else {
      assert.ok(result.message.includes('세미나가 없습니다'), 'Message should indicate none');
    }
  }

  // Edge case formats for 8/18
  const dateFormats = ['8/18', '08/18', '8.18', '8월 18일', '2026.08.18', '2026-08-18', '8/18 (화)', '8/18화요일'];
  for (const fmt of dateFormats) {
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
    const res = await collectTodaySeminarMessage(page as any, fmt);
    assert.strictEqual(res.lunchSeminarIds.length, 3, `(${fmt}) lunch`);
    assert.strictEqual(res.dinnerSeminarIds.length, 5, `(${fmt}) dinner`);
  }

  // Specific IDs check
  await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
  const idsRes = await collectTodaySeminarMessage(page as any, '2026-08-18');
  assert.deepStrictEqual(idsRes.lunchSeminarIds, ['5552', '5553', '5567']);
  assert.deepStrictEqual(idsRes.dinnerSeminarIds, ['5555', '5561', '5568', '5560', '5488']);

  console.log('All E2E checks passed');
  await browser.close();
}

runTests().catch((e) => {
  console.error('E2E test failed', e);
  process.exit(1);
});
