import path from 'path';
import fs from 'fs/promises';
import type { BrowserContext } from 'playwright';
import type { PlaywrightRunArgs } from '../types';
import { httpGet } from '../modules/http_client';
import { parseCurrentPointHtml } from '../modules/html_parser';
import * as logger from '../services/logger';

const POINT_PAGE_URL = 'https://www.doctorville.co.kr/my/point/pointUseHistoryList';
const MAIN_PAGE = 'https://www.doctorville.co.kr/main';

async function getPoint(_context?: BrowserContext): Promise<string> {
  try {
    const res = await httpGet(MAIN_PAGE);
    if (res.status === 200 && res.body) {
      return parseCurrentPointHtml(res.body);
    }
    return '조회 실패';
  } catch (error) {
    logger.error(
      'getPoint error',
      error && typeof error === 'object' && 'stack' in error ? (error as Error).stack : error,
    );
    return '조회 실패';
  }
}

async function run({ page, context }: PlaywrightRunArgs) {
  let screenshotPath: string | null = null;
  const ctx = context || page?.context();
  try {
    const pointText = await getPoint(ctx);

    if (pointText === '조회 실패') {
      if (page) {
        const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
        await fs.mkdir(baseScreenshotDir, { recursive: true });
        screenshotPath = path.join(baseScreenshotDir, `check_point_failed.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
      }
      return {
        success: false,
        message: '포인트를 조회할 수 없습니다. 로그인 상태를 확인해주세요.',
        imagePath: screenshotPath,
      };
    }

    return {
      success: true,
      message: `현재 포인트: ${pointText}\n${POINT_PAGE_URL}`,
    };
  } catch (error) {
    logger.error(
      'check_point task error',
      error && typeof error === 'object' && 'stack' in error ? (error as Error).stack : error,
    );
    if (!screenshotPath && page) {
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
