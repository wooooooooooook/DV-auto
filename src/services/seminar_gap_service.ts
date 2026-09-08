import type { SeminarListItem } from './seminar_repository';
import * as storage from './storage';
import * as logger from './logger';
import { getSeminarIdFromUrl } from '../modules/utils';
import {
  fetchSeminarDetail,
  parseSeminarDateTime,
  checkIsAdvancedSurvey,
  checkIsPointExcluded,
} from '../modules/seminar_api';

export const CHECKED_GAP_SEMINAR_IDS_KEY = 'apply_seminar:checked_gap_ids';

/**
 * mainFuture API 결과 목록(currentSeminars) 내의 세미나 ID 불연속(Gap)을 탐색하여 누락된 비공개 세미나를 발굴합니다.
 * - mainFuture API 목록의 ID들을 오름차순 정렬하여 최소 ID ~ 최대 ID 사이에서 누락된 정수 ID(Gap) 추출
 * - 이미 DB에 저장되어 있거나(storedSeminars) 확인 완료된 캐시(checkedGapIds)는 제외
 * - 누락된 각 ID에 대해 fetchSeminarDetail을 호출하여 상세 정보 조회
 * - 정원(maxPeopleCnt)이 100명 이상인 세미나만 비공개 세미나([비공개])로 등록 및 반환
 * - 정원이 100명 미만이거나 조회 실패/존재하지 않는 ID는 CHECKED_GAP_SEMINAR_IDS_KEY에 기록하여 중복 호출 방지
 */
export async function discoverMissingGapSeminars(
  currentSeminars: SeminarListItem[] = [],
  storedSeminars: SeminarListItem[] = [],
  referenceDate: string = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }),
  options: { maxCheckRange?: number; concurrency?: number; delayMs?: number } = {},
): Promise<{ gapSeminars: SeminarListItem[]; isAuthExpired: boolean }> {
  const { maxCheckRange = 50, concurrency = 2, delayMs = process.env.NODE_ENV === 'test' ? 0 : 150 } = options;

  // 1. mainFuture API 결과(currentSeminars)의 숫자 seminarId 목록 추출
  const mainFutureNumericIds: number[] = [];
  for (const s of currentSeminars) {
    const rawId = s.seminarId || getSeminarIdFromUrl(s.url);
    if (rawId) {
      const num = parseInt(String(rawId).replace(/[^0-9]/g, ''), 10);
      if (!Number.isNaN(num) && num > 0) {
        mainFutureNumericIds.push(num);
      }
    }
  }

  // mainFuture 결과에 2개 이상의 ID가 있어야 그 사이의 불연속(Gap)을 판별할 수 있음
  if (mainFutureNumericIds.length < 2) {
    return { gapSeminars: [], isAuthExpired: false };
  }

  const sortedMainFutureIds = Array.from(new Set(mainFutureNumericIds)).sort((a, b) => a - b);
  const minMainFutureId = sortedMainFutureIds[0];
  const maxMainFutureId = sortedMainFutureIds[sortedMainFutureIds.length - 1];
  const minCheckId = Math.max(minMainFutureId, maxMainFutureId - maxCheckRange);

  const mainFutureIdSet = new Set<number>(sortedMainFutureIds);

  // 2. 이미 DB에 저장된 ID 목록 및 확인 완료된 무효 ID 캐시 조회
  const storedIdSet = new Set<number>();
  for (const s of storedSeminars) {
    const rawId = s.seminarId || getSeminarIdFromUrl(s.url);
    if (rawId) {
      const num = parseInt(String(rawId).replace(/[^0-9]/g, ''), 10);
      if (!Number.isNaN(num) && num > 0) {
        storedIdSet.add(num);
      }
    }
  }

  const checkedGapIdsList = storage.get<number[]>(CHECKED_GAP_SEMINAR_IDS_KEY, []) || [];
  const checkedGapSet = new Set<number>(checkedGapIdsList);

  // 3. mainFuture 목록에서 빠져 있고, 아직 DB나 캐시에 없는 누락된 갭 ID 추출 (minCheckId ~ maxMainFutureId 사이)
  const missingGapIds: number[] = [];
  for (let id = minCheckId; id < maxMainFutureId; id++) {
    if (!mainFutureIdSet.has(id) && !storedIdSet.has(id) && !checkedGapSet.has(id)) {
      missingGapIds.push(id);
    }
  }

  if (missingGapIds.length === 0) {
    return { gapSeminars: [], isAuthExpired: false };
  }

  let isAuthExpired = false;
  const discoveredGapSeminars: SeminarListItem[] = [];
  const newlyCheckedIds: number[] = [];
  const nowIso = new Date().toISOString();

  // 4. Concurrency 기반으로 누락된 ID 상세 조회
  for (let i = 0; i < missingGapIds.length; i += concurrency) {
    if (isAuthExpired) break;
    const chunk = missingGapIds.slice(i, i + concurrency);

    await Promise.all(
      chunk.map(async (gapId) => {
        if (isAuthExpired) return;
        const sid = String(gapId);
        try {
          const detailRes = await fetchSeminarDetail(sid);
          if (detailRes.isAuthExpired) {
            isAuthExpired = true;
            return;
          }

          if (detailRes.success && detailRes.rawResponse?.seminarDetail) {
            const d = detailRes.rawResponse.seminarDetail;
            const maxPeopleCnt =
              d.maxPeopleCnt !== undefined && d.maxPeopleCnt !== null
                ? parseInt(String(d.maxPeopleCnt).replace(/[^0-9]/g, ''), 10)
                : 0;

            // 정원이 100명 이상인 경우에만 비공개 세미나로 등록
            if (!Number.isNaN(maxPeopleCnt) && maxPeopleCnt >= 100) {
              const startDt = typeof d.startDt === 'string' ? d.startDt : undefined;
              const endDt = typeof d.endDt === 'string' ? d.endDt : undefined;
              const { date, time, nightTime } = parseSeminarDateTime(startDt, endDt);
              const isAdvancedSurvey = checkIsAdvancedSurvey(d.useDepthSurvey);
              const isPointExcluded = detailRes.isPointExcluded ?? checkIsPointExcluded(d.intro);
              const processStateNum = d.processState !== undefined ? Number(d.processState) : undefined;
              const cancelProcessStateNum =
                d.cancelProcessState !== undefined ? Number(d.cancelProcessState) : undefined;
              const seminarCompletedNum =
                d.seminarCompleted !== undefined
                  ? typeof d.seminarCompleted === 'boolean'
                    ? d.seminarCompleted
                      ? 1
                      : 0
                    : Number(d.seminarCompleted)
                  : undefined;
              const hiddenYn = typeof d.hiddenYn === 'string' ? d.hiddenYn : 'Y';
              const diseaseCategoryNm = typeof d.diseaseCategoryNm === 'string' ? d.diseaseCategoryNm : undefined;

              const newItem: SeminarListItem = {
                seminarId: sid,
                name: typeof d.seminarNm === 'string' && d.seminarNm ? d.seminarNm : '비공개 세미나',
                url: `https://m.doctorville.co.kr/cme/seminar/${sid}`,
                date,
                time,
                nightTime,
                currentCount: d.applyCnt !== undefined && d.applyCnt !== null ? String(d.applyCnt) : '',
                totalCount: String(maxPeopleCnt),
                isAdvancedSurvey,
                isPointExcluded,
                processState: processStateNum,
                cancelProcessState: cancelProcessStateNum,
                seminarCompleted: seminarCompletedNum,
                hiddenYn,
                diseaseCategoryNm,
                detectedDate: referenceDate,
                detectedAt: nowIso,
              };

              discoveredGapSeminars.push(newItem);
              return;
            }
          }

          // 유효하지 않거나 정원 100명 미만인 경우 캐싱 목록에 추가
          newlyCheckedIds.push(gapId);
        } catch (err) {
          logger.warn(`discoverMissingGapSeminars: ID ${sid} 조회 실패`, err);
          newlyCheckedIds.push(gapId);
        }
      }),
    );

    if (i + concurrency < missingGapIds.length && delayMs > 0 && !isAuthExpired) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // 5. 새로 검사된 gapId 캐시 갱신 (최근 최대 500개 보관)
  if (newlyCheckedIds.length > 0) {
    const updatedCheckedList = Array.from(new Set([...checkedGapIdsList, ...newlyCheckedIds])).slice(-500);
    storage.set(CHECKED_GAP_SEMINAR_IDS_KEY, updatedCheckedList);
  }

  return { gapSeminars: discoveredGapSeminars, isAuthExpired };
}
