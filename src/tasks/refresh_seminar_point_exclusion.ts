import type { PlaywrightRunArgs, TaskResult } from '../types';
import {
  ensureLoggedIn,
  ensureSeminarDetailReady,
  getSeminarIdFromUrl,
  hasSurveyPointExcludedNotice,
  safeGoto,
} from '../modules/utils';
import * as storage from '../services/storage';
import fs from 'fs/promises';
import path from 'path';

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
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
};

async function getPointExclusionStatusFromDetail(
  page: import('playwright').Page,
  detailLink: string,
): Promise<boolean> {
  await safeGoto(page, detailLink, { waitUntil: 'domcontentloaded', timeout: 20000 }, 1);
  await ensureSeminarDetailReady(page, detailLink);
  return hasSurveyPointExcludedNotice(page);
}
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
    const screenshotPaths: string[] = [];
    const screenshotDir = path.join(process.cwd(), 'screenshot');
    await fs.mkdir(screenshotDir, { recursive: true });

    for (const seminar of currentSeminars) {
      const seminarId = getSeminarIdFromUrl(seminar.url);
      const detailLink = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : seminar.url;
      const cacheKey = seminarId || seminar.url;

      let isPointExcluded = checked.get(cacheKey);
      const seminarPage = await page.context().newPage();
      try {
        await ensureLoggedIn({ page: seminarPage, context: page.context() });
        if (typeof isPointExcluded !== 'boolean') {
          isPointExcluded = await getPointExclusionStatusFromDetail(seminarPage, detailLink);
          checked.set(cacheKey, isPointExcluded);
        } else {
          await safeGoto(seminarPage, detailLink, { waitUntil: 'domcontentloaded', timeout: 20000 }, 1);
        }

        const shotPath = path.join(
          screenshotDir,
          `refresh_point_exclusion_${seminarId || Date.now()}_${Date.now()}.png`,
        );
        await seminarPage.screenshot({ path: shotPath, fullPage: true });
        screenshotPaths.push(shotPath);
      } finally {
        await seminarPage.close().catch(() => {});
      }

      refreshed.push({
        ...seminar,
        isPointExcluded,
      });
    }

    // 기존 seminar_list의 포인트 필드 보존하면서 isPointExcluded 갱신
    const storedSeminars = storage.get<any[]>(SEMINAR_LIST_KEY, []) || [];
    const refreshedMap = new Map(refreshed.map((item) => [getSeminarIdFromUrl(item.url) || item.url, item]));
    const finalToStore = storedSeminars.map((s) => {
      const key = getSeminarIdFromUrl(s.url) || s.url;
      const matched = refreshedMap.get(key);
      if (!matched) return s;
      return { ...s, isPointExcluded: matched.isPointExcluded, isAdvancedSurvey: matched.isAdvancedSurvey };
    });
    storage.set(SEMINAR_LIST_KEY, finalToStore);

    const excludedCount = refreshed.filter((item) => item.isPointExcluded).length;
    return {
      success: true,
      message: `✅ 세미나 ${refreshed.length}건의 포인트미지급 여부를 재확인했습니다.\n- 포인트 미지급: ${excludedCount}건\n- 포인트 지급: ${refreshed.length - excludedCount}건`,
      screenshotPaths,
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
