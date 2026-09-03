import * as logger from './logger';
import * as seminarRepo from './seminar_repository';
import type { SeminarListItem } from './seminar_repository';
import { ProcessState, fetchSeminarDetail, checkIsPointExcluded, checkIsAdvancedSurvey } from '../modules/seminar_api';
import { getSeminarIdFromUrl } from '../modules/utils';

/**
 * 모든 세미나의 상세(detail) API를 조회하여 isPointExcluded 및 최신 메타데이터 갱신
 * - 과부하 방지를 위해 Concurrency 및 요청 간 delayMs 적용
 */
export async function enrichSeminarsWithDetail(
  seminars: SeminarListItem[],
  concurrency = 2,
  delayMs = 150,
): Promise<{ seminars: SeminarListItem[]; isAuthExpired: boolean }> {
  let isAuthExpired = false;
  const enriched: SeminarListItem[] = [];

  for (let i = 0; i < seminars.length; i += concurrency) {
    if (isAuthExpired) break;
    const chunk = seminars.slice(i, i + concurrency);

    const chunkResults = await Promise.all(
      chunk.map(async (item) => {
        if (isAuthExpired) return item;
        const seminarId = item.seminarId || getSeminarIdFromUrl(item.url);
        if (!seminarId) return item;

        try {
          const detailRes = await fetchSeminarDetail(seminarId);
          if (detailRes.isAuthExpired) {
            isAuthExpired = true;
            return item;
          }

          if (detailRes.success && detailRes.rawResponse?.seminarDetail) {
            const d = detailRes.rawResponse.seminarDetail;
            const isPointExcluded = detailRes.isPointExcluded ?? checkIsPointExcluded(d.intro);
            const isAdvancedSurvey = checkIsAdvancedSurvey(d.useDepthSurvey);
            const processStateNum = d.processState !== undefined ? Number(d.processState) : item.processState;
            const cancelProcessStateNum =
              d.cancelProcessState !== undefined ? Number(d.cancelProcessState) : item.cancelProcessState;
            const seminarCompletedNum =
              d.seminarCompleted !== undefined
                ? typeof d.seminarCompleted === 'boolean'
                  ? d.seminarCompleted
                    ? 1
                    : 0
                  : Number(d.seminarCompleted)
                : item.seminarCompleted;
            const hiddenYn = typeof d.hiddenYn === 'string' ? d.hiddenYn : item.hiddenYn;
            const isClosed = hiddenYn === 'Y' || hiddenYn === 'y' || item.isClosed;
            const diseaseCategoryNm =
              typeof d.diseaseCategoryNm === 'string' ? d.diseaseCategoryNm : item.diseaseCategoryNm;

            return {
              ...item,
              name: typeof d.seminarNm === 'string' && d.seminarNm ? d.seminarNm : item.name,
              currentCount: d.applyCnt !== undefined && d.applyCnt !== null ? String(d.applyCnt) : item.currentCount,
              totalCount:
                d.maxPeopleCnt !== undefined && d.maxPeopleCnt !== null ? String(d.maxPeopleCnt) : item.totalCount,
              isAdvancedSurvey,
              isPointExcluded,
              processState: processStateNum,
              cancelProcessState: cancelProcessStateNum,
              seminarCompleted: seminarCompletedNum,
              isClosed,
              hiddenYn,
              diseaseCategoryNm,
            };
          }
        } catch (err) {
          logger.warn(`enrichSeminarsWithDetail: ID ${seminarId} 상세 조회 실패`, err);
        }
        return item;
      }),
    );

    enriched.push(...chunkResults);

    if (i + concurrency < seminars.length && delayMs > 0 && !isAuthExpired) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (enriched.length < seminars.length) {
    enriched.push(...seminars.slice(enriched.length));
  }

  return { seminars: enriched, isAuthExpired };
}

/**
 * 세미나의 date/time 정보를 바탕으로 이미 종료 시각이 지났는지 판별합니다.
 * @param seminar 세미나 정보
 * @param referenceNowMs 기준 현재 시각 (기본값: Date.now())
 */
export function isPastSeminar(
  seminar: { date?: string | null; time?: string | null; detectedDate?: string | null },
  referenceNowMs = Date.now(),
): boolean {
  const dateStr = seminar.date || seminar.detectedDate;
  if (!dateStr) return false;

  // 1. 날짜 추출 (YYYY-MM-DD 우선, 없으면 M/D 형식)
  const isoMatch = dateStr.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  let year: number;
  let month: number;
  let day: number;

  if (isoMatch) {
    year = Number(isoMatch[1]);
    month = Number(isoMatch[2]);
    day = Number(isoMatch[3]);
  } else {
    // YYYY가 없는 경우 referenceNowMs의 연도 기준
    const nowKst = new Date(referenceNowMs + 9 * 60 * 60 * 1000);
    const mdMatch = dateStr.match(/(\d{1,2})\s*[-/.]\s*(\d{1,2})/) || dateStr.match(/(\d{1,2})월\s*(\d{1,2})일?/);
    if (!mdMatch) return false;
    year = nowKst.getUTCFullYear();
    month = Number(mdMatch[1]);
    day = Number(mdMatch[2]);
  }

  // 2. 시간 추출 (종료 시간 ~HH:MM 우선)
  let endHour = 23;
  let endMinute = 59;

  const timeText = (seminar.time || '').trim();
  if (timeText) {
    const rangeMatch = timeText.match(/~\s*(\d{1,2}):(\d{1,2})/);
    const startMatch = timeText.match(/(\d{1,2}):(\d{1,2})/);

    if (rangeMatch) {
      endHour = Number(rangeMatch[1]);
      endMinute = Number(rangeMatch[2]);
    } else if (startMatch) {
      // 단일 시작 시간인 경우 2시간 뒤를 종료 시각으로 간주
      endHour = Math.min(23, Number(startMatch[1]) + 2);
      endMinute = Number(startMatch[2]);
    }
  }

  // KST (UTC+9) 기준 timestamp 계산
  const endIso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(endHour).padStart(2, '0')}:${String(endMinute).padStart(2, '0')}:00+09:00`;
  const endMs = Date.parse(endIso);
  if (Number.isNaN(endMs)) return false;

  return endMs <= referenceNowMs;
}

/**
 * 세미나가 아직 완료되지 않은 상태(PROCESS_COMPLETED, PROCESS_END, seminarCompleted=1이 아님)인지 판별합니다.
 */
export function isUncompletedSeminar(seminar: {
  processState?: number | string | null;
  seminarCompleted?: number | string | boolean | null;
}): boolean {
  const ps =
    seminar.processState !== undefined && seminar.processState !== null ? Number(seminar.processState) : undefined;
  if (ps === ProcessState.PROCESS_COMPLETED || ps === ProcessState.PROCESS_END) {
    return false;
  }

  const completed =
    typeof seminar.seminarCompleted === 'boolean'
      ? seminar.seminarCompleted
        ? 1
        : 0
      : seminar.seminarCompleted !== undefined && seminar.seminarCompleted !== null
        ? Number(seminar.seminarCompleted)
        : 0;
  if (completed === 1) {
    return false;
  }

  return true;
}

/**
 * 세미나 목록의 detail API를 호출하여 최신 상태를 DB에 일괄 저장합니다.
 * @param seminars 대상 세미나 목록
 * @param concurrency 동시 요청 수 (기본값: 3)
 * @param delayMs 요청 간 지연 ms (기본값: 250ms)
 */
export async function syncSeminarsDetailToDb(
  seminars: Array<{ seminarId?: string | number | null; url?: string }>,
  concurrency = 3,
  delayMs = 250,
): Promise<SeminarListItem[]> {
  const validItems: SeminarListItem[] = seminars
    .map((s) => {
      const sid = s.seminarId !== undefined && s.seminarId !== null ? String(s.seminarId) : '';
      return {
        seminarId: sid,
        name: '',
        url: s.url || (sid ? `https://m.doctorville.co.kr/cme/seminar/${sid}` : ''),
        time: '',
        currentCount: '',
        totalCount: '',
        nightTime: false,
        isAdvancedSurvey: false,
      } as SeminarListItem;
    })
    .filter((s) => Boolean(s.seminarId));

  if (validItems.length === 0) return [];

  logger.info(
    `syncSeminarsDetailToDb: ${validItems.length}개 세미나 detail API 조회 및 DB 갱신 시작 (동시: ${concurrency}, 간격: ${delayMs}ms)`,
  );
  const { seminars: enriched } = await enrichSeminarsWithDetail(validItems, concurrency, delayMs);

  if (enriched.length > 0) {
    seminarRepo.upsertSeminars(enriched);
    logger.info(`syncSeminarsDetailToDb: ${enriched.length}개 세미나 DB 갱신 완료`);
  }

  return enriched;
}

/**
 * 앱 시작 시 DB에 저장된 세미나 중 이미 지난 세미나이면서 미완료 상태인 세미나들을 선별하여
 * 동시 3개, 250ms 간격으로 detail API를 호출하고 DB를 갱신합니다.
 */
export async function refreshPastUncompletedSeminars(
  concurrency = 3,
  delayMs = 250,
): Promise<{ total: number; targetCount: number; updatedCount: number }> {
  try {
    const allSeminars = seminarRepo.getAllSeminars();
    const nowMs = Date.now();

    const targets = allSeminars.filter((s) => isPastSeminar(s, nowMs) && isUncompletedSeminar(s));

    if (targets.length === 0) {
      logger.info(`[startup] 지나간 세미나 중 미완료 세미나가 없습니다. (전체 DB 세미나: ${allSeminars.length}개)`);
      return { total: allSeminars.length, targetCount: 0, updatedCount: 0 };
    }

    logger.info(
      `[startup] 지나간 미완료 세미나 ${targets.length}건 발견. detail API 동기화 시작 (동시 ${concurrency}개, ${delayMs}ms 간격)...`,
    );

    const enriched = await syncSeminarsDetailToDb(targets, concurrency, delayMs);

    logger.info(`[startup] 지나간 미완료 세미나 상태 갱신 완료: ${enriched.length}건 DB 업데이트 성공.`);

    return {
      total: allSeminars.length,
      targetCount: targets.length,
      updatedCount: enriched.length,
    };
  } catch (err) {
    logger.error('[startup] refreshPastUncompletedSeminars 실행 중 오류:', err);
    return { total: 0, targetCount: 0, updatedCount: 0 };
  }
}
