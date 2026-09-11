import type { SeminarListItem } from './seminar_repository';
import * as seminarRepo from './seminar_repository';
import * as logger from './logger';
import {
  fetchSeminarDetail,
  parseSeminarDateTime,
  checkIsAdvancedSurvey,
  checkIsPointExcluded,
} from '../modules/seminar_api';

/**
 * 세미나 ID로 닥터빌 Detail API를 조회하여 SeminarListItem 형태의 메타데이터를 파싱/반환합니다.
 * DB 저장 없이 순수하게 API 결과를 정규화된 객체로 반환하므로 다양한 상황에서 조합하여 사용할 수 있습니다.
 *
 * @param seminarId 세미나 ID (예: '5517')
 * @param fallbackDate 일자 파싱 실패 시 대체할 기준 일자
 */
export async function enrichSeminarFromDetail(
  seminarId: string,
  fallbackDate?: string,
): Promise<Partial<SeminarListItem>> {
  try {
    const detailRes = await fetchSeminarDetail(seminarId);
    if (!detailRes.success || !detailRes.rawResponse?.seminarDetail) {
      return {};
    }

    const d = detailRes.rawResponse.seminarDetail;
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

    let detectedDate = date;
    if (!detectedDate && typeof d.createDt === 'string') {
      detectedDate = d.createDt.split(' ')[0] || '';
    }
    if (!detectedDate && fallbackDate) {
      detectedDate = fallbackDate;
    }

    const hiddenYn = typeof d.hiddenYn === 'string' ? d.hiddenYn : undefined;
    const diseaseCategoryNm = typeof d.diseaseCategoryNm === 'string' ? d.diseaseCategoryNm : undefined;

    return {
      name: typeof d.seminarNm === 'string' ? d.seminarNm : '',
      date,
      time,
      nightTime,
      currentCount: d.applyCnt !== undefined && d.applyCnt !== null ? String(d.applyCnt) : '',
      totalCount: d.maxPeopleCnt !== undefined && d.maxPeopleCnt !== null ? String(d.maxPeopleCnt) : '',
      isAdvancedSurvey,
      isPointExcluded,
      processState: processStateNum,
      cancelProcessState: cancelProcessStateNum,
      seminarCompleted: seminarCompletedNum,
      hiddenYn,
      diseaseCategoryNm,
      detectedDate: detectedDate || '',
    };
  } catch (err) {
    logger.warn(`Failed to enrich seminar detail for ID ${seminarId}:`, err);
    return {};
  }
}

/**
 * DB에서 세미나를 조회하고, 세미나가 DB에 없거나 필수 정보(name, date)가 누락된 경우
 * Detail API를 호출하여 메타데이터를 채워 DB에 저장(upsert)한 후 반환합니다.
 *
 * @param seminarId 세미나 ID
 * @param fallbackDate 대체 기준 일자
 */
export async function getOrEnrichSeminar(seminarId: string, fallbackDate?: string): Promise<SeminarListItem | null> {
  if (!seminarId) return null;

  const existing = seminarRepo.getSeminarById(seminarId);
  if (existing && existing.name && existing.date) {
    return existing;
  }

  const detailInfo = await enrichSeminarFromDetail(seminarId, fallbackDate || existing?.detectedDate);
  const nowIso = new Date().toISOString();

  const itemToUpsert: SeminarListItem = {
    seminarId,
    name: detailInfo.name || existing?.name || '',
    url: existing?.url || `https://m.doctorville.co.kr/cme/seminar/${seminarId}`,
    date: detailInfo.date || existing?.date || '',
    time: detailInfo.time || existing?.time || '',
    currentCount: detailInfo.currentCount || existing?.currentCount || '',
    totalCount: detailInfo.totalCount || existing?.totalCount || '',
    nightTime: detailInfo.nightTime ?? existing?.nightTime ?? false,
    isAdvancedSurvey: detailInfo.isAdvancedSurvey ?? existing?.isAdvancedSurvey ?? false,
    isPointExcluded: detailInfo.isPointExcluded ?? existing?.isPointExcluded,
    processState: detailInfo.processState ?? existing?.processState,
    cancelProcessState: detailInfo.cancelProcessState ?? existing?.cancelProcessState,
    seminarCompleted: detailInfo.seminarCompleted ?? existing?.seminarCompleted,
    hiddenYn: detailInfo.hiddenYn || existing?.hiddenYn || 'N',
    diseaseCategoryNm: detailInfo.diseaseCategoryNm || existing?.diseaseCategoryNm,
    detectedDate: detailInfo.detectedDate || existing?.detectedDate || '',
    detectedAt: existing?.detectedAt || nowIso,
  };

  return seminarRepo.upsertSeminar(itemToUpsert);
}
