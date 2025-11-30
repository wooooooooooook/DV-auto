const { safeGoto, sendTelegram } = require('../modules/utils');

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';

async function run({ page, context, env }) {
    try {
        await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

        const firstSeminar = await page.locator('.list_cont').nth(0);
        const seminarDay = await firstSeminar.locator('.seminar_day').innerText();

        const today = new Date();
        const todayString = `${today.getMonth() + 1}/${today.getDate()}`;

        if (seminarDay === todayString) {
            const seminarDetails = await firstSeminar.locator('.list_detail');
            const count = await seminarDetails.count();
            let message = `오늘 ${count}개의 세미나가 있습니다.\n\n`;

            for (let i = 0; i < count; i++) {
                const detail = seminarDetails.nth(i);
                const num = await detail.locator('.txt_num').innerText();
                const title = await detail.locator('.list_tit').innerText();
                message += `${num}. ${title}\n`;
            }
            await sendTelegram(message);
        } else {
            await sendTelegram('오늘은 세미나가 없습니다.');
        }

        return true;
    } catch (e) {
        console.error('seminar check task error', e && e.stack ? e.stack : e);
        await sendTelegram(`❗ 세미나 확인 작업 오류: ${e && e.message ? e.message : String(e)}`).catch(() => { });
        return false;
    }
}

module.exports = { run };
