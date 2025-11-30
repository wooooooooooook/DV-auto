const { safeGoto, sendTelegram } = require('../modules/utils');

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';

async function run({ page, context, env }) {
    try {
        await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

        const firstSeminar = await page.locator('.list_cont').nth(0);
        const seminarDay = await firstSeminar.locator('.seminar_day').innerText();

        const now = new Date();
        const month = now.toLocaleDateString('en-US', { month: 'numeric', timeZone: 'Asia/Seoul' });
        const day = now.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'Asia/Seoul' });
        const todayString = `${month}/${day}`;

        if (seminarDay === todayString) {
            const seminarDetails = await firstSeminar.locator('.list_detail');
            const count = await seminarDetails.count();

            const lunchSeminars = [];
            const dinnerSeminars = [];

            for (let i = 0; i < count; i++) {
                const detail = seminarDetails.nth(i);
                const timeStr = await detail.locator('.txt_num.time').first().innerText();
                const title = await detail.locator('.list_tit').innerText();
                const hour = parseInt(timeStr.split(':')[0], 10);

                const seminarInfo = `${timeStr}. ${title}`;

                if (hour >= 11 && hour < 14) {
                    lunchSeminars.push(seminarInfo);
                } else if (hour >= 17 && hour < 20) {
                    dinnerSeminars.push(seminarInfo);
                }
            }

            let message = `오늘 점심 ${lunchSeminars.length}개, 저녁 ${dinnerSeminars.length}개의 세미나가 있습니다.\n`;

            if (lunchSeminars.length > 0) {
                message += `\n[점심 세미나]\n`;
                message += lunchSeminars.join('\n');
            }

            if (dinnerSeminars.length > 0) {
                message += `\n[저녁 세미나]\n`;
                message += dinnerSeminars.join('\n');
            }

            if (lunchSeminars.length === 0 && dinnerSeminars.length === 0) {
                await sendTelegram('오늘 점심/저녁 세미나가 없습니다.');
            } else {
                await sendTelegram(message);
            }
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
