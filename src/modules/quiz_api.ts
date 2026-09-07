import * as cheerio from 'cheerio';
import { sendDoctorVilleRequest } from './http_client';
import * as storage from '../services/storage';

export const QUIZ_LIST_URLS = [
  'https://www.doctorville.co.kr/product/medicineList',
  'https://www.doctorville.co.kr/product/instrumentList',
];

export const TODAY_QUIZ_CACHE_KEY = 'today_quiz:verified_api_answers';

export interface ProductQuizQuestion {
  questionId: number;
  quizId: number;
  questionNm: string;
  answerInfo: string; // e.g. "O$X" or "보기1$보기2$보기3$보기4"
  answerNum: number; // 1-based index
  answerExplanation?: string;
  createDt?: string;
}

export interface ProductQuizData {
  quizId: number;
  quizNm: string;
  point: number;
  useSt: string;
  startDt: string;
  endDt: string;
  categoryNm?: string;
  title?: string;
  titleEng?: string;
  pid: number | string;
  questionList: ProductQuizQuestion[];
  attemptCount?: number;
  applyCnt?: number;
}

export interface ProductQuizApiResponse {
  timestamp?: string;
  data: ProductQuizData | null;
  error: string | null;
}

export interface ParsedQuizQuestion {
  questionId: number;
  questionNm: string;
  choices: string[];
  answerNum: number; // 1-based index
  answerText: string;
  explanation: string;
}

export interface ValidatedQuizResult {
  quizId: number;
  pid: string;
  productTitle: string;
  point: number;
  link: string;
  answers: number[]; // 1-based indices (e.g. [1, 1, 1])
  questions: ParsedQuizQuestion[];
  verifiedDateKst: string;
}

export function getTodayIsoDateKst(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' as const });
}

/**
 * medicineList 및 instrumentList에서 당일 퀴즈가 있는 상품 링크와 pId를 탐색합니다.
 */
export async function findTodayQuizProductLinkHttp(): Promise<{ link: string; pId: string } | null> {
  for (const listUrl of QUIZ_LIST_URLS) {
    try {
      const res = await sendDoctorVilleRequest(listUrl);
      if (res.status !== 200) continue;

      const $ = cheerio.load(res.body);
      const quizBgs = $('.product_list .quiz_bg');
      if (quizBgs.length === 0) continue;

      for (let i = 0; i < quizBgs.length; i++) {
        const bg = quizBgs.eq(i);
        const anchor = bg.closest('a').length ? bg.closest('a') : bg.find('a');
        const href = anchor.attr('href');
        if (href) {
          const fullLink = href.startsWith('http') ? href : `https://www.doctorville.co.kr${href}`;
          const urlObj = new URL(fullLink);
          const pId = urlObj.searchParams.get('pId') || '';
          return { link: fullLink, pId };
        }
      }
    } catch (e) {
      console.warn(`[quiz_api] ${listUrl} 조회 중 오류:`, e);
    }
  }
  return null;
}

/**
 * 상세 페이지 HTML에서 quizId를 추출합니다.
 */
export function extractQuizIdFromHtml(html: string): string | null {
  const match = html.match(/var\s+quizId\s*=\s*["']?(\d+)["']?/i) || html.match(/product-quiz\/(\d+)/i);
  return match ? match[1] : null;
}

/**
 * 상품 상세 페이지를 HTTP로 조회하여 quizId를 추출합니다.
 */
export async function fetchQuizIdFromDetailUrl(detailUrl: string): Promise<string | null> {
  try {
    const res = await sendDoctorVilleRequest(detailUrl);
    if (res.status !== 200) return null;
    return extractQuizIdFromHtml(res.body);
  } catch (e) {
    console.warn(`[quiz_api] 상세 페이지(${detailUrl}) 조회 중 오류:`, e);
    return null;
  }
}

/**
 * 닥터빌 퀴즈 조회 API (GET /api/product-quiz/{quizId})를 호출합니다.
 */
export async function fetchProductQuizApi(
  quizId: string | number,
  refererUrl?: string,
): Promise<ProductQuizApiResponse | null> {
  try {
    const apiUrl = `https://api.doctorville.co.kr/api/product-quiz/${quizId}?_=${Date.now()}`;
    const headers: Record<string, string> = {
      Accept: 'application/json, text/plain, */*',
    };
    if (refererUrl) {
      headers.Referer = refererUrl;
    }

    const res = await sendDoctorVilleRequest(apiUrl, { headers });
    if (res.status !== 200) {
      console.warn(`[quiz_api] API 응답 오류 (HTTP ${res.status}): ${apiUrl}`);
      return null;
    }

    const json = JSON.parse(res.body) as ProductQuizApiResponse;
    return json;
  } catch (e) {
    console.warn(`[quiz_api] API 호출/파싱 실패 (quizId: ${quizId}):`, e);
    return null;
  }
}

/**
 * API 응답 데이터를 엄격하게 검증하고 정답 및 문항 정보를 파싱합니다.
 */
export function validateAndParseQuizData(
  data: ProductQuizData,
  options?: {
    expectedPid?: string | number;
    targetDateKst?: string;
    link?: string;
  },
): ValidatedQuizResult | null {
  if (!data) return null;

  // 1. 활성 상태 확인
  if (data.useSt !== 'Y') {
    console.warn(`[quiz_api] useSt가 Y가 아님: ${data.useSt}`);
    return null;
  }

  // 2. 날짜 검증 (KST)
  const targetDate = options?.targetDateKst || getTodayIsoDateKst();
  const startDate = data.startDt ? data.startDt.substring(0, 10) : '';
  const endDate = data.endDt ? data.endDt.substring(0, 10) : '';

  if (startDate && targetDate < startDate) {
    console.warn(`[quiz_api] 퀴즈 시작일(${startDate}) 전입니다. (오늘: ${targetDate})`);
    return null;
  }
  if (endDate && targetDate > endDate) {
    console.warn(`[quiz_api] 퀴즈 종료일(${endDate})이 지났습니다. (오늘: ${targetDate})`);
    return null;
  }

  // 3. pid 일치 확인 (옵션이 주어졌을 때)
  if (options?.expectedPid && String(data.pid) !== String(options.expectedPid)) {
    console.warn(`[quiz_api] pid 불일치: 기대값(${options.expectedPid}) !== API(${data.pid})`);
    return null;
  }

  // 4. 문항 및 정답 검증
  if (!Array.isArray(data.questionList) || data.questionList.length === 0) {
    console.warn('[quiz_api] questionList가 비어있습니다.');
    return null;
  }

  const answers: number[] = [];
  const parsedQuestions: ParsedQuizQuestion[] = [];

  for (let i = 0; i < data.questionList.length; i++) {
    const q = data.questionList[i];
    const questionNm = (q.questionNm || '').trim();
    const choices = (q.answerInfo || '')
      .split('$')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const ansNum = Number(q.answerNum);

    if (!questionNm || choices.length === 0) {
      console.warn(`[quiz_api] 문항 ${i + 1}의 지문 또는 보기가 비어있습니다.`);
      return null;
    }

    if (isNaN(ansNum) || ansNum < 1 || ansNum > choices.length) {
      console.warn(`[quiz_api] 문항 ${i + 1}의 정답 번호(${ansNum})가 보기 범위(1~${choices.length})를 벗어남`);
      return null;
    }

    const answerText = choices[ansNum - 1];
    answers.push(ansNum);
    parsedQuestions.push({
      questionId: q.questionId,
      questionNm,
      choices,
      answerNum: ansNum,
      answerText,
      explanation: (q.answerExplanation || '').trim(),
    });
  }

  return {
    quizId: Number(data.quizId),
    pid: String(data.pid),
    productTitle: data.title || data.quizNm || '',
    point: data.point || 0,
    link: options?.link || '',
    answers,
    questions: parsedQuestions,
    verifiedDateKst: targetDate,
  };
}

/**
 * 당일 퀴즈 정답을 조회합니다.
 * 1. 로컬 캐시 확인
 * 2. 캐시 부재 시 medicineList/instrumentList -> 상세 -> quizId -> API 호출 후 캐시 저장
 */
export async function getTodayVerifiedQuizAnswers(forceRefresh = false): Promise<ValidatedQuizResult | null> {
  const today = getTodayIsoDateKst();

  // 1. 캐시 확인
  if (!forceRefresh) {
    const cached = storage.get<ValidatedQuizResult>(TODAY_QUIZ_CACHE_KEY, null);
    if (cached && cached.verifiedDateKst === today && cached.answers?.length > 0) {
      console.log(`[quiz_api] 당일(${today}) 캐시된 정답 재사용 (${cached.productTitle}):`, cached.answers);
      return cached;
    }
  }

  // 2. 퀴즈 상품 링크 및 pId 찾기
  console.log('[quiz_api] 당일 퀴즈 상품 탐색 시작...');
  const found = await findTodayQuizProductLinkHttp();
  if (!found) {
    console.log('[quiz_api] 오늘 진행 중인 퀴즈 상품을 찾지 못했습니다.');
    return null;
  }

  console.log(`[quiz_api] 퀴즈 상품 링크 발견: ${found.link} (pId: ${found.pId})`);

  // 3. 상세 페이지에서 quizId 추출
  const quizId = await fetchQuizIdFromDetailUrl(found.link);
  if (!quizId) {
    console.warn(`[quiz_api] 상세 페이지에서 quizId를 찾지 못했습니다: ${found.link}`);
    return null;
  }

  console.log(`[quiz_api] quizId 추출 성공: ${quizId}`);

  // 4. API 호출
  const apiRes = await fetchProductQuizApi(quizId, found.link);
  if (!apiRes || !apiRes.data) {
    console.warn(`[quiz_api] 퀴즈 API 응답이 없거나 데이터가 비어있습니다: quizId=${quizId}`);
    return null;
  }

  // 5. 응답 검증 및 파싱
  const validated = validateAndParseQuizData(apiRes.data, {
    expectedPid: found.pId,
    targetDateKst: today,
    link: found.link,
  });

  if (!validated) {
    console.warn(`[quiz_api] 퀴즈 API 응답 검증 실패 (quizId: ${quizId})`);
    return null;
  }

  console.log(`[quiz_api] 퀴즈 API 정답 획득 성공! (${validated.productTitle}) 정답:`, validated.answers);

  // 6. 캐시 저장
  storage.set(TODAY_QUIZ_CACHE_KEY, validated);

  return validated;
}
