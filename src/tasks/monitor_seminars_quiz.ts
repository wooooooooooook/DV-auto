import type { BrowserContext, Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { sendTelegram, ensureLoggedIn, safeGoto, sleep } from '../modules/utils';
import { processSeminarQuiz, loadCheatsheet } from './seminar_quiz';
import { fetchSeminarSurveyQuizHttp } from '../modules/seminar_survey_api';
import { SEMINAR_DETAIL_PAGE, type MonitoredSeminarItem, type SeminarQuizFetchStatus } from './monitor_seminars_notice';
import type { SuspectedAdvancedType } from '../services/seminar_repository';

/** HTTP 퀴즈 사전 조회 최대 시도 횟수 (최초 1회 + 짧은 재시도 2회) */
export const QUIZ_HTTP_FAST_MAX_ATTEMPTS = 3;
/** 짧은 재시도 간격 (기본 1.5초) */
export const QUIZ_HTTP_FAST_RETRY_INTERVAL_MS = 1500;

/**
 * 기본 재시도 간격을 반환합니다. 테스트/운영에서 SEMINAR_QUIZ_HTTP_RETRY_INTERVAL_MS 로 대기시간을 조절할 수 있습니다.
 */
export function resolveQuizHttpRetryIntervalMs(): number {
  const fromEnv = Number(process.env.SEMINAR_QUIZ_HTTP_RETRY_INTERVAL_MS);
  if (Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return QUIZ_HTTP_FAST_RETRY_INTERVAL_MS;
}

/** 실제로 퀴즈 문항이 있는 세미나인지 판단할 때 참조하는 최소 응답 필드 */
export interface QuizHttpFastResponseLike {
  success: boolean;
  quizResultMessage?: string;
  quizSummaryMessage?: string;
  quizQuestionCnt?: number;
  depthSurveyQuestionCnt?: number;
  /** 설문 전체 문항 수 (없으면 allQuestions 길이로 판단) */
  totalQuestionCnt?: number;
  /** 실제로 읽어낸 설문 문항 목록 (0문항 조회 실패와 "설문이 비어 있음"을 구분하는 기준) */
  allQuestions?: unknown[];
  /** 일부 설문 페이지 조회/파싱 실패로 문항을 온전히 읽지 못한 경우 true */
  incomplete?: boolean;
  /** 조회에 실패한 설문 페이지 번호 목록 */
  failedPages?: number[];
  errorMessage?: string;
}

export interface QuizHttpFastStatusResolution {
  status: SeminarQuizFetchStatus;
  quizResultMessage: string | null;
  errorMessage?: string;
  /** 이번 응답에서 실제로 확인된 설문 문항 수 */
  surveyQuestionCnt: number;
  /** 응답은 받았으나 설문 문항을 온전히 읽지 못해 재시도가 필요한 상태인지 */
  retryable: boolean;
  /** 일부 설문 페이지 조회 실패 여부 */
  incomplete: boolean;
}

export interface SeminarQuizHttpFastResult {
  /** found: 정답 확보 / no_quiz: 진짜 문항 없음 / http_failed: 조회 자체 실패 */
  status: SeminarQuizFetchStatus;
  quizResultMessage: string | null;
  /** 실제 HTTP 조회를 수행한 횟수 (seminarId 없음 등 사전 불가 케이스는 0) */
  attempts: number;
  seminarId: string | null;
  errorMessage?: string;
  isAdvancedSurvey?: boolean;
  isSuspectedAdvancedSurvey?: boolean;
  suspectedAdvancedType?: SuspectedAdvancedType;
  /** 응답에서 확인된 설문 문항 수 (0문항이면 no_quiz로 확정하지 않음) */
  surveyQuestionCnt?: number;
  /** 일부 설문 페이지 조회 실패로 불완전하게 읽었는지 */
  incomplete?: boolean;
}

export interface SeminarQuizHttpFastOptions {
  maxAttempts?: number;
  retryIntervalMs?: number;
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * HTTP 응답에서 실제로 읽어낸 설문 문항 수를 계산합니다.
 * - allQuestions가 포함되어 있으면 그 길이를 신뢰합니다. (페이지 조회 실패로 0개일 수 있음)
 * - 없으면 totalQuestionCnt 메타데이터를 사용합니다.
 */
export function countSeminarSurveyQuestions(httpResult: QuizHttpFastResponseLike): number {
  if (Array.isArray(httpResult.allQuestions)) return httpResult.allQuestions.length;
  const fromMeta = httpResult.totalQuestionCnt;
  return typeof fromMeta === 'number' && fromMeta > 0 ? fromMeta : 0;
}

/**
 * 순수 HTTP 응답으로부터 퀴즈 결과 상태를 판별합니다.
 * - 정답(또는 심화설문 문항) 메시지가 있으면 found
 * - 설문 페이지 일부/전체 조회 실패(incomplete)했거나 설문 문항을 0개 읽었으면 http_failed(재시도 대상)
 * - 설문 문항이 실제로 있고 퀴즈/심화 문항 수가 0이면 no_quiz(진짜 퀴즈 없음)
 * - 그 외(문항은 있으나 정답 메시지 생성 불가)는 http_failed
 */
export function resolveQuizHttpFastStatus(httpResult: QuizHttpFastResponseLike): QuizHttpFastStatusResolution {
  const surveyQuestionCnt = countSeminarSurveyQuestions(httpResult);
  const incomplete = Boolean(httpResult.incomplete);
  const quizResultMessage = httpResult.quizResultMessage || httpResult.quizSummaryMessage || null;

  if (quizResultMessage) {
    return { status: 'found', quizResultMessage, surveyQuestionCnt, retryable: false, incomplete };
  }

  const failedPages = (httpResult.failedPages ?? []).filter((p) => Number.isFinite(p));
  const failedPagesSuffix = failedPages.length > 0 ? ` (실패 페이지: ${failedPages.join(', ')})` : '';

  // 일부 페이지라도 조회/파싱에 실패했다면 문항이 0개처럼 보여도 no_quiz로 확정하지 않습니다.
  if (incomplete) {
    return {
      status: 'http_failed',
      quizResultMessage: null,
      surveyQuestionCnt,
      retryable: true,
      incomplete,
      errorMessage:
        httpResult.errorMessage || `설문 일부 페이지 조회 실패로 문항을 온전히 읽지 못했습니다${failedPagesSuffix}`,
    };
  }

  // 설문 문항을 하나도 읽지 못한 경우: "퀴즈없이 설문만"이 아니라 조회 실패로 간주합니다.
  if (surveyQuestionCnt === 0) {
    return {
      status: 'http_failed',
      quizResultMessage: null,
      surveyQuestionCnt: 0,
      retryable: true,
      incomplete,
      errorMessage: httpResult.errorMessage || '설문 문항 0개 (설문 항목을 읽지 못했습니다)',
    };
  }

  const quizQuestionCnt = httpResult.quizQuestionCnt ?? 0;
  const depthSurveyQuestionCnt = httpResult.depthSurveyQuestionCnt ?? 0;
  if (quizQuestionCnt === 0 && depthSurveyQuestionCnt === 0) {
    return { status: 'no_quiz', quizResultMessage: null, surveyQuestionCnt, retryable: false, incomplete };
  }
  return {
    status: 'http_failed',
    quizResultMessage: null,
    surveyQuestionCnt,
    retryable: false,
    incomplete,
    errorMessage: httpResult.errorMessage || '퀴즈 정답 메시지를 생성하지 못했습니다',
  };
}

/**
 * 순수 HTTP API로 퀴즈 결과 및 심화설문 여부를 1~2초 내에 사전 조회합니다.
 * - seminarId가 없는 경우 바로 null 반환
 * - HTTP 조회 실패 시 null 반환 (후속 브라우저 fallback 처리)
 */
export async function tryFetchSeminarQuizHttpFast(
  seminarId: string | null | undefined,
  isAdvancedSurvey?: boolean,
  options?: SeminarQuizHttpFastOptions,
): Promise<SeminarQuizHttpFastResult> {
  const sid = seminarId ? String(seminarId).trim() : '';
  if (!sid) {
    return {
      status: 'http_failed',
      quizResultMessage: null,
      attempts: 0,
      seminarId: null,
      errorMessage: 'seminarId 없음',
    };
  }

  const maxAttempts = Math.max(1, options?.maxAttempts ?? QUIZ_HTTP_FAST_MAX_ATTEMPTS);
  const retryIntervalMs = options?.retryIntervalMs ?? resolveQuizHttpRetryIntervalMs();
  const wait = options?.sleepFn ?? sleep;

  let lastErrorMessage: string | undefined;
  let lastMeta: {
    isAdvancedSurvey?: boolean;
    isSuspectedAdvancedSurvey?: boolean;
    suspectedAdvancedType?: SuspectedAdvancedType;
  } = {};
  let lastSurveyQuestionCnt: number | undefined;
  let lastIncomplete: boolean | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const cheatsheet = await loadCheatsheet();
      const httpResult = await fetchSeminarSurveyQuizHttp(sid, cheatsheet, isAdvancedSurvey);
      if (httpResult && httpResult.success) {
        const resolved = resolveQuizHttpFastStatus(httpResult);
        lastMeta = {
          isAdvancedSurvey: httpResult.isAdvancedSurvey || isAdvancedSurvey,
          isSuspectedAdvancedSurvey: httpResult.isSuspectedAdvancedSurvey,
          suspectedAdvancedType: httpResult.suspectedAdvancedType,
        };
        // 설문 문항을 온전히 읽지 못한 경우(0문항·일부 페이지 조회 실패)는 재시도 대상입니다.
        if (resolved.retryable) {
          lastErrorMessage = resolved.errorMessage;
          lastSurveyQuestionCnt = resolved.surveyQuestionCnt;
          lastIncomplete = resolved.incomplete;
          console.warn(
            `[monitor_seminars] HTTP 퀴즈 사전 조회에서 설문 문항 미확보 (${sid}, ${attempt}/${maxAttempts}): ${lastErrorMessage}`,
          );
        } else {
          // 응답은 받았으나 정답 메시지가 없는 비정상 형태는 재시도 없이 그대로 반환
          return {
            status: resolved.status,
            quizResultMessage: resolved.quizResultMessage,
            attempts: attempt,
            seminarId: sid,
            errorMessage: resolved.errorMessage,
            isAdvancedSurvey: lastMeta.isAdvancedSurvey,
            isSuspectedAdvancedSurvey: lastMeta.isSuspectedAdvancedSurvey,
            suspectedAdvancedType: lastMeta.suspectedAdvancedType,
            surveyQuestionCnt: resolved.surveyQuestionCnt,
            incomplete: resolved.incomplete,
          };
        }
      } else {
        lastErrorMessage = httpResult?.errorMessage || 'HTTP 퀴즈 조회 실패';
        console.warn(
          `[monitor_seminars] HTTP 퀴즈 사전 조회 실패 (${sid}, ${attempt}/${maxAttempts}): ${lastErrorMessage}`,
        );
      }
    } catch (err) {
      lastErrorMessage = err instanceof Error ? err.message : String(err);
      console.warn(
        `[monitor_seminars] HTTP 퀴즈 사전 조회 예외 (${sid}, ${attempt}/${maxAttempts}):`,
        lastErrorMessage,
      );
    }

    if (attempt < maxAttempts) {
      await wait(retryIntervalMs);
    }
  }

  return {
    status: 'http_failed',
    quizResultMessage: null,
    attempts: maxAttempts,
    seminarId: sid,
    errorMessage: lastErrorMessage,
    isAdvancedSurvey: lastMeta.isAdvancedSurvey,
    isSuspectedAdvancedSurvey: lastMeta.isSuspectedAdvancedSurvey,
    suspectedAdvancedType: lastMeta.suspectedAdvancedType,
    surveyQuestionCnt: lastSurveyQuestionCnt,
    incomplete: lastIncomplete,
  };
}

/**
 * HTTP 사전 조회 결과를 세미나 항목 상태에 반영합니다.
 * - found: 정답 메시지 저장 / 분석중 해제
 * - no_quiz: 문항 없음 확정 / 분석중 해제 및 "문항분석중.." 미표시
 * - http_failed: 정답이 없으면 브라우저 파싱 대기(분석중) 상태로 표시
 */
export function applySeminarQuizHttpFetchResult(
  target: Pick<
    MonitoredSeminarItem,
    | 'quizResultMessage'
    | 'quizFetchStatus'
    | 'quizAnalysisPending'
    | 'isAdvancedSurvey'
    | 'isSuspectedAdvancedSurvey'
    | 'suspectedAdvancedType'
  >,
  result: SeminarQuizHttpFastResult,
): SeminarQuizHttpFastResult {
  if (result.isAdvancedSurvey !== undefined) {
    target.isAdvancedSurvey = result.isAdvancedSurvey;
  }
  if (result.isSuspectedAdvancedSurvey !== undefined) {
    target.isSuspectedAdvancedSurvey = result.isSuspectedAdvancedSurvey;
    target.suspectedAdvancedType = result.isSuspectedAdvancedSurvey ? result.suspectedAdvancedType : undefined;
  }

  target.quizFetchStatus = result.status;

  if (result.status === 'found') {
    if (result.quizResultMessage) {
      target.quizResultMessage = result.quizResultMessage;
    }
    target.quizAnalysisPending = false;
  } else if (result.status === 'no_quiz') {
    target.quizAnalysisPending = false;
  } else {
    // HTTP 조회 실패: 기존 정답이 없을 때만 브라우저 파싱 대기 상태로 둡니다.
    target.quizAnalysisPending = !target.quizResultMessage;
  }

  return result;
}

/**
 * Playwright 브라우저 파싱(handleSeminarEndAndQuiz) 완료 후 분석중 상태를 해제합니다.
 * - 브라우저에서 정답을 얻었으면 found 로 갱신
 * - 브라우저 파싱으로 퀴즈 문항이 정말 없음이 확인되었으면(quizAbsent) no_quiz 로 갱신
 * - 그 외는 분석중만 내립니다.
 */
export function completeSeminarQuizAnalysis(
  target: Pick<MonitoredSeminarItem, 'quizResultMessage' | 'quizFetchStatus' | 'quizAnalysisPending'>,
  browserMessage: string | null | undefined,
  quizAbsent = false,
): void {
  if (browserMessage) {
    target.quizResultMessage = browserMessage;
    target.quizFetchStatus = 'found';
  } else if (quizAbsent) {
    target.quizFetchStatus = 'no_quiz';
  }
  target.quizAnalysisPending = false;
}

/**
 * 세미나 종료 후 Playwright로 설문참여 버튼을 클릭하고 퀴즈를 처리하는 함수
 */
export async function handleSeminarEndAndQuiz(
  context: BrowserContext,
  seminar: {
    name: string;
    seminarId: string | null;
    isSurveyPointExcluded?: boolean;
    isAdvancedSurvey?: boolean;
    isSuspectedAdvancedSurvey?: boolean;
  },
  fallbackUrl: string,
): Promise<{
  message: string | null;
  foundSurveyButton: boolean;
  /** 브라우저 파싱 결과 설문은 있으나 퀴즈 문항이 실제로 없음이 확인됨 */
  quizAbsent: boolean;
  /** 브라우저에서 실제로 읽어낸 설문 문항 수 (0이면 조회 실패로 구분) */
  surveyQuestionCnt: number;
  isSuspectedAdvancedSurvey?: boolean;
  suspectedAdvancedType?: SuspectedAdvancedType;
}> {
  // 포인트미지급 세미나는 설문/퀴즈 처리 건너뛰기
  if (seminar.isSurveyPointExcluded) {
    console.log(
      `[monitor_seminars] Skipping quiz/survey handling for point-excluded seminar: ${seminar.name} (${seminar.seminarId})`,
    );
    return { message: null, foundSurveyButton: false, quizAbsent: false, surveyQuestionCnt: 0 };
  }
  const targetUrl = seminar.seminarId ? `${SEMINAR_DETAIL_PAGE}${seminar.seminarId}` : fallbackUrl;
  const surveyPage = await context.newPage();
  let popupPage: Page | null = null;
  let quizPage: Page = surveyPage;
  let quizResultMessage: string | null = null;
  let foundSurveyButton = false;
  let quizAbsent = false;
  let parsedSurveyQuestionCnt = 0;
  let isSuspectedAdvancedSurveyResult: boolean | undefined = undefined;
  let suspectedAdvancedTypeResult: SuspectedAdvancedType | undefined = undefined;

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
      const quizResult = await processSeminarQuiz(
        quizPage,
        seminar.seminarId ?? undefined,
        seminar.isAdvancedSurvey,
        seminar.isSuspectedAdvancedSurvey,
      );
      if (quizResult.success && quizResult.hasQuizResult) {
        quizResultMessage = quizResult.message;
      } else if (
        quizResult.success &&
        !quizResult.hasQuizResult &&
        !seminar.isAdvancedSurvey &&
        !quizResult.isSuspectedAdvancedSurvey &&
        (quizResult.surveyQuestionCnt ?? 0) > 0
      ) {
        // 설문참여 플로우를 수행한 뒤 퀴즈 문항이 실제로 없음이 확인된 경우.
        // 설문 문항을 하나도 읽지 못한 경우(조회 실패)에는 no_quiz로 확정하지 않습니다.
        // (심화설문·심화설문 의심 세미나는 주관식 문항이 정답 역할을 하므로 대상에서 제외)
        quizAbsent = true;
      } else if (quizResult.success && !quizResult.hasQuizResult) {
        console.warn(
          `[monitor_seminars] 설문 문항을 확인하지 못해 퀴즈없이 설문만(no_quiz) 판정을 보류합니다 (${seminar.seminarId}, 확인된 문항 수: ${quizResult.surveyQuestionCnt ?? 0})`,
        );
      }
      parsedSurveyQuestionCnt = quizResult.surveyQuestionCnt ?? 0;
      if (quizResult.isSuspectedAdvancedSurvey !== undefined) {
        isSuspectedAdvancedSurveyResult = quizResult.isSuspectedAdvancedSurvey;
        suspectedAdvancedTypeResult = quizResult.suspectedAdvancedType;
      }
    } else {
      console.log(`[monitor_seminars] "설문참여" 버튼을 찾지 못함 (${seminar.seminarId})`);
      // 버튼이 없어도 현재 페이지에서 퀴즈 찾기 시도
      const quizResult = await processSeminarQuiz(
        quizPage,
        seminar.seminarId ?? undefined,
        seminar.isAdvancedSurvey,
        seminar.isSuspectedAdvancedSurvey,
      );
      if (quizResult.success && quizResult.hasQuizResult) {
        quizResultMessage = quizResult.message;
      }
      parsedSurveyQuestionCnt = quizResult.surveyQuestionCnt ?? 0;
      if (quizResult.isSuspectedAdvancedSurvey !== undefined) {
        isSuspectedAdvancedSurveyResult = quizResult.isSuspectedAdvancedSurvey;
        suspectedAdvancedTypeResult = quizResult.suspectedAdvancedType;
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
  return {
    message: quizResultMessage,
    foundSurveyButton,
    quizAbsent,
    surveyQuestionCnt: parsedSurveyQuestionCnt,
    isSuspectedAdvancedSurvey: isSuspectedAdvancedSurveyResult,
    suspectedAdvancedType: suspectedAdvancedTypeResult,
  };
}
