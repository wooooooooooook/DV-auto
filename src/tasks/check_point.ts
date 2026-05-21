import path from 'path';
import fs from 'fs/promises';
import type { PlaywrightRunArgs } from '../types';
import { safeGoto } from '../modules/utils';
import * as logger from '../services/logger';

async function run({ page }: PlaywrightRunArgs) {
  let screenshotPath: string | null = null;
  try {
    const MAIN_PAGE = 'https://www.doctorville.co.kr/main';
    await safeGoto(page, MAIN_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

    // Wait for the member_point element or at least some content to be loaded
    try {
      await page.waitForSelector('.member_point', { timeout: 10000 });
    } catch (e) {
      logger.warn('Failed to find .member_point within timeout, taking screenshot for debugging.');
      const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
      await fs.mkdir(baseScreenshotDir, { recursive: true });
      screenshotPath = path.join(baseScreenshotDir, `check_point_not_found.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      return {
        success: false,
        message: '포인트 요소를 찾을 수 없습니다. 로그인 상태를 확인해주세요.',
        imagePath: screenshotPath,
      };
    }

    const pointElement = page.locator('.member_point');
    const pointText = (await pointElement.innerText()).trim();

    return {
      success: true,
      message: `현재 포인트: ${pointText}`,
    };
  } catch (error) {
    logger.error(
      'check_point task error',
      error && typeof error === 'object' && 'stack' in error ? (error as Error).stack : error,
    );
    if (!screenshotPath) {
      const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
      await fs.mkdir(baseScreenshotDir, { recursive: true });
      screenshotPath = path.join(baseScreenshotDir, `check_point_error.png`);
      await page
        .screenshot({ path: screenshotPath, fullPage: false })
        .catch((err: unknown) => logger.error('Failed to capture error screenshot:', err));
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `포인트 조회 중 오류 발생: ${message}`,
      imagePath: screenshotPath,
    };
  }
}

export { run };
