import path from 'path';
import fs from 'fs/promises';
import type { BrowserContext, Page } from 'playwright';
import type { PlaywrightRunArgs } from '../types';
import { safeGoto } from '../modules/utils';
import * as logger from '../services/logger';

async function getPoint(context: BrowserContext): Promise<string> {
  const page = await context.newPage();
  try {
    const MAIN_PAGE = 'https://www.doctorville.co.kr/main';
    await safeGoto(page, MAIN_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);
    await page.waitForSelector('.member_point', { timeout: 10000 });
    const pointElement = page.locator('.member_point');
    return (await pointElement.innerText()).trim();
  } catch (error) {
    logger.error(
      'getPoint error',
      error && typeof error === 'object' && 'stack' in error ? (error as Error).stack : error,
    );
    return '조회 실패';
  } finally {
    await page.close().catch(() => {});
  }
}

async function run({ page, context }: PlaywrightRunArgs) {
  let screenshotPath: string | null = null;
  const ctx = context || page.context();
  try {
    const pointText = await getPoint(ctx);

    if (pointText === '조회 실패') {
      const MAIN_PAGE = 'https://www.doctorville.co.kr/main';
      await safeGoto(page, MAIN_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);
      const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
      await fs.mkdir(baseScreenshotDir, { recursive: true });
      screenshotPath = path.join(baseScreenshotDir, `check_point_failed.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
      return {
        success: false,
        message: '포인트를 조회할 수 없습니다. 로그인 상태를 확인해주세요.',
        imagePath: screenshotPath,
      };
    }

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

export { run, getPoint };
