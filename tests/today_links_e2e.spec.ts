import { test, expect } from '@playwright/test';
import path from 'node:path';
import { collectTodaySeminarMessage } from '../src/tasks/today_links';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'seminar_main.html');
const FIXTURE_URL = `file://${FIXTURE_PATH}`;

test.describe('today_links E2E: collectTodaySeminarMessage with real browser context', () => {
  test('collectTodaySeminarMessage parses seminars correctly via evaluateAll', async ({ page }) => {
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });

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

      const result = await collectTodaySeminarMessage(
        page as unknown as Parameters<typeof collectTodaySeminarMessage>[0],
        tc.dateInput,
      );

      console.log(
        `[${tc.dateInput}] lunch: ${result.lunchSeminarIds.length}, dinner: ${result.dinnerSeminarIds.length}`,
      );

      expect(result.lunchSeminarIds.length).toBe(tc.expectedLunch);
      expect(result.dinnerSeminarIds.length).toBe(tc.expectedDinner);

      if (tc.expectedLunch > 0 || tc.expectedDinner > 0) {
        expect(result.message).toContain('세미나 리스트:');
        expect(result.message).toContain('[점심 세미나]');
        if (tc.expectedDinner > 0) {
          expect(result.message).toContain('[저녁 세미나]');
        }
      } else {
        expect(result.message).toContain('세미나가 없습니다');
      }
    }
  });

  test('collectTodaySeminarMessage handles date matching edge cases', async ({ page }) => {
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });

    const dateFormats = ['8/18', '08/18', '8.18', '8월 18일', '2026.08.18', '2026-08-18', '8/18 (화)', '8/18화요일'];

    for (const fmt of dateFormats) {
      await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });
      const result = await collectTodaySeminarMessage(
        page as unknown as Parameters<typeof collectTodaySeminarMessage>[0],
        fmt,
      );
      expect(result.lunchSeminarIds.length).toBe(3);
      expect(result.dinnerSeminarIds.length).toBe(5);
    }
  });

  test('collectTodaySeminarMessage extracts correct seminar IDs', async ({ page }) => {
    await page.goto(FIXTURE_URL, { waitUntil: 'domcontentloaded' });

    const result = await collectTodaySeminarMessage(
      page as unknown as Parameters<typeof collectTodaySeminarMessage>[0],
      '2026-08-18',
    );

    expect(result.lunchSeminarIds).toEqual(['5552', '5553', '5567']);
    expect(result.dinnerSeminarIds).toEqual(['5555', '5561', '5568', '5560', '5488']);
  });
});
