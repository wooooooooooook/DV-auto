const { safeGoto, escapeMarkdown } = require('../modules/utils');

const QUIZ_LIST_URL = 'https://www.doctorville.co.kr/product/medicineList';

async function collectQuizLink(page) {
  try {
    await safeGoto(page, QUIZ_LIST_URL, { waitUntil: 'load', timeout: 30000 }, 1);
    const quizBgCount = await page.locator('.quiz_bg').count();
    if (!quizBgCount) return null;

    const quizBg = page.locator('.product_list .quiz_bg').first();
    const handle = await quizBg.elementHandle();
    if (!handle) return null;
    const href = await page
      .evaluate((el) => {
        let cur = el;
        while (cur && cur.nodeType === 1) {
          if (cur.tagName === 'A' && cur.href) return cur.href;
          cur = cur.parentElement;
        }
        return null;
      }, handle)
      .catch(() => null);

    if (!href) return null;
    return href;
  } catch (_e) {
    console.error('collectQuizLink error', _e && _e.stack ? _e.stack : _e);
    return null;
  }
}

async function run({ page, _context }) {
  try {
    const quizLink = await collectQuizLink(page);

    let message = '✨ [출석체크](https://m.doctorville.co.kr/mypage/attendance)\n';

    if (quizLink) {
      message += `✨ [오늘의 퀴즈](${quizLink})\n`;
    } else {
      message += '✨ 오늘의 퀴즈는 없습니다.\n';
    }

    return { success: true, message, options: { parse_mode: 'MarkdownV2' } };
  } catch (_e) {
    console.error('today_links task error', _e && _e.stack ? _e.stack : _e);
    return {
      success: false,
      message: `today_links 작업 오류: ${_e && _e.message ? escapeMarkdown(String(_e)) : ''}`,
    };
  }
}

module.exports = { run };
