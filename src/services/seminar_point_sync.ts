import type { TaskContext } from '../types';
import type { SeminarListItem } from './seminar_repository';
import type { SeminarPointChange } from '../tasks/apply_seminar_notice';
import * as seminarRepo from './seminar_repository';
import { getSeminarIdFromUrl } from '../modules/utils';
import { searchSeminarPoints } from '../tasks/check_seminar_point';
import { clearCache as clearAdvancedSeminarsCache } from '../tasks/check_advanced_seminars';
import { enrichSeminarFromDetail } from './seminar_enrichment';

/**
 * 하위 호환성을 위해 유지 (seminar_enrichment 모듈의 enrichSeminarFromDetail 연결)
 */
export const fetchAndPopulateSeminarInfo = enrichSeminarFromDetail;

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
    clearAdvancedSeminarsCache();
  }
  return { seminars: updatedSeminars, pointChanges };
}
