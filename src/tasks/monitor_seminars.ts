import type { BrowserContext, Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import {
  safeGoto,
  sendNotificationToChannel,
  sendTelegram,
  getSeminarIdFromUrl,
  ensureLoggedIn,
  ensureSeminarDetailReady,
  hasSurveyPointExcludedNotice,
} from '../modules/utils';
import { processSeminarQuiz } from './seminar_quiz';

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
type SeminarInfo = {
  status: string;
  name: string;
  seminarId: string | null;
  hasSurvey?: boolean;
  isAdvancedSurvey?: boolean;
  isEntryStarted?: boolean;
  autoEnterDone?: boolean;
};

const seoulDateString = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

type SeminarSurveyMeta = {
  hasSurvey: boolean;
  isSurveyPointExcluded: boolean;
};

const getSeminarTrackingKey = (url: string, seminarId: string | null | undefined): string => seminarId || url;

async function checkSurveyMeta(context: BrowserContext, url: string): Promise<SeminarSurveyMeta> {
  const page = await context.newPage();
  try {
    await safeGoto(page, url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await ensureSeminarDetailReady(page, url);

    const isSurveyPointExcluded = await hasSurveyPointExcludedNotice(page);

    // Check for "설문참여" button
    const surveyBtn = page.locator('text="설문참여"').first();
    const isSurveyButtonVisible = await surveyBtn.isVisible({ timeout: 5000 }).catch(() => false);

    // Check for badge with inner text "설문" and class "seminar-badge"
    const surveyBadge = page.locator('.seminar-badge', { hasText: '설문' }).first();
    const isSurveyBadgeVisible = await surveyBadge.isVisible({ timeout: 5000 }).catch(() => false);

    return {
      hasSurvey: isSurveyButtonVisible || isSurveyBadgeVisible,
      isSurveyPointExcluded,
    };
  } catch (e) {
    console.warn(`[checkSurveyMeta] Failed to check survey for ${url}`, e);
    // If check fails, assume it exists to be safe (or false? User wants to suppress if *missing*. Safe default is true.)
    // But if we error out, maybe we shouldn't suppress the end notification.
    return { hasSurvey: true, isSurveyPointExcluded: false };
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
    console.log(`[monitor_seminars] Seminar end check (${seminar.seminarId}): ${surveyEnded}, ${canCancel}`);

    await detailPage.screenshot({ path: screenshotPath, fullPage: false });
    if (!canCancel) {
      console.log(`[monitor_seminars] End check pending for ${seminar.seminarId}. surveyEnded=${surveyEnded}`);
    }
    await fs
      .unlink(screenshotPath)
      .catch((err) => console.error(`Failed to delete screenshot: ${screenshotPath}`, err));
    return surveyEnded;
  } catch (e) {
    console.error(
      `[monitor_seminars] 종료 여부 확인 실패 (${seminar.seminarId})`,
      e && typeof e === 'object' && 'stack' in e ? (e as Error).stack : e,
    );
    return false;
  } finally {
    await detailPage.close().catch(() => {});
  }
}

/**
 * 세미나 종료 후 설문참여 버튼을 클릭하고 퀴즈를 처리하는 함수
 */
async function handleSeminarEndAndQuiz(
  context: BrowserContext,
  seminar: { name: string; seminarId: string | null },
  fallbackUrl: string,
): Promise<{ message: string | null; foundSurveyButton: boolean }> {
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
      // NOTE: 일부 페이지는 기본값이 이미 체크된 상태라 추가 클릭 시 오히려 해제될 수 있음.
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
  } finally {
    if (popupPage) {
      await popupPage.close().catch(() => {});
    }
    await surveyPage.close().catch(() => {});
  }
  return { message: quizResultMessage, foundSurveyButton };
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
        const isAdvancedSurvey = (await detail.locator('.ic_survey').count()) > 0;
        seminars[fullUrl] = { status: statusText, name: seminarName, seminarId: seminarId, isAdvancedSurvey };
      }
    }
  } else {
    console.log('[monitor_seminars] No seminars on today...');
  }

  return seminars;
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
      // 버튼 못 찾아도 현재 페이지 스크린샷 전송
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

    // "채널 선택" 다이얼로그 감지 후 "확인" 버튼 클릭
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

    console.log(`[monitor_seminars] Waiting for Q&A section to confirm seminar entry (${seminarId})`);
    await activePage.waitForTimeout(5000);

    // Q&A 섹션 존재 여부로 입장 완료 판정 (다중 fallback 전략)
    let isQnaVisible = false;

    // Strategy 1: Exact text match
    const qnaExact = activePage.locator('text="Q&A"').first();
    isQnaVisible = await qnaExact.isVisible({ timeout: 3000 }).catch(() => false);

    // Strategy 2: Case-insensitive partial match
    if (!isQnaVisible) {
      const qnaPartial = activePage.locator(':text-matches("Q&A", "i")').first();
      isQnaVisible = await qnaPartial.isVisible({ timeout: 3000 }).catch(() => false);
    }

    // Strategy 3: Look for "모든 질문" text (Q&A subsection)
    if (!isQnaVisible) {
      const allQuestions = activePage.locator('text=/모든\s*질문/i').first();
      isQnaVisible = await allQuestions.isVisible({ timeout: 3000 }).catch(() => false);
      if (isQnaVisible) {
        console.log(`[monitor_seminars] Q&A confirmed via '모든 질문' fallback for ${seminarId}`);
      }
    }

    // Strategy 4: Check for chat/message area (세미나 내부 페이지 특징)
    if (!isQnaVisible) {
      const chatArea = activePage.locator('.chat-container, [class*="chat"], [class*="message"]').first();
      isQnaVisible = await chatArea.isVisible({ timeout: 3000 }).catch(() => false);
      if (isQnaVisible) {
        console.log(`[monitor_seminars] Q&A confirmed via chat area detection for ${seminarId}`);
      }
    }

    if (!isQnaVisible) {
      console.warn(
        `[monitor_seminars] Q&A section not found after entry attempt for ${seminarId}. Entry may have failed.`,
      );
    } else {
      console.log(`[monitor_seminars] Q&A section confirmed. Seminar entry successful for ${seminarId}.`);
    }

    // Take a screenshot and send to admin
    const screenshotPath = path.join(process.cwd(), `seminar_entry_${screenshotKey}.png`);
    try {
      const entryStatus = isQnaVisible ? '🟢세미나 입장 완료' : '⚠️세미나 입장 불확실 (Q&A 미감지)';
      const entryMessage = `${entryStatus}\n**${seminarName}**\n${targetUrl}`;
      await activePage.screenshot({ path: screenshotPath, fullPage: false });

      const sentToAdmin = await sendTelegram(entryMessage, screenshotPath);
      if (!sentToAdmin) {
        console.error(
          `[monitor_seminars] Auto-enter screenshot send skipped/failed for ${seminarId}. Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.`,
        );
      }
      didEnter = sentToAdmin && isQnaVisible;
    } catch (screenshotError) {
      console.error(`[monitor_seminars] Failed to take/send screenshot for ${seminarId}`, screenshotError);
    } finally {
      // Clean up the screenshot file
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
  return performAutoEnter(context, seminarId, name, targetUrl, screenshotKey);
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
        const { hasSurvey, isSurveyPointExcluded } = await checkSurveyMeta(context, targetUrl);
        if (isSurveyPointExcluded) {
          excludedSeminarKeys.add(getSeminarTrackingKey(url, seminarId));
          console.log(
            `[monitor_seminars] Skipping monitoring for ${name} because survey points are excluded. (During Initialization)`,
          );
          delete monitoringList[url];
          continue;
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
          monitoringList[url].isEntryStarted = true;
        }
        const advancedSurveySuffix = monitoringList[url]?.isAdvancedSurvey ? ' [심화설문]' : '';
        let message = `🟢세미나시작\n**${name}**${advancedSurveySuffix}\n${targetUrl}`;
        if (!hasSurvey) {
          message += `\n(설문이 없는 세미나인 것 같습니다)`;
        }
        // auto-resume 시(재부팅/재시작)에는 이미 시작된 세미나의 채널 공지를 건너뜁니다
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

      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      } catch (reloadError) {
        console.error(`[${periodName}] page.reload failed. trying safeGoto fallback.`, reloadError);

        try {
          await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 }, 1);
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        } catch (fallbackError) {
          const reloadMessage = reloadError instanceof Error ? reloadError.message : String(reloadError);
          const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          await sendTelegram(
            `⚠️ [${periodName}] 세미나 목록 새로고침 실패. 다음 주기에 재시도합니다.\nreload: ${reloadMessage}\nfallback: ${fallbackMessage}`,
          ).catch(() => {});
          await randomDelay();
          continue;
        }
      }

      const currentSeminarsOnPage = await getTodaysSeminars(page, startHour, endHour);

      for (const [url, info] of Object.entries(currentSeminarsOnPage)) {
        const trackingKey = getSeminarTrackingKey(url, info.seminarId);
        if (excludedSeminarKeys.has(trackingKey)) {
          continue;
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
          autoEnterDone: monitoredInfo.autoEnterDone, // Preserve autoEnterDone state
          isAdvancedSurvey: monitoredInfo.isAdvancedSurvey, // Preserve isAdvancedSurvey state
        };

        const effectiveStatus = currentInfo ? currentInfo.status : monitoredInfo.status;
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
          // Always try to handle the end/quiz, regardless of initial survey status
          const { message: quizResultMessage, foundSurveyButton } = await handleSeminarEndAndQuiz(
            context,
            mergedSeminarInfo,
            url,
          );

          // If we knew it had a survey, OR if we just found one (even if we thought it didn't have one)
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
          delete monitoringList[url]; // Remove from monitoring
          continue; // Move to the next seminar
        }

        // 2. If it still exists, get its new state
        const { status: newStatus, name: newName } = currentInfo || monitoredInfo;
        const _oldStatus = monitoredInfo.status;

        // 3. Check for transition to '입장하기' (New entry detection)
        // Check if now ready for entry (either newly transitioned from Apply status, or newly discovered as entry-ready)
        if (currentInfo && newStatus === '입장하기' && !monitoredInfo.isEntryStarted) {
          console.log(`[${periodName}] Seminar ready for entry: ${newName}.`);
          const targetUrl = mergedSeminarInfo.seminarId ? `${SEMINAR_DETAIL_PAGE}${mergedSeminarInfo.seminarId}` : url;

          // Check for survey existence
          const { hasSurvey, isSurveyPointExcluded } = await checkSurveyMeta(context, targetUrl);
          if (isSurveyPointExcluded) {
            excludedSeminarKeys.add(getSeminarTrackingKey(url, mergedSeminarInfo.seminarId));
            console.log(
              `[monitor_seminars] Skipping monitoring for ${newName} because survey points are excluded. (During Loop)`,
            );
            delete monitoringList[url];
            continue;
          }

          if (monitoringList[url] && currentInfo) {
            monitoringList[url].isAdvancedSurvey = currentInfo.isAdvancedSurvey;
          }

          const advancedSurveySuffix = currentInfo?.isAdvancedSurvey ? ' [심화설문]' : '';
          let message = `🟢세미나시작\n**${newName}**${advancedSurveySuffix}\n${targetUrl}`;
          if (!hasSurvey) {
            message += `\n(설문이 없는 세미나인 것 같습니다)`;
          }
          await sendNotificationToChannel(message);

          // Update state in both merged and original list
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
          // Note: monitoringList[url] will be updated below at step 4
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

        // 4. Always update the seminar's status and name in the monitoring list
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
    await sendTelegram(`❗ [${periodName}] 세미나 감시 작업 오류: ${message}`).catch(() => {});
    return false;
  }
}

export { monitorSeminars };
