import fs from 'fs/promises';
import path from 'path';
import type { Page } from 'playwright';
import { sendTelegram } from '../modules/utils';

const CHEATSHEET_PATH = path.join(process.cwd(), 'data/seminar_quiz_cheatsheet.json');

export type Cheatsheet = Record<string, string>;

export interface QuizQuestion {
  questionText: string;
  options: Array<{ index: number; text: string; value: string }>;
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
  for (const opt of options) {
    if (opt.text.includes(answerKeyword)) {
      return { index: opt.index, text: opt.text };
    }
  }
  return null;
}

/**
 * 페이지에서 퀴즈 문제들을 파싱
 */
async function parseQuizQuestions(page: Page): Promise<QuizQuestion[]> {
  const questions: QuizQuestion[] = [];

  // [퀴즈] 텍스트가 포함된 .whitespace-pre-wrap 요소들 찾기
  const quizContainers = page.locator('.whitespace-pre-wrap:has(span:text("[퀴즈]"))');
  const count = await quizContainers.count();

  for (let i = 0; i < count; i++) {
    const container = quizContainers.nth(i);

    // 전체 텍스트에서 문제 추출
    const fullText = await container.innerText().catch(() => '');
    const questionLine =
      fullText
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0) || fullText.trim();

    // 보기 추출 - ol > li 안의 label > span
    const optionElements = container.locator('ol li label');
    const optionCount = await optionElements.count();

    const options: QuizQuestion['options'] = [];
    for (let j = 0; j < optionCount; j++) {
      const label = optionElements.nth(j);
      const input = label.locator('input[type="radio"]');
      const span = label.locator('span.col-start-2');

      const value = (await input.getAttribute('value')) || '';
      const text = (await span.innerText().catch(() => '')).trim();

      options.push({ index: j + 1, text, value }); // 1-indexed
    }

    questions.push({
      questionText: questionLine,
      options,
    });
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
 * 세미나 퀴즈 처리 메인 함수
 * 설문참여 페이지에서 퀴즈를 감지하고 정답을 찾아 보고
 */
async function processSeminarQuiz(page: Page, seminarName?: string): Promise<SeminarQuizResult> {
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await page.waitForSelector('.whitespace-pre-wrap:has(span:text("[퀴즈]"))', { timeout: 5000 }).catch(() => {});
    // 퀴즈 문제 파싱
    const questions = await parseQuizQuestions(page);

    if (questions.length === 0) {
      const message = seminarName
        ? `ℹ️ ${seminarName} 설문 페이지에서 퀴즈를 찾지 못했습니다.`
        : 'ℹ️ 설문 페이지에서 퀴즈를 찾지 못했습니다.';
      await sendTelegram(message);
      return { success: true, hasQuizResult: false, message };
    }

    // 족보 로드
    const cheatsheet = await loadCheatsheet();

    if (Object.keys(cheatsheet).length === 0) {
      // 족보가 비어있으면 문제만 보고
      let message = '📝 퀴즈 발견 (족보 비어있음):\n\n';
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        message += `Q${i + 1}: ${q.questionText.substring(0, 100)}...\n`;
        for (const opt of q.options) {
          message += `  ${opt.index}. ${opt.text}\n`;
        }
        message += '\n';
      }
      await sendTelegram(message);
      return { success: true, hasQuizResult: false, message };
    }

    // 각 문제에 대해 정답 찾기
    const results: QuizResult[] = [];
    let _hasUnknown = false;
    let _hasMultipleMatches = false;

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const matchingKeywords = findMatchingKeywords(q.questionText, cheatsheet);

      let selectedIndex: number | null = null;
      let selectedText: string | null = null;
      let matchedKeyword: string | null = null;
      let multipleMatches: string[] | null = null;

      if (matchingKeywords.length === 0) {
        // 족보에 없음
        _hasUnknown = true;
      } else if (matchingKeywords.length === 1) {
        // 정확히 하나 매칭
        matchedKeyword = matchingKeywords[0];
        const answerKeyword = cheatsheet[matchedKeyword];
        const found = findOptionByAnswer(q.options, answerKeyword);
        if (found) {
          selectedIndex = found.index;
          selectedText = found.text;
        } else {
          _hasUnknown = true;
        }
      } else {
        // 여러 개 매칭 - 첫 번째 것 사용하되 경고
        _hasMultipleMatches = true;
        multipleMatches = matchingKeywords;
        matchedKeyword = matchingKeywords[0];
        const answerKeyword = cheatsheet[matchedKeyword];
        const found = findOptionByAnswer(q.options, answerKeyword);
        if (found) {
          selectedIndex = found.index;
          selectedText = found.text;
        }
      }

      results.push({
        questionIndex: i + 1,
        questionText: q.questionText,
        selectedIndex,
        selectedText,
        matchedKeyword,
        multipleMatches,
      });
    }

    // 결과 메시지 생성 및 전송
    const resultMessage = formatQuizResults(results, _hasUnknown, _hasMultipleMatches);

    // 퀴즈 결과는 세미나 종료 메시지에 붙여서 보냅니다.

    // 미등록 문제가 있으면 추가 정보 전송 (admin_bot에)
    if (_hasUnknown) {
      const unknownMessage = formatUnknownQuestions(questions, results);
      await sendTelegram(unknownMessage);
    }

    return { success: true, hasQuizResult: true, message: resultMessage };
  } catch (e) {
    console.error('[seminar_quiz] 오류', e && typeof e === 'object' && 'stack' in e ? (e as Error).stack : e);
    const message = e instanceof Error ? e.message : String(e);
    await sendTelegram(`❗ 세미나 퀴즈 처리 오류: ${message}`).catch(() => {});
    return { success: false, hasQuizResult: false, message: `세미나 퀴즈 처리 오류: ${message}` };
  }
}

export { processSeminarQuiz, loadCheatsheet, CHEATSHEET_PATH };
