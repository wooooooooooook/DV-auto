import type { PlaywrightRunArgs, TaskResult } from '../types';
import { getSeminarIdFromUrl, isSurveyPointExcludedSeminar, safeGoto } from '../modules/utils';
import * as storage from '../services/storage';

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
const SEMINAR_LIST_KEY = 'apply_seminar:seminar_list';
const NEW_SEMINAR_KEY = 'apply_seminar:new_seminars';

type SeminarListItem = {
  name: string;
  url: string;
  date?: string;
  time?: string;
  currentCount?: string;
  totalCount?: string;
  isPointExcluded?: boolean;
  isAdvancedSurvey?: boolean;
};

type StoredNewSeminars = {
  date: string;
  seminars: Array<SeminarListItem & { seminarId?: string | null }>;
};

async function run({ page }: PlaywrightRunArgs): Promise<TaskResult> {
  try {
    await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'networkidle', timeout: 30000 }, 1);

    const currentSeminars = await page.locator('.list_cont').evaluateAll((nodes) => {
      const results: SeminarListItem[] = [];
      nodes.forEach((node) => {
        const date = node.querySelector('.seminar_day .date')?.textContent?.trim() || '';
        const links = node.querySelectorAll('a.list_detail');
        links.forEach((link) => {
          const href = link.getAttribute('href') || '';
          if (!href) return;

          const title =
            link.querySelector('.list_tit .tit')?.textContent?.trim() || link.textContent?.trim() || '세미나';
          const time = link.querySelector('.txt_num.time')?.textContent?.replace(/\n/g, '').trim() || '';

          const personNode = link.querySelector('.person');
          const currentCount = personNode?.querySelector('.txt_num')?.textContent?.trim() || '';
          const totalCount = personNode?.querySelector('.total .txt_num')?.textContent?.replace(/\//g, '').trim() || '';

          results.push({
            url: new URL(href, 'https://www.doctorville.co.kr/seminar/main').toString(),
            name: title,
            date,
            time,
            currentCount,
            totalCount,
            isAdvancedSurvey: !!link.querySelector('.ic_survey'),
          });
        });
      });
      return results;
    });

    const checked = new Map<string, boolean>();
    const refreshed = [] as SeminarListItem[];

    for (const seminar of currentSeminars) {
      const seminarId = getSeminarIdFromUrl(seminar.url);
      const detailLink = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : seminar.url;
      const cacheKey = seminarId || seminar.url;

      let isPointExcluded = checked.get(cacheKey);
      if (typeof isPointExcluded !== 'boolean') {
        isPointExcluded = await isSurveyPointExcludedSeminar(page.context(), detailLink);
        checked.set(cacheKey, isPointExcluded);
      }

      refreshed.push({
        ...seminar,
        isPointExcluded,
      });
    }

    storage.set(SEMINAR_LIST_KEY, refreshed);

    const storedNew = storage.get<StoredNewSeminars>(NEW_SEMINAR_KEY);
    if (storedNew?.seminars?.length) {
      const refreshedNewSeminars = storedNew.seminars.map((seminar) => {
        const seminarId = seminar.seminarId || getSeminarIdFromUrl(seminar.url);
        const matched = refreshed.find((item) => {
          const itemId = getSeminarIdFromUrl(item.url);
          if (seminarId && itemId) return seminarId === itemId;
          return item.url === seminar.url;
        });

        if (!matched) return seminar;

        return {
          ...seminar,
          isPointExcluded: matched.isPointExcluded,
          isAdvancedSurvey: matched.isAdvancedSurvey,
        };
      });

      storage.set(NEW_SEMINAR_KEY, {
        ...storedNew,
        seminars: refreshedNewSeminars,
      });
    }

    const excludedCount = refreshed.filter((item) => item.isPointExcluded).length;
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
