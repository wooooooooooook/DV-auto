import type { BrowserContext, Page } from 'playwright';
import type { PlaywrightRunArgs } from '../types';
import { safeGoto } from '../modules/utils';
import * as logger from '../services/logger';

const POINT_HISTORY_URL = 'https://www.doctorville.co.kr/my/point/pointUseHistoryList';

interface SeminarPointResult {
  found: boolean;
  point?: number;
  pointText?: string;
  date?: string;
  service?: string;
  content?: string;
  type?: '적립' | '사용';
  expiry?: string;
}

/**
 * 포인트 내역 페이지에서 단일 세미나 번호 검색 (페이지는 이미 로드되어 있다고 가정)
 * @param page 이미 포인트 내역 페이지에 있는 Page 객체
 * @param seminarId 세미나 번호
 * @param daysBack 검색 기간(일)
 */
async function searchSingleSeminarPoint(page: Page, seminarId: string, daysBack = 30): Promise<SeminarPointResult> {
  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    const formatDate = (d: Date) => d.toISOString().split('T')[0];

    // 검색 폼 채우기
    await page.fill('input[name="startDt"], input#startDt', formatDate(startDate));
    await page.fill('input[name="endDt"], input#endDt', formatDate(endDate));
    await page.fill('input[name="keyword"], input#keyword', seminarId);

    // 검색 버튼 클릭
    await page.click('button[type="submit"], input[type="submit"], button:has-text("검색")').catch(async () => {
      await page.keyboard.press('Enter');
    });

    // 결과 로딩 대기
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);

    // 테이블 파싱
    const result = await page.evaluate((targetSeminarId: string) => {
      const rows = document.querySelectorAll('#useList table tbody tr, table tbody tr');
      for (const row of rows) {
        const cells = row.querySelectorAll('td');
        if (cells.length < 6) continue;

        const date = cells[0]?.textContent?.trim() || '';
        const service = cells[1]?.textContent?.trim() || '';
        const content = cells[2]?.textContent?.trim() || '';
        const type = cells[3]?.textContent?.trim() || '';
        const pointText = cells[4]?.textContent?.trim() || '';
        const expiry = cells[5]?.textContent?.trim() || '';

        if (content.includes(targetSeminarId) || service.includes(targetSeminarId)) {
          const pointMatch = pointText.match(/([\d,]+)/);
          const point = pointMatch ? parseInt(pointMatch[1].replace(/,/g, ''), 10) : undefined;

          return {
            found: true,
            point,
            pointText,
            date,
            service,
            content,
            type: type as '적립' | '사용',
            expiry,
          };
        }
      }
      return { found: false };
    }, seminarId);

    return result;
  } catch (error) {
    logger.error(`searchSingleSeminarPoint error for ${seminarId}`, error);
    return { found: false };
  }
}

/**
 * 여러 세미나 번호 일괄 검색 (한 번 로그인/페이지 진입 후 반복 검색)
 * @param context 브라우저 컨텍스트
 * @param seminarIds 세미나 번호 배열
 * @param daysBack 검색 기간(일)
 */
export async function searchSeminarPoints(
  context: BrowserContext,
  seminarIds: string[],
  daysBack = 30,
): Promise<Map<string, SeminarPointResult>> {
  const page = await context.newPage();
  const results = new Map<string, SeminarPointResult>();

  try {
    // 1회만 페이지 이동 + 로그인 대기
    await safeGoto(page, POINT_HISTORY_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }, 1);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // 각 세미나 번호별 검색 반복
    for (const seminarId of seminarIds) {
      const result = await searchSingleSeminarPoint(page, seminarId, daysBack);
      results.set(seminarId, result);
    }

    return results;
  } catch (error) {
    logger.error('searchSeminarPoints error', error);
    return results;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * Task runner용 wrapper (단일/복수 모두 지원)
 */
export async function run(
  { context }: PlaywrightRunArgs,
  seminarId: string,
): Promise<{
  success: boolean;
  message: string;
  pointResult?: SeminarPointResult;
}> {
  if (!seminarId) {
    return { success: false, message: '세미나 번호가 필요합니다.' };
  }

  try {
    const results = await searchSeminarPoints(context, [seminarId], 60);
    const result = results.get(seminarId);

    if (result?.found) {
      const status = result.type === '적립' ? '지급됨' : '사용됨';
      return {
        success: true,
        message: `세미나 ${seminarId} 포인트 ${status}: ${result.pointText} (${result.date} / ${result.content})`,
        pointResult: result,
      };
    } else {
      return {
        success: true,
        message: `세미나 ${seminarId} 포인트 내역을 찾을 수 없습니다 (최근 60일간).`,
        pointResult: result,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('check_seminar_point task error', error);
    return {
      success: false,
      message: `세미나 포인트 조회 중 오류: ${message}`,
    };
  }
}
