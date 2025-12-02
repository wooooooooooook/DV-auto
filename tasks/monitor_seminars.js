const { safeGoto, sendNotificationToChannel, sendTelegram } = require('../modules/utils');
const keyMessageMonitor = require('./monitor_key_messages');

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const BASE_URL = 'https://www.doctorville.co.kr';

// Helper function for random delay
const randomDelay = () => {
  const delay = Math.floor(Math.random() * (10 - 5 + 1) + 5) * 60 * 1000; // 5 to 10 minutes in ms
  return new Promise((resolve) => setTimeout(resolve, delay));
};

// Helper function to get today's seminars within a specific time range
async function getTodaysSeminars(page, startHour, endHour) {
  const seminars = {}; // href -> { status, name }

  const listConts = await page.locator('.list_cont');
  const count = await listConts.count();

  const now = new Date();
  const month = now.toLocaleDateString('en-US', { month: 'numeric', timeZone: 'Asia/Seoul' });
  const day = now.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'Asia/Seoul' });
  const todayString = `${month}/${day}`;

  for (let i = 0; i < count; i++) {
    const container = listConts.nth(i);
    const seminarDay = await container
      .locator('.seminar_day .date')
      .innerText()
      .catch(() => '');

    if (seminarDay === todayString) {
      const seminarDetails = await container.locator('.list_detail');
      const detailCount = await seminarDetails.count();

      for (let j = 0; j < detailCount; j++) {
        const detail = seminarDetails.nth(j);
        const timeStr = await detail.locator('.txt_num.time').first().innerText();
        const hour = parseInt(timeStr.split(':')[0], 10);

        if (hour >= startHour && hour < endHour) {
          const href = await detail.getAttribute('href');
          const fullUrl = `${BASE_URL}${href}`;
          const statusElement = detail.locator('.progress .ico_box');
          const statusText = (await statusElement.count()) > 0 ? await statusElement.innerText() : '상태없음';
          const seminarName = await detail.locator('.list_tit .tit').first().innerText();
          seminars[fullUrl] = { status: statusText, name: seminarName };
        }
      }
      break; // Found today's seminars, no need to check other containers
    }
  }
  return seminars;
}

async function monitorSeminars({ page, context }, periodName, startHour, endHour) {
  let monitoringList = {}; // href -> {status, name}

  try {
    // await sendNotificationToChannel(`[${periodName}] 세미나 감시를 시작합니다.`);

    // Initial population of the monitoring list
    await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

    const initialSeminars = await getTodaysSeminars(page, startHour, endHour);
    for (const [url, { status, name }] of Object.entries(initialSeminars)) {
      if (status === '입장하기') {
        console.log(`[${periodName}] Seminar already available: ${name}. Starting key message monitor.`);
        const newPage = await context.newPage();
        // Do not await, let it run in the background
        keyMessageMonitor
          .monitor({ page: newPage, context }, url, name)
          .catch((e) => console.error(`Key message monitor failed for ${name}`, e));
      } else {
        monitoringList[url] = { status, name };
      }
    }

    if (Object.keys(monitoringList).length === 0) {
      await sendTelegram(`[${periodName}] 감시할 세미나가 없습니다. 태스크를 종료합니다.`);
      return true;
    }

    const initialSeminarNames = Object.values(monitoringList)
      .map((s) => `  - ${s.name} (${s.status})`)
      .join('\n');
    await sendTelegram(`[${periodName}] 총 ${Object.keys(monitoringList).length}개의 세미나 감시를 시작합니다.\n${initialSeminarNames}`);

    // Monitoring loop
    while (Object.keys(monitoringList).length > 0) {
      const statusMessage =
        `[${periodName}] 현재 ${Object.keys(monitoringList).length}개의 세미나를 감시중입니다.\n` +
        Object.values(monitoringList)
          .map((s) => `  - ${s.name} (${s.status})`)
          .join('\n');
      await sendTelegram(statusMessage);

      const currentTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
      if (currentTime.getHours() >= endHour) {
        const remainingSeminars = Object.values(monitoringList).map((s) => s.name);
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
        const monitoredInfo = monitoringList[url];
        if (!monitoredInfo) continue;

        if (!currentSeminarsOnPage[url]) {
          // Seminar disappeared from the list
          await sendNotificationToChannel(`[${monitoredInfo.name}] 세미나가 목록에서 사라졌습니다.`);
          delete monitoringList[url];
        } else {
          // Seminar still exists, check status
          const { status: newStatus, name: newName } = currentSeminarsOnPage[url];
          if ((newStatus === '입장가능' || newStatus === '입장하기') && monitoredInfo.status === '신청완료') {
            console.log(`[${periodName}] Seminar ready for entry: ${newName}. Starting key message monitor.`);
            await sendNotificationToChannel(
              `[${newName}] 세미나 입장이 시작되었습니다. 키 메시지 모니터링을 시작합니다.`,
            );

            const newPage = await context.newPage();
            // Do not await, let it run in the background
            keyMessageMonitor
              .monitor({ page: newPage, context }, url, newName)
              .catch((e) => console.error(`Key message monitor failed for ${newName}`, e));

            delete monitoringList[url];
          } else {
            // Update status and name just in case
            monitoringList[url] = { status: newStatus, name: newName };
          }
        }
      }
    }

    // await sendNotificationToChannel(`[${periodName}] 세미나 감시를 종료합니다.`);
    return true;
  } catch (e) {
    console.error(`[${periodName}] seminar monitoring task error`, e && e.stack ? e.stack : e);
    await sendTelegram(
      `❗ [${periodName}] 세미나 감시 작업 오류: ${e && e.message ? e.message : String(e)}`,
    ).catch(() => {});
    return false;
  }
}

module.exports = { monitorSeminars };
