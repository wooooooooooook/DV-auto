import type { BrowserContext, Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { sendTelegram, ensureLoggedIn, safeGoto } from '../modules/utils';
import { processSeminarQuiz, loadCheatsheet } from './seminar_quiz';
import { fetchSeminarSurveyQuizHttp } from '../modules/seminar_survey_api';
import { SEMINAR_DETAIL_PAGE } from './monitor_seminars_notice';

/**
 * 순수 HTTP API로 퀴즈 결과 및 심화설문 여부를 1~2초 내에 사전 조회합니다.
 * - seminarId가 없는 경우 바로 null 반환
 * - HTTP 조회 실패 시 null 반환 (후속 브라우저 fallback 처리)
 */
export async function tryFetchSeminarQuizHttpFast(
  seminarId: string | null | undefined,
  isAdvancedSurvey?: boolean,
): Promise<{ quizResultMessage: string | null; isAdvancedSurvey?: boolean } | null> {
  if (!seminarId) return null;
  try {
    const cheatsheet = await loadCheatsheet();
    const httpResult = await fetchSeminarSurveyQuizHttp(seminarId, cheatsheet, isAdvancedSurvey);
    if (httpResult && httpResult.success) {
      const quizResultMessage = httpResult.quizResultMessage || httpResult.quizSummaryMessage || null;
      return {
        quizResultMessage,
        isAdvancedSurvey: httpResult.isAdvancedSurvey || isAdvancedSurvey,
      };
    }
  } catch (err) {
    console.warn(`[monitor_seminars] HTTP 퀴즈 사전 조회 실패 (${seminarId}):`, err);
  }
  return null;
}

/**
 * 세미나 종료 후 Playwright로 설문참여 버튼을 클릭하고 퀴즈를 처리하는 함수
 */
export async function handleSeminarEndAndQuiz(
  context: BrowserContext,
  seminar: { name: string; seminarId: string | null; isSurveyPointExcluded?: boolean; isAdvancedSurvey?: boolean },
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
      const quizResult = await processSeminarQuiz(quizPage, seminar.seminarId ?? undefined, seminar.isAdvancedSurvey);
      if (quizResult.success && quizResult.hasQuizResult) {
        quizResultMessage = quizResult.message;
      }
    } else {
      console.log(`[monitor_seminars] "설문참여" 버튼을 찾지 못함 (${seminar.seminarId})`);
      // 버튼이 없어도 현재 페이지에서 퀴즈 찾기 시도
      const quizResult = await processSeminarQuiz(quizPage, seminar.seminarId ?? undefined, seminar.isAdvancedSurvey);
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
