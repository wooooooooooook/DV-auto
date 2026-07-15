import type { BrowserContext, Page } from 'playwright';
import type { PlaywrightRunArgs, TaskContext, TaskResult } from '../types';
import { safeGoto } from '../modules/utils';
import { processSeminarQuiz } from './seminar_quiz';

/**
 * 수동 세미나 퀴즈 실행 태스크
 * ctx.args.seminarId 와 ctx.args.isAdvancedSurvey 를 받아서 해당 세미나 디테일 페이지로 이동
 *   → 설문참여 → 퀴즈 (선택+제출) 처리
 */
async function run({ page }: PlaywrightRunArgs, options?: Record<string, unknown>): Promise<TaskResult> {
  // options 우선, 없으면 ctx.args (그 다음 호환 위해 process.env 도 fallback)
  const opts = (options as { args?: Record<string, string> } | undefined)?.args ?? {};
  const fromCtx: Record<string, string> = opts;
  const envFallback = process.env as Record<string, string>;
  const seminarId = fromCtx.SEMINAR_ID || fromCtx.seminarId || envFallback.SEMINAR_ID || '';
  const isAdvancedSurvey =
    String(
      fromCtx.IS_ADVANCED_SURVEY ?? fromCtx.isAdvancedSurvey ?? envFallback.IS_ADVANCED_SURVEY ?? '',
    ).toLowerCase() === 'true';

  if (!seminarId) {
    return {
      success: false,
      message: 'seminarId 가 비어 있습니다. 사용법: /run_seminar_quiz <seminarId> [advanced]',
    };
  }

  const targetUrl = `https://m.doctorville.co.kr/cme/seminar/${seminarId}`;
  const browserCtx = (page as Page).context() as BrowserContext;
  const surveyPage = await browserCtx.newPage();
  let popupPage: Page | null = null;
  let quizPage: Page = surveyPage;

  try {
    await safeGoto(surveyPage, targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await surveyPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    const surveyBtn = surveyPage.locator('text="설문참여"').first();
    const isSurveyVisible = await surveyBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (!isSurveyVisible) {
      await surveyPage.close().catch(() => {});
      return { success: false, message: `세미나(${seminarId})에서 "설문참여" 버튼을 찾지 못했습니다.` };
    }

    // 설문참여 클릭 → 팝업 감지
    const firstPopupPromise = browserCtx.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await surveyBtn.click({ force: true }).catch(() => {});
    popupPage = (await firstPopupPromise) || null;
    if (popupPage) {
      quizPage = popupPage;
      await popupPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    } else {
      await surveyPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      await surveyPage.waitForTimeout(1000);
    }

    // 개인정보 동의 모달 (상태만 로그)
    const consentModal = quizPage
      .locator('text="개인정보 활용에 대한 동의", text="개인정보 제3자 제공 동의서"')
      .first();
    if (await consentModal.isVisible({ timeout: 1500 }).catch(() => false)) {
      const agreeCheckbox = quizPage.locator('input[type="checkbox"]').first();
      const isChecked = await agreeCheckbox.isChecked().catch(() => false);
      console.log(
        `[run_seminar_quiz] 동의 체크박스 상태: ${isChecked ? 'checked' : 'unchecked'} (seminarId=${seminarId})`,
      );
    }

    // 참여하기 버튼 클릭
    const participateBtn = quizPage.locator(':text-is("설문 참여하기"), :text-is("참여하기")').first();
    if (await participateBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      const secondPopupPromise = browserCtx.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await participateBtn.click({ force: true }).catch(() => {});
      const secondPopup = (await secondPopupPromise) || null;
      if (secondPopup) {
        if (popupPage && popupPage !== quizPage) {
          await popupPage.close().catch(() => {});
        }
        popupPage = secondPopup;
        quizPage = secondPopup;
        await secondPopup.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      } else {
        await quizPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await quizPage.waitForTimeout(1000);
      }
    }

    await quizPage.waitForTimeout(5000);

    const quizResult = await processSeminarQuiz(quizPage, seminarId, isAdvancedSurvey);
    return {
      success: quizResult.success,
      message: `[수동세미나 ${seminarId}${isAdvancedSurvey ? ' (심화)' : ''}] ${quizResult.message || '완료'}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, message: `[run_seminar_quiz] 오류: ${msg}` };
  } finally {
    if (popupPage) await popupPage.close().catch(() => {});
    await surveyPage.close().catch(() => {});
  }
}

export { run };
// satisfy linter — TaskContext reference keeps the import "used"
export type { TaskContext };
