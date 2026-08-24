import { sendTelegram } from '../modules/utils';
import type { TaskContext, TaskResult } from '../types';
import { httpGetJson, httpPostForm, sendDoctorVilleRequest } from '../modules/http_client';
import { parseRecentSeminarPointRowsHtml } from '../modules/html_parser';
import * as logger from '../services/logger';

const POINT_HISTORY_API = 'https://m-api.doctorville.co.kr/api/mw/my/point/histories/use';
const POINT_HISTORY_PC_URL = 'https://www.doctorville.co.kr/my/point/pointUseHistoryList';

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

interface PointHistoryItem {
  seq: number;
  usn: number;
  point: number;
  pathSeq: number | string;
  pathNm: string;
  regDt: string;
  pointUseTypeNm: string;
  pointUseServiceNm: string;
}

interface PointHistoriesApiResponse {
  list?: {
    items?: PointHistoryItem[];
    totalCount?: number;
  };
}

/**
 * 하위 호환성을 위해 유지 (HTML String Parser로 연결)
 */
export async function parseRecentSeminarPointRows(page?: {
  content: () => Promise<string>;
}): Promise<Map<string, SeminarPointResult>> {
  try {
    if (!page || typeof page.content !== 'function') return new Map();
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

function formatYYMMDD(d: Date): string {
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/**
 * 포인트 지급내역을 모바일 JSON API(우선) 및 PC Form(폴백)으로 조회하여 세미나 포인트 매칭.
 */
export async function searchSeminarPoints(
  _context?: unknown,
  seminarIds: string[] = [],
  daysBack = 30,
): Promise<SearchSeminarPointsResult> {
  const results = new Map<string, SeminarPointResult>();

  try {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - daysBack);

    const startDt = formatYYMMDD(startDate);
    const endDt = formatYYMMDD(endDate);

    const apiUrl = `${POINT_HISTORY_API}?page=1&pageSize=100&startDt=${startDt}&endDt=${endDt}`;
    const apiRes = await sendDoctorVilleRequest(apiUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json, text/plain, */*',
      },
    });

    if (apiRes.resultType === 'AUTH_EXPIRED') {
      await sendTelegram('🔒 세션이 만료되었습니다. 로그인이 필요합니다.').catch(() => {});
      return { success: false, points: results, error: 'AUTH_EXPIRED' };
    }

    if (apiRes.status === 200 && apiRes.body) {
      try {
        const parsedJson: PointHistoriesApiResponse = JSON.parse(apiRes.body);
        const items = parsedJson.list?.items || [];

        for (const item of items) {
          if (item.pointUseTypeNm !== '적립') continue;
          const pathNm = item.pathNm || '';
          const pathSeqStr = String(item.pathSeq || '');

          // 1) 심층설문 관리자 적립: '8/14 설문 포인트 5544'
          const adminMatch = pathNm.match(/설문\s*포인트\s*(\d+)/);
          if (adminMatch) {
            const id = adminMatch[1];
            if (!results.has(id)) {
              results.set(id, {
                found: true,
                point: item.point,
                pointText: `${Number(item.point).toLocaleString()}P`,
                date: item.regDt,
                service: item.pointUseServiceNm || '닥터빌',
                content: item.pathNm,
                type: '적립',
              });
            }
          }

          // 2) 라이브세미나 설문 적립: pathSeq 끝에 seminarId 포함
          if (item.pointUseServiceNm === '라이브세미나' || pathNm.includes('세미나')) {
            for (const id of seminarIds) {
              if (pathSeqStr.endsWith(id) && !results.has(id)) {
                results.set(id, {
                  found: true,
                  point: item.point,
                  pointText: `${Number(item.point).toLocaleString()}P`,
                  date: item.regDt,
                  service: item.pointUseServiceNm || '라이브세미나',
                  content: item.pathNm,
                  type: '적립',
                });
              }
            }
          }
        }

        for (const seminarId of seminarIds) {
          if (!results.has(seminarId)) results.set(seminarId, { found: false });
        }

        logger.info(`parsed recent seminar point rows (JSON API): items ${items.length}, matched: ${results.size}`);
        return { success: true, points: results };
      } catch (jsonErr) {
        logger.warn('searchSeminarPoints JSON API parse error, falling back to HTML form:', jsonErr);
      }
    }

    // JSON API 실패 시 PC Web 폼 폴백
    const formatDateFull = (d: Date) => d.toISOString().split('T')[0];
    const formData = {
      startDt: formatDateFull(startDate),
      endDt: formatDateFull(endDate),
      keyword: '',
      item: '',
    };

    const pcRes = await httpPostForm(POINT_HISTORY_PC_URL, formData);
    if (pcRes.resultType === 'AUTH_EXPIRED') {
      await sendTelegram('🔒 세션이 만료되었습니다. 로그인이 필요합니다.').catch(() => {});
      return { success: false, points: results, error: 'AUTH_EXPIRED' };
    }
    if (pcRes.status !== 200 || !pcRes.body) {
      return { success: false, points: results, error: `HTTP Status ${pcRes.status}` };
    }

    const parsed = parseRecentSeminarPointRowsHtml(pcRes.body);
    for (const [seminarId, result] of parsed) {
      results.set(seminarId, result);
    }
    for (const seminarId of seminarIds) {
      if (!results.has(seminarId)) results.set(seminarId, { found: false });
    }
    logger.info(`parsed recent seminar point rows (PC Form fallback): ${parsed.size}, total: ${results.size}`);
    return { success: true, points: results };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('searchSeminarPoints error', error);
    return { success: false, points: results, error: errorMsg };
  }
}

export async function run(
  ctxOrId?: TaskContext | string,
  seminarIdArg?: string,
): Promise<TaskResult & { pointResult?: SeminarPointResult }> {
  let seminarId = '';
  if (typeof ctxOrId === 'string') {
    seminarId = ctxOrId;
  } else if (ctxOrId && typeof ctxOrId === 'object') {
    seminarId = ctxOrId.args?.seminarId || seminarIdArg || '';
  } else if (seminarIdArg) {
    seminarId = seminarIdArg;
  }

  if (!seminarId) return { success: false, message: '세미나 번호가 필요합니다.' };
  try {
    const searchRes = await searchSeminarPoints(undefined, [seminarId], 60);
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
