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
  kind: 'quiz' | 'poll';
}

export interface SurveyQuestion extends QuizQuestion {
  /** 필수 문항 여부 (문제 끝 * 여부) */
  isRequired: boolean;
  /** 입력 타입: radio | checkbox | text */
  inputType: 'radio' | 'checkbox' | 'text';
  /** 문항 번호 (data-question-number) */
  questionNumber: number;
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

function markerKind(marker: string | null): QuizQuestion['kind'] {
  if (marker && /퀴즈/i.test(marker)) return 'quiz';
  return 'poll';
}

/**
 * 페이지의 모든 설문 문항 파싱 (퀴즈/일반 포함)
 * - li[data-question-number] 단위로 파싱하여 중복 방지
 * - 마커([퀴즈] 등) 있으면 kind 분류, 없으면 'poll'
 * - 필수 여부(*), inputType(radio/checkbox/text) 추출
 */
async function parseAllSurveyQuestions(page: Page): Promise<SurveyQuestion[]> {
  const parsed = await page.evaluate(() => {
    type Option = { index: number; text: string; value: string };
    type ParsedQ = {
      questionNumber: number;
      questionLine: string;
      marker: string | null;
      isRequired: boolean;
      inputType: 'radio' | 'checkbox' | 'text';
      options: Option[];
    };

    const items = document.querySelectorAll('li[data-question-number]');
    const result: ParsedQ[] = [];

    items.forEach((li) => {
      const questionNumber = parseInt((li as HTMLElement).dataset['questionNumber'] ?? '0', 10);

      // 마커 span ([퀴즈] 등): 색상으로 구분된 스팬 탐색
      // 실제 HTML에서 [퀴즈] 마커는 span.text-\[#28BCAA\] 로 렌더링됨
      const allSpans = li.querySelectorAll('span');
      let marker: string | null = null;
      for (const span of Array.from(allSpans)) {
        const t = (span as HTMLElement).innerText?.trim() ?? '';
        const m = t.match(/^\[[\s\S]*?\]$/);
        if (m && /퀴즈|OX|주관식|설문|일반|poll/i.test(t)) {
          marker = t;
          break;
        }
      }

      // 문제 텍스트: whitespace-pre-wrap 컨테이너의 innerText에서 첫 실질 라인
      const labelEl = li.querySelector('label.block') as HTMLElement | null;
      const preWrap = labelEl?.querySelector('.whitespace-pre-wrap') as HTMLElement | null;
      let questionLine = '';
      if (preWrap) {
        const fullText = preWrap.innerText?.trim() ?? '';
        const lines = fullText
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        // 첫 번째 줄에서 마커([퀴즈] 등) 부분만 제거하고 나머지를 문제 텍스트로 사용
        // 마커와 문제 텍스트가 같은 줄에 있는 경우를 올바르게 처리
        const firstLine = lines[0] ?? '';
        questionLine = firstLine.replace(/^\[[\s\S]*?\]\s*/, '').trim();
        // 끝의 * 제거 (필수 표시)
        questionLine = questionLine.replace(/\s*\*\s*(\(최소.*?\))?\s*$/, '').trim();
      }

      if (!questionLine) return;

      // 필수 여부: label 내 span.text-red-600 중 '*' 가 있으면 필수
      const redSpans = li.querySelectorAll('label .text-red-600');
      let isRequired = false;
      for (const s of Array.from(redSpans)) {
        if ((s as HTMLElement).innerText?.trim() === '*') {
          isRequired = true;
          break;
        }
      }

      // 입력 타입 판별
      const hasCheckbox = li.querySelector('input[type="checkbox"]') !== null;
      const hasText = li.querySelector('input[type="text"], textarea') !== null;
      const inputType: 'radio' | 'checkbox' | 'text' = hasCheckbox ? 'checkbox' : hasText ? 'text' : 'radio';

      // 보기 추출 (sr-only hidden input 제외)
      const options: Option[] = [];
      if (hasCheckbox) {
        const checkboxes = Array.from(li.querySelectorAll('input[type="checkbox"]')).filter(
          (inp) => !(inp as HTMLElement).classList.contains('sr-only'),
        );
        checkboxes.forEach((inp, idx) => {
          const input = inp as HTMLInputElement;
          const labelParent = input.closest('label') as HTMLElement | null;
          const span = labelParent?.querySelector('span.col-start-2, span') as HTMLElement | null;
          options.push({
            index: idx + 1,
            text: (span?.innerText ?? labelParent?.innerText ?? '').trim(),
            value: input.value ?? '',
          });
        });
      } else if (hasText) {
        options.push({ index: 1, text: '[주관식]', value: '' });
      } else {
        const radios = Array.from(li.querySelectorAll('input[type="radio"]'));
        radios.forEach((inp, idx) => {
          const input = inp as HTMLInputElement;
          const labelParent = input.closest('label') as HTMLElement | null;
          const span = labelParent?.querySelector('span.col-start-2, span') as HTMLElement | null;
          options.push({
            index: idx + 1,
            text: (span?.innerText ?? labelParent?.innerText ?? '').trim(),
            value: input.value ?? '',
          });
        });
      }

      result.push({ questionNumber, questionLine, marker, isRequired, inputType, options });
    });

    return result;
  });

  return parsed.map((q) => ({
    questionText: q.questionLine,
    options: q.options,
    marker: q.marker,
    kind: markerKind(q.marker),
    isRequired: q.isRequired,
    inputType: q.inputType,
    questionNumber: q.questionNumber,
  }));
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
function formatUnknownQuestions(questions: SurveyQuestion[], results: QuizResult[]): string {
  let message = '❓ 족보에 없는 퀴즈:\n\n';

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.selectedIndex === null && result.kind === 'quiz') {
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
 *
 * 자동 클릭 규칙:
 *   - [퀴즈] 문항: 족보 정답 인덱스로 클릭 (족보 미매칭 시 스킵)
 *   - 비퀴즈 필수(*) 문항: radio는 1번째, checkbox는 1번째만 클릭
 *   - 비필수(*없음) 문항: 스킵
 *   - 주관식: 족보에 있으면 입력
 */
async function processSeminarQuiz(
  page: Page,
  seminarId?: string,
  isAdvancedSurvey?: boolean,
): Promise<SeminarQuizResult> {
  const seminarName = seminarId;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    // JS(React) 렌더링 완료 대기 - 다이얼로그는 JS 실행 후 나타남
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});

    // '작성 중인 정보를 불러왔습니다' 초안 복원 다이얼로그 처리
    // React 포탈로 렌더링되므로 텍스트로 직접 탐색
    try {
      const draftNotice = page.locator(':text("작성 중인 정보를 불러왔습니다")').first();
      const hasDraft = await draftNotice.isVisible({ timeout: 3000 }).catch(() => false);
      if (hasDraft) {
        console.log('[seminar_quiz] "작성 중인 정보를 불러왔습니다" 다이얼로그 감지');
        const closeBtn = page.getByRole('button', { name: '닫기' }).first();
        await closeBtn.waitFor({ state: 'visible', timeout: 2000 });
        await closeBtn.click({ force: true });
        console.log('[seminar_quiz] 초안 복원 다이얼로그 "닫기" 클릭 완료');
        await page.waitForTimeout(500);
      }
    } catch {
      // 다이얼로그 없으면 정상 진행
    }

    // 마커 또는 일반 설문 문항 감지
    const markerSel = ':text-matches("\\[\\s*(퀴즈|O\\s*X|주관식|설문|일반|poll)\\s*\\]", "i")';
    const quizSelector = `.whitespace-pre-wrap:has(${markerSel})`;
    let isQuizVisible = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      // 마커 있는 [퀴즈] 문항 OR li[data-question-number] 형태의 설문 문항 중 하나라도 있으면 진행
      const hasMarker = await page
        .locator(quizSelector)
        .first()
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);

      const hasSurveyItems = await page
        .locator('li[data-question-number]')
        .first()
        .waitFor({ state: 'visible', timeout: 3000 })
        .then(() => true)
        .catch(() => false);

      isQuizVisible = hasMarker || hasSurveyItems;

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

    // 설문 문항 파싱 (퀴즈/일반 모두 포함)
    const questions = await parseAllSurveyQuestions(page);

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
        if (q.kind === 'quiz') {
          message += `Q${i + 1}: ${q.questionText.substring(0, 100)}...\n`;
          for (const opt of q.options) {
            message += `  ${opt.index}. ${opt.text}\n`;
          }
          message += '\n';
        }
      }
      await sendTelegram(message);
      return { success: true, hasQuizResult: false, message };
    }

    // 채널 송신 자격: quiz ONLY ([퀴즈] 마커만)
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

      // [퀴즈] 문항만 족보 매칭
      if (q.kind === 'quiz') {
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
      }

      results.push({
        questionIndex: q.questionNumber > 0 ? q.questionNumber : i + 1,
        questionText: q.questionText,
        selectedIndex,
        selectedText,
        matchedKeyword,
        multipleMatches,
        marker: q.marker,
        kind: q.kind,
      });
    }

    // 채널용 결과: [퀴즈] 문항만
    const channelResults = results.filter((r) => CHANNEL_ELIGIBLE_KINDS.has(r.kind));
    const resultMessage = formatQuizResults(channelResults, _hasUnknown, _hasMultipleMatches);

    // ── 자동 클릭·제출 ───────────────────────────────────────────────
    // 규칙:
    //   - [퀴즈] 문항: 족보 정답 인덱스로 클릭 (족보 미매칭 시 스킵)
    //   - 비퀴즈 필수(*) 문항: radio는 1번째, checkbox는 1번째만 클릭
    //   - 비필수(*없음) 문항: 스킵
    //   - 주관식: 족보에 있으면 입력
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const result = results[i];
      const qNum = q.questionNumber > 0 ? q.questionNumber : i + 1;

      await page.waitForTimeout(300); // UI 안정화

      // 문항 영역 로케이터: data-question-number 속성 활용
      const areaLocator = page.locator(`li[data-question-number="${qNum}"]`).first();
      const hasArea = await areaLocator.count().catch(() => 0);
      const area = hasArea > 0 ? areaLocator : page.locator('body').first();

      if (q.kind === 'quiz' && q.options.length > 0) {
        // [퀴즈] 문항: 족보 정답으로 클릭 (미매칭 시 스킵)
        if (result.selectedIndex !== null) {
          const clicked = await clickOptionByIndex(page, area, result.selectedIndex, qNum);
          if (!clicked) {
            console.warn(`[seminar_quiz] Q${qNum} [퀴즈] 선택 실패 (index=${result.selectedIndex})`);
          }
        } else {
          console.warn(`[seminar_quiz] Q${qNum} [퀴즈] 족보 미매칭 - 선택 건너뜀`);
        }
      } else if (q.options.length > 0) {
        // 일반 설문 문항
        if (!q.isRequired) {
          // 필수 아닌 문항은 스킵
          console.log(`[seminar_quiz] Q${qNum} 비필수 문항 스킵 (${q.marker ?? 'no-marker'})`);
          continue;
        }
        // 필수 문항: radio/checkbox 모두 1번째 선택지만 클릭
        if (q.inputType === 'checkbox') {
          // 체크박스: 1번째만 체크
          const checkbox = area.locator('input[type="checkbox"]:not(.sr-only)').first();
          const cbCount = await checkbox.count().catch(() => 0);
          if (cbCount > 0) {
            await checkbox.check({ force: true, timeout: 2000 }).catch(() => {});
            console.log(`[seminar_quiz] Q${qNum} 체크박스 1번째 체크`);
          }
        } else {
          // 라디오: 1번째 선택
          const clicked = await clickOptionByIndex(page, area, 1, qNum);
          if (!clicked) {
            console.warn(`[seminar_quiz] Q${qNum} 일반 문항 1번째 선택 실패`);
          }
        }
      }
    }

    // 제출하기 버튼 클릭 및 native dialog/alert 처리 자동 수락 등록
    page.on('dialog', async (dialog) => {
      console.log(`[seminar_quiz] Dialog detected: [${dialog.type()}] "${dialog.message()}". Accepting...`);
      await dialog.accept().catch(() => {});
    });

    // 제출 버튼 탐지·클릭
    await page.waitForTimeout(1000);
    const submitBtn = page
      .locator(
        'input[type="submit"].btn-primary, button:text-matches("제출하기|설문완료|응답완료", "i"):not([disabled])',
      )
      .first();
    const submitVisible = await submitBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (submitVisible) {
      await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
      await submitBtn.click({ force: true }).catch(() => {});
      console.log('[seminar_quiz] "제출하기" 버튼 클릭 완료');
      await page.waitForTimeout(5000); // 제출 처리 대기 5초
    }

    // 헤드리스UI 확인 다이얼로그 대기 및 클릭
    // 다이얼로그는 #headlessui-portal-root 포탈에 렌더링되므로 waitForSelector로 출현 대기
    try {
      await page.waitForSelector('[data-headlessui-state="open"]', { timeout: 5000 });
      console.log('[seminar_quiz] 설문제출 확인 다이얼로그 감지');

      // "확인" 버튼: getByRole이 가장 신뢰성 높음
      const confirmBtn = page.getByRole('button', { name: '확인' }).first();
      await confirmBtn.waitFor({ state: 'visible', timeout: 3000 });
      await confirmBtn.click({ force: true });
      console.log('[seminar_quiz] 설문제출 모달 "확인" 클릭 완료');
    } catch {
      console.warn('[seminar_quiz] 설문제출 확인 다이얼로그 미감지 또는 "확인" 클릭 실패');
    }

    // /outro 페이지로 이동 대기 (최대 10초)
    const baseDir = path.join(process.cwd(), 'screenshot');
    const submitShotPath = path.join(baseDir, `quiz_submit_${seminarName ?? 'unknown'}_${Date.now()}.png`);
    try {
      await fs.mkdir(baseDir, { recursive: true });
      const navigatedToOutro = await page
        .waitForURL('**/outro', { timeout: 10000 })
        .then(() => true)
        .catch(() => false);

      if (navigatedToOutro) {
        console.log('[seminar_quiz] /outro 페이지 이동 확인 완료');
      } else {
        console.warn('[seminar_quiz] /outro 이동 미확인, 현재 페이지 스크린샷 전송');
      }

      await page.screenshot({ path: submitShotPath, fullPage: true }).catch(() => {});
      const submitStatus = navigatedToOutro ? '✅ 설문 제출 완료' : '⚠️ 설문 제출 결과 불확실';
      await sendTelegram(`📋 ${submitStatus}\n${resultMessage}`, submitShotPath).catch(() => {});
    } catch (_ssErr) {
      /* ignore */
    } finally {
      await fs.unlink(submitShotPath).catch(() => {});
    }
    // ── 자동 클릭·제출 끝 ─────────────────────────────────────────────

    // 미등록 [퀴즈] 문제가 있으면 관리자에게 상세 전송
    if (_hasUnknown) {
      const unknownMessage = formatUnknownQuestions(questions, results);
      await sendTelegram(unknownMessage);
    }

    return { success: true, hasQuizResult: channelResults.length > 0, message: resultMessage };
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
