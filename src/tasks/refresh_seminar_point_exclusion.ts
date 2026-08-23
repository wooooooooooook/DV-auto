import type { TaskResult } from '../types';
import { getSeminarIdFromUrl, isSurveyPointExcludedSeminarHttp } from '../modules/utils';
import { httpGet } from '../modules/http_client';
import { parseSeminarListHtml } from '../modules/html_parser';
import * as storage from '../services/storage';

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
const _SEMINAR_DETAIL_HTTP_PAGE = 'https://www.doctorville.co.kr/seminar/seminarDetail?seminarId=';
const SEMINAR_LIST_KEY = 'apply_seminar:seminar_list';

type SeminarListItem = {
  name: string;
  url: string;
  date?: string;
  time?: string;
  currentCount?: string;
  totalCount?: string;
  isPointExcluded?: boolean;
  isAdvancedSurvey?: boolean;
  seminarId?: string | null;
};

async function run(): Promise<TaskResult> {
  try {
    const mainRes = await httpGet(SEMINAR_PAGE);
    if (mainRes.status !== 200 || !mainRes.body) {
      throw new Error(`HTTP status ${mainRes.status} on ${SEMINAR_PAGE}`);
    }

    const currentSeminars = parseSeminarListHtml(mainRes.body);
    const storedSeminars = storage.get<SeminarListItem[]>(SEMINAR_LIST_KEY, []) || [];
    const storedMap = new Map(storedSeminars.map((s) => [s.seminarId || getSeminarIdFromUrl(s.url) || s.url, s]));

    const checked = new Map<string, boolean | undefined>();
    const refreshed: SeminarListItem[] = [];

    for (const seminar of currentSeminars) {
      const seminarId = getSeminarIdFromUrl(seminar.url);
      const detailLink = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : seminar.url;
      const cacheKey = seminarId || seminar.url;
      const existingItem = storedMap.get(cacheKey);

      let isPointExcluded = checked.get(cacheKey);

      if (typeof isPointExcluded !== 'boolean') {
        const pointExRes = await isSurveyPointExcludedSeminarHttp(detailLink);
        if (pointExRes.status === 'success') {
          isPointExcluded = pointExRes.excluded;
          checked.set(cacheKey, isPointExcluded);
        } else {
          // HTTP 조회 실패 시 덮어쓰지 않고 기존 값 유지
          isPointExcluded = existingItem?.isPointExcluded;
        }
      }

      refreshed.push({
        ...seminar,
        seminarId,
        isPointExcluded,
      });
    }

    // Storage merge: update isPointExcluded and isAdvancedSurvey while preserving other fields (like pointPaid)
    const refreshedMap = new Map(
      refreshed.map((item) => [item.seminarId || getSeminarIdFromUrl(item.url) || item.url, item]),
    );

    const finalToStore = storedSeminars.map((seminar) => {
      const key = seminar.seminarId || getSeminarIdFromUrl(seminar.url) || seminar.url;
      const matched = refreshedMap.get(key);
      if (!matched) return seminar;
      return {
        ...seminar,
        isPointExcluded: matched.isPointExcluded ?? seminar.isPointExcluded,
        isAdvancedSurvey: matched.isAdvancedSurvey ?? seminar.isAdvancedSurvey,
      };
    });

    storage.set(SEMINAR_LIST_KEY, finalToStore);

    const excludedCount = refreshed.filter((item) => item.isPointExcluded === true).length;
    return {
      success: true,
      message: `✅ 세미나 ${refreshed.length}건의 포인트미지급 여부를 재확인했습니다.\n- 포인트 미지급: ${excludedCount}건\n- 포인트 지급: ${refreshed.length - excludedCount}건`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `세미나 포인트미지급 상태 재확인 중 오류: ${message}`,
    };
  }
}

export { run };
