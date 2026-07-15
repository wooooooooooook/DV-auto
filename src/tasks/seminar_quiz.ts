import fs from 'fs/promises';
import path from 'path';
import type { Page } from 'playwright';
import { sendTelegram } from '../modules/utils';

const CHEATSHEET_PATH = path.join(process.cwd(), 'data/seminar_quiz_cheatsheet.json');

export type Cheatsheet = Record<string, string>;

export interface QuizQuestion {
  questionText: string;
  options: Array<{ index: number; text: string; value: string; id: string }>;
  isQuiz: boolean; // [퀴즈] 마커 있으면 true
  name: string;   // radio group name (e.g. userQuestions.7.optionIds)
}

interface QuizResult {
  questionIndex: number;
  questionText: string;
  selectedIndex: number | null;
  selectedText: string | null;
  matchedKeyword: string | null;
  multipleMatches: string[] | null; // 여러 개 매칭된 경우
}

async function loadCheatsheet(): Promise<Cheatsheet> {
  try {
    const raw = await fs.readFile(CHEATSHEET_PATH, 'utf8');
    return JSON.parse(raw) as Cheatsheet;
  } catch (error) {
    console.warn('[seminar_quiz] 족보 파일 로드 실패, 빈 객체 사용', error);
    return {};
  }
}

/**
 * 문제 텍스트에서 족보 키워드 검색
 * 여러 개가 매칭되면 모두 반환
 */
export function findMatchingKeywords(questionText: string, cheatsheet: Cheatsheet): string[] {
  const matches: string[] = [];
  for (const keyword of Object.keys(cheatsheet)) {
    if (questionText.includes(keyword)) {
      matches.push(keyword);
    }
  }
  return matches;
}

/**
 * 보기에서 정답 키워드가 포함된 항목 찾기
 * 1-indexed 반환 (1번, 2번, ...)
 */
export function findOptionByAnswer(
  options: QuizQuestion['options'],
  answerKeyword: string,
): { index: number; text: string } | null {
  const normalizedAnswer = normalizeForMatch(answerKeyword);

  // 1) 엄격 매칭: 보기 텍스트가 정답 키워드를 포함하는지 확인
  for (const opt of options) {
    if (normalizeForMatch(opt.text).includes(normalizedAnswer)) {
      return { index: opt.index, text: opt.text };
    }
  }

  // 2) 역방향 매칭: 정답 키워드가 보기 텍스트를 포함하는 경우
  for (const opt of options) {
    const normalizedOption = normalizeForMatch(opt.text);
    if (normalizedAnswer.includes(normalizedOption)) {
      return { index: opt.index, text: opt.text };
    }
  }

  return null;
}

function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/[.,!?"'`~·•…]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * 여러 키워드가 매칭되는 경우 가장 구체적인(긴) 키워드부터 시도해
 * 실제 보기 텍스트에서 답을 찾을 수 있는 후보를 우선 선택
 */
export function resolveBestKeywordMatch(
  questionText: string,
  options: QuizQuestion['options'],
  cheatsheet: Cheatsheet,
): { keyword: string; option: { index: number; text: string } } | null {
  const matchingKeywords = findMatchingKeywords(questionText, cheatsheet).sort((a, b) => b.length - a.length);
  for (const keyword of matchingKeywords) {
    const answerKeyword = cheatsheet[keyword];
    const option = findOptionByAnswer(options, answerKeyword);
    if (option) {
      return { keyword, option };
    }
  }
  return null;
}

/**
 * 페이지에서 모든 설문 문항(퀴즈 + 일반)을 파싱
 * 각 문항의 radio group name, 퀴즈 여부, 선택지를 추출
 */
async function parseQuizQuestions(page: Page): Promise<QuizQuestion[]> {
  const questions: QuizQuestion[] = [];

  // .whitespace-pre-wrap 안에서 <ol><li><label><input type="radio"> 구조 탐색
  // outer label: <label for="userQuestions.N.optionIds" class="block">
  // inner <div class="whitespace-pre-wrap"> 안에 질문 텍스트 + <ol> 보기
  const outerLabels = page.locator('label.block:has(.whitespace-pre-wrap)');

  const count = await outerLabels.count();
  for (let i = 0; i < count; i++) {
    const outerLabel = outerLabels.nth(i);

    // outer label의 for 속성 → radio group name
    const name = (await outerLabel.getAttribute('for')) || '';
    if (!name) continue;

    // div.whitespace-pre-wrap 안에서 텍스트 추출
    const questionText = await outerLabel.locator('.whitespace-pre-wrap').first().innerText().catch(() => '');
    // 첫 번째 비어있지 않은 줄을 질문으로 사용
    const firstLine = questionText.split('\n').map((l: string) => l.trim()).find((l: string) => l.length > 0) || questionText.trim();

    // [퀴즈] 마커 확인 (span 태그 내 포함)
    const hasQuizMarker = await outerLabel.locator('span:text("[퀴즈]")').count() > 0;

    // ol > li 안의 label > radio + span.col-start-2
    const optionElements = outerLabel.locator('ol li label');
    const optionCount = await optionElements.count();

    const options: QuizQuestion['options'] = [];
    for (let j = 0; j < optionCount; j++) {
      const label = optionElements.nth(j);
      const input = label.locator('input[type="radio"]');
      const span = label.locator('span.col-start-2');

      const value = (await input.getAttribute('value')) || '';
      const text = (await span.innerText().catch(() => '')).trim();

      options.push({ index: j + 1, text, value, id: value });
    }

    if (options.length > 0) {
      questions.push({
        questionText: firstLine,
        options,
        isQuiz: hasQuizMarker,
        name,
      });
    }
  }

  return questions;
}

/**
 * 퀴즈 결과를 텔레그램 메시지 형식으로 포맷
 */
function formatQuizResults(results: QuizResult[], _hasUnknown: boolean, _hasMultipleMatches: boolean): string {
  let message = '';

  // 정답 요약 (예: "퀴즈 정답 213")
  const answerSummary = results.map((r) => (r.selectedIndex !== null ? r.selectedIndex : '?')).join('');
  message += `퀴즈 정답 ${answerSummary}\n\n`;

  // 상세 내역
  for (const result of results) {
    const shortQuestion =
      result.questionText.length > 25 ? result.questionText.substring(0, 25) + '...' : result.questionText;

    if (result.multipleMatches && result.multipleMatches.length > 1) {
      message += `⚠️ Q${result.questionIndex}: ${shortQuestion}\n`;
      message += `   → 여러 키워드 매칭: ${result.multipleMatches.join(', ')}\n`;
      message += `   → 선택: ${result.selectedText || '없음'} (${result.selectedIndex || '?'}번)\n\n`;
    } else if (result.selectedIndex !== null) {
      message += `✅ Q${result.questionIndex}: ${shortQuestion}\n`;
      message += `   → ${result.selectedText} (${result.selectedIndex}번)\n\n`;
    } else {
      message += `❓ Q${result.questionIndex}: ${shortQuestion}\n`;
    }
  }

  return message;
}

/**
 * 미등록 문제를 텔레그램 메시지 형식으로 포맷
 */
function formatUnknownQuestions(questions: QuizQuestion[], results: QuizResult[]): string {
  let message = '❓ 족보에 없는 퀴즈:\n\n';

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.selectedIndex === null) {
      const q = questions[i];
      message += `Q${result.questionIndex}: ${q.questionText.substring(0, 100)}...\n`;
      for (const opt of q.options) {
        message += `  ${opt.index}. ${opt.text}\n`;
      }
      message += `\n등록: /add_seminar_quiz <키워드> | <정답>\n\n`;
    }
  }

  return message;
}

type SeminarQuizResult = {
  success: boolean;
  hasQuizResult: boolean;
  message: string;
};

/**
 * 퀴즈 여부에 따라 선택할 선택지 인덱스를 결정
 * - [퀴즈] 마커 있음 → 족보에서 정답 검색 (1-indexed)
 * - 일반 문항   → 2번 옵션 선택 (1-indexed)
 * 반환: null = 선택 안 함 (족보에 없거나 옵션 초과)
 */
async function resolveSelection(
  question: QuizQuestion,
  cheatsheet: Cheatsheet,
): Promise<{ optionIndex: number; selectedText: string } | null> {
  if (question.isQuiz) {
    const bestMatch = resolveBestKeywordMatch(question.questionText, question.options, cheatsheet);
    if (!bestMatch) return null;
    return { optionIndex: bestMatch.option.index, selectedText: bestMatch.option.text };
  }
  // 일반 문항: 2번 옵션
  if (question.options.length >= 2) {
    return { optionIndex: 2, selectedText: question.options[1].text };
  }
  return null;
}

/**
 * 세미나 퀴즈 처리 메인 함수
 * 설문참여 페이지에서 퀴즈를 감지하고 정답을 찾아 클릭+제출
 * @param isAdvancedSurvey - 심화설문 여부 (true면 제출 후 outro 처리 스킵)
 */
async function processSeminarQuiz(page: Page, seminarName?: string, isAdvancedSurvey = false): Promise<SeminarQuizResult> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});

    const quizSelector = '.whitespace-pre-wrap:has(span:text("[퀴즈]"))';
    let isQuizVisible = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      isQuizVisible = await page
        .locator(quizSelector)
        .first()
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);

      if (isQuizVisible) break;
      if (attempt < 3) {
        console.log(
          `[seminar_quiz] [퀴즈] 텍스트 탐지 실패, 새로고침 재시도 (${attempt}/3) (${seminarName ?? 'unknown'})`,
        );
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    const questions = await parseQuizQuestions(page);

    if (questions.length === 0) {
      const message = seminarName
        ? `ℹ️ ${seminarName} 설문 페이지에서 문항을 찾지 못했습니다.`
        : 'ℹ️ 설문 페이지에서 문항을 찾지 못했습니다.';
      const shotPath = `screenshot/quiz_not_found_${Date.now()}.png`;
      await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
      await sendTelegram(message, shotPath);
      return { success: true, hasQuizResult: false, message };
    }

    const cheatsheet = await loadCheatsheet();

    // ① 모든 문항에 대해 선택지 결정
    const results: QuizResult[] = [];
    const selections: Array<{ name: string; value: string; selectedText: string }> = [];
    let hasUnknown = false;
    let hasMultipleMatches = false;

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];

      let selectedIndex: number | null = null;
      let selectedText: string | null = null;
      let matchedKeyword: string | null = null;
      let multipleMatches: string[] | null = null;

      const selection = await resolveSelection(q, cheatsheet);

      if (selection) {
        selectedIndex = selection.optionIndex;
        selectedText = selection.selectedText;
        selections.push({ name: q.name, value: q.options[selection.optionIndex - 1].value, selectedText });
      } else if (q.isQuiz) {
        hasUnknown = true;
      }

      if (q.isQuiz && Object.keys(cheatsheet).length > 0) {
        const matchingKeywords = findMatchingKeywords(q.questionText, cheatsheet);
        if (matchingKeywords.length > 1) {
          hasMultipleMatches = true;
          multipleMatches = matchingKeywords;
        }
        if (!selection) {
          hasUnknown = true;
        }
        if (matchingKeywords.length > 0 && !selectedText) {
          matchedKeyword = matchingKeywords[0];
        }
      }

      results.push({ questionIndex: i + 1, questionText: q.questionText, selectedIndex, selectedText, matchedKeyword, multipleMatches });
    }

    // ② 라디오 버튼 클릭
    for (const sel of selections) {
      const radio = page.locator(`input[type="radio"][name="${sel.name}"][value="${sel.value}"]`).first();
      if (await radio.count() > 0) {
        await radio.check({ force: true }).catch(() => {});
        console.log(`[seminar_quiz] Selected Q (name=${sel.name}, value=${sel.value}, text=${sel.selectedText})`);
      } else {
        console.warn(`[seminar_quiz] Radio not found: [name=${sel.name}][value=${sel.value}]`);
      }
      await page.waitForTimeout(300);
    }

    // ③ 제출 버튼 클릭
    const submitBtn = page.locator('input[type="submit"][value="제출하기"]').first();
    const submitExists = await submitBtn.count() > 0;
    if (submitExists) {
      await submitBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1000);

      // ④ 확인 버튼 (심화설문 아닐 때만)
      if (!isAdvancedSurvey) {
        const confirmBtn = page.locator('button[type="button"]:text("확인")').first();
        if (await confirmBtn.count() > 0) {
          console.log('[seminar_quiz] 확인 버튼 발견, 클릭');
          await confirmBtn.click({ force: true }).catch(() => {});
          await page.waitForTimeout(500);
        }

        // ⑤ outro 페이지 도착 시 스크린샷 전송
        await page.waitForURL('**/outro**', { timeout: 10000 }).catch(() => {});
        const currentUrl = page.url();
        if (currentUrl.includes('/outro')) {
          const outroShotPath = `screenshot/quiz_outro_${Date.now()}.png`;
          await page.screenshot({ path: outroShotPath, fullPage: true }).catch(() => {});
          const msg = `${seminarName ? `${seminarName} ` : ''}설문 완료 (outro 확인)`;
          await sendTelegram(msg, outroShotPath).catch(() => {});
        }
      }
    } else {
      console.warn('[seminar_quiz] 제출하기 버튼을 찾지 못했습니다.');
    }

    // ⑥ 결과 메시지 생성
    const resultMessage = formatQuizResults(results, hasUnknown, hasMultipleMatches);
    if (hasUnknown) {
      const unknownMessage = formatUnknownQuestions(questions, results);
      await sendTelegram(unknownMessage);
    }

    return { success: true, hasQuizResult: true, message: resultMessage };
  } catch (e) {
    console.error('[seminar_quiz] 오류', e && typeof e === 'object' && 'stack' in e ? (e as Error).stack : e);
    const message = e instanceof Error ? e.message : String(e);
    const errShotPath = `screenshot/quiz_error_${Date.now()}.png`;
    await page.screenshot({ path: errShotPath, fullPage: true }).catch(() => {});
    await sendTelegram(`❗ 세미나 퀴즈 처리 오류: ${message}`, errShotPath).catch(() => {});
    return { success: false, hasQuizResult: false, message: `세미나 퀴즈 처리 오류: ${message}` };
  }
}

export { processSeminarQuiz, resolveSelection, loadCheatsheet, CHEATSHEET_PATH };
