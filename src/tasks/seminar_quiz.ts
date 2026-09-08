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
 * 양쪽을 normalizeForMatch로 정규화 후 비교 (공백, 특수문자, * 등 무시)
 */
export function findMatchingKeywords(questionText: string, cheatsheet: Cheatsheet): string[] {
  const normalizedQuestion = normalizeForMatch(questionText);
  const matches: string[] = [];
  for (const keyword of Object.keys(cheatsheet)) {
    if (normalizedQuestion.includes(normalizeForMatch(keyword))) {
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
    .replace(/\s+/g, '')
    .replace(/[.,!?"'`~·•…*]/g, '')
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
 * 일반(비퀴즈) 설문 문항에서 하위 분기를 최소화하는 최적의 보기 인덱스(1-indexed)를 찾습니다.
 * "아니오", "해당없음", "없음", "비대상" 등의 보기가 있으면 우선 선택하여 복잡한 하위 문항 생성을 방지합니다.
 */
export function findMinimalBranchOptionIndex(options: QuizQuestion['options']): number {
  if (options.length === 0) return 1;

  const negativePatterns = [/^아니오$/, /^아닙니다$/, /해당\s*없음/, /^없음$/, /비대상/, /전공의\s*아님/, /기타/];

  for (const pattern of negativePatterns) {
    const matched = options.find((opt) => pattern.test(opt.text.trim()));
    if (matched) {
      return matched.index;
    }
  }

  return 1;
}

export function isQuizQuestionPattern(questionText: string, _cheatsheet?: Cheatsheet): boolean {
  // [퀴즈] 등 명시적 마커가 포함된 경우
  if (/\[\s*(퀴즈|OX|O\s*X|주관식|QUIZ)\s*\]/i.test(questionText)) {
    return true;
  }
  return false;
}

export function markerKind(
  marker: string | null,
  httpQuizQuestionNums?: Set<number>,
  questionNumber?: number,
): QuizQuestion['kind'] {
  if (marker && /퀴즈|ox|주관식|quiz/i.test(marker)) return 'quiz';
  if (questionNumber && httpQuizQuestionNums?.has(questionNumber)) return 'quiz';
  return 'poll';
}

/**
 * 페이지의 모든 설문 문항 파싱 (퀴즈/일반 포함)
 * - li[data-question-number] 단위로 파싱하여 중복 방지
 * - 마커([퀴즈] 등) 있으면 kind 분류, 없으면 'poll'
 * - 필수 여부(*), inputType(radio/checkbox/text) 추출
 */
async function parseAllSurveyQuestions(
  page: Page,
  cheatsheet?: Cheatsheet,
  httpQuizQuestionNums?: Set<number>,
): Promise<SurveyQuestion[]> {
  // DOM 렌더링 완료 대기 (React 컴포넌트 마운트 및 텍스트 렌더링 대기)
  await page.waitForSelector('li[data-question-number]', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);

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

      // 마커 탐색: li 내부의 모든 태그(span, div, p, label 등)에서 [퀴즈] 등 패턴 탐색
      const allTextNodes = Array.from(li.querySelectorAll('span, div, p, label, b, strong, em'));
      let marker: string | null = null;
      for (const el of allTextNodes) {
        const t = (el as HTMLElement).innerText?.trim() ?? '';
        const m = t.match(/\[\s*(퀴즈|OX|O\s*X|주관식|설문|일반|poll)\s*\]/i);
        if (m) {
          marker = m[0].replace(/\s+/g, '');
          break;
        }
      }

      // 문제 텍스트: whitespace-pre-wrap 컨테이너 또는 label 전체 innerText
      const labelEl = li.querySelector('label.block, label') as HTMLElement | null;
      const preWrap = (labelEl?.querySelector('.whitespace-pre-wrap') || labelEl) as HTMLElement | null;
      let questionLine = '';
      if (preWrap) {
        const fullText = preWrap.innerText?.trim() ?? '';
        const lines = fullText
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        // 첫 번째 줄에서 마커([퀴즈] 등) 감지 및 번호 접두어 부분 제거
        const firstLine = lines[0] ?? '';
        const inlineMarkerMatch = firstLine.match(/^\[\s*(퀴즈|OX|O\s*X|주관식|설문|일반|poll)\s*\]/i);
        if (inlineMarkerMatch && !marker) {
          marker = inlineMarkerMatch[0].replace(/\s+/g, '');
        }

        questionLine = firstLine
          .replace(/^\[[\s\S]*?\]\s*/, '')
          .replace(/^\d+\.\s*/, '')
          .trim();
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
    kind: markerKind(q.marker, httpQuizQuestionNums, q.questionNumber),
    isRequired: q.isRequired,
    inputType: q.inputType,
    questionNumber: q.questionNumber,
  }));
}

/**
 * 퀴즈 결과를 텔레그램 메시지 형식으로 포맷
 */
function formatQuizResults(
  results: QuizResult[],
  _hasUnknown: boolean,
  _hasMultipleMatches: boolean,
  depthSurveyCount?: number,
): string {
  if (results.length === 0) {
    return depthSurveyCount && depthSurveyCount > 0 ? `심화${depthSurveyCount}` : '퀴즈 없음';
  }

  let message = '';

  // 정답 요약 (예: "퀴즈 정답 412 + 심화1" 또는 "퀴즈 정답 412")
  const answerSummary = results.map((r) => (r.selectedIndex !== null ? String(r.selectedIndex) : '-')).join('');
  const hasAnyUnknown = results.some((r) => r.selectedIndex === null);
  const prefix = results.length > 0 && results[0].marker ? `${results[0].marker} ` : '퀴즈 ';
  const depthSuffix = depthSurveyCount && depthSurveyCount > 0 ? ` + 심화${depthSurveyCount}` : '';
  message += `${prefix.trim()}정답 ${answerSummary}${depthSuffix}${hasAnyUnknown ? ' (일부 미해결)' : ''}\n\n`;

  // 상세 내역
  let lastMarker: string | null = null;
  for (const result of results) {
    if (result.marker !== lastMarker) {
      if (lastMarker !== null) message += '\n';
      if (result.marker) message += `[${result.marker.replace(/^\[|\]$/g, '')}]\n`;
      lastMarker = result.marker;
    }

    const shortQuestion =
      result.questionText.length > 25 ? result.questionText.substring(0, 25) + '...' : result.questionText;

    if (result.selectedIndex === null) {
      message += `❓ Q${result.questionIndex}: ${shortQuestion}\n   → 족보 미등록 (답변 번호 미확인)\n`;
    } else if (result.multipleMatches && result.multipleMatches.length > 1) {
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
      const q = questions.find((item) => item.questionNumber === result.questionIndex) || questions[i];
      if (!q) continue;
      message += `Q${result.questionIndex}: ${q.questionText}\n`;
      for (const opt of q.options) {
        message += `  ${opt.index}. ${opt.text}\n`;
      }
      message += '\n';
    }
  }

  message += `💡 족보 등록 방법:\n• 이 메시지에 답장(Reply)으로 정답 번호(예: 123)만 전송\n• 또는 /add_seminar_answer_batch 사용`;
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
 *   - 비퀴즈 필수(*) 문항: radio는 최소 분기(아니오 등), checkbox는 1번째만 클릭
 *   - 주관식: 족보에 있으면 입력 또는 기본 텍스트 입력
 */
async function processSeminarQuiz(
  page: Page,
  seminarId?: string,
  isAdvancedSurvey?: boolean,
): Promise<SeminarQuizResult> {
  const seminarName = seminarId;
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    // JS(React) 렌더링 완료 대기
    await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});

    // '작성 중인 정보를 불러왔습니다' 초안 복원 다이얼로그 처리
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

    // 네이티브 다이얼로그 자동 수락 핸들러 등록
    page.on('dialog', async (dialog) => {
      console.log(`[seminar_quiz] Dialog detected: [${dialog.type()}] "${dialog.message()}". Accepting...`);
      await dialog.accept().catch(() => {});
    });

    // 족보 로드
    const cheatsheet = await loadCheatsheet();

    // ── HTTP API 기반 퀴즈 사전 조회 (백업 및 퀴즈 번호/심화설문 확정용) ──
    let httpQuizResult: import('../modules/seminar_survey_api').SurveyQuizHttpResult | null = null;
    const httpQuizMap = new Map<number, import('../modules/seminar_survey_api').HttpQuizQuestion>();
    const httpQuizNums = new Set<number>();

    if (seminarId) {
      try {
        const { fetchSeminarSurveyQuizHttp } = await import('../modules/seminar_survey_api');
        httpQuizResult = await fetchSeminarSurveyQuizHttp(seminarId, cheatsheet, isAdvancedSurvey);
        if (httpQuizResult.success) {
          console.log(
            `[seminar_quiz] HTTP API 설문 조회 성공: 총 ${httpQuizResult.totalQuestionCnt}문항 중 퀴즈 ${httpQuizResult.quizQuestionCnt}문항 (심화설문: ${httpQuizResult.isAdvancedSurvey})`,
          );
          for (const q of httpQuizResult.quizzes) {
            httpQuizMap.set(q.questionNumber, q);
            httpQuizNums.add(q.questionNumber);
          }
        }
      } catch (err) {
        console.warn('[seminar_quiz] HTTP API 퀴즈 조회 실패 fallback 진행:', err);
      }
    }

    const effectiveIsAdvancedSurvey = Boolean(isAdvancedSurvey) || Boolean(httpQuizResult?.isAdvancedSurvey);

    // 채널 송신 자격: quiz ONLY ([퀴즈] 마커 및 퀴즈 문항)
    const CHANNEL_ELIGIBLE_KINDS: ReadonlySet<QuizQuestion['kind']> = new Set(['quiz']);

    const accumulatedResults: QuizResult[] = [];
    const accumulatedQuestions: SurveyQuestion[] = [];
    let _hasUnknown = false;
    let _hasMultipleMatches = false;

    const MAX_PAGES = 10;
    let currentPageNum = 1;
    let lastPageQuestionCount = 0;

    // ── 다중 페이지 탐색 및 응답 루프 ───────────────────────────────────────────────
    while (currentPageNum <= MAX_PAGES) {
      console.log(`[seminar_quiz] 설문 페이지 ${currentPageNum} 탐색 시작 (${seminarName ?? 'unknown'})`);

      // 마커 또는 일반 설문 문항 감지 (렌더링 안정화 대기)
      const markerSel = ':text-matches("\\[\\s*(퀴즈|O\\s*X|주관식|설문|일반|poll)\\s*\\]", "i")';
      const quizSelector = `.whitespace-pre-wrap:has(${markerSel}), li[data-question-number]:has(${markerSel})`;
      let isSurveyVisible = false;

      for (let attempt = 1; attempt <= 3; attempt++) {
        const hasMarker = await page
          .locator(quizSelector)
          .first()
          .waitFor({ state: 'visible', timeout: 3000 })
          .then(() => true)
          .catch(() => false);

        const hasSurveyItems = await page
          .locator('li[data-question-number]')
          .first()
          .waitFor({ state: 'visible', timeout: 3000 })
          .then(() => true)
          .catch(() => false);

        isSurveyVisible = hasMarker || hasSurveyItems;
        if (isSurveyVisible) break;

        if (attempt < 3) {
          await page.waitForTimeout(1000);
        }
      }

      // 현재 페이지의 문항 파싱 (DOM 렌더링 완료 대기 포함)
      const pageQuestions = await parseAllSurveyQuestions(page, cheatsheet, httpQuizNums);
      console.log(`[seminar_quiz] 페이지 ${currentPageNum} 문항 파싱 수: ${pageQuestions.length}`);
      lastPageQuestionCount = pageQuestions.length;

      for (let i = 0; i < pageQuestions.length; i++) {
        const q = pageQuestions[i];
        accumulatedQuestions.push(q);

        const qNum = q.questionNumber > 0 ? q.questionNumber : i + 1;
        let selectedIndex: number | null = null;
        let selectedText: string | null = null;
        let matchedKeyword: string | null = null;
        let multipleMatches: string[] | null = null;

        const isQuiz = q.kind === 'quiz' || httpQuizNums.has(qNum);

        // [퀴즈] 문항: 족보 매칭 또는 HTTP API 결과 사용
        if (isQuiz) {
          const matchingKeywords = findMatchingKeywords(q.questionText, cheatsheet);
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
            // HTTP API 매칭 결과 fallback
            const httpQ = httpQuizMap.get(qNum);
            if (httpQ && httpQ.selectedIndex !== null) {
              matchedKeyword = httpQ.matchedKeyword;
              selectedIndex = httpQ.selectedIndex;
              selectedText = httpQ.selectedText;
              multipleMatches = httpQ.multipleMatches || null;
            } else {
              _hasUnknown = true;
            }
          }
        }

        const result: QuizResult = {
          questionIndex: qNum,
          questionText: q.questionText,
          selectedIndex,
          selectedText,
          matchedKeyword,
          multipleMatches,
          marker: q.marker,
          kind: isQuiz ? 'quiz' : q.kind,
        };
        accumulatedResults.push(result);

        // UI 선택 처리
        await page.waitForTimeout(200);
        const areaLocator = page.locator(`li[data-question-number="${qNum}"]`).first();
        const hasArea = await areaLocator.count().catch(() => 0);
        const area = hasArea > 0 ? areaLocator : page.locator('body').first();

        if (isQuiz && q.options.length > 0) {
          if (selectedIndex !== null) {
            const clicked = await clickOptionByIndex(page, area, selectedIndex, qNum);
            if (!clicked) {
              console.warn(`[seminar_quiz] Q${qNum} [퀴즈] 선택 실패 (index=${selectedIndex})`);
            }
          } else {
            console.warn(`[seminar_quiz] Q${qNum} [퀴즈] 족보 미매칭 - 선택 건너뜀`);
          }
        } else if (q.options.length > 0) {
          // 일반 설문 문항: 분기 최소화 인덱스 선택 ("아니오", "해당없음" 우선)
          if (q.inputType === 'checkbox') {
            const checkbox = area.locator('input[type="checkbox"]:not(.sr-only)').first();
            const cbCount = await checkbox.count().catch(() => 0);
            if (cbCount > 0) {
              await checkbox.check({ force: true, timeout: 2000 }).catch(() => {});
              console.log(`[seminar_quiz] Q${qNum} 체크박스 1번째 체크`);
            }
          } else {
            const minIndex = findMinimalBranchOptionIndex(q.options);
            const clicked = await clickOptionByIndex(page, area, minIndex, qNum);
            if (!clicked) {
              console.warn(`[seminar_quiz] Q${qNum} 일반 문항 선택 실패 (index=${minIndex})`);
            }
          }
        }
      }

      await page.waitForTimeout(500);

      // 동적 분기로 새로 나타난 미선택 라디오 또는 빈 주관식 입력 보완
      try {
        // 1) 아직 체크되지 않은 라디오가 있는 문항들 1번째 옵션 체크
        const unselectedRadios = page.locator('li[data-question-number]:not(:has(input[type="radio"]:checked))');
        const unselectedCount = await unselectedRadios.count().catch(() => 0);
        for (let j = 0; j < unselectedCount; j++) {
          const item = unselectedRadios.nth(j);
          const firstRadio = item.locator('input[type="radio"]').first();
          if (await firstRadio.isVisible().catch(() => false)) {
            await firstRadio.check({ force: true }).catch(() => {});
          }
        }

        // 2) 빈 주관식 단답형/장문형 텍스트 필드 채우기
        const emptyInputs = page.locator(
          'li[data-question-number] input[type="text"], li[data-question-number] textarea',
        );
        const inputCount = await emptyInputs.count().catch(() => 0);
        for (let j = 0; j < inputCount; j++) {
          const inp = emptyInputs.nth(j);
          const val = await inp.inputValue().catch(() => '');
          if (!val && (await inp.isVisible().catch(() => false))) {
            await inp.fill('좋습니다').catch(() => {});
          }
        }
      } catch {
        /* ignore fallback errors */
      }

      await page.waitForTimeout(500);

      // "다음" 버튼 확인
      const nextBtn = page.locator('button:text-matches("^다음$|^다음\\s*단계$|^Next$", "i"):not([disabled])').first();
      const hasNext = await nextBtn.isVisible({ timeout: 2000 }).catch(() => false);

      // "제출하기" / "설문완료" 버튼 확인
      const submitBtn = page
        .locator(
          'input[type="submit"].btn-primary, button:text-matches("제출하기|설문완료|응답완료", "i"):not([disabled])',
        )
        .first();
      const hasSubmit = await submitBtn.isVisible({ timeout: 2000 }).catch(() => false);

      if (hasNext && !hasSubmit) {
        console.log(`[seminar_quiz] 다음 페이지 이동 버튼 감지 (현재 페이지: ${currentPageNum}) -> 클릭`);
        const prevFirstQ = pageQuestions[0]?.questionNumber;
        await nextBtn.scrollIntoViewIfNeeded().catch(() => {});
        await nextBtn.click({ force: true }).catch(() => {});
        await page.waitForLoadState('networkidle', { timeout: 6000 }).catch(() => {});

        // 다음 페이지 렌더링 대기
        if (prevFirstQ !== undefined) {
          await page
            .waitForFunction(
              (prev) => {
                const firstLi = document.querySelector('li[data-question-number]');
                if (!firstLi) return false;
                const qNum = parseInt(firstLi.getAttribute('data-question-number') || '0', 10);
                return qNum !== prev;
              },
              prevFirstQ,
              { timeout: 4000 },
            )
            .catch(() => {});
        }
        await page.waitForTimeout(1500);
        currentPageNum++;
      } else {
        console.log(`[seminar_quiz] 마지막 설문 페이지 도달 (총 탐색 페이지: ${currentPageNum})`);
        break;
      }
    }
    // ── 다중 페이지 탐색 및 응답 루프 끝 ─────────────────────────────────────────

    // 채널용 결과: [퀴즈] 문항만 필터링 (UI에서 누락되었더라도 HTTP API에서 발견된 경우 HTTP 결과로 채움)
    let channelResults = accumulatedResults.filter((r) => CHANNEL_ELIGIBLE_KINDS.has(r.kind));
    if (channelResults.length === 0 && httpQuizResult && httpQuizResult.quizzes.length > 0) {
      console.log('[seminar_quiz] UI에서 퀴즈를 직접 감지하지 못했으나 HTTP API 퀴즈 결과로 대체합니다.');
      channelResults = httpQuizResult.quizzes.map((q) => ({
        questionIndex: q.questionNumber,
        questionText: q.questionText,
        selectedIndex: q.selectedIndex,
        selectedText: q.selectedText,
        matchedKeyword: q.matchedKeyword,
        multipleMatches: q.multipleMatches || null,
        marker: '[퀴즈]',
        kind: 'quiz',
      }));
    }

    if (channelResults.length === 0 && accumulatedQuestions.length === 0) {
      const message = seminarName
        ? `ℹ️ ${seminarName} 설문 페이지에서 퀴즈를 찾지 못했습니다.`
        : 'ℹ️ 설문 페이지에서 퀴즈를 찾지 못했습니다.';
      const shotPath = `screenshot/quiz_not_found_${Date.now()}.png`;
      await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
      await sendTelegram(message, shotPath);
      return { success: true, hasQuizResult: false, message };
    }

    // 심화설문 문항 수: HTTP API 또는 마지막 페이지의 문항 수로 산정
    let depthSurveyCount = 0;
    if (effectiveIsAdvancedSurvey) {
      if (httpQuizResult && httpQuizResult.depthSurveyQuestionCnt > 0) {
        depthSurveyCount = httpQuizResult.depthSurveyQuestionCnt;
      } else if (lastPageQuestionCount > 0) {
        depthSurveyCount = lastPageQuestionCount;
      }
    }

    const resultMessage = formatQuizResults(channelResults, _hasUnknown, _hasMultipleMatches, depthSurveyCount);

    // ── 심화설문인 경우: 제출 금지 ───────────────────────────────────────
    if (effectiveIsAdvancedSurvey) {
      console.log(`[seminar_quiz] ⚠️ 심화설문 세미나(${seminarName})이므로 퀴즈 정답 추출 후 제출을 생략합니다.`);

      const initialUrl = page.url();
      const seminarPageUrl = seminarId ? `https://m.doctorville.co.kr/cme/seminar/${seminarId}` : initialUrl;
      const baseDir = path.join(process.cwd(), 'screenshot');
      const advancedShotPath = path.join(baseDir, `quiz_advanced_${seminarName ?? 'unknown'}_${Date.now()}.png`);

      try {
        await fs.mkdir(baseDir, { recursive: true });
        await page.screenshot({ path: advancedShotPath, fullPage: true }).catch(() => {});
        await sendTelegram(
          `📋 ℹ️ [심화설문] 퀴즈 정답 추출 완료 (자동 제출 제외)\n${resultMessage}\n\n🔗 세미나 URL: ${seminarPageUrl}`,
          advancedShotPath,
        ).catch(() => {});
      } catch (_ssErr) {
        await sendTelegram(
          `📋 ℹ️ [심화설문] 퀴즈 정답 추출 완료 (자동 제출 제외)\n${resultMessage}\n\n🔗 세미나 URL: ${seminarPageUrl}`,
        ).catch(() => {});
      } finally {
        await fs.unlink(advancedShotPath).catch(() => {});
      }

      if (_hasUnknown) {
        const unknownMessage = formatUnknownQuestions(accumulatedQuestions, accumulatedResults);
        await sendTelegram(unknownMessage).catch(() => {});
      }

      return {
        success: true,
        hasQuizResult: channelResults.length > 0,
        message: `${resultMessage}\n(※ 심화설문으로 자동 제출이 제외되었습니다)`,
      };
    }

    // ── 일반 세미나: 제출하기 버튼 클릭 및 확인 모달 처리 ─────────────────
    await page.waitForTimeout(1000);
    const initialUrl = page.url();
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
    }

    // 제출하기 클릭 후 모달/다이얼로그 및 페이지 이동 대기
    try {
      const modalOrOutro = await Promise.race([
        page.waitForSelector('[data-headlessui-state="open"]', { timeout: 10000 }).then(() => 'modal' as const),
        page
          .waitForSelector('button:text-matches("^확인$", "i")', { timeout: 10000 })
          .then(() => 'confirm_btn' as const),
        page.waitForURL('**/outro', { timeout: 10000 }).then(() => 'outro' as const),
      ]).catch(() => null);

      console.log(`[seminar_quiz] 제출 후 상태 감지: ${modalOrOutro ?? 'timeout/none'}`);

      if (modalOrOutro === 'modal' || modalOrOutro === 'confirm_btn') {
        let confirmBtn = page.getByRole('button', { name: '확인' }).first();
        let isConfirmVisible = await confirmBtn.isVisible().catch(() => false);

        if (!isConfirmVisible) {
          confirmBtn = page
            .locator('button, div, span, a')
            .filter({ hasText: /^확인$/ })
            .first();
          isConfirmVisible = await confirmBtn.isVisible().catch(() => false);
        }

        if (isConfirmVisible) {
          await confirmBtn.click({ force: true });
          console.log('[seminar_quiz] 설문제출 모달 "확인" 클릭 완료');
        } else {
          console.warn('[seminar_quiz] 모달 감지되었으나 "확인" 버튼 탐지 실패');
        }
      }
    } catch (e) {
      console.warn('[seminar_quiz] 제출 후 모달/다이얼로그 처리 중 예외 발생:', e);
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
      const seminarPageUrl = seminarId ? `https://m.doctorville.co.kr/cme/seminar/${seminarId}` : initialUrl;
      await sendTelegram(
        `📋 ${submitStatus}\n${resultMessage}\n\n🔗 세미나 URL: ${seminarPageUrl}`,
        submitShotPath,
      ).catch(() => {});
    } catch (_ssErr) {
      /* ignore */
    } finally {
      await fs.unlink(submitShotPath).catch(() => {});
    }
    // ── 자동 클릭·제출 끝 ─────────────────────────────────────────────

    // 미등록 [퀴즈] 문제가 있으면 관리자에게 상세 전송
    if (_hasUnknown) {
      const unknownMessage = formatUnknownQuestions(accumulatedQuestions, accumulatedResults);
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
