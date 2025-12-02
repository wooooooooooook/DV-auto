const { safeGoto } = require('../modules/utils');

const QUIZ_LIST_URL = 'https://www.doctorville.co.kr/product/medicineList';

async function collectQuizLink(page) {
    try {
        await safeGoto(page, QUIZ_LIST_URL, { waitUntil: 'load', timeout: 30000 }, 1);
        const quizBgCount = await page.locator('.quiz_bg').count();
        if (!quizBgCount) return null;

        const quizBg = page.locator('.product_list .quiz_bg').first();
        const handle = await quizBg.elementHandle();
        if (!handle) return null;
        const href = await page.evaluate(el => {
            let cur = el;
            while (cur && cur.nodeType === 1) {
                if (cur.tagName === 'A' && cur.href) return cur.href;
                cur = cur.parentElement;
            }
            return null;
        }, handle).catch(() => null);

        if (!href) return null;
        return href;
    } catch (e) {
        console.error('collectQuizLink error', e && e.stack ? e.stack : e);
        return null;
    }
}

async function run({ page, context }) {
    try {
        const quizLink = await collectQuizLink(page);

        let message = '✨ 출석체크: https://m.doctorville.co.kr/mypage/attendance\n';

        message += `✨ 오늘의 퀴즈 링크:\n${(quizLink) ? quizLink : '오늘은 퀴즈가 없습니다.'}\n`;

        return { success: true, message };
    } catch (e) {
        console.error('today_links task error', e && e.stack ? e.stack : e);
        return { success: false, message: `today_links 작업 오류: ${e && e.message ? e.message : String(e)}` };
    }
}

module.exports = { run };
