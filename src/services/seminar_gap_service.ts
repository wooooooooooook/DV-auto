import type { SeminarListItem } from './seminar_repository';
import * as storage from './storage';
import * as logger from './logger';
import { getSeminarIdFromUrl } from '../modules/utils';
import {
  fetchSeminarDetail,
  parseSeminarDateTime,
  checkIsAdvancedSurvey,
  checkIsPointExcluded,
  type FetchSeminarDetailResult,
  type SeminarDetailApiResponse,
} from '../modules/seminar_api';

export const CHECKED_GAP_SEMINAR_IDS_KEY = 'apply_seminar:checked_gap_ids';

/**
 * fetchSeminarDetail 응답 데이터로부터 SeminarListItem 객체를 생성합니다.
 */
function createSeminarListItemFromDetail(
  sid: string,
  d: NonNullable<SeminarDetailApiResponse['seminarDetail']>,
  detailRes: Extract<FetchSeminarDetailResult, { success: true }>,
  referenceDate: string,
  nowIso: string,
): SeminarListItem {
  const maxPeopleCnt =
    d.maxPeopleCnt !== undefined && d.maxPeopleCnt !== null
      ? parseInt(String(d.maxPeopleCnt).replace(/[^0-9]/g, ''), 10)
      : 0;

  const startDt = typeof d.startDt === 'string' ? d.startDt : undefined;
  const endDt = typeof d.endDt === 'string' ? d.endDt : undefined;
  const { date, time, nightTime } = parseSeminarDateTime(startDt, endDt);
  const isAdvancedSurvey = checkIsAdvancedSurvey(d.useDepthSurvey);
  const isPointExcluded = detailRes.isPointExcluded ?? checkIsPointExcluded(d.intro);
  const processStateNum = d.processState !== undefined ? Number(d.processState) : undefined;
  const cancelProcessStateNum = d.cancelProcessState !== undefined ? Number(d.cancelProcessState) : undefined;
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

  return {
    seminarId: sid,
    name: typeof d.seminarNm === 'string' && d.seminarNm ? d.seminarNm : hiddenYn === 'Y' ? '비공개 세미나' : '세미나',
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
}

/**
 * 1. mainFuture API 결과 목록(currentSeminars) 내의 세미나 ID 불연속(Gap)을 탐색하여 누락된 비공개 세미나를 발굴합니다.
 * 2. 마지막으로 저장/확인된 세미나 번호의 다음 번호(Max ID + 1, +2 ...)를 순차 조회하여 신규 등록된 세미나를 발굴합니다.
 * - 정원(maxPeopleCnt)이 100명 이상인 세미나만 유효한 세미나로 등록 및 반환
 * - 정원이 100명 미만인 세미나는 CHECKED_GAP_SEMINAR_IDS_KEY에 기록하여 중복 호출 방지
 * - 아직 미등록된 ID(404 등)는 캐시하지 않고 다음 탐색 시 재확인 가능하도록 유지
 */
export async function discoverMissingGapSeminars(
  currentSeminars: SeminarListItem[] = [],
  storedSeminars: SeminarListItem[] = [],
  referenceDate: string = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }),
  options: {
    maxCheckRange?: number;
    concurrency?: number;
    delayMs?: number;
    maxForwardCheckCount?: number;
  } = {},
): Promise<{ gapSeminars: SeminarListItem[]; isAuthExpired: boolean }> {
  const {
    maxCheckRange = 50,
    concurrency = 2,
    delayMs = process.env.NODE_ENV === 'test' ? 0 : 150,
    maxForwardCheckCount = 10,
  } = options;

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

  // 2. 이미 DB에 저장된 ID 목록 및 확인 완료된 무효 ID 캐시 조회
  const storedIdSet = new Set<number>();
  const storedNumericIds: number[] = [];
  for (const s of storedSeminars) {
    const rawId = s.seminarId || getSeminarIdFromUrl(s.url);
    if (rawId) {
      const num = parseInt(String(rawId).replace(/[^0-9]/g, ''), 10);
      if (!Number.isNaN(num) && num > 0) {
        storedIdSet.add(num);
        storedNumericIds.push(num);
      }
    }
  }

  const mainFutureIdSet = new Set<number>(mainFutureNumericIds);
  const checkedGapIdsList = storage.get<number[]>(CHECKED_GAP_SEMINAR_IDS_KEY, []) || [];
  const checkedGapSet = new Set<number>(checkedGapIdsList);

  const allKnownNumericIds = [...mainFutureNumericIds, ...storedNumericIds];
  if (allKnownNumericIds.length === 0) {
    return { gapSeminars: [], isAuthExpired: false };
  }

  // 3. Gap 탐색: mainFuture 목록 사이의 누락된 갭 ID 추출
  const missingGapIds: number[] = [];
  if (mainFutureNumericIds.length >= 2) {
    const sortedMainFutureIds = Array.from(new Set(mainFutureNumericIds)).sort((a, b) => a - b);
    const minMainFutureId = sortedMainFutureIds[0];
    const maxMainFutureId = sortedMainFutureIds[sortedMainFutureIds.length - 1];
    const minCheckId = Math.max(minMainFutureId, maxMainFutureId - maxCheckRange);

    for (let id = minCheckId; id < maxMainFutureId; id++) {
      if (!mainFutureIdSet.has(id) && !storedIdSet.has(id) && !checkedGapSet.has(id)) {
        missingGapIds.push(id);
      }
    }
  }

  let isAuthExpired = false;
  const discoveredGapSeminars: SeminarListItem[] = [];
  const newlyCheckedIds: number[] = [];
  const nowIso = new Date().toISOString();

  // 4. Concurrency 기반으로 누락된 Gap ID 상세 조회
  if (missingGapIds.length > 0) {
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
                const newItem = createSeminarListItemFromDetail(sid, d, detailRes, referenceDate, nowIso);
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
  }

  // 5. Next ID (+1) 탐색: 마지막 저장/알려진 최댓값 세미나 번호 + 1 조회
  if (!isAuthExpired) {
    const maxKnownId = Math.max(...allKnownNumericIds);
    let currentForwardId = maxKnownId + 1;
    let checkedCount = 0;

    while (checkedCount < maxForwardCheckCount && !isAuthExpired) {
      if (mainFutureIdSet.has(currentForwardId) || storedIdSet.has(currentForwardId)) {
        currentForwardId++;
        continue;
      }
      if (checkedGapSet.has(currentForwardId)) {
        currentForwardId++;
        continue;
      }

      const sid = String(currentForwardId);
      try {
        const detailRes = await fetchSeminarDetail(sid);
        if (detailRes.isAuthExpired) {
          isAuthExpired = true;
          break;
        }

        if (detailRes.success && detailRes.rawResponse?.seminarDetail) {
          const d = detailRes.rawResponse.seminarDetail;
          const maxPeopleCnt =
            d.maxPeopleCnt !== undefined && d.maxPeopleCnt !== null
              ? parseInt(String(d.maxPeopleCnt).replace(/[^0-9]/g, ''), 10)
              : 0;

          if (!Number.isNaN(maxPeopleCnt) && maxPeopleCnt >= 100) {
            const newItem = createSeminarListItemFromDetail(sid, d, detailRes, referenceDate, nowIso);
            discoveredGapSeminars.push(newItem);
            logger.info(`discoverMissingGapSeminars: 최신 세미나 ID ${sid} 발굴 성공! (${newItem.name})`);
            currentForwardId++;
            checkedCount++;
            if (delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            continue;
          } else {
            // 정원 100명 미만인 세미나는 등록되어 있으나 대상이 아니므로 캐시에 추가
            newlyCheckedIds.push(currentForwardId);
            currentForwardId++;
            checkedCount++;
            if (delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
            continue;
          }
        }

        // 조회 실패 / 404: 아직 세미나가 등록되지 않은 상태이므로 탐색 종료 (캐싱하지 않음)
        break;
      } catch (err) {
        logger.warn(`discoverMissingGapSeminars: Forward ID ${sid} 조회 실패`, err);
        break;
      }
    }
  }

  // 6. 새로 검사된 gapId 캐시 갱신 (최근 최대 500개 보관)
  if (newlyCheckedIds.length > 0) {
    const updatedCheckedList = Array.from(new Set([...checkedGapIdsList, ...newlyCheckedIds])).slice(-500);
    storage.set(CHECKED_GAP_SEMINAR_IDS_KEY, updatedCheckedList);
  }

  return { gapSeminars: discoveredGapSeminars, isAuthExpired };
}
