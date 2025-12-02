const { safeGoto, sendTelegram, getSeminarIdFromUrl } = require('../modules/utils');

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const BASE_URL = 'https://www.doctorville.co.kr/'
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/'

async function run({ page, context }) {
    try {
        await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

        const listConts = await page.locator('.list_cont');
        const count = await listConts.count();

        const now = new Date();
        const month = now.toLocaleDateString('en-US', { month: 'numeric', timeZone: 'Asia/Seoul' });
        const day = now.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'Asia/Seoul' });
        const todayString = `${month}/${day}`;

        const lunchSeminars = [];
        const dinnerSeminars = [];

        for (let i = 0; i < count; i++) {
            const container = listConts.nth(i);
            const seminarDay = await container.locator('.seminar_day .date').innerText().catch(() => '');
            if (seminarDay !== todayString) continue;

            const seminarDetails = await container.locator('.list_detail');
            const dcount = await seminarDetails.count();

            for (let j = 0; j < dcount; j++) {
                const detail = seminarDetails.nth(j);
                const timeElem = detail.locator('.txt_num.time').first();
                const timeRaw = await timeElem.innerText();
                const time = timeRaw.replace(/\n/g, '').trim();
                const title = await detail.locator('.list_tit .tit').innerText();
                const classAttr = (await timeElem.getAttribute('class')) || '';
                const href = await detail.getAttribute('href');
                const fullUrl = new URL(href, BASE_URL).toString();
                const seminarId = getSeminarIdFromUrl(fullUrl);
                let seminarLink = '';
                if (seminarId) {
                    seminarLink = `${SEMINAR_DETAIL_PAGE}${seminarId}`;
                } else {
                    seminarLink = fullUrl; // Fallback to original full URL if ID not found
                }
                const seminarInfo = `　${time}. ${title} ${seminarLink}`;

                // If the time element has the `night_time` class treat as dinner, otherwise lunch
                if (classAttr.includes('night_time')) {
                    dinnerSeminars.push(seminarInfo);
                } else {
                    lunchSeminars.push(seminarInfo);
                }
            }
        }

        if (lunchSeminars.length > 0 || dinnerSeminars.length > 0) {
            let message = `오늘의 세미나 리스트: 점심 ${lunchSeminars.length}개, 저녁 ${dinnerSeminars.length}개\n`;

            if (lunchSeminars.length > 0) {
                message += `\n🍴[점심 세미나]\n`;
                message += lunchSeminars.join('\n');
            }

            if (dinnerSeminars.length > 0) {
                message += `\n🍴[저녁 세미나]\n`;
                message += dinnerSeminars.join('\n');
            }
            return { success: true, message };
        }
        else {
            return { success: true, message: '오늘의 세미나 리스트: 오늘은 세미나가 없습니다.' };
        }
    } catch (e) {
        console.error('seminar check task error', e && e.stack ? e.stack : e);
        // Return result to caller, do not send telegram message from here
        return { success: false, message: `세미나 확인 작업 오류: ${e && e.message ? e.message : String(e)}` };
    }
}

module.exports = { run };
