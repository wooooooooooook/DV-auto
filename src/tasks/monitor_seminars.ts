import type { BrowserContext, Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import {
  safeGoto,
  sendNotificationToChannel,
  sendTelegram,
  getSeminarIdFromUrl,
  ensureLoggedIn,
  fetchSeminarDetail,
} from '../modules/utils';
import { httpGet } from '../modules/http_client';
import { parseSeminarListHtml } from '../modules/html_parser';
import { processSeminarQuiz } from './seminar_quiz';

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const BASE_URL = 'https://www.doctorville.co.kr';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
const SEMINAR_DETAIL_PC_PAGE = 'https://www.doctorville.co.kr/seminar/seminarDetail';

// Helper function for random delay
const randomDelay = (): Promise<void> => {
  const minMs = 60 * 1000; // 1 minute
  const maxMs = 3 * 60 * 1000; // 3 minutes
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs); // 1 to 3 minutes in ms
  return new Promise((resolve) => setTimeout(resolve, delay));
};

// Helper function to get today's seminars within a specific time range
export type SeminarInfo = {
  status: string;
  name: string;
  seminarId: string | null;
  hasSurvey?: boolean;
  isSurveyPointExcluded?: boolean;
  isAdvancedSurvey?: boolean;
  isEntryStarted?: boolean;
  autoEnterDone?: boolean;
};

const seoulDateString = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

export type SeminarSurveyMeta = {
  hasSurvey: boolean;
  isSurveyPointExcluded: boolean;
};

const getSeminarTrackingKey = (url: string, seminarId: string | null | undefined): string => seminarId || url;

export async function checkSurveyMeta(url: string): Promise<SeminarSurveyMeta> {
  const res = await fetchSeminarDetail(url);
  if (res.status === 'success') {
    return {
      hasSurvey: res.metadata.hasSurvey,
      isSurveyPointExcluded: res.metadata.isPointExcluded,
    };
  }
  console.warn(
    '[checkSurveyMeta] Failed to check survey via HTTP for ' + url,
    res.status === 'error' ? res.error : res.status,
  );
  return { hasSurvey: true, isSurveyPointExcluded: false };
}

export async function isSeminarEnded(
  seminar: { name: string; seminarId: string | null },
  fallbackUrl: string,
): Promise<boolean> {
  const targetUrl = seminar.seminarId ? SEMINAR_DETAIL_PAGE + seminar.seminarId : fallbackUrl;
  const res = await fetchSeminarDetail(targetUrl);
  if (res.status === 'success') {
    console.log('[monitor_seminars] Seminar end check (' + seminar.seminarId + '): isEnded=' + res.metadata.isEnded);
    return res.metadata.isEnded;
  }
  console.error(
    '[monitor_seminars] 종료 여부 확인 실패 (' + seminar.seminarId + ')',
    res.status === 'error' ? res.error : res.status,
  );
  return false;
}

/**
 * 세미나 종료 후 설문참여 버튼을 클릭하고 퀴즈를 처리하는 함수
 */
async function handleSeminarEndAndQuiz(
  context: BrowserContext,
  seminar: { name: string; seminarId: string | null; isSurveyPointExcluded?: boolean },
  fallbackUrl: string,
): Promise<{ message: string | null; foundSurveyButton: boolean }> {
  // 포인트미지급 세미나는 설문/퀴즈 처리 건너뛰기
  if (seminar.isSurveyPointExcluded) {
    console.log(
      `[monitor_seminars] Skipping quiz/survey handling for point-excluded seminar: ${seminar.name} (${seminar.seminarId})`,
    );
    return { message: null, foundSurveyButton: false };
  }
  const targetUrl = seminar.seminarId ? `${SEMINAR_DETAIL_PAGE}${seminar.seminarId}` : fallbackUrl;
  const surveyPage = await context.newPage();
  let popupPage: Page | null = null;
  let quizPage: Page = surveyPage;
  let quizResultMessage: string | null = null;
  let foundSurveyButton = false;

  try {
    await safeGoto(surveyPage, targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await surveyPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // "설문참여" 버튼 찾기
    const surveyBtn = surveyPage.locator('text="설문참여"').first();
    const isSurveyButtonVisible = await surveyBtn.isVisible({ timeout: 3000 }).catch(() => false);
    foundSurveyButton = isSurveyButtonVisible;

    if (isSurveyButtonVisible) {
      console.log(`[monitor_seminars] "설문참여" 버튼 발견, 클릭 (${seminar.seminarId})`);
      const firstPopupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await surveyBtn.click({ force: true }).catch(() => {});
      popupPage = (await firstPopupPromise) || null;
      if (popupPage) {
        quizPage = popupPage;
        await popupPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      } else {
        await surveyPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await surveyPage.waitForTimeout(1000); // 페이지 로드 대기
      }

      // 개인정보 동의 모달이 있을 경우 상태만 확인
      const consentModal = quizPage
        .locator('text="개인정보 활용에 대한 동의", text="개인정보 제3자 제공 동의서"')
        .first();
      const isConsentModalVisible = await consentModal.isVisible({ timeout: 1500 }).catch(() => false);
      if (isConsentModalVisible) {
        console.log(`[monitor_seminars] 개인정보 동의 모달 감지 (${seminar.seminarId})`);
        const agreeCheckbox = quizPage.locator('input[type="checkbox"]').first();
        const isChecked = await agreeCheckbox.isChecked().catch(() => false);
        console.log(
          `[monitor_seminars] 동의 체크박스 상태: ${isChecked ? 'checked' : 'unchecked'} (${seminar.seminarId})`,
        );
      }

      // "참여하기" 또는 "설문 참여하기" 요소 찾기 및 클릭 (button/div/span 등 태그 무관)
      const participateBtn = quizPage.locator(':text-is("설문 참여하기"), :text-is("참여하기")').first();
      const isParticipateBtnVisible = await participateBtn.isVisible({ timeout: 3000 }).catch(() => false);
      if (isParticipateBtnVisible) {
        const isParticipateBtnEnabled = await participateBtn.isEnabled().catch(() => true);
        console.log(
          `[monitor_seminars] "참여하기" 버튼 발견 (enabled=${isParticipateBtnEnabled}) (${seminar.seminarId})`,
        );

        await quizPage.waitForTimeout(1000); // UI 안정화 대기
        const beforeUrl = quizPage.url();

        const secondPopupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
        await participateBtn.click({ force: true }).catch(() => {});
        const secondPopup = (await secondPopupPromise) || null;
        if (secondPopup) {
          if (popupPage && popupPage !== quizPage) {
            await popupPage.close().catch(() => {});
          }
          popupPage = secondPopup;
          quizPage = secondPopup;
          await secondPopup.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          console.log(`[monitor_seminars] 2차 팝업 열림: ${quizPage.url()} (${seminar.seminarId})`);
        } else {
          await quizPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          await quizPage.waitForTimeout(1000);
          const afterUrl = quizPage.url();
          console.log(
            `[monitor_seminars] 2차 팝업 미감지 (samePage: ${beforeUrl} -> ${afterUrl}) (${seminar.seminarId})`,
          );
        }
      } else {
        console.log(`[monitor_seminars] "참여하기" 버튼 미감지 (${seminar.seminarId})`);
      }

      // "설문을 시작합니다" 텍스트 확인 대신 5초 대기
      await quizPage.waitForTimeout(5000);

      // 퀴즈 처리 (댓글로 결과 전송)
      const quizResult = await processSeminarQuiz(quizPage, seminar.seminarId);
      if (quizResult.success && quizResult.hasQuizResult) {
        quizResultMessage = quizResult.message;
      }
    } else {
      console.log(`[monitor_seminars] "설문참여" 버튼을 찾지 못함 (${seminar.seminarId})`);
      // 버튼이 없어도 현재 페이지에서 퀴즈 찾기 시도
      const quizResult = await processSeminarQuiz(quizPage, seminar.seminarId);
      if (quizResult.success && quizResult.hasQuizResult) {
        quizResultMessage = quizResult.message;
      }
    }
  } catch (e) {
    console.error(
      `[monitor_seminars] 설문/퀴즈 처리 실패 (${seminar.seminarId})`,
      e && typeof e === 'object' && 'stack' in e ? (e as Error).stack : e,
    );
    const message = e instanceof Error ? e.message : String(e);
    const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
    const errShotPath = path.join(
      baseScreenshotDir,
      `seminar_quiz_failed_${seminar.seminarId || Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`,
    );
    try {
      await fs.mkdir(baseScreenshotDir, { recursive: true });
      await quizPage.screenshot({ path: errShotPath, fullPage: true }).catch(() => {});
    } catch (_ssErr) {
      /* ignore */
    }
    await sendTelegram(`❗ [${seminar.name}] 세미나 퀴즈 처리 실패: ${message}\n${targetUrl}`, errShotPath).catch(
      () => {},
    );
  } finally {
    if (popupPage) {
      await popupPage.close().catch(() => {});
    }
    await surveyPage.close().catch(() => {});
  }
  return { message: quizResultMessage, foundSurveyButton };
}

export type GetTodaysSeminarsResult =
  | { success: true; seminars: Record<string, SeminarInfo> }
  | { success: false; errorType: 'AUTH_EXPIRED' | 'HTTP_ERROR'; error: string };

export async function getTodaysSeminarsHttp(startHour: number, endHour: number): Promise<GetTodaysSeminarsResult> {
  const seminars: Record<string, SeminarInfo> = {};

  const mainRes = await httpGet(SEMINAR_PAGE);
  if (mainRes.resultType === 'AUTH_EXPIRED') {
    return { success: false, errorType: 'AUTH_EXPIRED', error: 'AUTH_EXPIRED' };
  }
  if (mainRes.status !== 200 || !mainRes.body) {
    return { success: false, errorType: 'HTTP_ERROR', error: `HTTP GET failed with status ${mainRes.status}` };
  }

  const rawList = parseSeminarListHtml(mainRes.body);
  if (rawList.length === 0) {
    return { success: true, seminars };
  }

  const now = new Date();
  const month = now.toLocaleDateString('en-US', { month: 'numeric', timeZone: 'Asia/Seoul' });
  const day = now.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'Asia/Seoul' });
  const todayString = `${month}/${day}`;

  const firstDate = rawList[0]?.date || '';
  console.log(
    `[monitor_seminars] Getting Today seminar lists (HTTP)... Today's date string: ${todayString}, Seminar day string: ${firstDate}`,
  );

  if (firstDate === todayString) {
    for (const item of rawList) {
      if (item.date !== todayString) continue;
      const hour = parseInt(item.time.split(':')[0], 10);
      if (hour >= startHour && hour < endHour) {
        const fullUrl = new URL(item.url, BASE_URL).toString();
        const seminarId = getSeminarIdFromUrl(fullUrl);
        seminars[fullUrl] = {
          status: item.status || '상태없음',
          name: item.name,
          seminarId,
          isAdvancedSurvey: item.isAdvancedSurvey,
        };
      }
    }
  } else {
    console.log('[monitor_seminars] No seminars on today...');
  }

  return { success: true, seminars };
}

async function performAutoEnter(
  context: BrowserContext,
  seminarId: string | null,
  seminarName: string,
  targetUrl: string,
  screenshotKey: string,
): Promise<boolean> {
  const page = await context.newPage();
  let didEnter = false;

  try {
    console.log(`[monitor_seminars] Performing auto-enter for ${seminarId} (${targetUrl})`);

    await ensureLoggedIn({ page, context });
    await safeGoto(page, targetUrl, { waitUntil: 'networkidle', timeout: 15000 });

    const enterBtn = page.locator('text="입장하기"').first();
    if (!(await enterBtn.isVisible({ timeout: 5000 }))) {
      console.log(`[monitor_seminars] '입장하기' button not found for ${seminarId}. retry needed.`);
      const notFoundScreenshotPath = path.join(process.cwd(), `seminar_entry_notfound_${screenshotKey}.png`);
      try {
        await page.screenshot({ path: notFoundScreenshotPath, fullPage: false });
        await sendTelegram(
          `⚠️ '입장하기' 버튼을 찾지 못했습니다 (재시도 예정)\n**${seminarName}**\n${targetUrl}`,
          notFoundScreenshotPath,
        );
      } catch (ssErr) {
        console.error(`[monitor_seminars] Failed to take/send not-found screenshot for ${seminarId}`, ssErr);
      } finally {
        await fs.unlink(notFoundScreenshotPath).catch(() => {});
      }
      return false;
    }

    const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await enterBtn.click();

    const popup = await popupPromise;
    let activePage = page;

    if (popup) {
      console.log(`[monitor_seminars] Popup detected for ${seminarId}`);
      activePage = popup;
      await activePage.waitForLoadState('domcontentloaded');
    }

    console.log(`[monitor_seminars] Checking for '채널 선택' dialog after clicking '입장하기' (${seminarId})`);
    await activePage.waitForTimeout(2000);
    const channelSelectText = activePage.locator('text="채널 선택"').first();
    const isChannelSelectVisible = await channelSelectText.isVisible({ timeout: 5000 }).catch(() => false);
    if (isChannelSelectVisible) {
      console.log(`[monitor_seminars] '채널 선택' dialog detected for ${seminarId}. Clicking '확인'.`);
      const confirmBtn = activePage.locator('text="확인"').first();
      await confirmBtn.click({ force: true }).catch(() => {
        console.warn(`[monitor_seminars] Failed to click '확인' button for ${seminarId}`);
      });
      console.log(`[monitor_seminars] Clicked '확인' for channel selection (${seminarId})`);
      await activePage.waitForTimeout(3000);
    } else {
      console.log(`[monitor_seminars] No '채널 선택' dialog detected for ${seminarId}`);
    }

    console.log(`[monitor_seminars] Waiting for chat iframe to confirm seminar entry (${seminarId})`);
    await activePage.waitForTimeout(5000);

    const chatFrame = page.frames().find((f) => f.url().includes('socialstream') || f.url().includes('video.ibm.com'));
    let isQnaVisible = !!chatFrame;

    if (isQnaVisible) {
      console.log(`[monitor_seminars] Chat iframe (socialstream) found for ${seminarId}. Entry confirmed.`);
    } else {
      const currentUrl = activePage.url();
      const urlPattern = /https:\/\/m\.doctorville\.co\.kr\/cme\/seminar\/attend\?seminarId=\d+/;
      const on24Pattern = /https:\/\/event\.on24\.com\/eventRegistration\/console\/apollox\/mainEvent/;
      if (urlPattern.test(currentUrl) || on24Pattern.test(currentUrl)) {
        isQnaVisible = true;
        console.log(`[monitor_seminars] Entry confirmed via URL pattern for ${seminarId}: ${currentUrl}`);
      } else {
        console.log(`[monitor_seminars] Chat iframe not found and URL mismatch for ${seminarId}: ${currentUrl}`);
      }
    }

    if (!isQnaVisible) {
      console.warn(
        `[monitor_seminars] Q&A section not found after entry attempt for ${seminarId}. Entry may have failed.`,
      );

      if (seminarId) {
        const pcFallbackUrl = `${SEMINAR_DETAIL_PC_PAGE}?seminarId=${seminarId}`;
        console.log(`[monitor_seminars] PC fallback for ${seminarId} -> ${pcFallbackUrl}`);
        try {
          await ensureLoggedIn({ page: activePage, context });
          await safeGoto(activePage, pcFallbackUrl, { waitUntil: 'networkidle', timeout: 15000 });
          const pcEnterBtn = activePage.locator('text="입장하기"').first();
          if (await pcEnterBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            const pcPopupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
            await pcEnterBtn.click().catch((e) => {
              console.warn(`[monitor_seminars] PC fallback '입장하기' click failed for ${seminarId}`, e);
            });
            const pcPopup = await pcPopupPromise;
            const pcActive = pcPopup ?? activePage;
            if (pcPopup) await pcActive.waitForLoadState('domcontentloaded').catch(() => {});
            await pcActive.waitForTimeout(5000);
            const pcChatFrame = pcActive
              .frames()
              .find((f) => f.url().includes('socialstream') || f.url().includes('video.ibm.com'));
            const pcUrlPattern = /https:\/\/m\.doctorville\.co\.kr\/cme\/seminar\/attend\?seminarId=\d+/;
            const pcOn24Pattern = /https:\/\/event\.on24\.com\/eventRegistration\/console\/apollox\/mainEvent/;
            if (pcChatFrame || pcUrlPattern.test(pcActive.url()) || pcOn24Pattern.test(pcActive.url())) {
              isQnaVisible = true;
              activePage = pcActive;
              console.log(`[monitor_seminars] PC fallback entry confirmed for ${seminarId}.`);
            } else {
              console.warn(`[monitor_seminars] PC fallback also failed for ${seminarId}: ${pcActive.url()}`);
            }
            if (pcPopup) await pcPopup.close().catch(() => {});
          } else {
            console.warn(`[monitor_seminars] PC fallback '입장하기' button not found for ${seminarId}`);
          }
        } catch (pcErr) {
          console.error(`[monitor_seminars] PC fallback threw for ${seminarId}`, pcErr);
        }
      }
    } else {
      console.log(`[monitor_seminars] Q&A section confirmed. Seminar entry successful for ${seminarId}.`);
    }

    const screenshotPath = path.join(process.cwd(), `seminar_entry_${screenshotKey}.png`);
    try {
      await activePage.screenshot({ path: screenshotPath, fullPage: false });
      didEnter = isQnaVisible;
    } catch (screenshotError) {
      console.error(`[monitor_seminars] Failed to take screenshot for ${seminarId}`, screenshotError);
    } finally {
      await fs.unlink(screenshotPath).catch(() => {});
    }

    if (popup) {
      await popup.close().catch(() => {});
    }
  } catch (e) {
    console.error(`[monitor_seminars] Auto-enter failed for ${seminarId}`, e);
  } finally {
    await page.close().catch(() => {});
  }

  return didEnter;
}

async function checkAndPerformAutoEnter(
  context: BrowserContext,
  seminarId: string | null,
  seminarUrl: string,
  name: string,
  status: string,
  autoEnterDone: boolean | undefined,
): Promise<boolean> {
  if (status !== '입장하기' || autoEnterDone) {
    return !!autoEnterDone;
  }

  const targetUrl = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : seminarUrl;
  const screenshotKey = seminarId || `url_${Date.now()}`;
  const didEnter = await performAutoEnter(context, seminarId, name, targetUrl, screenshotKey);

  if (didEnter) {
    const entryMessage = `🟢세미나 입장 완료\n**${name}**\n${targetUrl}`;
    const screenshotPath = path.join(process.cwd(), `seminar_entry_${screenshotKey}.png`);
    try {
      const page = await context.newPage();
      await safeGoto(page, targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.screenshot({ path: screenshotPath, fullPage: false });
      await sendTelegram(entryMessage, screenshotPath);
      await page.close().catch(() => {});
    } catch (e) {
      console.error(`[monitor_seminars] Entry notification send failed for ${seminarId}`, e);
    } finally {
      await fs.unlink(screenshotPath).catch(() => {});
    }
  }

  return didEnter;
}

async function monitorSeminars(
  { page, context }: { page: Page; context: BrowserContext },
  periodName: string,
  startHour: number,
  endHour: number,
  options: { isAutoResume?: boolean } = {},
) {
  const { isAutoResume } = options;
  let monitoringList: Record<string, SeminarInfo> = {};
  const excludedSeminarKeys = new Set<string>();
  const todayIsoDate = seoulDateString();

  try {
    const initialResult = await getTodaysSeminarsHttp(startHour, endHour);
    let initialSeminars: Record<string, SeminarInfo> = {};
    if (initialResult.success === false) {
      if (initialResult.errorType === 'AUTH_EXPIRED') {
        const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
        await sendTelegram(msg).catch(() => {});
        return false;
      }
      console.warn(`[${periodName}] Initial HTTP seminar list fetch failed: ${initialResult.error}`);
    } else {
      initialSeminars = initialResult.seminars;
    }
    monitoringList = { ...initialSeminars };

    for (const [url, { status, name, seminarId }] of Object.entries(initialSeminars)) {
      if (status === '입장하기') {
        console.log(`[${periodName}] Seminar already available: ${name}`);
        await sendTelegram(`[${periodName}] Seminar already available: ${name}`);
        const targetUrl = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : url;

        const { hasSurvey, isSurveyPointExcluded } = await checkSurveyMeta(targetUrl);
        if (isSurveyPointExcluded) {
          console.log(
            `[monitor_seminars] ${name} is point-excluded. Entry only, no channel notice, no end monitoring. (During Initialization)`,
          );
        }

        if (monitoringList[url]) {
          monitoringList[url].autoEnterDone = await checkAndPerformAutoEnter(
            context,
            seminarId,
            url,
            name,
            status,
            monitoringList[url]?.autoEnterDone,
          );
          monitoringList[url].hasSurvey = hasSurvey;
          monitoringList[url].isSurveyPointExcluded = isSurveyPointExcluded;
          monitoringList[url].isEntryStarted = true;
        }

        if (isSurveyPointExcluded) {
          excludedSeminarKeys.add(getSeminarTrackingKey(url, seminarId));
          delete monitoringList[url];
          continue;
        }

        const advancedSurveySuffix = monitoringList[url]?.isAdvancedSurvey ? ' [심화설문]' : '';
        let message = `🟢세미나시작\n**${name}**${advancedSurveySuffix}\n${targetUrl}`;
        if (!hasSurvey) {
          message += `\n(설문이 없는 세미나인 것 같습니다)`;
        }
        if (!isAutoResume) {
          await sendNotificationToChannel(message);
        } else {
          console.log(
            `[${periodName}] Skipping channel notification for already-started seminar during auto-resume: ${name}`,
          );
        }
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

      const pollRes = await getTodaysSeminarsHttp(startHour, endHour);
      if (pollRes.success === false) {
        if (pollRes.errorType === 'AUTH_EXPIRED') {
          const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
          await sendTelegram(msg).catch(() => {});
          return false;
        }
        const errDetail = pollRes.error;
        console.warn(
          `[${periodName}] 세미나 목록 HTTP polling 실패 (${errDetail}). 기존 monitoringList 유지 후 다음 주기에 재시도.`,
        );
        await sendTelegram(
          `⚠️ [${periodName}] 세미나 목록 HTTP polling 실패: ${errDetail}. 다음 주기에 재시도합니다.`,
        ).catch(() => {});
        continue;
      }

      const currentSeminarsOnPage = pollRes.seminars;

      for (const [url, info] of Object.entries(currentSeminarsOnPage)) {
        const trackingKey = getSeminarTrackingKey(url, info.seminarId);
        if (excludedSeminarKeys.has(trackingKey)) {
          continue;
        }

        if (!monitoringList[url]) {
          monitoringList[url] = info;
        }
      }

      // Per-cycle detail cache to prevent redundant HTTP GET requests for the same seminar
      const detailCache = new Map<string, { hasSurvey: boolean; isSurveyPointExcluded: boolean; isEnded: boolean }>();
      const getDetailMeta = async (targetUrl: string, seminarId: string | null) => {
        const key = seminarId || targetUrl;
        if (detailCache.has(key)) return detailCache.get(key)!;

        const res = await fetchSeminarDetail(targetUrl);
        let meta = { hasSurvey: true, isSurveyPointExcluded: false, isEnded: false };
        if (res.status === 'success') {
          meta = {
            hasSurvey: res.metadata.hasSurvey,
            isSurveyPointExcluded: res.metadata.isPointExcluded,
            isEnded: res.metadata.isEnded,
          };
        }
        detailCache.set(key, meta);
        return meta;
      };

      const monitoredUrls = [...Object.keys(monitoringList)];
      for (const url of monitoredUrls) {
        const monitoredInfo = monitoringList[url];

        const currentInfo = currentSeminarsOnPage[url];
        const mergedSeminarInfo: SeminarInfo = {
          name: currentInfo?.name || monitoredInfo.name,
          status: currentInfo?.status || monitoredInfo.status,
          seminarId: currentInfo?.seminarId || monitoredInfo.seminarId,
          hasSurvey: monitoredInfo.hasSurvey,
          isSurveyPointExcluded: monitoredInfo.isSurveyPointExcluded,
          isEntryStarted: monitoredInfo.isEntryStarted,
          autoEnterDone: monitoredInfo.autoEnterDone,
          isAdvancedSurvey: monitoredInfo.isAdvancedSurvey,
        };

        const effectiveStatus = currentInfo ? currentInfo.status : monitoredInfo.status;
        let ended = false;

        if (mergedSeminarInfo.isEntryStarted) {
          if (mergedSeminarInfo.hasSurvey === false) {
            if (!currentInfo) {
              ended = true;
            }
          } else {
            const targetUrl = mergedSeminarInfo.seminarId
              ? `${SEMINAR_DETAIL_PAGE}${mergedSeminarInfo.seminarId}`
              : url;
            const detail = await getDetailMeta(targetUrl, mergedSeminarInfo.seminarId);
            ended = detail.isEnded;
          }
        }

        if (ended) {
          const { message: quizResultMessage, foundSurveyButton } = await handleSeminarEndAndQuiz(
            context,
            mergedSeminarInfo,
            url,
          );

          if (mergedSeminarInfo.hasSurvey !== false || foundSurveyButton) {
            const targetUrl = mergedSeminarInfo.seminarId
              ? `${SEMINAR_DETAIL_PAGE}${mergedSeminarInfo.seminarId}`
              : url;
            const quizSuffix = quizResultMessage ? `\n\n${quizResultMessage}` : '';
            const advancedSurveySuffix = mergedSeminarInfo.isAdvancedSurvey ? ' [심화설문]' : '';
            const message = `🔴세미나종료\n**${mergedSeminarInfo.name}**${advancedSurveySuffix}\n${targetUrl}${quizSuffix}`;
            await sendNotificationToChannel(message);
          } else {
            console.log(
              `[monitor_seminars] Skipping end notification for ${mergedSeminarInfo.name} because it has no survey.`,
            );
          }
          delete monitoringList[url];
          continue;
        }

        const { status: newStatus, name: newName } = currentInfo || monitoredInfo;

        if (currentInfo && newStatus === '입장하기' && !monitoredInfo.isEntryStarted) {
          console.log(`[${periodName}] Seminar ready for entry: ${newName}.`);
          const targetUrl = mergedSeminarInfo.seminarId ? `${SEMINAR_DETAIL_PAGE}${mergedSeminarInfo.seminarId}` : url;

          const detail = await getDetailMeta(targetUrl, mergedSeminarInfo.seminarId);
          const hasSurvey = detail.hasSurvey;
          const isSurveyPointExcluded = detail.isSurveyPointExcluded;

          if (isSurveyPointExcluded) {
            console.log(
              `[monitor_seminars] ${newName} is point-excluded. Entry only, no channel notice, no end monitoring. (During Loop)`,
            );
          }

          if (monitoringList[url] && currentInfo) {
            monitoringList[url].isAdvancedSurvey = currentInfo.isAdvancedSurvey;
            monitoringList[url].isSurveyPointExcluded = isSurveyPointExcluded;
          }

          if (isSurveyPointExcluded) {
            const trackingKey = getSeminarTrackingKey(url, mergedSeminarInfo.seminarId);
            excludedSeminarKeys.add(trackingKey);
            mergedSeminarInfo.hasSurvey = hasSurvey;
            mergedSeminarInfo.isEntryStarted = true;
            mergedSeminarInfo.autoEnterDone = await checkAndPerformAutoEnter(
              context,
              mergedSeminarInfo.seminarId,
              url,
              mergedSeminarInfo.name,
              newStatus,
              mergedSeminarInfo.autoEnterDone,
            );
            delete monitoringList[url];
            continue;
          }

          const advancedSurveySuffix = currentInfo?.isAdvancedSurvey ? ' [심화설문]' : '';
          let message = `🟢세미나시작\n**${newName}**${advancedSurveySuffix}\n${targetUrl}`;
          if (!hasSurvey) {
            message += `\n(설문이 없는 세미나인 것 같습니다)`;
          }
          await sendNotificationToChannel(message);

          mergedSeminarInfo.hasSurvey = hasSurvey;
          mergedSeminarInfo.isEntryStarted = true;
          mergedSeminarInfo.autoEnterDone = await checkAndPerformAutoEnter(
            context,
            mergedSeminarInfo.seminarId,
            url,
            mergedSeminarInfo.name,
            newStatus,
            mergedSeminarInfo.autoEnterDone,
          );
        } else {
          mergedSeminarInfo.autoEnterDone = await checkAndPerformAutoEnter(
            context,
            mergedSeminarInfo.seminarId,
            url,
            mergedSeminarInfo.name,
            effectiveStatus,
            mergedSeminarInfo.autoEnterDone,
          );
        }

        monitoringList[url] = {
          ...mergedSeminarInfo,
          status: newStatus,
          name: newName,
        };
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
    const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
    const errShotPath = path.join(baseScreenshotDir, `${periodName}_monitoring_failed_${Date.now()}.png`);
    try {
      await fs.mkdir(baseScreenshotDir, { recursive: true });
      await page.screenshot({ path: errShotPath, fullPage: true }).catch(() => {});
    } catch (_ssErr) {
      /* ignore */
    }
    await sendTelegram(`❗ [${periodName}] 세미나 감시 작업 오류: ${message}`, errShotPath).catch(() => {});
    return false;
  }
}

export { monitorSeminars };
