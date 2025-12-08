import type { BrowserContext, Page } from 'playwright';
import {
  safeGoto,
  sendNotificationToChannel,
  sendTelegram,
  getSeminarIdFromUrl,
  escapeMarkdownV2,
} from '../modules/utils';
import * as storage from '../services/storage';
// import * as keyMessageMonitor from './monitor_key_messages';

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const BASE_URL = 'https://www.doctorville.co.kr';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
const TODAY_SEMINAR_KEY = 'today_seminars';

// Helper function for random delay
const randomDelay = (): Promise<void> => {
  const minMs = 60 * 1000; // 1 minute
  const maxMs = 3 * 60 * 1000; // 3 minutes
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs); // 1 to 3 minutes in ms
  return new Promise((resolve) => setTimeout(resolve, delay));
};

// Helper function to get today's seminars within a specific time range
type SeminarInfo = { status: string; name: string; seminarId: string | null };
type StoredSeminarIds = { date: string; lunchSeminarIds: string[]; dinnerSeminarIds: string[] };
type SeminarBucketKey = 'lunchSeminarIds' | 'dinnerSeminarIds';

const seoulDateString = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

async function isSeminarEnded(
  context: BrowserContext,
  seminar: { name: string; seminarId: string | null },
  fallbackUrl: string,
): Promise<boolean> {
  const targetUrl = seminar.seminarId ? `${SEMINAR_DETAIL_PAGE}${seminar.seminarId}` : fallbackUrl;
  const detailPage = await context.newPage();

  try {
    await safeGoto(detailPage, targetUrl, { waitUntil: 'networkidle', timeout: 15000 }, 1);
    const surveyEnded = await detailPage.locator('.survey-end').first().isVisible({ timeout: 2000 });
    console.log(`[monitor_seminars] Seminar end check (${seminar.name}): ${surveyEnded}`);
    return surveyEnded;
  } catch (e) {
    console.error(
      `[monitor_seminars] 종료 여부 확인 실패 (${seminar.name})`,
      e && typeof e === 'object' && 'stack' in e ? (e as Error).stack : e,
    );
    return false;
  } finally {
    await detailPage.close().catch(() => { });
  }
}

function getStoredSeminarsForToday(todayIsoDate: string): StoredSeminarIds | null {
  const stored = storage.get<StoredSeminarIds>(TODAY_SEMINAR_KEY);
  if (!stored || stored.date !== todayIsoDate) return null;
  return {
    date: stored.date,
    lunchSeminarIds: stored.lunchSeminarIds || [],
    dinnerSeminarIds: stored.dinnerSeminarIds || [],
  };
}

function updateStoredSeminars(
  todayIsoDate: string,
  targetList: SeminarBucketKey,
  seminarId: string,
  current: StoredSeminarIds | null,
): StoredSeminarIds {
  const base = current || { date: todayIsoDate, lunchSeminarIds: [], dinnerSeminarIds: [] };
  const updated = {
    date: todayIsoDate,
    lunchSeminarIds: [...base.lunchSeminarIds],
    dinnerSeminarIds: [...base.dinnerSeminarIds],
  };
  if (!updated[targetList].includes(seminarId)) {
    updated[targetList].push(seminarId);
  }
  storage.set(TODAY_SEMINAR_KEY, updated);
  return updated;
}

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
  const todayIsoDate = seoulDateString();
  const bucketKey: SeminarBucketKey = periodName === '점심' ? 'lunchSeminarIds' : 'dinnerSeminarIds';

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
        const messagePrefix = `**${escapeMarkdownV2(name)}** ${escapeMarkdownV2('세미나 입장이 시작되었습니다.')}`;
        await sendNotificationToChannel(`${messagePrefix} [바로가기](${targetUrl})`, null, {
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
        const remainingSeminars = Object.values(monitoringList).map(
          (s) => `**${s.name}** (${SEMINAR_DETAIL_PAGE}${s.seminarId})`,
        );
        if (remainingSeminars.length > 0) {
          let message = ` ${escapeMarkdownV2(periodName)} ${escapeMarkdownV2('모니터링 시간이 종료되었지만, 마치지 않은 세미나가 있습니다:')}\n`;
          message += remainingSeminars.join('\n');
          await sendNotificationToChannel(message, null, {
            parse_mode: 'MarkdownV2',
          });
        }
        break;
      }

      await randomDelay();

      await page.reload({ waitUntil: 'load', timeout: 30000 });

      const currentSeminarsOnPage = await getTodaysSeminars(page, startHour, endHour);
      let storedSeminars = getStoredSeminarsForToday(todayIsoDate);
      const storedSeminarIdSet = storedSeminars
        ? new Set([...(storedSeminars.lunchSeminarIds || []), ...(storedSeminars.dinnerSeminarIds || [])])
        : null;

      for (const [url, info] of Object.entries(currentSeminarsOnPage)) {
        const { seminarId, name } = info;
        if (storedSeminarIdSet && seminarId && !storedSeminarIdSet.has(seminarId)) {
          const targetUrl = `${SEMINAR_DETAIL_PAGE}${seminarId}`;
          await sendNotificationToChannel(`새로 추가된 세미나가 있습니다. ${name} ${targetUrl}`);
          storedSeminars = updateStoredSeminars(todayIsoDate, bucketKey, seminarId, storedSeminars);
          storedSeminarIdSet.add(seminarId);
        }

        if (!monitoringList[url]) {
          monitoringList[url] = info;
        }
      }

      const monitoredUrls = [...Object.keys(monitoringList)];
      for (const url of monitoredUrls) {
        const monitoredInfo = monitoringList[url];

        const currentInfo = currentSeminarsOnPage[url];
        const mergedSeminarInfo = {
          name: currentInfo?.name || monitoredInfo.name,
          status: currentInfo?.status || monitoredInfo.status,
          seminarId: currentInfo?.seminarId || monitoredInfo.seminarId,
        };
        const ended = await isSeminarEnded(context, mergedSeminarInfo, url);

        // 1. Check seminar end by visiting detail page
        if (ended) {
          const targetUrl = mergedSeminarInfo.seminarId ? `${SEMINAR_DETAIL_PAGE}${mergedSeminarInfo.seminarId}` : url;
          const messagePrefix = `**${escapeMarkdownV2(mergedSeminarInfo.name)}** ${escapeMarkdownV2('세미나가 종료되었습니다. 설문 입장해주세요.')}`;
          await sendNotificationToChannel(`${messagePrefix} [바로가기](${targetUrl})`, null, {
            parse_mode: 'MarkdownV2',
          });
          delete monitoringList[url]; // Remove from monitoring
          continue; // Move to the next seminar
        }

        // 2. If it still exists, get its new state
        const { status: newStatus, name: newName } = currentInfo || monitoredInfo;
        const oldStatus = monitoredInfo.status;

        // 3. Check for status change from '신청완료' to '입장하기'
        if (currentInfo && newStatus === '입장하기' && oldStatus === '신청완료') {
          console.log(`[${periodName}] Seminar ready for entry: ${newName}. Starting key message monitor.`);
          const targetUrl = mergedSeminarInfo.seminarId ? `${SEMINAR_DETAIL_PAGE}${mergedSeminarInfo.seminarId}` : url;
          const messagePrefix = `**${escapeMarkdownV2(newName)}** ${escapeMarkdownV2('세미나 입장이 시작되었습니다.')}`;
          await sendNotificationToChannel(`${messagePrefix} [바로가기](${targetUrl})`, null, {
            parse_mode: 'MarkdownV2',
          });

          // const newPage = await context.newPage();
          // keyMessageMonitor
          //   .monitor({ page: newPage, context }, url, newName)
          //   .catch((e) => console.error(`Key message monitor failed for ${newName}`, e));
        }

        // 4. Always update the seminar's status and name in the monitoring list
        if (currentInfo) {
          monitoringList[url] = {
            status: newStatus,
            name: newName,
            seminarId: mergedSeminarInfo.seminarId,
          };
        } else {
          monitoringList[url] = mergedSeminarInfo;
        }
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
