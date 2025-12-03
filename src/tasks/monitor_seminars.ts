import type { BrowserContext, Page } from 'playwright';
import { safeGoto, sendNotificationToChannel, sendTelegram, getSeminarIdFromUrl, escapeMarkdown } from '../modules/utils';
// import * as keyMessageMonitor from './monitor_key_messages';

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const BASE_URL = 'https://www.doctorville.co.kr';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';

// Helper function for random delay
const randomDelay = (): Promise<void> => {
  const minMs = 60 * 1000; // 1 minute
  const maxMs = 3 * 60 * 1000; // 3 minutes
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs); // 1 to 3 minutes in ms
  return new Promise((resolve) => setTimeout(resolve, delay));
};

// Helper function to get today's seminars within a specific time range
type SeminarInfo = { status: string; name: string; seminarId: string | null };

async function getTodaysSeminars(page: Page, startHour: number, endHour: number): Promise<Record<string, SeminarInfo>> {
  const seminars: Record<string, SeminarInfo> = {};

  const container = await page.locator('.list_cont').first();
  const seminarDay = await container
    .locator('.seminar_day .date')
    .innerText()
    .catch(() => '');

  const now = new Date();
  const month = now.toLocaleDateString('en-US', { month: 'numeric', timeZone: 'Asia/Seoul' });
  const day = now.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'Asia/Seoul' });
  const todayString = `${month}/${day}`;

  console.log(
    `[monitor_seminars] Getting Today seminar lists... Today's date string: ${todayString}, Seminar day string: ${seminarDay}`,
  );

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
        const seminarId = getSeminarIdFromUrl(fullUrl);
        const statusElement = detail.locator('.progress .ico_box');
        const statusText = (await statusElement.count()) > 0 ? await statusElement.innerText() : '상태없음';
        const seminarName = await detail.locator('.list_tit .tit').first().innerText();
        seminars[fullUrl] = { status: statusText, name: seminarName, seminarId: seminarId };
      }
    }
  } else {
    console.log('[monitor_seminars] No seminars on today...');
  }

  return seminars;
}

async function monitorSeminars(
  { page, context }: { page: Page; context: BrowserContext },
  periodName: string,
  startHour: number,
  endHour: number,
) {
  let monitoringList: Record<string, { status: string; name: string; seminarId: string | null }> = {};

  try {
    // Initial population of the monitoring list
    await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

    const initialSeminars = await getTodaysSeminars(page, startHour, endHour);
    monitoringList = { ...initialSeminars } as Record<
      string,
      { status: string; name: string; seminarId: string | null }
    >; // Track all seminars from the start

    for (const [url, { status, name, seminarId }] of Object.entries(initialSeminars)) {
      // If a seminar is already open, start its key message monitor immediately
      if (status === '입장하기') {
        console.log(`[${periodName}] Seminar already available: ${name}`);
        await sendTelegram(`[${periodName}] Seminar already available: ${name}`);
        const targetUrl = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : url;
        const messagePrefix = escapeMarkdown(`${name} 세미나 입장이 시작되었습니다.`);
        await sendNotificationToChannel(`${messagePrefix} [바로가기](${escapeMarkdown(targetUrl)})`, null, {
          parse_mode: 'MarkdownV2',
        });
        // const newPage = await context.newPage();
        // keyMessageMonitor
        //   .monitor({ page: newPage, context }, url, name)
        //   .catch((e) => console.error(`Key message monitor failed for ${name}`, e));
      }
    }

    if (Object.keys(monitoringList).length === 0) {
      await sendTelegram(`[${periodName}] ${periodName}에 감시할 세미나가 없습니다.`);
      return true;
    }

    const initialSeminarNames = Object.values(monitoringList)
      .map((s) => `  - ${s.name} (${s.status})`)
      .join('\n');
    await sendTelegram(
      `[${periodName}] 총 ${Object.keys(monitoringList).length}개의 세미나 감시를 시작합니다.\n${initialSeminarNames}`,
    );

    // Monitoring loop
    while (Object.keys(monitoringList).length > 0) {
      // const statusMessage =
      //   `[${periodName}] 현재 ${Object.keys(monitoringList).length}개의 세미나를 감시중입니다.\n` +
      //   Object.values(monitoringList)
      //     .map((s) => `  - ${s.name} (${s.status})`)
      //     .join('\n');
      // await sendTelegram(statusMessage);

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

      const monitoredUrls = [...Object.keys(monitoringList)];
      for (const url of monitoredUrls) {
        const monitoredInfo = monitoringList[url];

        // 1. Check if the seminar has disappeared from the page
        if (!currentSeminarsOnPage[url]) {
          const targetUrl = monitoredInfo.seminarId ? `${SEMINAR_DETAIL_PAGE}${monitoredInfo.seminarId}` : url;
          const messagePrefix = escapeMarkdown(`${monitoredInfo.name} 세미나가 종료되었습니다. 설문 입장해주세요.`);
          await sendNotificationToChannel(`${messagePrefix} [바로가기](${escapeMarkdown(targetUrl)})`, null, {
            parse_mode: 'MarkdownV2',
          });
          delete monitoringList[url]; // Remove from monitoring
          continue; // Move to the next seminar
        }

        // 2. If it still exists, get its new state
        const { status: newStatus, name: newName, seminarId: newSeminarId } = currentSeminarsOnPage[url];
        const oldStatus = monitoredInfo.status;

        // 3. Check for status change from '신청완료' to '입장하기'
        if (newStatus === '입장하기' && oldStatus === '신청완료') {
          console.log(`[${periodName}] Seminar ready for entry: ${newName}. Starting key message monitor.`);
          const targetUrl = newSeminarId ? `${SEMINAR_DETAIL_PAGE}${newSeminarId}` : url;
          const messagePrefix = escapeMarkdown(`${newName} 세미나 입장이 시작되었습니다.`);
          await sendNotificationToChannel(`${messagePrefix} [바로가기](${escapeMarkdown(targetUrl)})`, null, {
            parse_mode: 'MarkdownV2',
          });

          // const newPage = await context.newPage();
          // keyMessageMonitor
          //   .monitor({ page: newPage, context }, url, newName)
          //   .catch((e) => console.error(`Key message monitor failed for ${newName}`, e));
        }

        // 4. Always update the seminar's status and name in the monitoring list
        monitoringList[url] = { status: newStatus, name: newName, seminarId: newSeminarId };
      }
    }

    await sendTelegram(`[${periodName}] 세미나 감시를 종료합니다.`);
    return true;
  } catch (e) {
    console.error(
      `[${periodName}] seminar monitoring task error`,
      e && typeof e === 'object' && 'stack' in e ? (e as Error).stack : e,
    );
    const message = e instanceof Error ? e.message : String(e);
    await sendTelegram(`❗ [${periodName}] 세미나 감시 작업 오류: ${message}`).catch(() => { });
    return false;
  }
}

export { monitorSeminars };
