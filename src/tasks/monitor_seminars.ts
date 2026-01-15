import type { BrowserContext, Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { safeGoto, sendNotificationToChannel, sendTelegram, getSeminarIdFromUrl } from '../modules/utils';
import * as storage from '../services/storage';

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
type SeminarInfo = {
  status: string;
  name: string;
  seminarId: string | null;
  hasSurvey?: boolean;
  isEntryStarted?: boolean;
};
type StoredSeminarIds = { date: string; lunchSeminarIds: string[]; dinnerSeminarIds: string[] };
type SeminarBucketKey = 'lunchSeminarIds' | 'dinnerSeminarIds';

const seoulDateString = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

async function checkSurveyExistence(context: BrowserContext, url: string): Promise<boolean> {
  const page = await context.newPage();
  try {
    await safeGoto(page, url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

    // Check for "설문참여" button
    const surveyBtn = page.locator('text="설문참여"').first();
    const isSurveyButtonVisible = await surveyBtn.isVisible({ timeout: 5000 }).catch(() => false);

    // Check for badge with inner text "설문" and class "seminar-badge"
    const surveyBadge = page.locator('.seminar-badge', { hasText: '설문' }).first();
    const isSurveyBadgeVisible = await surveyBadge.isVisible({ timeout: 5000 }).catch(() => false);

    return isSurveyButtonVisible || isSurveyBadgeVisible;
  } catch (e) {
    console.warn(`[checkSurveyExistence] Failed to check survey for ${url}`, e);
    // If check fails, assume it exists to be safe (or false? User wants to suppress if *missing*. Safe default is true.)
    // But if we error out, maybe we shouldn't suppress the end notification.
    return true;
  } finally {
    await page.close().catch(() => {});
  }
}

async function isSeminarEnded(
  context: BrowserContext,
  seminar: { name: string; seminarId: string | null },
  fallbackUrl: string,
): Promise<boolean> {
  const targetUrl = seminar.seminarId ? `${SEMINAR_DETAIL_PAGE}${seminar.seminarId}` : fallbackUrl;
  const detailPage = await context.newPage();
  const screenshotPath = path.join(process.cwd(), `screenshot_end_check_${seminar.seminarId || Date.now()}.png`);

  try {
    await safeGoto(detailPage, targetUrl, { waitUntil: 'commit', timeout: 15000 }, 2);
    await detailPage.reload({ waitUntil: 'networkidle', timeout: 15000 });
    const surveyEnded = await detailPage.locator('text="세미나 종료"').first().isVisible({ timeout: 2000 });
    const canCancel = await detailPage.locator('text="신청 취소"').first().isVisible({ timeout: 2000 });
    console.log(`[monitor_seminars] Seminar end check (${seminar.name}): ${surveyEnded}, ${canCancel}`);

    await detailPage.screenshot({ path: screenshotPath, fullPage: false });
    if (!canCancel) {
      await sendTelegram(`[종료 확인 모니터 중] ${seminar.name}? ${surveyEnded} `, screenshotPath);
    }
    await fs
      .unlink(screenshotPath)
      .catch((err) => console.error(`Failed to delete screenshot: ${screenshotPath}`, err));
    return surveyEnded;
  } catch (e) {
    console.error(
      `[monitor_seminars] 종료 여부 확인 실패 (${seminar.name})`,
      e && typeof e === 'object' && 'stack' in e ? (e as Error).stack : e,
    );
    return false;
  } finally {
    await detailPage.close().catch(() => {});
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
  let monitoringList: Record<string, SeminarInfo> = {};
  const todayIsoDate = seoulDateString();
  const bucketKey: SeminarBucketKey = periodName === '점심' ? 'lunchSeminarIds' : 'dinnerSeminarIds';

  try {
    // Initial population of the monitoring list
    await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

    const initialSeminars = await getTodaysSeminars(page, startHour, endHour);
    monitoringList = { ...initialSeminars };

    for (const [url, { status, name, seminarId }] of Object.entries(initialSeminars)) {
      // If a seminar is already open, start its key message monitor immediately
      if (status === '입장하기') {
        console.log(`[${periodName}] Seminar already available: ${name}`);
        await sendTelegram(`[${periodName}] Seminar already available: ${name}`);
        const targetUrl = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : url;

        // Check for survey existence
        const hasSurvey = await checkSurveyExistence(context, targetUrl);
        monitoringList[url].hasSurvey = hasSurvey;
        monitoringList[url].isEntryStarted = true;

        let message = `**${name}** 세미나 입장이 시작되었습니다.`;
        if (!hasSurvey) {
          message += ` (설문이 없는 세미나인 것 같습니다)`;
        }
        await sendNotificationToChannel(`${message}\n${targetUrl}`);
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
      const currentTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
      if (currentTime.getHours() >= endHour) {
        const remainingSeminars = Object.values(monitoringList).map(
          (s) => `**${s.name}** (${SEMINAR_DETAIL_PAGE}${s.seminarId})`,
        );
        if (remainingSeminars.length > 0) {
          let message = ` ${periodName} 모니터링 시간이 종료되었지만, 마치지 않은 세미나가 있습니다:\n`;
          message += remainingSeminars.join('\n');
          await sendNotificationToChannel(message);
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
          await sendNotificationToChannel(`오늘 새로 추가된 세미나가 있습니다. ${name} ${targetUrl}`);
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
        const mergedSeminarInfo: SeminarInfo = {
          name: currentInfo?.name || monitoredInfo.name,
          status: currentInfo?.status || monitoredInfo.status,
          seminarId: currentInfo?.seminarId || monitoredInfo.seminarId,
          hasSurvey: monitoredInfo.hasSurvey, // Preserve hasSurvey state
          isEntryStarted: monitoredInfo.isEntryStarted, // Preserve isEntryStarted state
        };

        let ended = false;

        // Only check for end if the seminar entry has started (notice sent).
        if (mergedSeminarInfo.isEntryStarted) {
          if (mergedSeminarInfo.hasSurvey === false) {
            if (!currentInfo) {
              // If survey is not required and seminar disappeared from the list, consider it ended/removed
              ended = true;
            }
          } else {
            ended = await isSeminarEnded(context, mergedSeminarInfo, url);
          }
        }

        // 1. Check seminar end by visiting detail page
        if (ended) {
          // Only send end notification if survey was present (or unknown, default to true/undefined)
          if (mergedSeminarInfo.hasSurvey !== false) {
            const targetUrl = mergedSeminarInfo.seminarId
              ? `${SEMINAR_DETAIL_PAGE}${mergedSeminarInfo.seminarId}`
              : url;
            const message = `**${mergedSeminarInfo.name}** 세미나가 종료되었습니다. 설문 입장해주세요.\n${targetUrl}`;
            await sendNotificationToChannel(message);
          } else {
            console.log(
              `[monitor_seminars] Skipping end notification for ${mergedSeminarInfo.name} because it has no survey.`,
            );
          }
          delete monitoringList[url]; // Remove from monitoring
          continue; // Move to the next seminar
        }

        // 2. If it still exists, get its new state
        const { status: newStatus, name: newName } = currentInfo || monitoredInfo;
        const oldStatus = monitoredInfo.status;

        // 3. Check for status change from '신청완료' to '입장하기'
        if (currentInfo && newStatus === '입장하기' && oldStatus === '신청완료') {
          console.log(`[${periodName}] Seminar ready for entry: ${newName}.`);
          const targetUrl = mergedSeminarInfo.seminarId ? `${SEMINAR_DETAIL_PAGE}${mergedSeminarInfo.seminarId}` : url;

          // Check for survey existence
          const hasSurvey = await checkSurveyExistence(context, targetUrl);

          let message = `**${newName}** 세미나 입장이 시작되었습니다.`;
          if (!hasSurvey) {
            message += ` (설문이 없는 세미나인 것 같습니다)`;
          }
          await sendNotificationToChannel(`${message}\n${targetUrl}`);

          // Update hasSurvey in merged info so it gets saved to monitoringList
          mergedSeminarInfo.hasSurvey = hasSurvey;
          mergedSeminarInfo.isEntryStarted = true;
        }

        // 4. Always update the seminar's status and name in the monitoring list
        if (currentInfo) {
          monitoringList[url] = {
            status: newStatus,
            name: newName,
            seminarId: mergedSeminarInfo.seminarId,
            hasSurvey: mergedSeminarInfo.hasSurvey,
            isEntryStarted: mergedSeminarInfo.isEntryStarted,
          };
        } else {
          monitoringList[url] = mergedSeminarInfo;
        }
      }
    }

    await sendTelegram(`[${periodName}] 세미나 감시를 종료합니다.`);
    const finishMessage = `🏁${todayIsoDate}의 ${periodName}세미나 모니터링이 종료되었습니다.🏁`;
    await sendNotificationToChannel(finishMessage);

    return true;
  } catch (e) {
    console.error(
      `[${periodName}] seminar monitoring task error`,
      e && typeof e === 'object' && 'stack' in e ? (e as Error).stack : e,
    );
    const message = e instanceof Error ? e.message : String(e);
    await sendTelegram(`❗ [${periodName}] 세미나 감시 작업 오류: ${message}`).catch(() => {});
    return false;
  }
}

export { monitorSeminars };
