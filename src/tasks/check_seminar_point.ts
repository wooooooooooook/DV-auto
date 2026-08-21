import type { BrowserContext, Page } from 'playwright';
import type { PlaywrightRunArgs } from '../types';
import { safeGoto } from '../modules/utils';
import * as logger from '../services/logger';

const POINT_HISTORY_URL = 'https://www.doctorville.co.kr/my/point/pointUseHistoryList';

export interface SeminarPointResult {
  found: boolean;
  point?: number;
  pointText?: string;
  date?: string;
  service?: string;
  content?: string;
  type?: '적립' | '사용';
  expiry?: string;
}

/** 전체 테이블 파싱 결과도 함께 반환하기 위한 타입 */
export interface ParsedPointTable {
  results: Map<string, SeminarPointResult>;
  allParsed: Map<string, SeminarPointResult>;
}

async function parseRecentSeminarPointRows(page: Page): Promise<Map<string, SeminarPointResult>> {
  const results = new Map<string, SeminarPointResult>();
  const rows = await page.evaluate(() => {
    const selectors = ['#useList table tbody tr', 'table tbody tr'];
    for (const selector of selectors) {
      const found = Array.from(document.querySelectorAll(selector));
      if (found.length > 0) {
        return found.map((row) =>
          Array.from(row.querySelectorAll('td')).map((cell) => (cell.textContent || '').replace(/\s+/g, ' ').trim()),
        );
      }
    }
    return [] as string[][];
  });

  for (const cells of rows) {
    if (cells.length < 5) continue;
    const date = cells[0] || '';
    const service = cells[1] || '';
    const content = cells[2] || '';
    const type = cells[3] || '';
    const pointText = cells[4] || '';
    const expiry = cells[5] || '';
    if (type !== '적립') continue;

    const idMatch = content.match(/설문\s*포인트\s*(\d+)/);
    if (!idMatch) continue;
    const seminarId = idMatch[1];
    const pointMatch = pointText.match(/[+]?\s*([\d,]+)\s*P/i);
    const point = pointMatch ? parseInt(pointMatch[1].replace(/,/g, ''), 10) : undefined;

    if (!results.has(seminarId)) {
      results.set(seminarId, { found: true, point, pointText, date, service, content, type: '적립', expiry });
    }
  }
  return results;
}

/**
 * 포인트 지급내역 테이블을 파싱한다.
 * - requestedIds가 주어지면 해당 ID만 필터링한 results 반환
 * - allParsed에는 테이블에서 파싱된 모든 적립 내역이 들어옴
 */
export async function searchSeminarPoints(
  context: BrowserContext,
  seminarIds: string[],
  daysBack = 30,
): Promise<ParsedPointTable> {
  const page = await context.newPage();
  const requested = new Set(seminarIds);
  const results = new Map<string, SeminarPointResult>();

  try {
    await safeGoto(page, POINT_HISTORY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }, 1);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);
    const formatDate = (d: Date) => d.toISOString().split('T')[0];

    await page.fill('input[name="startDt"], input#startDt', formatDate(startDate)).catch(() => {});
    await page.fill('input[name="endDt"], input#endDt', formatDate(endDate)).catch(() => {});
    await page.fill('input[name="keyword"], input#keyword', '').catch(() => {});
    await page.click('button[type="submit"], input[type="submit"], button:has-text("검색")').catch(async () => {
      await page.keyboard.press('Enter').catch(() => {});
    });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);

    const allParsed = await parseRecentSeminarPointRows(page);

    for (const [seminarId, result] of allParsed) {
      if (requested.has(seminarId)) results.set(seminarId, result);
    }
    for (const seminarId of seminarIds) {
      if (!results.has(seminarId)) results.set(seminarId, { found: false });
    }
    logger.info(`parsed recent seminar point rows: ${allParsed.size}, matched: ${results.size}`);
    return { results, allParsed };
  } catch (error) {
    logger.error('searchSeminarPoints error', error);
    return { results, allParsed: new Map() };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function run(
  { context }: PlaywrightRunArgs,
  seminarId: string,
): Promise<{ success: boolean; message: string; pointResult?: SeminarPointResult }> {
  if (!seminarId) return { success: false, message: '세미나 번호가 필요합니다.' };
  try {
    const { results } = await searchSeminarPoints(context, [seminarId], 60);
    const result = results.get(seminarId);
    if (result?.found) {
      return {
        success: true,
        message: `세미나 ${seminarId} 포인트 지급됨: ${result.pointText} (${result.date} / ${result.content})`,
        pointResult: result,
      };
    }
    return {
      success: true,
      message: `세미나 ${seminarId} 포인트 내역을 찾을 수 없습니다 (최근 60일간).`,
      pointResult: result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('check_seminar_point task error', error);
    return { success: false, message: `세미나 포인트 조회 중 오류: ${message}` };
  }
}
