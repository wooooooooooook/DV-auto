import type { BrowserContext } from 'playwright';
import quizMapping from '../../data/quiz.json';
import type { PlaywrightRunArgs } from '../types';
import {
  safeGoto,
  sendTelegram,
  getSeminarIdFromUrl,
  hasSurveyPointExcludedNotice,
  getPointConversionAvailabilityHttp,
  isSurveyPointExcludedSeminarHttp,
} from '../modules/utils';
import * as storage from '../services/storage';
import * as seminarRepo from '../services/seminar_repository';
import {
  loadCheatsheet,
  findMatchingKeywords,
  resolveBestKeywordMatch,
  findOptionByAnswer,
  type QuizQuestion,
} from './seminar_quiz';
import { TODAY_QUIZ_INFO_KEY, type CachedTodayQuizInfo } from './today_quiz';
import {
  fetchMainFutureSeminars,
  fetchSeminarDetail,
  parseSeminarDateTime,
  checkIsAdvancedSurvey,
} from '../modules/seminar_api';

const QUIZ_LIST_URLS = [
  'https://www.doctorville.co.kr/product/medicineList',
  'https://www.doctorville.co.kr/product/instrumentList',
];
const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const BASE_URL = 'https://www.doctorville.co.kr/';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
const POINT_CONVERSION_API_URL = 'https://api.doctorville.co.kr/api/point/conversion/availability';
const POINT_CONVERSION_URL = 'https://www.doctorville.co.kr/my/point/pointUseHistoryList';
const TODAY_QUIZ_TEMP_KEY = 'today_quiz:temp_answers';
export const TODAY_LINKS_CACHE_KEY = 'today_links_cache';

export interface TodayLinksCache {
  date: string;
  message: string;
  options?: Record<string, unknown>;
  cachedAt: string;
}

function getTodayLinksCache(): TodayLinksCache | null {
  return storage.get<TodayLinksCache>(TODAY_LINKS_CACHE_KEY, null);
}

function setTodayLinksCache(cache: TodayLinksCache): void {
  storage.set(TODAY_LINKS_CACHE_KEY, cache);
}

function clearTodayLinksCache(): void {
  storage.deleteKey(TODAY_LINKS_CACHE_KEY);
}

type PointConversionInfo = {
  available?: boolean;
  availablePlannedAt?: string;
  meridiem?: string;
};

type QuizInfo = { link: string; productTitle?: string; answers?: Array<string | number> };
type SeminarData = {
  date: string;
  lunchSeminarIds: string[];
  dinnerSeminarIds: string[];
};
type SeminarTaskData = SeminarData & { allSeminarIds: string[] };
type SeminarMessageResult = SeminarData & { message: string };
type StoredNewSeminars = {
  date: string;
  seminars: Array<{
    name: string;
    url: string;
    seminarId: string | null;
    isPointExcluded?: boolean;
    isAdvancedSurvey?: boolean;
    date?: string;
    time?: string;
    currentCount?: string;
    totalCount?: string;
  }>;
};

type TempQuizAnswers = {
  date: string;
  productTitle: string;
  answers: Array<string | number>;
};
const TODAY_SEMINAR_KEY = 'today_seminars';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * today_links 전용: HTTP 요청 우선 검사 후 필요 시 빠른 DOM 로드로 포인트미지급 여부 검사
 */
async function checkPointExcludedFast(url: string, context?: BrowserContext): Promise<boolean> {
  const start = Date.now();
  try {
    const httpRes = await isSurveyPointExcludedSeminarHttp(url);
    if (httpRes.status === 'success') {
      console.log(
        `[today_links] 포인트미지급 HTTP 확인 완료 (${Date.now() - start}ms, 결과: ${httpRes.excluded}): ${url}`,
      );
      return httpRes.excluded;
    }
  } catch (_e) {
    /* ignore and fallback */
  }

  if (!context) return false;

  await sendTelegram(
    `⚠️ [today_links] 포인트미지급 HTTP 조회 실패로 Playwright DOM 폴백을 실행합니다.\nURL: ${url}`,
  ).catch(() => {});

  const page = await context.newPage();
  try {
    await safeGoto(page, url, { waitUntil: 'domcontentloaded', timeout: 8000 }, 1);
    await page
      .locator('text=공유, .detail_cont, .seminar_info, body')
      .first()
      .waitFor({ state: 'attached', timeout: 3000 })
      .catch(() => {});
    const isExcluded = await hasSurveyPointExcludedNotice(page);
    console.log(
      `[today_links] 포인트미지급 DOM fallback 확인 완료 (${Date.now() - start}ms, 결과: ${isExcluded}): ${url}`,
    );
    return isExcluded;
  } catch (_e) {
    console.warn(`[today_links] 포인트미지급 확인 실패 (${Date.now() - start}ms): ${url}`);
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

/**
 * 미확인 세미나 목록을 병렬(concurrency=4)로 빠르게 일괄 확인 (HTTP 우선, 필요 시 브라우저 fallback)
 */
async function batchCheckPointExcluded(
  items: Array<{ link: string; cacheKey: string }>,
  cache: Map<string, boolean>,
  context?: BrowserContext,
): Promise<void> {
  const targets = items.filter((item) => !cache.has(item.cacheKey));
  if (targets.length === 0) return;

  console.log(`[today_links] 포인트미지급 병렬 일괄 확인 시작 (총 ${targets.length}건, HTTP 우선)`);
  const startTime = Date.now();

  const concurrency = 4;
  for (let i = 0; i < targets.length; i += concurrency) {
    const batch = targets.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (target) => {
        try {
          const isExcluded = await checkPointExcludedFast(target.link, context);
          cache.set(target.cacheKey, isExcluded);
        } catch {
          cache.set(target.cacheKey, false);
        }
      }),
    );
  }

  console.log(`[today_links] 포인트미지급 병렬 일괄 확인 완료 (총 소요시간: ${Date.now() - startTime}ms)`);
}

function findPointExcludedFromStoredSeminars(
  storedSeminars: Array<{ url: string; seminarId?: string | null; isPointExcluded?: boolean }>,
  seminarId: string | null,
  fullUrl: string,
): boolean | undefined {
  const normalizedFullUrl = fullUrl.replace(/\/+$/, '');
  const matched = storedSeminars.find((seminar) => {
    if (typeof seminar.isPointExcluded !== 'boolean') return false;

    if (seminarId) {
      if (seminar.seminarId && seminar.seminarId === seminarId) return true;
      const storedId = getSeminarIdFromUrl(seminar.url);
      if (storedId && storedId === seminarId) return true;
    }

    return seminar.url.replace(/\/+$/, '') === normalizedFullUrl;
  });

  return matched?.isPointExcluded;
}

/**
 * 텍스트에서 괄호 안의 내용을 정리합니다.
 */
function cleanBrackets(text: string): string {
  let prev = text;
  let cur = text;
  do {
    prev = cur;
    cur = cur
      .replace(/\([^)()]*\)/g, '')
      .replace(/\[[^[\]]*\]/g, '')
      .trim();
  } while (cur !== prev);
  return cur;
}

/**
 * 문제 텍스트를 검색용으로 정규화합니다.
 */
function _normalizeQuestionText(text: string): string {
  return cleanBrackets(text)
    .replace(/[^가-힣a-zA-Z0-9]/g, '')
    .trim();
}

async function parseTodayQuizQuestions(page: PlaywrightRunArgs['page']): Promise<QuizQuestion[]> {
  const questions: QuizQuestion[] = [];

  const areaSelector = '#questionArea .question_area';
  const areas = await page.locator(areaSelector).all();

  for (const area of areas) {
    const questionText = await area
      .locator('.txt_question')
      .innerText()
      .catch(() => '');
    const options: QuizQuestion['options'] = [];

    const choiceItems = await area.locator('.question_choice li').all();
    for (let i = 0; i < choiceItems.length; i++) {
      const item = choiceItems[i];
      const label = item.locator('label');
      const input = item.locator('input[type="radio"]');

      const text = await label.innerText().catch(() => '');
      const value = (await input.getAttribute('value')) || '';

      options.push({
        index: i + 1,
        text: text.trim(),
        value,
      });
    }

    if (questionText) {
      questions.push({
        questionText: questionText.trim(),
        options,
        marker: '[퀴즈]',
        kind: 'quiz',
      });
    }
  }

  return questions;
}

async function findAnswersByCheatsheet(page: PlaywrightRunArgs['page']): Promise<Array<string | number> | null> {
  try {
    const cheatsheet = await loadCheatsheet();
    if (Object.keys(cheatsheet).length === 0) return null;

    const questions = await parseTodayQuizQuestions(page);
    if (questions.length === 0) return null;

    const result: Array<string | number> = [];
    for (const q of questions) {
      console.log(`[today_links] 매칭 시도 문제: ${q.questionText.substring(0, 30)}...`);
      const bestMatch = resolveBestKeywordMatch(q.questionText, q.options, cheatsheet);
      if (bestMatch) {
        console.log(
          `[today_links] 매칭 성공: ${bestMatch.keyword} -> ${cheatsheet[bestMatch.keyword]} (보기 ${bestMatch.option.index}번)`,
        );
        result.push(bestMatch.option.index);
        continue;
      }
      const matches = findMatchingKeywords(q.questionText, cheatsheet);
      if (matches.length > 0) {
        const chosenKeyword = matches[0];
        const answerKeyword = cheatsheet[chosenKeyword];
        const option = findOptionByAnswer(q.options, answerKeyword);
        if (option) {
          console.log(`[today_links] 매칭 성공: ${chosenKeyword} -> ${answerKeyword} (보기 ${option.index}번)`);
          result.push(option.index);
          continue;
        }
      }
      console.warn(`[today_links] 문제에 대한 정답을 찾지 못했습니다: ${q.questionText.substring(0, 50)}...`);
      return null;
    }
    return result;
  } catch (e) {
    console.error('[today_links] 족보 매칭 중 오류', e);
    return null;
  }
}

function parseTargetDate(input?: string): Date {
  const now = new Date();
  if (!input) return now;

  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'today' || trimmed === '오늘') {
    return now;
  }
  if (trimmed === 'tomorrow' || trimmed === '내일') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (trimmed === 'yesterday' || trimmed === '어제') {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d;
  }
  if (trimmed === '모레') {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    return d;
  }

  // YYYY-MM-DD 또는 YYYY/MM/DD 또는 YYYY.MM.DD 또는 YYYYMMDD
  const ymdMatch = trimmed.match(/^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})$/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10) - 1;
    const day = parseInt(ymdMatch[3], 10);
    return new Date(year, month, day, 12, 0, 0);
  }

  // MM-DD 또는 M/D 또는 MM.DD
  const mdMatch = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (mdMatch) {
    const currentYear = now.getFullYear();
    const month = parseInt(mdMatch[1], 10) - 1;
    const day = parseInt(mdMatch[2], 10);
    return new Date(currentYear, month, day, 12, 0, 0);
  }

  // MMDD (4자리)
  const mmddMatch = trimmed.match(/^(\d{2})(\d{2})$/);
  if (mmddMatch) {
    const currentYear = now.getFullYear();
    const month = parseInt(mmddMatch[1], 10) - 1;
    const day = parseInt(mmddMatch[2], 10);
    return new Date(currentYear, month, day, 12, 0, 0);
  }

  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  return now;
}

function getTodayDateStrings(customDateInput?: string) {
  const opts = { timeZone: 'Asia/Seoul' as const };
  const targetDate = parseTargetDate(customDateInput);
  const now = new Date();

  const month = targetDate.toLocaleDateString('en-US', { month: 'numeric', ...opts });
  const day = targetDate.toLocaleDateString('en-US', { day: 'numeric', ...opts });
  const iso = targetDate.toLocaleDateString('en-CA', opts);

  const yesterday = new Date(targetDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIso = yesterday.toLocaleDateString('en-CA', opts);

  const nowIso = now.toLocaleDateString('en-CA', opts);
  const isCustomDate = Boolean(customDateInput && iso !== nowIso);

  const targetMonth = parseInt(month, 10);
  const targetDay = parseInt(day, 10);

  return {
    todayString: `${month}/${day}`,
    isoDate: iso,
    yesterdayIso,
    isCustomDate,
    targetMonth,
    targetDay,
  };
}

function getYesterdayAddedSeminars(yesterdayIso: string): StoredNewSeminars['seminars'] {
  const storedSeminars = seminarRepo.getSeminarsByDetectedDate(yesterdayIso);

  return storedSeminars
    .filter((seminar) => {
      if (!seminar.totalCount || seminar.totalCount.trim() === '') return true;
      const parsed = parseInt(seminar.totalCount.replace(/[^0-9]/g, ''), 10);
      return isNaN(parsed) || parsed >= 10;
    })
    .map((seminar) => ({
      name: seminar.name,
      url: seminar.url,
      seminarId: seminar.seminarId,
      isPointExcluded: seminar.isPointExcluded,
      isAdvancedSurvey: seminar.isAdvancedSurvey,
      date: seminar.date,
      time: seminar.time,
      currentCount: seminar.currentCount,
      totalCount: seminar.totalCount,
    }))
    .sort((a, b) => {
      if (!a.seminarId && !b.seminarId) return 0;
      if (!a.seminarId) return 1;
      if (!b.seminarId) return -1;
      return a.seminarId.localeCompare(b.seminarId, undefined, { numeric: true });
    });
}

function getTempQuizAnswers(isoDate: string, productTitle: string): Array<string | number> | null {
  const stored = storage.get<TempQuizAnswers>(TODAY_QUIZ_TEMP_KEY);
  if (!stored || stored.date !== isoDate || stored.productTitle !== productTitle) return null;
  if (!Array.isArray(stored.answers) || stored.answers.length === 0) return null;
  return stored.answers;
}

async function findQuizHref(page: PlaywrightRunArgs['page']): Promise<string | null> {
  for (const url of QUIZ_LIST_URLS) {
    console.log(`[today_links] 퀴즈 목록 확인: ${url}`);
    await safeGoto(page, url, { waitUntil: 'load', timeout: 30000 }, 1);

    const quizBg = page.locator('.product_list .quiz_bg').first();
    const quizBgCount = await quizBg.count();
    if (!quizBgCount) {
      console.log(`[today_links] 퀴즈 항목을 찾지 못했습니다. 다음 경로를 확인합니다: ${url}`);
      continue;
    }

    const handle = await quizBg.elementHandle();
    if (!handle) continue;

    const href = await page
      .evaluate((el) => {
        let cur: Element | null = el;
        while (cur && cur.nodeType === 1) {
          const anchor = cur as HTMLAnchorElement;
          if (anchor.tagName === 'A' && anchor.href) return anchor.href;
          cur = cur.parentElement;
        }
        return null;
      }, handle)
      .catch(() => null);

    if (!href) {
      console.log(`[today_links] 퀴즈 링크를 찾지 못했습니다. 다음 경로를 확인합니다: ${url}`);
      continue;
    }

    return href;
  }

  return null;
}

async function collectQuizInfo(page?: PlaywrightRunArgs['page']): Promise<QuizInfo | null> {
  try {
    const { isoDate } = getTodayDateStrings();

    // 1. today_quiz가 실행되어 스토리지에 캐시된 오늘자 퀴즈 정보가 있는지 먼저 확인
    const cachedQuiz = storage.get<CachedTodayQuizInfo>(TODAY_QUIZ_INFO_KEY);
    if (cachedQuiz && cachedQuiz.date === isoDate) {
      console.log('[today_links] 캐시된 오늘의 퀴즈 정보를 사용합니다:', cachedQuiz);
      if (!cachedQuiz.link) return null;

      // temp_answers 갱신 여부 확인 (사용자가 텔레그램 답장으로 정답을 갱신했을 수 있음)
      const tempAnswers = cachedQuiz.productTitle ? getTempQuizAnswers(isoDate, cachedQuiz.productTitle) : null;
      return {
        link: cachedQuiz.link,
        productTitle: cachedQuiz.productTitle,
        answers: tempAnswers || cachedQuiz.answers,
      };
    }

    // 2. 캐시가 없고 page가 제공되지 않은 경우 브라우저 탐색 생략
    if (!page) {
      console.log('[today_links] 오늘자 퀴즈 캐시가 없고 브라우저 페이지가 제공되지 않아 퀴즈 탐색을 건너뜁니다.');
      return null;
    }

    const href = await findQuizHref(page);
    if (!href) return null;

    await safeGoto(page, href, { waitUntil: 'load', timeout: 30000 }, 1);

    const titleElem = page.locator('#product_title');
    const productTitle =
      (await titleElem.count()) > 0
        ? (
            await titleElem
              .first()
              .innerText()
              .catch(() => '')
          ).trim()
        : '';

    // 1. seminar_quiz_cheatsheet(족보)에서 먼저 탐색
    let answers: Array<string | number> = (await findAnswersByCheatsheet(page)) || [];

    // 2. 족보에 없으면 임시 캐시 또는 quiz.json 매핑에서 탐색
    if (answers.length === 0) {
      const tempAnswers = productTitle ? getTempQuizAnswers(isoDate, productTitle) : null;
      if (tempAnswers) {
        answers = tempAnswers;
      } else if (productTitle) {
        const mapping = quizMapping as Record<string, Array<string | number>>;
        const mappingAnswers = mapping[productTitle];
        if (mappingAnswers && Array.isArray(mappingAnswers) && mappingAnswers.length > 0) {
          console.log(`[today_links] "${productTitle}" 족보 미매칭으로 quiz.json에서 정답을 참조합니다.`);
          answers = mappingAnswers;
        }
      }
    }

    return {
      link: href,
      productTitle: productTitle || undefined,
      answers: Array.isArray(answers) && answers.length > 0 ? answers : undefined,
    };
  } catch (_e) {
    console.error('collectQuizInfo error', _e && typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e);
    return null;
  }
}

type DateTarget = {
  todayString: string;
  isoDate: string;
  targetMonth: number;
  targetDay: number;
};

type ParsedSeminarItem = {
  title: string;
  time: string;
  seminarLink: string;
  fullUrl: string;
  seminarId: string | null;
  classAttr: string;
  isAdvancedSurvey: boolean;
  isPointExcluded?: boolean;
};

function isDateMatching(dateText: string, target: DateTarget): boolean {
  if (!dateText) return false;
  if (dateText.includes(target.todayString)) return true;
  if (dateText.includes(target.isoDate)) return true;

  // YYYY.MM.DD, YYYY-MM-DD, YYYY/MM/DD 등 연도 포함 형식
  const ymdMatch = dateText.match(/(\d{4})[^\d]+(\d{1,2})[^\d]+(\d{1,2})/);
  if (ymdMatch) {
    const m = parseInt(ymdMatch[2], 10);
    const d = parseInt(ymdMatch[3], 10);
    if (m === target.targetMonth && d === target.targetDay) return true;
  }

  // M/D, MM/DD, M.D, MM.DD, M월 D일 등 월/일 형식
  const mdMatch = dateText.match(/(\d{1,2})[^\d]+(\d{1,2})/);
  if (mdMatch) {
    const m = parseInt(mdMatch[1], 10);
    const d = parseInt(mdMatch[2], 10);
    if (m === target.targetMonth && d === target.targetDay) return true;
  }

  return false;
}

function parseSeminarsFromNodes(nodes: Array<Element>, target: DateTarget): ParsedSeminarItem[] {
  const results: ParsedSeminarItem[] = [];

  function isDateMatching(dateText: string, t: DateTarget): boolean {
    if (!dateText) return false;
    if (dateText.includes(t.todayString)) return true;
    if (dateText.includes(t.isoDate)) return true;

    const ymdMatch = dateText.match(/(\d{4})[^\d]+(\d{1,2})[^\d]+(\d{1,2})/);
    if (ymdMatch) {
      const m = parseInt(ymdMatch[2], 10);
      const d = parseInt(ymdMatch[3], 10);
      if (m === t.targetMonth && d === t.targetDay) return true;
    }

    const mdMatch = dateText.match(/(\d{1,2})[^\d]+(\d{1,2})/);
    if (mdMatch) {
      const m = parseInt(mdMatch[1], 10);
      const d = parseInt(mdMatch[2], 10);
      if (m === t.targetMonth && d === t.targetDay) return true;
    }

    return false;
  }

  nodes.forEach((node) => {
    const date =
      node.querySelector('.seminar_day .date')?.textContent?.trim() ||
      node.querySelector('.list_time .txt_date')?.textContent?.trim() ||
      '';
    if (!isDateMatching(date, target)) return;

    const links = node.querySelectorAll('a.list_detail, .list_seminar > li');
    links.forEach((link) => {
      const anchor = link.tagName && link.tagName.toLowerCase() === 'a' ? link : link.querySelector('a');
      const href = anchor?.getAttribute('href') || link.getAttribute('href') || '';
      if (!href) return;

      const title =
        link.querySelector('.list_tit .tit')?.textContent?.trim() ||
        link.querySelector('.txt_tit')?.textContent?.trim() ||
        link.textContent?.trim() ||
        '세미나';
      const timeElem = link.querySelector('.txt_num.time') || link.querySelector('.time');
      const time = timeElem?.textContent?.replace(/\n/g, '').trim() || '';
      const classAttr = link.getAttribute('class') || timeElem?.getAttribute('class') || '';
      const isAdvancedSurvey = !!link.querySelector('.advanced-survey, [class*="advanced"], .ic_survey');

      const urlObj = new URL(href, 'https://www.doctorville.co.kr/');
      const seminarId = urlObj.searchParams.get('seminarId') || (href.match(/\/seminar\/(\d+)/)?.[1] ?? null);
      const seminarLink = seminarId ? `https://m.doctorville.co.kr/cme/seminar/${seminarId}` : urlObj.toString();

      results.push({
        title,
        time,
        seminarLink,
        fullUrl: urlObj.toString(),
        seminarId,
        classAttr: classAttr || '',
        isAdvancedSurvey,
      });
    });
  });

  return results;
}

async function collectTodaySeminarMessage(
  page?: PlaywrightRunArgs['page'],
  customDateInput?: string,
): Promise<SeminarMessageResult> {
  const { todayString, isoDate, isCustomDate, targetMonth, targetDay } = getTodayDateStrings(customDateInput);
  const lunchSeminarIds: string[] = [];
  const dinnerSeminarIds: string[] = [];
  const seminarTitlePrefix = isCustomDate ? `[${todayString}]` : '오늘의';

  try {
    let parsedSeminars: ParsedSeminarItem[] = [];
    const dateTarget: DateTarget = { todayString, isoDate, targetMonth, targetDay };

    const apiRes = await fetchMainFutureSeminars();
    if (apiRes.success) {
      for (const item of apiRes.items) {
        const { date, time, nightTime } = parseSeminarDateTime(item.startDt, item.endDt);
        if (!isDateMatching(date, dateTarget)) continue;

        const seminarId = String(item.seminarId ?? '');
        const seminarLink = `https://m.doctorville.co.kr/cme/seminar/${seminarId}`;
        const isAdvancedSurvey = checkIsAdvancedSurvey(item.useDepthSurvey);
        parsedSeminars.push({
          title: item.seminarNm || '세미나',
          time,
          seminarLink,
          fullUrl: seminarLink,
          seminarId,
          classAttr: nightTime ? 'night_time' : '',
          isAdvancedSurvey,
        });
      }
    } else if (page) {
      console.warn('[today_links] fetchMainFutureSeminars 실패, DOM fallback 시도:', apiRes.errorMessage);
      await sendTelegram(
        `⚠️ [today_links] 세미나 목록 API 조회 실패(${apiRes.errorMessage})로 Playwright DOM 폴백을 실행합니다.`,
      ).catch(() => {});
      await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 }, 1);

      parsedSeminars = await page.locator('.list_cont').evaluateAll(parseSeminarsFromNodes, {
        todayString,
        isoDate,
        targetMonth,
        targetDay,
      });
    } else {
      console.warn(
        '[today_links] fetchMainFutureSeminars 실패 및 page 미제공으로 DOM fallback 생략:',
        apiRes.errorMessage,
      );
    }

    if (!parsedSeminars || parsedSeminars.length === 0) {
      return {
        message: `<b>${seminarTitlePrefix} 세미나:</b> 세미나가 없습니다. ☕`,
        date: isoDate,
        lunchSeminarIds: [],
        dinnerSeminarIds: [],
      };
    }

    const lunchSeminars: string[] = [];
    const dinnerSeminars: string[] = [];
    const storedSeminars = seminarRepo.getAllSeminars();
    const pointExcludedCache = new Map<string, boolean>();

    const isDinnerSeminar = (classAttr: string, time: string): boolean => {
      if (classAttr.includes('night_time')) return true;

      const hourMatch = time.match(/(\d{1,2})\s*:/);
      if (!hourMatch) return false;

      const hour = Number(hourMatch[1]);
      return Number.isFinite(hour) && hour >= 16;
    };

    const uncachedSeminarItems: Array<{ link: string; cacheKey: string }> = [];
    for (const item of parsedSeminars) {
      const pointExcludedKey = item.seminarId || item.fullUrl;
      if (typeof item.isPointExcluded === 'boolean') {
        pointExcludedCache.set(pointExcludedKey, item.isPointExcluded);
        continue;
      }
      const storedPointExcluded = findPointExcludedFromStoredSeminars(storedSeminars, item.seminarId, item.fullUrl);
      if (typeof storedPointExcluded === 'boolean') {
        pointExcludedCache.set(pointExcludedKey, storedPointExcluded);
      } else if (item.seminarId) {
        // detail API로 비동기 확인
        try {
          const detailRes = await fetchSeminarDetail(item.seminarId);
          if (detailRes.success) {
            pointExcludedCache.set(pointExcludedKey, detailRes.isPointExcluded);
            continue;
          }
        } catch (_e) {
          // ignore
        }
        const httpLink = 'https://www.doctorville.co.kr/seminar/seminarDetail?seminarId=' + item.seminarId;
        uncachedSeminarItems.push({ link: httpLink, cacheKey: pointExcludedKey });
      } else {
        uncachedSeminarItems.push({ link: item.seminarLink, cacheKey: pointExcludedKey });
      }
    }

    if (uncachedSeminarItems.length > 0) {
      await batchCheckPointExcluded(uncachedSeminarItems, pointExcludedCache, page?.context());
    }

    for (const item of parsedSeminars) {
      const pointExcludedKey = item.seminarId || item.fullUrl;
      const isPointExcluded = pointExcludedCache.get(pointExcludedKey) || false;
      const pointExcludedSuffix = isPointExcluded ? ' 🚫<b>[포인트미지급]</b>' : '';
      const advancedSurveySuffix = item.isAdvancedSurvey ? ' 📝<b>[심화설문]</b>' : '';
      const titleDisplay = isPointExcluded ? `<s>${escapeHtml(item.title)}</s>` : escapeHtml(item.title);
      const seminarInfo = ` ${item.time}. ${titleDisplay}${pointExcludedSuffix}${advancedSurveySuffix} ${item.seminarLink}`;

      if (isDinnerSeminar(item.classAttr, item.time)) {
        dinnerSeminars.push(seminarInfo);
        if (item.seminarId) dinnerSeminarIds.push(item.seminarId);
      } else {
        lunchSeminars.push(seminarInfo);
        if (item.seminarId) lunchSeminarIds.push(item.seminarId);
      }
    }

    if (lunchSeminars.length > 0 || dinnerSeminars.length > 0) {
      let message = `<b>${seminarTitlePrefix} 세미나 리스트:</b>\n`;

      if (lunchSeminars.length > 0) {
        message += `🍴 <b>[점심 세미나]</b>\n- `;
        message += lunchSeminars.join('\n- ');
      }
      message += '\n';
      if (dinnerSeminars.length > 0) {
        message += `\n🍴 <b>[저녁 세미나]</b>\n- `;
        message += dinnerSeminars.join('\n- ');
      }
      return {
        message,
        date: isoDate,
        lunchSeminarIds: [...new Set(lunchSeminarIds)],
        dinnerSeminarIds: [...new Set(dinnerSeminarIds)],
      };
    }
    return {
      message: `<b>${seminarTitlePrefix} 세미나 리스트:</b> 세미나가 없습니다. ☕`,
      date: isoDate,
      lunchSeminarIds: [],
      dinnerSeminarIds: [],
    };
  } catch (_e) {
    const message = _e instanceof Error ? _e.message : String(_e);
    console.error(
      'collectTodaySeminarMessage error',
      _e && typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e,
    );
    return {
      message: `<b>${seminarTitlePrefix} 세미나 확인 실패:</b> ${escapeHtml(message)}`,
      date: isoDate,
      lunchSeminarIds: [],
      dinnerSeminarIds: [],
    };
  }
}

async function collectPointConversionInfo(page?: PlaywrightRunArgs['page']): Promise<PointConversionInfo | null> {
  try {
    const httpData = await getPointConversionAvailabilityHttp();
    if (httpData) {
      return httpData;
    }

    if (page) {
      await sendTelegram(
        '⚠️ [today_links] 포인트 전환 정보 API 직접 조회 실패로 Playwright 브라우저 폴백을 실행합니다.',
      ).catch(() => {});
      const currentUrl = page.url();
      if (!currentUrl.includes('doctorville.co.kr')) {
        await safeGoto(page, BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }, 1);
      }
      const response = (await page.evaluate(async (apiUrl: string) => {
        try {
          const res = await fetch(apiUrl, { credentials: 'include' });
          if (!res.ok) return null;
          const text = await res.text();
          if (!text) return null;
          return JSON.parse(text);
        } catch {
          return null;
        }
      }, POINT_CONVERSION_API_URL)) as { data?: PointConversionInfo } | null;

      return response?.data ?? null;
    }

    return null;
  } catch (err) {
    console.error('[today_links] 포인트 전환 정보 조회 실패:', err);
    return null;
  }
}

function parsePointConversionPlannedDate(plannedAt: string | undefined): { month: number; day: number } | null {
  if (!plannedAt) return null;
  const m = plannedAt.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  if (!month || !day) return null;
  return { month, day };
}

export function isPointConversionDay(info: PointConversionInfo | null | undefined, todayIsoOverride?: string): boolean {
  if (!info || info.available) return false;
  const planned = parsePointConversionPlannedDate(info.availablePlannedAt);
  if (!planned) return false;
  const todayIso = todayIsoOverride ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  const [y, mo, d] = todayIso.split('-').map(Number);
  if (!y || !mo || !d) return false;
  const todayMs = Date.UTC(y, mo - 1, d);
  let targetMs = Date.UTC(y, planned.month - 1, planned.day);
  if (targetMs < todayMs) {
    targetMs = Date.UTC(y + 1, planned.month - 1, planned.day);
  }
  return targetMs === todayMs;
}

function getPointConversionDdayLabel(plannedAt: string | undefined, todayIsoOverride?: string): string {
  const planned = parsePointConversionPlannedDate(plannedAt);
  if (!planned) return '';
  const todayIso = todayIsoOverride ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  const [y, mo, d] = todayIso.split('-').map(Number);
  if (!y || !mo || !d) return '';
  const todayMs = Date.UTC(y, mo - 1, d);
  let targetYear = y;
  let targetMs = Date.UTC(targetYear, planned.month - 1, planned.day);
  if (targetMs < todayMs) {
    targetYear += 1;
    targetMs = Date.UTC(targetYear, planned.month - 1, planned.day);
  }
  const diffDays = Math.round((targetMs - todayMs) / 86400000);
  if (diffDays === 0) return ' (D-Day)';
  if (diffDays > 0) return ` (D-${diffDays})`;
  return '';
}

function formatPointConversionMessage(info: PointConversionInfo | null, todayIsoOverride?: string): string {
  if (!info) return '';
  if (info.available) {
    return `💳 <b>현재 네이버페이 포인트 전환 가능합니다.</b>\n${POINT_CONVERSION_URL}`;
  }
  if (isPointConversionDay(info, todayIsoOverride)) {
    return `💳 <b>오늘 네이버페이포인트 전환 가능 예정입니다. 전환 가능 알림을 기다려주세요!</b>\n${POINT_CONVERSION_URL}`;
  }
  const plannedParts = [info.availablePlannedAt, info.meridiem].map((s) => s?.trim()).filter(Boolean);
  if (plannedParts.length > 0) {
    const dday = getPointConversionDdayLabel(info.availablePlannedAt, todayIsoOverride);
    return `💳 <b>다음 네이버페이포인트 전환가능일:</b> ${escapeHtml(plannedParts.join(' '))}${dday}`;
  }
  return '';
}

export type TodayLinksFormatInput = {
  quizInfo: QuizInfo | null;
  seminarMessage: SeminarMessageResult | null;
  storedNewSeminars: StoredNewSeminars['seminars'];
  pointConversionInfo: PointConversionInfo | null;
  targetDate?: string;
  isCustomDate?: boolean;
};

export type TodayLinksFormattedResult = {
  message: string;
  options: {
    parse_mode: 'HTML';
    link_preview_options?: {
      is_disabled: boolean;
    };
    reply_markup: {
      inline_keyboard: Array<Array<{ text: string; url: string }>>;
    };
  };
};

function formatTodayLinksBroadcast(input: TodayLinksFormatInput): TodayLinksFormattedResult {
  const { quizInfo, seminarMessage, storedNewSeminars, pointConversionInfo, targetDate, isCustomDate } = input;

  let message = '';
  if (isCustomDate && targetDate) {
    message += `📅 <b>[${escapeHtml(targetDate)} 링크 및 세미나]</b>\n\n`;
  }

  message += '✨ <b>출석체크:</b> https://m.doctorville.co.kr/mypage/attendance\n\n';

  let quizMessage = '오늘은 퀴즈가 없습니다. ☕';
  if (quizInfo?.link) {
    if (quizInfo.productTitle) {
      const answersText = quizInfo.answers?.map(String).join('');
      const answerNote = answersText
        ? `, 정답: <code>${escapeHtml(answersText)}</code>`
        : ' (저장된 정답이 없습니다. 댓글로 알려주세요.)';
      quizMessage = `<b>${escapeHtml(quizInfo.productTitle)}</b>${answerNote}`;
    }
    quizMessage += `\n${quizInfo.link}`;
  }
  message += `✏️ <b>오늘의 퀴즈:</b> ${quizMessage}\n`;
  if (seminarMessage?.message) {
    message += `\n📖 ${seminarMessage.message}\n`;
  }

  const visibleNewSeminars = (storedNewSeminars || []).filter((item) => {
    if (!item.totalCount || item.totalCount.trim() === '') return true;
    const parsed = parseInt(item.totalCount.replace(/[^0-9]/g, ''), 10);
    return isNaN(parsed) || parsed >= 10;
  });

  if (visibleNewSeminars.length > 0) {
    const newSeminarList = visibleNewSeminars
      .map((item, index) => {
        const link = item.seminarId ? `${SEMINAR_DETAIL_PAGE}${item.seminarId}` : item.url;
        const pointExcludedSuffix = item.isPointExcluded ? ' 🚫[포인트미지급]' : '';
        const advancedSurveySuffix = item.isAdvancedSurvey ? ' ✨<b>[심화설문]</b>' : '';
        const dateTimePrefix = item.date || item.time ? `[${item.date}${item.time ? ' ' + item.time : ''}] ` : '';
        const truncatedName = item.name.length > 20 ? `${item.name.slice(0, 20)}...` : item.name;
        const capacityInfo =
          item.currentCount || item.totalCount ? ` (${item.currentCount || '0'}/${item.totalCount || '0'})` : '';
        const nameDisplay = item.isPointExcluded ? `<s>${escapeHtml(truncatedName)}</s>` : escapeHtml(truncatedName);
        return `${index + 1}. ${dateTimePrefix}${nameDisplay}${capacityInfo}${pointExcludedSuffix}${advancedSurveySuffix}\n${link}`;
      })
      .join('\n');

    message += `\n🆕 <b>어제 추가된 신규 세미나</b>\n${newSeminarList}\n`;
  }

  const pointConversionMessage = formatPointConversionMessage(
    pointConversionInfo,
    isCustomDate && targetDate ? targetDate.split(' ')[0] : undefined,
  );
  if (pointConversionMessage) {
    message += `\n${pointConversionMessage}\n`;
  }

  message += `\n<blockquote>🤖 <b>닥터빌 텔레그램방에 전송된 메시지입니다.</b>
매일 오전 9시 링크모음 발송, 세미나 시작/종료, 퀴즈 정답 알림, 지금 가입하세요!
https://t.me/+J1UGmvLA9jU4NjQ1</blockquote>\n<blockquote>✨세미나정보변경/포인트지급내역 알림 등 상세 알림을 받으려면 알림봇을 구독해주세요! https://t.me/DV_notice_bot </blockquote>`;

  const inlineKeyboard: Array<Array<{ text: string; url: string }>> = [];

  const actionRow: Array<{ text: string; url: string }> = [
    { text: '✨ 출석체크 바로가기', url: 'https://m.doctorville.co.kr/mypage/attendance' },
  ];
  if (quizInfo?.link) {
    actionRow.push({ text: '✏️ 오늘의 퀴즈 풀기', url: quizInfo.link });
  }
  inlineKeyboard.push(actionRow);

  // 포인트 전환 가능일(당일 전환 가능)인 경우 포인트 전환 바로가기 버튼 추가
  const pointConversionDay = pointConversionInfo?.available
    ? true
    : isPointConversionDay(pointConversionInfo, isCustomDate && targetDate ? targetDate.split(' ')[0] : undefined);
  if (pointConversionDay) {
    inlineKeyboard.push([{ text: '💳 포인트 전환하러 가기', url: POINT_CONVERSION_URL }]);
  }

  // 세미나 목록 바로가기 버튼 추가
  inlineKeyboard.push([{ text: '📋 세미나 목록 바로가기', url: SEMINAR_PAGE }]);

  const options = {
    parse_mode: 'HTML' as const,
    link_preview_options: {
      is_disabled: true,
    },
    reply_markup: {
      inline_keyboard: inlineKeyboard,
    },
  };

  return { message, options };
}

async function run({ page, args }: Partial<PlaywrightRunArgs> = {}, taskOptions?: Record<string, unknown>) {
  try {
    const inputDate = (
      args?.date ||
      args?.targetDate ||
      (taskOptions?.targetDate as string) ||
      (taskOptions?.date as string)
    )?.trim();
    const { todayString, isoDate, yesterdayIso, isCustomDate } = getTodayDateStrings(inputDate);

    const quizInfo = await collectQuizInfo(page);
    const seminarMessage = await collectTodaySeminarMessage(page, inputDate);
    const pointConversionInfo = await collectPointConversionInfo(page);

    let storedNewSeminars = getYesterdayAddedSeminars(yesterdayIso);
    if (storedNewSeminars.length > 0) {
      let updatedMissingPointFlag = false;
      const pointExcludedCache = new Map<string, boolean>();

      const storedSeminars = seminarRepo.getAllSeminars();

      const uncachedItems: Array<{ link: string; cacheKey: string }> = [];

      for (const item of storedNewSeminars) {
        const link = item.seminarId ? `${SEMINAR_DETAIL_PAGE}${item.seminarId}` : item.url;
        const cacheKey = item.seminarId || item.url;

        if (typeof item.isPointExcluded === 'boolean') {
          pointExcludedCache.set(cacheKey, item.isPointExcluded);
          continue;
        }

        const storedPointExcluded = findPointExcludedFromStoredSeminars(storedSeminars, item.seminarId, link);
        if (typeof storedPointExcluded === 'boolean') {
          pointExcludedCache.set(cacheKey, storedPointExcluded);
        } else {
          const httpLink = item.seminarId
            ? 'https://www.doctorville.co.kr/seminar/seminarDetail?seminarId=' + item.seminarId
            : link;
          uncachedItems.push({ link: httpLink, cacheKey });
        }
      }

      if (uncachedItems.length > 0) {
        await batchCheckPointExcluded(uncachedItems, pointExcludedCache, page?.context());
      }

      storedNewSeminars = storedNewSeminars.map((item) => {
        const cacheKey = item.seminarId || item.url;
        const isPointExcluded = pointExcludedCache.get(cacheKey);
        if (typeof isPointExcluded === 'boolean' && item.isPointExcluded !== isPointExcluded) {
          updatedMissingPointFlag = true;
          return { ...item, isPointExcluded };
        }
        return item;
      });

      if (updatedMissingPointFlag) {
        for (const item of storedNewSeminars) {
          if (typeof item.isPointExcluded === 'boolean') {
            const sid = item.seminarId || getSeminarIdFromUrl(item.url);
            if (sid) {
              const existing = seminarRepo.getSeminarById(sid);
              if (existing && existing.isPointExcluded !== item.isPointExcluded) {
                seminarRepo.upsertSeminar({
                  ...existing,
                  isPointExcluded: item.isPointExcluded,
                });
              }
            }
          }
        }
      }
    }

    const { message, options } = formatTodayLinksBroadcast({
      quizInfo,
      seminarMessage,
      storedNewSeminars,
      pointConversionInfo,
      targetDate: isCustomDate ? `${isoDate} (${todayString})` : undefined,
      isCustomDate,
    });

    const newSeminarIds = storedNewSeminars.map((item) => item.seminarId).filter((id): id is string => Boolean(id));
    const allSeminarIds = seminarMessage
      ? Array.from(
          new Set([
            ...(seminarMessage.lunchSeminarIds || []),
            ...(seminarMessage.dinnerSeminarIds || []),
            ...newSeminarIds,
          ]),
        )
      : [...newSeminarIds];

    // 당일 세미나인 경우에만 storage 갱신 및 캐시 저장
    if (!isCustomDate) {
      storage.set(TODAY_SEMINAR_KEY, {
        date: seminarMessage.date,
        lunchSeminarIds: seminarMessage.lunchSeminarIds,
        dinnerSeminarIds: seminarMessage.dinnerSeminarIds,
      });
      setTodayLinksCache({
        date: seminarMessage.date,
        message,
        options,
        cachedAt: new Date().toISOString(),
      });
    }

    return {
      success: true,
      message,
      options,
      seminarData: {
        date: seminarMessage.date,
        lunchSeminarIds: seminarMessage.lunchSeminarIds,
        dinnerSeminarIds: seminarMessage.dinnerSeminarIds,
        allSeminarIds,
      } as SeminarTaskData,
    };
  } catch (_e) {
    console.error('today_links task error', _e && typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e);
    const message = _e instanceof Error ? _e.message : String(_e);
    return { success: false, message: `today_links 작업 오류: ${message}` };
  }
}

export {
  run,
  formatTodayLinksBroadcast,
  getTodayDateStrings,
  parseTargetDate,
  isDateMatching,
  parseSeminarsFromNodes,
  collectTodaySeminarMessage,
  getYesterdayAddedSeminars,
  getTodayLinksCache,
  setTodayLinksCache,
  clearTodayLinksCache,
};
export type { SeminarData, SeminarTaskData, DateTarget, ParsedSeminarItem };
