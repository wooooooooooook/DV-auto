const { safeGoto, sendTelegram } = require('../modules/utils');

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';

async function run({ page, context, env }) {
    try {
        await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

        const seminarContainers = await page.locator('.list_cont').all();
        let message = '앞으로 5일간의 세미나 일정입니다.\n\n';
        let foundSeminars = false;

        for (let i = 0; i < Math.min(seminarContainers.length, 5); i++) {
            const container = seminarContainers[i];
            const seminarDay = await container.locator('.seminar_day').innerText();
            const seminarDetails = await container.locator('.list_detail').all();

            if (seminarDetails.length > 0) {
                foundSeminars = true;
                message += `[${seminarDay}]\n`;
                for (const detail of seminarDetails) {
                    const time = await detail.locator('span.txt_num').innerText();
                    const title = await detail.locator('.list_tit').innerText();
                    message += `${time} - ${title}\n`;
                }
                message += '\n';
            }
        }

        if (!foundSeminars) {
            message = '앞으로 5일간 예정된 세미나가 없습니다.';
        }

        await sendTelegram(message);
        return true;
    } catch (e) {
        console.error('5days seminar check task error', e && e.stack ? e.stack : e);
        await sendTelegram(`❗ 5일 세미나 확인 작업 오류: ${e && e.message ? e.message : String(e)}`).catch(() => { });
        return false;
    }
}

module.exports = { run };
