const { safeGoto, sendNotificationToChannel } = require('../modules/utils');

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const BASE_URL = 'https://www.doctorville.co.kr';

// Helper function for random delay
const randomDelay = () => {
    const delay = Math.floor(Math.random() * (10 - 5 + 1) + 5) * 60 * 1000; // 5 to 10 minutes in ms
    return new Promise(resolve => setTimeout(resolve, delay));
};

// Helper function to get today's seminars within a specific time range
async function getTodaysSeminars(page, startHour, endHour) {
    const seminars = {}; // href -> { status }

    const listConts = await page.locator('.list_cont');
    const count = await listConts.count();

    const now = new Date();
    const month = now.toLocaleDateString('en-US', { month: 'numeric', timeZone: 'Asia/Seoul' });
    const day = now.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'Asia/Seoul' });
    const todayString = `${month}/${day}`;

    for (let i = 0; i < count; i++) {
        const container = listConts.nth(i);
        const seminarDay = await container.locator('.seminar_day').innerText();

        if (seminarDay === todayString) {
            const seminarDetails = await container.locator('.list_detail');
            const detailCount = await seminarDetails.count();

            for (let j = 0; j < detailCount; j++) {
                const detail = seminarDetails.nth(j);
                const timeStr = await detail.locator('.txt_num.time').first().innerText();
                const hour = parseInt(timeStr.split(':')[0], 10);

                if (hour >= startHour && hour < endHour) {
                    const href = await detail.locator('a').first().getAttribute('href');
                    const fullUrl = `${BASE_URL}${href}`;
                    const statusElement = detail.locator('.progress .ico_box');
                    const statusText = await statusElement.count() > 0 ? await statusElement.innerText() : '상태없음';
                    seminars[fullUrl] = { status: statusText };
                }
            }
            break; // Found today's seminars, no need to check other containers
        }
    }
    return seminars;
}

async function monitorSeminars({ page, context, env }, periodName, startHour, endHour) {
    let monitoringList = {}; // href -> status

    try {
        await sendNotificationToChannel(`[${periodName}] 세미나 감시를 시작합니다.`);

        // Initial population of the monitoring list
        await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

        const initialSeminars = await getTodaysSeminars(page, startHour, endHour);
        for (const [url, { status }] of Object.entries(initialSeminars)) {
             monitoringList[url] = status;
             if (status === '입장가능' || status === '입장하기') {
                await sendNotificationToChannel(`세미나 입장 가능합니다 ${url}`);
                delete monitoringList[url]; // Remove from monitoring
             }
        }

        if (Object.keys(monitoringList).length === 0) {
            await sendNotificationToChannel(`[${periodName}] 감시할 세미나가 없습니다. 태스크를 종료합니다.`);
            return true;
        }

        // Monitoring loop
        while (Object.keys(monitoringList).length > 0) {
            const currentTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
            if (currentTime.getHours() >= endHour) {
                const remainingSeminars = Object.keys(monitoringList);
                if (remainingSeminars.length > 0) {
                    let message = `[${periodName}] 모니터링 시간이 종료되었지만, 마치지 않은 세미나가 있습니다:\n`;
                    message += remainingSeminars.join('\n');
                    await sendNotificationToChannel(message);
                }
                break;
            }

            await randomDelay();

            await page.reload({ waitUntil: 'load', timeout: 30000 });

            const currentSeminarsOnPage = await getTodaysSeminars(page, startHour, endHour);

            const monitoredUrls = [...Object.keys(monitoringList)]; // Create a copy to iterate over
            for (const url of monitoredUrls) {
                if (!currentSeminarsOnPage[url]) {
                    // Seminar disappeared from the list
                    await sendNotificationToChannel(`세미나가 종료되었습니다. ${url}`);
                    delete monitoringList[url];
                } else {
                    // Seminar still exists, check status
                    const newStatus = currentSeminarsOnPage[url].status;
                    if ((newStatus === '입장가능' || newStatus === '입장하기') && monitoringList[url] === '신청완료') {
                         await sendNotificationToChannel(`세미나 입장 가능합니다 ${url}`);
                         delete monitoringList[url];
                    } else {
                         monitoringList[url] = newStatus; // Update status
                    }
                }
            }
        }

        await sendNotificationToChannel(`[${periodName}] 세미나 감시를 종료합니다.`);
        return true;

    } catch (e) {
        console.error(`[${periodName}] seminar monitoring task error`, e && e.stack ? e.stack : e);
        await sendNotificationToChannel(`❗ [${periodName}] 세미나 감시 작업 오류: ${e && e.message ? e.message : String(e)}`).catch(() => {});
        return false;
    }
}

module.exports = { monitorSeminars };
