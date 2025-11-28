const { safeGoto } = require('../modules/utils');

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const QUIZ_LIST_URL = 'https://www.doctorville.co.kr/product/medicineList';
const BASE = 'https://www.doctorville.co.kr';

async function collectSeminarLinks(page) {
    try {
        await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);
        const listConts = await page.locator('.list_cont');
        const count = await listConts.count();

        const now = new Date();
        const month = now.toLocaleDateString('en-US', { month: 'numeric', timeZone: 'Asia/Seoul' });
        const day = now.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'Asia/Seoul' });
        const todayString = `${month}/${day}`;

        const links = [];

        for (let i = 0; i < count; i++) {
            const container = listConts.nth(i);
            const seminarDay = await container.locator('.seminar_day .date').innerText().catch(() => '');
            if (seminarDay !== todayString) continue;

            const details = container.locator('.list_detail');
            const dcount = await details.count();
            for (let j = 0; j < dcount; j++) {
                const detail = details.nth(j);
                const titleLocator = detail.locator('.list_tit .tit');
                const title = await titleLocator.innerText().catch(() => '(no title)');
                const titleHandle = await titleLocator.elementHandle().catch(() => null);

                let href = null;
                if (titleHandle) {
                    href = await page.evaluate(el => {
                        let cur = el;
                        // Walk up a few levels to find the parent <a> tag
                        for (let i = 0; i < 5 && cur; i++) {
                            if (cur.tagName === 'A' && cur.href) return cur.href;
                            cur = cur.parentElement;
                        }
                        return null;
                    }, titleHandle).catch(() => null);
                }
                
                if (href) {
                    const full = href.startsWith('http') ? href : (BASE + href);
                    links.push({ title: title.trim(), url: full });
                }
            }
        }

        return links;
    } catch (e) {
        console.error('collectSeminarLinks error', e && e.stack ? e.stack : e);
        return [];
    }
}

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
        const seminarLinks = await collectSeminarLinks(page);
        const quizLink = await collectQuizLink(page);

        let message = '';
        if (seminarLinks && seminarLinks.length > 0) {
            message += `오늘의 세미나 (${seminarLinks.length}):\n`;
            seminarLinks.forEach((s, i) => {
                message += `${i + 1}. ${s.title}\n${s.url}\n`;
            });
        } else {
            message += '오늘의 세미나가 없습니다.\n';
        }

        message += '\n';
        if (quizLink) {
            message += `오늘의 퀴즈 링크:\n${quizLink}\n`;
        } else {
            message += '오늘의 퀴즈 링크가 없습니다.\n';
        }

        return { success: true, message };
    } catch (e) {
        console.error('today_links task error', e && e.stack ? e.stack : e);
        return { success: false, message: `today_links 작업 오류: ${e && e.message ? e.message : String(e)}` };
    }
}

module.exports = { run };
