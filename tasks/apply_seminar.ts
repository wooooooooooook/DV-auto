import path from 'path';
import fs from 'fs/promises';
import type { PlaywrightRunArgs } from '../types';
import { safeGoto, sendTelegram } from '../modules/utils';

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';

async function run({ page }: PlaywrightRunArgs) {
  let screenshotPath: string | null = null;
  try {
    await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

    const totalSeminarLinks = await page.locator('a.list_detail');
    // totalCount can be different from items.length if some seminars are not applyable
    const totalSeminarsAvailable = await totalSeminarLinks.count();
    console.log('Total seminar links found:', totalSeminarsAvailable);

    const applyLocator = page.locator('a:has(.ico_apply)');
    const items = await applyLocator.evaluateAll((nodes) =>
      nodes.map((n) => ({ href: n.getAttribute('href'), text: (n.textContent || '').trim() })),
    );
    const attemptedApplyCount = items.length;

    for (const item of items) {
      console.log('Applying for seminar:', item.text, item.href);
      await safeGoto(page, item.href, { waitUntil: 'load', timeout: 30000 }, 1);

      try {
        await page.click('a#applyLiveSeminarMemberBtn', { timeout: 5000 }).catch((_e) => {
          console.error('Error clicking apply button:', _e);
        });
      } catch (_e) {
        console.error('apply button click threw:', _e && _e.message ? _e.message : _e);
      }

      try {
        await page.waitForSelector('#seminarAgree', { timeout: 2000 });
        await page.click('#seminarAgree').catch((_e) => {
          console.error('Error clicking agree checkbox:', _e);
        });
      } catch (_e) {
        // Not present within 2s — continue without blocking
      }
      await page.waitForTimeout(500);
      console.log('success applied for seminar');
    }

    const appliedCount = await page.locator('a:has(.ico_completion)').count();
    let message = `✅ ${appliedCount}개 세미나 신청 완료! (${appliedCount}/${totalSeminarsAvailable})`;

    const failedToApplyCount = attemptedApplyCount - appliedCount;
    if (failedToApplyCount > 0) {
      message += `\n (${failedToApplyCount}개는 마감 등의 사유로 신청 실패)`;
    }

    const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
    await fs.mkdir(baseScreenshotDir, { recursive: true });
    screenshotPath = path.join(baseScreenshotDir, `apply_seminar_result.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    return { success: true, message: message, imagePath: screenshotPath };
  } catch (error) {
    console.error('seminar task error', error && typeof error === 'object' && 'stack' in error ? (error as Error).stack : error);
    if (!screenshotPath) {
      const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
      await fs.mkdir(baseScreenshotDir, { recursive: true });
      screenshotPath = path.join(baseScreenshotDir, `apply_seminar_error.png`);
      await page
        .screenshot({ path: screenshotPath, fullPage: false })
        .catch((err: unknown) => console.error('Failed to capture error screenshot:', err));
    }
    const message = error instanceof Error ? error.message : String(error);
    await sendTelegram(`❗ 세미나 신청 작업 오류: ${message}`, screenshotPath).catch(
      () => {},
    );
    return {
      success: false,
      message: `세미나 신청 작업 오류: ${message}`,
      imagePath: screenshotPath,
    };
  }
}

export { run };
