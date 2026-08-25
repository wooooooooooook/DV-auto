import type { BrowserContext, Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import {
  safeGoto,
  sendNotificationToChannel,
  sendTelegram,
  ensureLoggedIn,
  loadCookies,
  sleep,
} from '../modules/utils';
import {
  fetchMainFutureSeminars,
  fetchSeminarDetail,
  parseSeminarDateTime,
  checkIsAdvancedSurvey,
  checkIsPointExcluded,
  ProcessState,
  SurveyState,
  type FutureSeminarApiItem,
} from '../modules/seminar_api';
import { processSeminarQuiz } from './seminar_quiz';
import * as storage from '../services/storage';
import { SEMINAR_LIST_KEY, type SeminarListItem } from './apply_seminar';

const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
const SEMINAR_DETAIL_PC_PAGE = 'https://www.doctorville.co.kr/seminar/seminarDetail';

// API 폴링 주기: 1분 (60초)
export const API_POLL_INTERVAL_MS = 60 * 1000;

export type SeminarInfo = {
  status: string;
  name: string;
  seminarId: string | null;
  startDt?: string;
  endDt?: string;
  hasSurvey?: boolean;
  isSurveyPointExcluded?: boolean;
  isAdvancedSurvey?: boolean;
  isEntryStarted?: boolean;
  autoEnterDone?: boolean;
  processState?: number;
  cancelProcessState?: number;
  seminarCompleted?: number;
  surveyState?: number;
};

const seoulDateString = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

const getSeminarTrackingKey = (url: string, seminarId: string | null | undefined): string => seminarId || url;

/**
 * 세미나 startDt 기반으로 세미나 시작 시간 도래 여부 판정
 * 한국 시간(KST, UTC+9) 기준으로 현재 시각(또는 referenceTimeMs) >= startDt 인지 비교
 */
export function isSeminarStartedByTime(startDt?: string, referenceTimeMs?: number): boolean {
  if (!startDt) return false;
  try {
    const clean = startDt.trim().replace('T', ' ');
    // "2026-08-25 13:00:00" -> "2026-08-25T13:00:00+09:00"
    const isoWithTz = clean.includes('+') || clean.endsWith('Z') ? clean : `${clean.replace(' ', 'T')}+09:00`;
    const targetMs = new Date(isoWithTz).getTime();
    if (isNaN(targetMs)) return false;
    const nowMs = referenceTimeMs !== undefined ? referenceTimeMs : Date.now();
    return nowMs >= targetMs;
  } catch {
    return false;
  }
}

/**
 * Playwright BrowserContext 온디맨드 획득 헬퍼
 * 전달받은 context가 있으면 재사용하고, 없으면 필요한 시점에만 Chromium을 실행하고 종료합니다.
 */
export async function withBrowserContext<T>(
  providedContext: BrowserContext | undefined,
  callback: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  if (providedContext) {
    return await callback(providedContext);
  }

  const { chromium } = await import('playwright');
  const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';
  const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await loadCookies(context).catch(() => {});
  try {
    return await callback(context);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * API 기반으로 당일 특정 시간대(startHour ~ endHour)의 세미나 목록을 조회하여 SeminarInfo 맵으로 반환
 */
export async function getTodaysSeminarsFromApi(
  startHour: number,
  endHour: number,
  referenceDate?: string,
): Promise<{
  success: boolean;
  isAuthExpired: boolean;
  seminars: Record<string, SeminarInfo>;
  rawItems: FutureSeminarApiItem[];
}> {
  const targetDate = referenceDate || seoulDateString();
  const apiRes = await fetchMainFutureSeminars();

  if (!apiRes.success) {
    return {
      success: false,
      isAuthExpired: !!apiRes.isAuthExpired,
      seminars: {},
      rawItems: [],
    };
  }

  const storedList = storage.get<SeminarListItem[]>(SEMINAR_LIST_KEY, []) || [];
  const storedPointExcludedMap = new Map<string, boolean>();
  for (const s of storedList) {
    const sid = s.seminarId ? String(s.seminarId).trim() : '';
    if (sid && s.isPointExcluded !== undefined) {
      storedPointExcludedMap.set(sid, s.isPointExcluded);
    }
  }

  const seminars: Record<string, SeminarInfo> = {};
  const items = apiRes.items || [];

  for (const item of items) {
    const { date, startHour: itemStartHour } = parseSeminarDateTime(item.startDt, item.endDt);

    // 날짜가 오늘(targetDate)이고 모니터링 시간대(startHour <= h < endHour)인지 확인
    if (
      date === targetDate &&
      Number.isFinite(itemStartHour) &&
      itemStartHour >= startHour &&
      itemStartHour < endHour
    ) {
      const seminarId = String(item.seminarId ?? '').trim();
      const fullUrl = `${SEMINAR_DETAIL_PAGE}${seminarId}`;
      const processStateNum = item.processState !== undefined ? Number(item.processState) : undefined;
      const cancelProcessStateNum = item.cancelProcessState !== undefined ? Number(item.cancelProcessState) : undefined;
      const seminarCompletedNum =
        item.seminarCompleted !== undefined
          ? typeof item.seminarCompleted === 'boolean'
            ? item.seminarCompleted
              ? 1
              : 0
            : Number(item.seminarCompleted)
          : undefined;

      const isAdvancedSurvey = checkIsAdvancedSurvey(item.useDepthSurvey);
      const storedIsPointExcluded = seminarId ? storedPointExcludedMap.get(seminarId) : undefined;
      const isPointExcluded =
        storedIsPointExcluded !== undefined
          ? storedIsPointExcluded
          : typeof item.intro === 'string' && item.intro.trim().length > 0
            ? checkIsPointExcluded(item.intro)
            : false;
      const hasSurvey = item.useSurvey !== false && item.useSurvey !== 'N' && item.useSurvey !== 0;

      let statusText = '대기중';
      if (processStateNum === ProcessState.PROCESS_ENTER) {
        statusText = '입장하기';
      } else if (processStateNum === ProcessState.PROCESS_STARTED) {
        statusText = '진행중';
      } else if (
        processStateNum === ProcessState.PROCESS_END ||
        processStateNum === ProcessState.PROCESS_COMPLETED ||
        seminarCompletedNum === 1
      ) {
        statusText = '종료';
      } else if (processStateNum === ProcessState.PROCESS_APPLY) {
        statusText = '신청하기';
      } else if (processStateNum === ProcessState.PROCESS_CANCEL) {
        statusText = '신청완료';
      }

      seminars[fullUrl] = {
        status: statusText,
        name: item.seminarNm || '세미나',
        seminarId,
        startDt: item.startDt,
        endDt: item.endDt,
        hasSurvey,
        isSurveyPointExcluded: isPointExcluded,
        isAdvancedSurvey,
        processState: processStateNum,
        cancelProcessState: cancelProcessStateNum,
        seminarCompleted: seminarCompletedNum,
      };
    }
  }

  return {
    success: true,
    isAuthExpired: false,
    seminars,
    rawItems: items,
  };
}

/**
 * 개별 세미나의 종료 상태 및 설문 상태, 입장이력을 API(fetchSeminarDetail)로 확인
 */
export async function checkSeminarEndStatusFromApi(seminarId: string): Promise<{
  isEnded: boolean;
  isSurveyOpen: boolean;
  surveyState?: number;
  isPointExcluded: boolean;
  hasEntryHistory: boolean;
}> {
  const detailRes = await fetchSeminarDetail(seminarId);
  if (!detailRes.success) {
    return {
      isEnded: false,
      isSurveyOpen: false,
      isPointExcluded: false,
      hasEntryHistory: false,
    };
  }

  const raw = detailRes.rawResponse;
  const detail = raw?.seminarDetail;
  const surveyState = detailRes.surveyState;
  const processState = detail?.processState !== undefined ? Number(detail.processState) : undefined;
  const seminarCompleted = detail?.seminarCompleted !== undefined ? Number(detail.seminarCompleted) : undefined;

  // 설문 진행 중 상태 (SURVEY_PROGRESS === 1)
  const isSurveyOpen = surveyState === SurveyState.SURVEY_PROGRESS;

  // 세미나 종료 상태 판별:
  // 1) surveyState가 1(진행중)이거나 2(완료)인 경우
  // 2) processState가 7(PROCESS_END) 또는 8(PROCESS_COMPLETED)인 경우
  // 3) seminarCompleted가 1인 경우
  const isEnded =
    isSurveyOpen ||
    surveyState === SurveyState.SURVEY_COMPLETED ||
    processState === ProcessState.PROCESS_END ||
    processState === ProcessState.PROCESS_COMPLETED ||
    seminarCompleted === 1;

  return {
    isEnded,
    isSurveyOpen,
    surveyState,
    isPointExcluded: detailRes.isPointExcluded,
    hasEntryHistory: detailRes.hasEntryHistory ?? false,
  };
}

/**
 * 세미나 종료 후 Playwright로 설문참여 버튼을 클릭하고 퀴즈를 처리하는 함수
 */
export async function handleSeminarEndAndQuiz(
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
    await ensureLoggedIn({ page: surveyPage, context });
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

      // "참여하기" 또는 "설문 참여하기" 요소 찾기 및 클릭
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
      const quizResult = await processSeminarQuiz(quizPage, seminar.seminarId ?? undefined);
      if (quizResult.success && quizResult.hasQuizResult) {
        quizResultMessage = quizResult.message;
      }
    } else {
      console.log(`[monitor_seminars] "설문참여" 버튼을 찾지 못함 (${seminar.seminarId})`);
      // 버튼이 없어도 현재 페이지에서 퀴즈 찾기 시도
      const quizResult = await processSeminarQuiz(quizPage, seminar.seminarId ?? undefined);
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

/**
 * Playwright로 세미나 라이브 방송에 자동 입장하는 함수
 */
export async function performAutoEnter(
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

    console.log(`[monitor_seminars] Waiting for chat iframe to confirm seminar entry (${seminarId})`);
    await activePage.waitForTimeout(5000);

    // Q&A 섹션 존재 여부로 입장 완료 판정: video.ibm.com/socialstream iframe 확인
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

      // 불확실 시 → PC 도메인 상세 페이지로 fallback 후 '입장하기' 클릭
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

/**
 * 입장 상태 확인 및 자동 입장 실행 (첫 성공 시 텔레그램 스크린샷 알림 전송)
 */
export async function checkAndPerformAutoEnter(
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

  // 첫 성공 시에만 관리자 알림 전송 (중복 방지)
  if (didEnter) {
    const entryMessage = `🟢세미나 입장 완료\n**${name}**\n${targetUrl}`;
    const screenshotPath = path.join(process.cwd(), `seminar_entry_${screenshotKey}.png`);
    try {
      const page = await context.newPage();
      await ensureLoggedIn({ page, context });
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

export type MonitorSeminarsOptions = {
  isAutoResume?: boolean;
  context?: BrowserContext;
  page?: Page;
  pollIntervalMs?: number;
};

/**
 * API 기반 세미나 모니터링 메인 태스크
 * 1분마다 API로 상태를 감시하고, 입장/설문 참여 시에만 Playwright를 온디맨드로 구동합니다.
 */
async function monitorSeminars(
  periodName: string,
  startHour: number,
  endHour: number,
  options?: MonitorSeminarsOptions,
): Promise<boolean>;
async function monitorSeminars(
  args: { page?: Page; context?: BrowserContext },
  periodName: string,
  startHour: number,
  endHour: number,
  options?: MonitorSeminarsOptions,
): Promise<boolean>;
async function monitorSeminars(
  arg1: string | { page?: Page; context?: BrowserContext },
  arg2: string | number,
  arg3?: number,
  arg4?: number | MonitorSeminarsOptions,
  arg5?: MonitorSeminarsOptions,
): Promise<boolean> {
  let periodName: string;
  let startHour: number;
  let endHour: number;
  let options: MonitorSeminarsOptions;
  let providedContext: BrowserContext | undefined;

  if (typeof arg1 === 'object' && arg1 !== null) {
    providedContext = arg1.context;
    periodName = arg2 as string;
    startHour = arg3 as number;
    endHour = arg4 as number;
    options = arg5 || {};
  } else {
    periodName = arg1 as string;
    startHour = arg2 as number;
    endHour = arg3 as number;
    options = (arg4 as MonitorSeminarsOptions) || {};
    providedContext = options.context;
  }

  const { isAutoResume, pollIntervalMs = API_POLL_INTERVAL_MS } = options;
  let monitoringList: Record<string, SeminarInfo> = {};
  const excludedSeminarKeys = new Set<string>();
  const todayIsoDate = seoulDateString();

  try {
    console.log(`[${periodName}] API 기반 세미나 모니터링 시작 (시간대: ${startHour}시 ~ ${endHour}시)`);

    // 1. 초기 세미나 목록 조회 (API)
    const initialFetch = await getTodaysSeminarsFromApi(startHour, endHour, todayIsoDate);
    if (!initialFetch.success) {
      if (initialFetch.isAuthExpired) {
        await sendTelegram(`🔒 [${periodName}] 세미나 모니터링: 세션이 만료되었습니다. 로그인이 필요합니다.`);
        return false;
      }
      console.warn(`[${periodName}] 초기 세미나 목록 API 조회 실패, 다음 주기에 재시도합니다.`);
    }

    monitoringList = { ...initialFetch.seminars };

    // 이미 시작/입장 가능한 세미나 처리 (신청 완료 세미나뿐 아니라 신청 실패/미신청 세미나도 startDt 도래 시 포함)
    for (const [url, info] of Object.entries(initialFetch.seminars)) {
      const isReadyToEnter =
        info.processState === ProcessState.PROCESS_ENTER ||
        info.processState === ProcessState.PROCESS_STARTED ||
        isSeminarStartedByTime(info.startDt);

      if (isReadyToEnter) {
        console.log(`[${periodName}] Seminar already available for entry / started: ${info.name}`);
        await sendTelegram(`[${periodName}] Seminar already available: ${info.name}`);
        const targetUrl = info.seminarId ? `${SEMINAR_DETAIL_PAGE}${info.seminarId}` : url;

        // 포인트미지급 여부 및 입장이력 확인 (detail API 조회)
        let isPointExcluded = false;
        let hasEntryHistory = false;
        if (info.seminarId) {
          const detailCheck = await checkSeminarEndStatusFromApi(info.seminarId);
          isPointExcluded = detailCheck.isPointExcluded;
          hasEntryHistory = detailCheck.hasEntryHistory;
          info.isSurveyPointExcluded = isPointExcluded;
        }

        // 신청 완료되어 입장 가능한 세미나인 경우에만 온디맨드 자동 입장 시도
        const canAutoEnter = info.processState === ProcessState.PROCESS_ENTER || info.status === '입장하기';

        if (canAutoEnter) {
          // isAutoResume 상태이고 이미 입장이력이 있으면 자동입장 생략
          if (isAutoResume && hasEntryHistory) {
            console.log(
              `[${periodName}] [isAutoResume] 세미나(${info.seminarId}) 입장이력이 확인되어 자동입장을 생략합니다: ${info.name}`,
            );
            info.autoEnterDone = true;
          } else {
            // Playwright 온디맨드 입장 시도
            await withBrowserContext(providedContext, async (ctx) => {
              info.autoEnterDone = await checkAndPerformAutoEnter(
                ctx,
                info.seminarId,
                url,
                info.name,
                '입장하기',
                info.autoEnterDone,
              );
            });
          }
        }

        info.isEntryStarted = true;

        // 포인트미지급 세미나: 공지봇 알림 없이 모니터링 목록에서 제거
        if (isPointExcluded) {
          console.log(
            `[monitor_seminars] ${info.name} is point-excluded. Entry only, no channel notice, no end monitoring. (During Initialization)`,
          );
          excludedSeminarKeys.add(getSeminarTrackingKey(url, info.seminarId));
          delete monitoringList[url];
          continue;
        }

        const advancedSurveySuffix = info.isAdvancedSurvey ? ' [심화설문]' : '';
        let message = `🟢세미나시작\n**${info.name}**${advancedSurveySuffix}\n${targetUrl}`;
        if (!info.hasSurvey) {
          message += `\n(설문이 없는 세미나인 것 같습니다)`;
        }

        if (!isAutoResume) {
          await sendNotificationToChannel(message);
        } else {
          console.log(
            `[${periodName}] Skipping channel notification for already-started seminar during auto-resume: ${info.name}`,
          );
        }
      }
    }

    if (Object.keys(monitoringList).length === 0) {
      console.log(`[${periodName}] 예정된 세미나가 없어 알림 없이 모니터링을 종료합니다.`);
      return true;
    }

    const initialSeminarNames = Object.values(monitoringList)
      .map((s) => `  - ${s.name} (${s.status})`)
      .join('\n');
    await sendTelegram(
      `[${periodName}] 총 ${Object.keys(monitoringList).length}개의 세미나 감시를 시작합니다.\n${initialSeminarNames}`,
    );

    let loopIteration = 0;

    // 2. API 모니터링 루프 (1분 폴링)
    while (Object.keys(monitoringList).length > 0) {
      loopIteration++;
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

      await sleep(pollIntervalMs);

      // 메인 세미나 목록 API 호출
      const pollRes = await getTodaysSeminarsFromApi(startHour, endHour, todayIsoDate);
      if (!pollRes.success) {
        if (pollRes.isAuthExpired) {
          await sendTelegram(`🔒 [${periodName}] 세미나 모니터링 중 세션이 만료되었습니다.`);
        }
        console.warn(`[${periodName}] 세미나 목록 API 폴링 실패, 다음 주기에 재시도합니다.`);
        continue;
      }

      const currentSeminarsOnApi = pollRes.seminars;

      // 신규 발견된 세미나 추가
      for (const [url, info] of Object.entries(currentSeminarsOnApi)) {
        const trackingKey = getSeminarTrackingKey(url, info.seminarId);
        if (excludedSeminarKeys.has(trackingKey)) {
          continue;
        }
        if (!monitoringList[url]) {
          monitoringList[url] = info;
        }
      }

      // 5분마다 하트비트 로깅 (5 iterations)
      if (loopIteration % 5 === 0) {
        const activeSummary = Object.values(monitoringList)
          .map((s) => `${s.name}(${s.status},입장=${s.autoEnterDone ? '완료' : '미완료'})`)
          .join(', ');
        console.log(
          `[${periodName}] 모니터링 진행 중 (남은 세미나: ${Object.keys(monitoringList).length}건: ${activeSummary})`,
        );
      }

      const monitoredUrls = [...Object.keys(monitoringList)];

      for (const url of monitoredUrls) {
        const monitoredInfo = monitoringList[url];
        if (!monitoredInfo) continue;

        const currentInfo = currentSeminarsOnApi[url];
        const seminarId = monitoredInfo.seminarId || (currentInfo ? currentInfo.seminarId : null);
        const name = currentInfo?.name || monitoredInfo.name;
        const targetUrl = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : url;

        // ── 0. API 목록에서 사라진 세미나 처리 (감시 리스트 정리) ─────
        if (!currentInfo) {
          console.log(`[${periodName}] 세미나가 메인 API 목록에서 사라짐: ${name} (${seminarId})`);

          if (seminarId) {
            const endCheck = await checkSeminarEndStatusFromApi(seminarId);
            if (endCheck.isEnded) {
              console.log(`[${periodName}] 목록에서 사라진 세미나 종료 상태 확인됨: ${name} (${seminarId})`);

              // 시작 공지가 아직 안 나갔고 포인트 미지급이 아니면 시작 공지 먼저 발송
              if (!monitoredInfo.isEntryStarted && !monitoredInfo.isSurveyPointExcluded && !endCheck.isPointExcluded) {
                const advancedSurveySuffix = monitoredInfo.isAdvancedSurvey ? ' [심화설문]' : '';
                let startMsg = `🟢세미나시작\n**${name}**${advancedSurveySuffix}\n${targetUrl}`;
                if (!monitoredInfo.hasSurvey) {
                  startMsg += `\n(설문이 없는 세미나인 것 같습니다)`;
                }
                await sendNotificationToChannel(startMsg);
              }

              // 1. 먼저 설문 및 퀴즈 처리 (포인트 미지급이 아닌 경우)
              let quizResultMessage: string | null = null;
              let foundSurveyButton = false;
              if (!monitoredInfo.isSurveyPointExcluded && !endCheck.isPointExcluded) {
                await withBrowserContext(providedContext, async (ctx) => {
                  const res = await handleSeminarEndAndQuiz(
                    ctx,
                    {
                      name,
                      seminarId,
                      isSurveyPointExcluded: false,
                    },
                    url,
                  );
                  quizResultMessage = res.message;
                  foundSurveyButton = res.foundSurveyButton;
                });
              }

              // 2. 설문/퀴즈 완료 후 🔴 종료 공지 발송 (퀴즈 정답 포함)
              if (monitoredInfo.hasSurvey !== false || foundSurveyButton || endCheck.isSurveyOpen) {
                const quizSuffix = quizResultMessage ? `\n\n${quizResultMessage}` : '';
                const advancedSurveySuffix = monitoredInfo.isAdvancedSurvey ? ' [심화설문]' : '';
                const endMsg = `🔴세미나종료\n**${name}**${advancedSurveySuffix}\n${targetUrl}${quizSuffix}`;
                await sendNotificationToChannel(endMsg);
              }
            } else {
              console.log(
                `[${periodName}] 세미나(${name}, ${seminarId})가 목록에서 제거되어 감시 대상에서 제외합니다.`,
              );
            }
          }

          delete monitoringList[url];
          continue;
        }

        const mergedSeminarInfo: SeminarInfo = {
          ...monitoredInfo,
          name,
          seminarId,
          startDt: currentInfo?.startDt || monitoredInfo.startDt,
          endDt: currentInfo?.endDt || monitoredInfo.endDt,
          status: currentInfo?.status || monitoredInfo.status,
          processState: currentInfo?.processState ?? monitoredInfo.processState,
          cancelProcessState: currentInfo?.cancelProcessState ?? monitoredInfo.cancelProcessState,
          seminarCompleted: currentInfo?.seminarCompleted ?? monitoredInfo.seminarCompleted,
        };

        // ── A. 종료 감시 (API 기반) ──────────────────────────────────
        if (mergedSeminarInfo.isEntryStarted && seminarId) {
          const endCheck = await checkSeminarEndStatusFromApi(seminarId);

          if (endCheck.isEnded) {
            console.log(
              `[${periodName}] 세미나 종료 감지됨: ${name} (${seminarId}), isSurveyOpen=${endCheck.isSurveyOpen}`,
            );

            // 1) Playwright 온디맨드로 설문 및 퀴즈 처리
            let quizResultMessage: string | null = null;
            let foundSurveyButton = false;

            await withBrowserContext(providedContext, async (ctx) => {
              const res = await handleSeminarEndAndQuiz(
                ctx,
                {
                  name: mergedSeminarInfo.name,
                  seminarId: mergedSeminarInfo.seminarId,
                  isSurveyPointExcluded: mergedSeminarInfo.isSurveyPointExcluded || endCheck.isPointExcluded,
                },
                url,
              );
              quizResultMessage = res.message;
              foundSurveyButton = res.foundSurveyButton;
            });

            // 2) 설문/퀴즈 완료 후 🔴 세미나 종료 공지 발송 (퀴즈 정답 포함)
            if (mergedSeminarInfo.hasSurvey !== false || foundSurveyButton || endCheck.isSurveyOpen) {
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
        }

        // ── B. 입장 감시 및 자동 입장 (및 시작 감시) ────────────────
        const isReadyForEntry =
          mergedSeminarInfo.processState === ProcessState.PROCESS_ENTER ||
          mergedSeminarInfo.processState === ProcessState.PROCESS_STARTED ||
          currentInfo?.status === '입장하기' ||
          isSeminarStartedByTime(mergedSeminarInfo.startDt);

        if (isReadyForEntry) {
          // 1) 신규 입장 가능/시작 상태 감지 (공지 및 첫 입장 시도)
          if (!monitoredInfo.isEntryStarted) {
            console.log(`[${periodName}] Seminar newly ready for entry / started: ${name} (${seminarId})`);

            // 포인트미지급 여부 및 입장이력 확인 (detail API)
            let isPointExcluded = false;
            let hasEntryHistory = false;
            if (seminarId) {
              const detailCheck = await checkSeminarEndStatusFromApi(seminarId);
              isPointExcluded = detailCheck.isPointExcluded;
              hasEntryHistory = detailCheck.hasEntryHistory;
              mergedSeminarInfo.isSurveyPointExcluded = isPointExcluded;
            }

            const canAutoEnter =
              mergedSeminarInfo.processState === ProcessState.PROCESS_ENTER || currentInfo?.status === '입장하기';

            if (canAutoEnter) {
              // isAutoResume 상태이고 이미 입장이력이 있으면 자동입장 생략
              if (isAutoResume && hasEntryHistory) {
                console.log(
                  `[${periodName}] [isAutoResume] 세미나(${seminarId}) 입장이력이 확인되어 자동입장을 생략합니다: ${name}`,
                );
                mergedSeminarInfo.autoEnterDone = true;
              } else {
                // Playwright 온디맨드 자동 입장
                await withBrowserContext(providedContext, async (ctx) => {
                  mergedSeminarInfo.autoEnterDone = await checkAndPerformAutoEnter(
                    ctx,
                    seminarId,
                    url,
                    name,
                    '입장하기',
                    mergedSeminarInfo.autoEnterDone,
                  );
                });
              }
            }

            mergedSeminarInfo.isEntryStarted = true;

            // 포인트미지급 세미나: 채널 공지 없이 관리자 알림(스크린샷) 후 모니터링 목록에서 제외
            if (isPointExcluded) {
              console.log(
                `[monitor_seminars] ${name} is point-excluded. Entry only, no channel notice, no end monitoring. (During Loop)`,
              );
              const trackingKey = getSeminarTrackingKey(url, seminarId);
              excludedSeminarKeys.add(trackingKey);
              delete monitoringList[url];
              continue;
            }

            const advancedSurveySuffix = mergedSeminarInfo.isAdvancedSurvey ? ' [심화설문]' : '';
            let message = `🟢세미나시작\n**${name}**${advancedSurveySuffix}\n${targetUrl}`;
            if (!mergedSeminarInfo.hasSurvey) {
              message += `\n(설문이 없는 세미나인 것 같습니다)`;
            }
            await sendNotificationToChannel(message);
          } else if (
            !mergedSeminarInfo.autoEnterDone &&
            (mergedSeminarInfo.processState === ProcessState.PROCESS_ENTER || currentInfo?.status === '입장하기')
          ) {
            // 2) 이미 공지는 나갔으나 입장이 아직 완료되지 않았고 입장 가능한 상태인 경우 재입장 시도
            await withBrowserContext(providedContext, async (ctx) => {
              mergedSeminarInfo.autoEnterDone = await checkAndPerformAutoEnter(
                ctx,
                seminarId,
                url,
                name,
                '입장하기',
                mergedSeminarInfo.autoEnterDone,
              );
            });
          }
        }

        monitoringList[url] = mergedSeminarInfo;
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
