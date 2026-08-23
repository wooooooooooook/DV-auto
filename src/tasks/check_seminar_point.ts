import { sendTelegram } from '../modules/utils';
import type { BrowserContext, Page } from 'playwright';
import type { PlaywrightRunArgs } from '../types';
import { httpPostForm } from '../modules/http_client';
import { parseRecentSeminarPointRowsHtml } from '../modules/html_parser';
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

/**
 * 하위 호환성을 위해 유지 (HTML String Parser로 연결)
 */
export async function parseRecentSeminarPointRows(page: Page): Promise<Map<string, SeminarPointResult>> {
  try {
    const html = await page.content();
    return parseRecentSeminarPointRowsHtml(html);
  } catch (_e) {
    return new Map();
  }
}

export interface SearchSeminarPointsResult {
  success: boolean;
  points: Map<string, SeminarPointResult>;
  error?: string;
}

/**
 * 포인트 지급내역 테이블을 HTTP POST로 조회하고 파싱하여 매칭한다.
 * BrowserContext/Page 의존성 없이 HTTP Client로 처리 가능.
 */
export async function searchSeminarPoints(
  _context?: BrowserContext,
  seminarIds: string[] = [],
  daysBack = 30,
): Promise<SearchSeminarPointsResult> {
  const results = new Map<string, SeminarPointResult>();

  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);
    const formatDate = (d: Date) => d.toISOString().split('T')[0];

    const formData = {
      startDt: formatDate(startDate),
      endDt: formatDate(endDate),
      keyword: '',
      item: '',
    };

    const res = await httpPostForm(POINT_HISTORY_URL, formData);
    if (res.resultType === 'AUTH_EXPIRED') {
      await sendTelegram('🔒 세션이 만료되었습니다. 로그인이 필요합니다.').catch(() => {});
      return { success: false, points: results, error: 'AUTH_EXPIRED' };
    }
    if (res.status !== 200 || !res.body) {
      return { success: false, points: results, error: `HTTP Status ${res.status}` };
    }

    const parsed = parseRecentSeminarPointRowsHtml(res.body);
    for (const [seminarId, result] of parsed) {
      results.set(seminarId, result);
    }
    for (const seminarId of seminarIds) {
      if (!results.has(seminarId)) results.set(seminarId, { found: false });
    }
    logger.info(`parsed recent seminar point rows (HTTP): ${parsed.size}, total returned: ${results.size}`);
    return { success: true, points: results };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('searchSeminarPoints error', error);
    return { success: false, points: results, error: errorMsg };
  }
}

export async function run(
  { context }: PlaywrightRunArgs,
  seminarId: string,
): Promise<{ success: boolean; message: string; pointResult?: SeminarPointResult }> {
  if (!seminarId) return { success: false, message: '세미나 번호가 필요합니다.' };
  try {
    const searchRes = await searchSeminarPoints(context, [seminarId], 60);
    if (!searchRes.success) {
      return { success: false, message: `세미나 포인트 조회 중 오류: ${searchRes.error || '조회 실패'}` };
    }
    const result = searchRes.points.get(seminarId);
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
