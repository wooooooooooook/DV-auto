const { safeGoto, sendTelegram } = require('../modules/utils');

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';

async function run({ page, context }) {
    try {
        await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

        const seminarContainers = await page.locator('.list_cont').all();
        let message = '앞으로 5일간의 세미나 일정입니다.\n\n';
        let foundSeminars = false;

        for (let i = 0; i < Math.min(seminarContainers.length, 5); i++) {
            const container = seminarContainers[i];
            const seminarDay = await container.locator('.seminar_day .date').innerText();
            const seminarDetails = await container.locator('.list_detail').all();

            if (seminarDetails.length > 0) {
                foundSeminars = true;
                const lunchSeminars = [];
                const dinnerSeminars = [];

                for (const detail of seminarDetails) {
                    const timeElem = detail.locator('.txt_num.time').first();
                    const timeRaw = await timeElem.innerText();
                    const time = timeRaw.replace(/\n/g, '').trim();
                    const title = await detail.locator('.list_tit .tit').innerText();
                    const classAttr = (await timeElem.getAttribute('class')) || '';
                    const seminarInfo = `　${time} - ${title}`;

                    if (classAttr.includes('night_time')) {
                        dinnerSeminars.push(seminarInfo);
                    } else {
                        lunchSeminars.push(seminarInfo);
                    }
                }

                message += `🗓️\[${seminarDay}\]\n`;
                message += `점심 ${lunchSeminars.length}개, 저녁 ${dinnerSeminars.length}개\n`;

                if (lunchSeminars.length > 0) {
                    message += `\n🍴[점심 세미나]\n`;
                    message += lunchSeminars.join('\n') + '\n';
                }

                if (dinnerSeminars.length > 0) {
                    message += `\n🍴[저녁 세미나]\n`;
                    message += dinnerSeminars.join('\n') + '\n';
                }

                message += '\n';
            }
        }

        if (!foundSeminars) {
            message = '앞으로 5일간 예정된 세미나가 없습니다.';
        }

        return { success: true, message };
    } catch (e) {
        console.error('5days seminar check task error', e && e.stack ? e.stack : e);
        // Notify admin about the error, but return the error to caller
        await sendTelegram(`❗ 5일 세미나 확인 작업 오류: ${e && e.message ? e.message : String(e)}`).catch(() => { });
        return { success: false, message: `5일 세미나 확인 작업 오류: ${e && e.message ? e.message : String(e)}` };
    }
}

module.exports = { run };
