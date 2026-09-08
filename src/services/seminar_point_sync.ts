import type { TaskContext } from '../types';
import type { SeminarListItem } from './seminar_repository';
import type { SeminarPointChange } from '../tasks/apply_seminar_notice';
import * as seminarRepo from './seminar_repository';
import * as logger from './logger';
import { getSeminarIdFromUrl } from '../modules/utils';
import { searchSeminarPoints } from '../tasks/check_seminar_point';
import {
  fetchSeminarDetail,
  parseSeminarDateTime,
  checkIsAdvancedSurvey,
  checkIsPointExcluded,
} from '../modules/seminar_api';

export async function fetchAndPopulateSeminarInfo(
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
    logger.warn(`Failed to fetch seminar detail for ID ${seminarId}:`, err);
    return {};
  }
}

export async function refreshSeminarPointStatus(
  _context?: TaskContext['context'],
  seminars: SeminarListItem[] = [],
): Promise<{ seminars: SeminarListItem[]; pointChanges: SeminarPointChange[] }> {
  const searchRes = await searchSeminarPoints(undefined, [], 60);
  if (!searchRes.success) {
    console.warn(
      'refreshSeminarPointStatus: point history query failed, keeping seminar_list status intact:',
      searchRes.error,
    );
    return { seminars, pointChanges: [] };
  }
  const parsedPoints = searchRes.points;
  const checkedAt = new Date().toISOString();
  const pointChanges: SeminarPointChange[] = [];

  const changedSeminars: SeminarListItem[] = [];

  const updatedSeminars: SeminarListItem[] = [];
  for (const seminar of seminars) {
    const id = seminar.seminarId || getSeminarIdFromUrl(seminar.url);
    let currentItem = { ...seminar };
    let hasChanged = false;

    // 만약 기존 세미나 메타데이터(이름 또는 일자)가 비어 있는 경우, detail API로 정보 채우기
    if (id && (!currentItem.name || !currentItem.date)) {
      const extra = await fetchAndPopulateSeminarInfo(id, currentItem.detectedDate || currentItem.date);
      currentItem = {
        ...currentItem,
        name: extra.name || currentItem.name || '',
        date: extra.date || currentItem.date || '',
        time: extra.time || currentItem.time || '',
        nightTime: extra.nightTime ?? currentItem.nightTime ?? false,
        currentCount: extra.currentCount || currentItem.currentCount || '',
        totalCount: extra.totalCount || currentItem.totalCount || '',
        isAdvancedSurvey: extra.isAdvancedSurvey ?? currentItem.isAdvancedSurvey ?? false,
        isPointExcluded: extra.isPointExcluded ?? currentItem.isPointExcluded,
        processState: extra.processState ?? currentItem.processState,
        cancelProcessState: extra.cancelProcessState ?? currentItem.cancelProcessState,
        seminarCompleted: extra.seminarCompleted ?? currentItem.seminarCompleted,
        detectedDate: extra.detectedDate || currentItem.detectedDate || '',
      };
      hasChanged = true;
    }

    if (currentItem.pointPaid === true) {
      if (hasChanged) {
        changedSeminars.push(currentItem);
      }
      updatedSeminars.push(currentItem);
      continue;
    }

    if (id && parsedPoints.has(id)) {
      const pointResult = parsedPoints.get(id)!;
      if (pointResult.found && pointResult.type === '적립') {
        pointChanges.push({
          seminarId: id,
          name: currentItem.name,
          date: currentItem.date,
          url: id ? `https://m.doctorville.co.kr/cme/seminar/${id}` : currentItem.url,
          point: pointResult.point,
          pointText: pointResult.pointText,
          pointDate: pointResult.date,
          pointContent: pointResult.content,
        });

        const updatedItem: SeminarListItem = {
          ...currentItem,
          pointPaid: true,
          point: pointResult.point,
          pointDate: pointResult.date,
          pointText: pointResult.pointText,
          pointContent: pointResult.content,
          pointCheckedAt: checkedAt,
        };
        changedSeminars.push(updatedItem);
        updatedSeminars.push(updatedItem);
        continue;
      }
    }

    const updatedItem: SeminarListItem = {
      ...currentItem,
      pointPaid: false,
      pointCheckedAt: checkedAt,
    };
    changedSeminars.push(updatedItem);
    updatedSeminars.push(updatedItem);
  }

  for (const [id, pointResult] of parsedPoints) {
    if (!pointResult.found || pointResult.type !== '적립') continue;

    const exists = updatedSeminars.some((item) => (item.seminarId || getSeminarIdFromUrl(item.url)) === id);
    if (!exists) {
      // 포인트 목록에서만 신규 발견된 경우: seminar detail API로 세미나 메타데이터 채우기
      const detailInfo = await fetchAndPopulateSeminarInfo(id, pointResult.date);

      const newItem: SeminarListItem = {
        seminarId: id,
        name: detailInfo.name || '',
        url: `https://m.doctorville.co.kr/cme/seminar/${id}`,
        date: detailInfo.date || '',
        time: detailInfo.time || '',
        currentCount: detailInfo.currentCount || '',
        totalCount: detailInfo.totalCount || '',
        nightTime: detailInfo.nightTime ?? false,
        isAdvancedSurvey: detailInfo.isAdvancedSurvey ?? false,
        isPointExcluded: detailInfo.isPointExcluded ?? false,
        processState: detailInfo.processState,
        cancelProcessState: detailInfo.cancelProcessState,
        seminarCompleted: detailInfo.seminarCompleted,
        pointPaid: true,
        point: pointResult.point,
        pointDate: pointResult.date,
        pointText: pointResult.pointText,
        pointContent: pointResult.content,
        pointCheckedAt: checkedAt,
        detectedDate: detailInfo.detectedDate || '',
        detectedAt: checkedAt,
      };
      changedSeminars.push(newItem);
      updatedSeminars.push(newItem);

      pointChanges.push({
        seminarId: id,
        name: newItem.name,
        date: newItem.date,
        url: newItem.url || `https://m.doctorville.co.kr/cme/seminar/${id}`,
        point: pointResult.point,
        pointText: pointResult.pointText,
        pointDate: pointResult.date,
        pointContent: pointResult.content,
      });
    }
  }

  if (changedSeminars.length > 0) {
    seminarRepo.upsertSeminars(changedSeminars);
  }
  return { seminars: updatedSeminars, pointChanges };
}
