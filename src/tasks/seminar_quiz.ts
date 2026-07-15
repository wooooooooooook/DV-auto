import fs from 'fs/promises';
import path from 'path';
import type { Page } from 'playwright';
import { sendTelegram } from '../modules/utils';

const CHEATSHEET_PATH = path.join(process.cwd(), 'data/seminar_quiz_cheatsheet.json');

export type Cheatsheet = Record<string, string>;

export interface QuizQuestion {
  questionText: string;
  options: Array<{ index: number; text: string; value: string }>;
  /** 페이지에서 발견된 마커 (예: "[퀴즈]", "[OX]", "[주관식]"). 없으면 분류 불가 → 채널 누출 방지용. */
  marker: string | null;
  /** 마커로 추론한 문항 타입 */
  kind: 'quiz' | 'ox' | 'subjective' | 'poll' | 'unknown';
}

interface QuizResult {
  questionIndex: number;
  questionText: string;
  selectedIndex: number | null;
  selectedText: string | null;
  matchedKeyword: string | null;
  multipleMatches: string[] | null; // 여러 개 매칭된 경우
  marker: string | null;
  kind: QuizQuestion['kind'];
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
 * 인덱스를 기반으로 보기를 클릭하는 유연한 헬퍼 (1-indexed)
 */
async function clickOptionByIndex(
  page: Page,
  area: ReturnType<Page['locator']>,
  index: number,
  qNum: number,
): Promise<boolean> {
  try {
    // 인덱스 기반으로 1) ol li의 N번째 라디오나 라벨 클릭 시도
    const inputs = area.locator('input[type="radio"]');
    const inputCount = await inputs.count().catch(() => 0);

    if (inputCount >= index) {
      const radio = inputs.nth(index - 1);
      // Playwright check()는 force: true 옵션으로 숨겨진 엘리먼트도 핸들링 가능
      await radio.check({ force: true, timeout: 2000 });
      console.log(`[seminar_quiz] Q${qNum} 라디오 체크 성공 (index=${index})`);
      return true;
    }

    // 2) 폴백: 영역 내 모든 label 중 N번째 label 클릭 시도
    const labels = area.locator('label');
    const labelCount = await labels.count().catch(() => 0);
    if (labelCount >= index) {
      await labels.nth(index - 1).click({ force: true, timeout: 2000 });
      console.log(`[seminar_quiz] Q${qNum} 라벨 클릭 성공 (index=${index})`);
      return true;
    }

    // 3) 폴백: 영역 내 모든 li 중 N번째 li 클릭 시도
    const lis = area.locator('ol li, ul li');
    const liCount = await lis.count().catch(() => 0);
    if (liCount >= index) {
      await lis.nth(index - 1).click({ force: true, timeout: 2000 });
      console.log(`[seminar_quiz] Q${qNum} LI 클릭 성공 (index=${index})`);
      return true;
    }

    return false;
  } catch (e) {
    console.error(`[seminar_quiz] Q${qNum} 클릭 중 오류 (index=${index})`, e);
    return false;
  }
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
 * 페이지에서 퀴즈 문제들을 파싱
 */
// 마커 정규식: 페이지 패턴이 다양함. 대소문자 무시, 공백 유연.
const MARKER_PATTERNS: Array<{ regex: RegExp; kind: QuizQuestion['kind']; label: string }> = [
  { regex: /\[\s*퀴즈\s*\]/i, kind: 'quiz', label: '[퀴즈]' },
  { regex: /\[\s*O\s*X\s*\]/i, kind: 'ox', label: '[OX]' },
  { regex: /\[\s*주관식\s*\]/i, kind: 'subjective', label: '[주관식]' },
  { regex: /\[\s*설문\s*\]/i, kind: 'poll', label: '[설문]' },
  { regex: /\[\s*일반\s*\]/i, kind: 'poll', label: '[일반]' },
  { regex: /\[\s*poll\s*\]/i, kind: 'poll', label: '[poll]' },
];

function detectMarker(text: string): { marker: string | null; kind: QuizQuestion['kind'] } {
  for (const { regex, kind, label } of MARKER_PATTERNS) {
    if (regex.test(text)) return { marker: label, kind };
  }
  return { marker: null, kind: 'unknown' };
}

/**
 * 다양한 quiz 박스 패턴을 흡수:
 * - 표준: .whitespace-pre-wrap 안에 [퀴즈] span + ol > li label
 * - 변형 1: 마커가 같은 줄 텍스트로만 존재하고 span 분리 안 됨
 * - 변형 2: ol 안에 input[type=radio]만 있고 label 텍스트가 형제 노드
 * - 변형 3: 마커 박스와 보기 박스가 형제로 분리됨 (.gap-3 패턴)
 */
async function parseQuizQuestions(page: Page): Promise<QuizQuestion[]> {
  const questions: QuizQuestion[] = [];

  // 1) 표준 셀렉터: 마커 span이 자식으로 있는 컨테이너
  const standardContainers = page.locator(
    '.whitespace-pre-wrap:has(span:text-matches("\\\\[\\\\s*(퀴즈|O\\\\s*X|주관식|설문|일반|poll)\\\\s*\\\\]", "i"))',
  );
  // 2) 폴백 셀렉터: 마커가 텍스트로만 있는 컨테이너 (span 분리 없음)
  const fallbackContainers = page.locator('.whitespace-pre-wrap', {
    hasText: /^\s*\[\s*(퀴즈|O\s*X|주관식|설문|일반|poll)\s*\]/i,
  });

  const standardCount = await standardContainers.count();
  const fallbackCount = await fallbackContainers.count();
  const seenHandles = new WeakSet<Element>();
  const containers: Array<{
    handle: Awaited<ReturnType<typeof standardContainers.nth>>['elementHandle'] extends () => Promise<infer H>
      ? H
      : never;
  }> = [];

  for (let i = 0; i < standardCount; i++) {
    const h = await standardContainers
      .nth(i)
      .elementHandle()
      .catch(() => null);
    if (h) {
      const el = h.asElement();
      if (el && !seenHandles.has(el)) {
        seenHandles.add(el);
        containers.push({ handle: h });
      }
    }
  }
  for (let i = 0; i < fallbackCount; i++) {
    const h = await fallbackContainers
      .nth(i)
      .elementHandle()
      .catch(() => null);
    if (h) {
      const el = h.asElement();
      if (el && !seenHandles.has(el)) {
        seenHandles.add(el);
        containers.push({ handle: h });
      }
    }
  }

  for (const { handle } of containers) {
    if (!handle) continue;
    const container = handle; // elementHandle 자체를 locator 컨텍스트로 쓸 수 없으므로 evaluate 사용
    const parsed = await page
      .evaluate((el) => {
        type Option = { index: number; text: string; value: string };
        const text = (el as HTMLElement).innerText?.trim() ?? '';
        if (!text) return null;

        const firstLine =
          text
            .split('\n')
            .map((l) => l.trim())
            .find((l) => l.length > 0) ?? text.trim();

        // 마커 추출: 가장 먼저 나타난 [..] 매칭
        const m = text.match(/\[\s*(퀴즈|O\s*X|주관식|설문|일반|poll)\s*\]/i);
        const marker = m ? `[${m[1].replace(/\s+/g, ' ').trim()}]` : null;

        // 보기 추출: 다양한 패턴 시도
        const options: Option[] = [];

        // 패턴 A: ol > li label > span.col-start-2
        const labelsA = el.querySelectorAll('ol li label');
        if (labelsA.length > 0) {
          for (let i = 0; i < labelsA.length; i++) {
            const label = labelsA[i] as HTMLElement;
            const input = label.querySelector('input[type="radio"]') as HTMLInputElement | null;
            const span = label.querySelector('span.col-start-2, span') as HTMLElement | null;
            options.push({
              index: i + 1,
              text: (span?.innerText ?? label.innerText ?? '').trim(),
              value: input?.value ?? '',
            });
          }
        }

        // 패턴 B: input[type=radio]이 ol 바깥에 있을 때 - 텍스트 형제노드
        if (options.length === 0) {
          const radios = el.querySelectorAll('input[type="radio"]');
          for (let i = 0; i < radios.length; i++) {
            const radio = radios[i] as HTMLInputElement;
            const parent = radio.closest('label, li, div') as HTMLElement | null;
            const text = (parent?.innerText ?? parent?.textContent ?? '').trim();
            options.push({ index: i + 1, text, value: radio.value ?? '' });
          }
        }

        // 패턴 C: input은 없고 li/div에 텍스트만 - (주관식 가능성)
        if (options.length === 0) {
          const directTexts = el.querySelectorAll('ol > li, ul > li, .gap-3 > *');
          for (let i = 0; i < directTexts.length; i++) {
            const node = directTexts[i] as HTMLElement;
            const t = (node.innerText ?? node.textContent ?? '').trim();
            if (t) options.push({ index: i + 1, text: t, value: '' });
          }
        }

        return { questionLine: firstLine, marker, options };
      }, handle.asElement() ?? null)
      .catch(() => null);

    if (!parsed) continue;

    const detected = detectMarker(`${parsed.marker ?? ''}\n${parsed.questionLine}`);
    const finalMarker = detected.marker ?? parsed.marker;

    questions.push({
      questionText: parsed.questionLine,
      options: parsed.options,
      marker: finalMarker,
      kind: detected.kind,
    });
  }

  return questions;
}

/**
 * 퀴즈 결과를 텔레그램 메시지 형식으로 포맷
 */
function formatQuizResults(results: QuizResult[], _hasUnknown: boolean, _hasMultipleMatches: boolean): string {
  let message = '';

  // 정답 요약 (예: "퀴즈 정답 1-1-?")
  const answerSummary = results.map((r) => (r.selectedIndex !== null ? String(r.selectedIndex) : '-')).join('');
  const hasAnyUnknown = results.some((r) => r.selectedIndex === null);
  const prefix = results.length > 0 && results[0].marker ? `${results[0].marker} ` : '퀴즈 ';
  message += `${prefix.trim()}정답 ${answerSummary}${hasAnyUnknown ? ' (일부 미해결)' : ''}\n\n`;

  // 상세 내역 — 미해결은 요약에 - 로만 표시하고 상세 라인 안 찍음 (노이즈 방지)
  let lastMarker: string | null = null;
  for (const result of results) {
    if (result.marker !== lastMarker) {
      if (lastMarker !== null) message += '\n';
      if (result.marker) message += `[${result.marker.replace(/^\[|\]$/g, '')}]\n`;
      lastMarker = result.marker;
    }

    if (result.selectedIndex === null) {
      continue; // 미해결은 요약에 -로 표시하고 끝
    }

    const shortQuestion =
      result.questionText.length > 25 ? result.questionText.substring(0, 25) + '...' : result.questionText;

    if (result.multipleMatches && result.multipleMatches.length > 1) {
      message += `⚠️ Q${result.questionIndex}: ${shortQuestion}\n`;
      message += `   → 여러 키워드 매칭: ${result.multipleMatches.join(', ')}\n`;
      message += `   → 선택: ${result.selectedText || '없음'} (${result.selectedIndex || '?'}번)\n`;
    } else {
      message += `✅ Q${result.questionIndex}: ${shortQuestion}\n`;
      message += `   → ${result.selectedText} (${result.selectedIndex}번)\n`;
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
async function processSeminarQuiz(
  page: Page,
  seminarId?: string,
  isAdvancedSurvey?: boolean,
): Promise<SeminarQuizResult> {
  const seminarName = seminarId;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});

    // 다양한 마커 ([퀴즈]/[OX]/[주관식]/[설문] 등) 셀렉터 — span 버전 + 텍스트 버전
    const markerSel = ':text-matches("\\\\[\\\\s*(퀴즈|O\\\\s*X|주관식|설문|일반|poll)\\\\s*\\\\]", "i")';
    const quizSelector = `.whitespace-pre-wrap:has(${markerSel})`;
    let isQuizVisible = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      isQuizVisible = await page
        .locator(quizSelector)
        .first()
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);

      if (isQuizVisible) {
        break;
      }

      if (attempt < 3) {
        console.log(
          `[seminar_quiz] 마커 텍스트 탐지 실패, 새로고침 재시도 (${attempt}/3) (${seminarName ?? 'unknown'})`,
        );
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2000);
      }
    }

    // 퀴즈 문제 파싱
    const questions = await parseQuizQuestions(page);

    if (questions.length === 0) {
      const message = seminarName
        ? `ℹ️ ${seminarName} 설문 페이지에서 퀴즈를 찾지 못했습니다.`
        : 'ℹ️ 설문 페이지에서 퀴즈를 찾지 못했습니다.';
      const shotPath = `screenshot/quiz_not_found_${Date.now()}.png`;
      await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
      await sendTelegram(message, shotPath);
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

    // 각 문제에 대해 정답 찾기 (마커별 분기)
    // 채널 송신 자격: quiz ONLY ([퀴즈] 마커만)
    // 제출 태스크는 별도로 모든 마커 박스([퀴즈]/[OX]/[주관식]/[설문]/[poll])를 처리한다.
    // → processSeminarQuiz는 파싱까지만 담당하고, 실제 클릭·제출은 별도 태스크에서 한다.
    const CHANNEL_ELIGIBLE_KINDS: ReadonlySet<QuizQuestion['kind']> = new Set(['quiz']);

    const results: QuizResult[] = [];
    let _hasUnknown = false;
    let _hasMultipleMatches = false;

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];

      let selectedIndex: number | null = null;
      let selectedText: string | null = null;
      let matchedKeyword: string | null = null;
      let multipleMatches: string[] | null = null;

      // 모든 종류의 문항에 대해 족보 매칭 시도
      const matchingKeywords = findMatchingKeywords(q.questionText, cheatsheet);
      if (matchingKeywords.length === 0) {
        _hasUnknown = true;
      } else {
        if (matchingKeywords.length > 1) {
          _hasMultipleMatches = true;
          multipleMatches = matchingKeywords;
        }
        const bestMatch = resolveBestKeywordMatch(q.questionText, q.options, cheatsheet);
        if (bestMatch) {
          matchedKeyword = bestMatch.keyword;
          selectedIndex = bestMatch.option.index;
          selectedText = bestMatch.option.text;
        } else {
          _hasUnknown = true;
        }
      }

      results.push({
        questionIndex: i + 1,
        questionText: q.questionText,
        selectedIndex,
        selectedText,
        matchedKeyword,
        multipleMatches,
        marker: q.marker,
        kind: q.kind,
      });
    }

    // 채널용 결과: 채널 자격이 있는 문항만 포함
    const channelResults = results.filter((r) => CHANNEL_ELIGIBLE_KINDS.has(r.kind));

    // 결과 메시지 생성 및 전송
    // 채널 메시지는 [퀴즈] 문항만, ??? 대신 - 로 미해결 표시
    const resultMessage = formatQuizResults(channelResults, _hasUnknown, _hasMultipleMatches);

    // ── 자동 클릭·제출 ───────────────────────────────────────────────
    // 모든 마커 종류([퀴즈]/[OX]/[설문]/[주관식] 등)의 문항을 처리
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const result = results[i];

      await page.waitForTimeout(300); // UI 안정화

      // 각 문항 영역 로케이터: questionText 근처의 .whitespace-pre-wrap 또는 .question_area
      // 문제 텍스트 앞 30자로 영역 축소
      const qKey = q.questionText
        .substring(0, 30)
        .replace(/[^\w가-힣]/g, '')
        .trim();
      const areaLocator = page
        .locator(`.whitespace-pre-wrap:has-text("${qKey}"), .question_area:has-text("${qKey}")`)
        .first();

      const hasArea = await areaLocator.count().catch(() => 0);
      const area = hasArea > 0 ? areaLocator : page.locator('body').first();

      if (q.kind === 'subjective' && result.matchedKeyword) {
        // 주관식: 족보 텍스트를 input[type=text]에 입력
        const answerText = cheatsheet[result.matchedKeyword] ?? '';
        if (answerText) {
          const textInput = area.locator('input[type="text"], input[type="search"], textarea').first();
          if ((await textInput.count()) > 0) {
            await textInput.scrollIntoViewIfNeeded().catch(() => {});
            await textInput.fill(answerText).catch(() => {});
            console.log(`[seminar_quiz] 주관식 입력: Q${i + 1} → "${answerText}"`);
          }
        }
      } else if (q.options.length > 0) {
        // 객관식: 정답 인덱스가 있으면 클릭, 없으면 2번째 보기 클릭
        const targetIndex = result.selectedIndex ?? 2; // 디폴트: 2번째
        const clicked = await clickOptionByIndex(page, area, targetIndex, i + 1);
        if (!clicked) {
          console.warn(`[seminar_quiz] Q${i + 1} 선택 실패 (${q.marker ?? 'unknown'}, index=${targetIndex})`);
        }
      }
    }

    // 제출하기 버튼 클릭 및 dialog/alert 처리 자동 수락 등록
    page.on('dialog', async (dialog) => {
      console.log(`[seminar_quiz] Dialog detected: [${dialog.type()}] "${dialog.message()}". Accepting...`);
      await dialog.accept().catch(() => {});
    });

    // 제출 버튼 탐지·클릭
    await page.waitForTimeout(1000);
    const submitBtn = page
      .locator(
        ':text-matches("제출|완료|제출하기|설문완료|응답완료", "i"):not([disabled]):not([style*="display:none"])',
      )
      .first();
    const submitVisible = await submitBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (submitVisible) {
      await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
      await submitBtn.click({ force: true }).catch(() => {});
      console.log('[seminar_quiz] "제출하기" 버튼 클릭 완료');
      await page.waitForTimeout(1500);
    }

    // "확인" 모달/알럿 처리 (레이어 팝업으로 뜬 경우도 대비)
    const confirmBtn = page
      .locator(':text-matches("확인|예", "i"):not([disabled]):not([style*="display:none"])')
      .first();
    const confirmVisible = await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (confirmVisible) {
      await confirmBtn.scrollIntoViewIfNeeded().catch(() => {});
      await confirmBtn.click({ force: true }).catch(() => {});
      console.log('[seminar_quiz] 최종 "확인" 클릭 완료');
      await page.waitForTimeout(2000);
    }

    // 제출 완료 후 최종 화면 스크린샷 → 관리자에게 전송
    const baseDir = path.join(process.cwd(), 'screenshot');
    const submitShotPath = path.join(baseDir, `quiz_submit_${seminarName ?? 'unknown'}_${Date.now()}.png`);
    try {
      await fs.mkdir(baseDir, { recursive: true });
      await page.screenshot({ path: submitShotPath, fullPage: true }).catch(() => {});
      await sendTelegram(`📋 세미나 설문/퀴즈 제출 완료\n${resultMessage}`, submitShotPath).catch(() => {});
    } catch (_ssErr) {
      /* ignore */
    } finally {
      await fs.unlink(submitShotPath).catch(() => {});
    }
    // ── 자동 클릭·제출 끝 ─────────────────────────────────────────────

    // 미등록 문제가 있으면 관리자에게 상세 전송
    if (_hasUnknown) {
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

export { processSeminarQuiz, loadCheatsheet, CHEATSHEET_PATH };
