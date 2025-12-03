import type { PlaywrightRunArgs } from '../types';
import { safeGoto } from '../modules/utils';

const QUIZ_LIST_URL = 'https://www.doctorville.co.kr/product/medicineList';

async function collectQuizLink(page: PlaywrightRunArgs['page']): Promise<string | null> {
  try {
    await safeGoto(page, QUIZ_LIST_URL, { waitUntil: 'load', timeout: 30000 }, 1);
    const quizBgCount = await page.locator('.quiz_bg').count();
    if (!quizBgCount) return null;

    const quizBg = page.locator('.product_list .quiz_bg').first();
    const handle = await quizBg.elementHandle();
    if (!handle) return null;
    const href = await page
      .evaluate((el) => {
        let cur: Element | null = el;
        while (cur && cur.nodeType === 1) {
          const anchor = cur as HTMLAnchorElement;
          if (anchor.tagName === 'A' && anchor.href) return anchor.href;
          cur = cur.parentElement;
        }
        return null;
      }, handle)
      .catch(() => null);

    if (!href) return null;
    return href;
  } catch (_e) {
    console.error('collectQuizLink error', _e && typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e);
    return null;
  }
}

async function run({ page }: PlaywrightRunArgs) {
  try {
    const quizLink = await collectQuizLink(page);

    let message = '✨ 출석체크: https://m.doctorville.co.kr/mypage/attendance\n';

    message += `✨ 오늘의 퀴즈 링크:\n${quizLink ? quizLink : '오늘은 퀴즈가 없습니다.'}\n`;

    return { success: true, message };
  } catch (_e) {
    console.error('today_links task error', _e && typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e);
    const message = _e instanceof Error ? _e.message : String(_e);
    return { success: false, message: `today_links 작업 오류: ${message}` };
  }
}

export { run };
