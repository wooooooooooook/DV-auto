import { request } from 'undici';
import * as logger from '../services/logger';

export const DOCPLE_BASE_URL = 'https://docple-plus.com';

export interface DocpleAuthTokens {
  accessToken: string;
  refreshToken?: string;
  joinType?: string;
  uid?: string;
  loginOTP?: string;
  isDoctorApproved?: boolean;
}

export interface DocpleLoginResult {
  success: boolean;
  code?: string;
  message: string;
  data?: DocpleAuthTokens;
}

export interface DocpleUserInfo {
  id?: string;
  nickname?: string;
  email?: string;
  joinType?: string;
  name?: string;
  myCash?: number;
  hospitalName?: string;
  dutyCode?: string;
  dutyText?: string;
  [key: string]: unknown;
}

export interface DocpleCashInfo {
  totalCash: number;
  recentList?: Array<{
    id?: number;
    cash?: number;
    title?: string;
    type?: string;
    date?: string;
    description?: string;
    createdDt?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface DocpleAttendanceCalendarItem {
  date?: string;
  attended?: boolean;
  day?: number;
  [key: string]: unknown;
}

export interface DocpleAttendanceResult {
  status: 'SUCCESS' | 'ALREADY' | 'FAILED';
  rewardCash?: number;
  message: string;
  raw?: unknown;
}

export interface DocpleEdetailingMedicine {
  id: number | string;
  name: string;
  companyName?: string;
  hasQuiz?: boolean;
  hasActiveQuiz?: boolean;
  quizStatus?: string;
  quizUrl: string;
  thumbnailUrl?: string;
  [key: string]: unknown;
}

export interface DocpleActiveQuiz {
  quizId: number;
  quizName: string;
  imageUrl?: string;
  startDate?: string;
  endDate?: string;
  rewardCash?: number;
  pharmaCompanyName?: string;
  medicineId?: number;
  diseaseCategory?: string;
  diseaseCategoryName?: string;
  [key: string]: unknown;
}

export interface DocpleQuizOption {
  optionId: number;
  optionText: string;
  sortOrder?: number;
}

export interface DocpleQuizQuestion {
  questionId: number;
  questionText: string;
  sortOrder?: number;
  options: DocpleQuizOption[];
}

export interface DocpleQuizDetail {
  quizId: number;
  quizName: string;
  imageUrl?: string;
  description?: string;
  startDate?: string;
  endDate?: string;
  maxDailyAttempts?: number;
  remainingAttempts?: number;
  hasPassedBefore?: boolean;
  canAttempt?: boolean;
  questions: DocpleQuizQuestion[];
  [key: string]: unknown;
}

export interface DocpleMedicineDetail {
  id: number;
  medicineName: string;
  imageUrl?: string;
  pharmaCompanyName?: string;
  sellerCompanyName?: string;
  therapeuticCategory?: string;
  diseaseCategoryName?: string;
  mainIngredient?: string;
  billingCode?: string;
  atcCode?: string;
  introImageUrl?: string;
  brochureUrl?: string;
  brochureFileName?: string;
  purchaseLink?: string;
  detailContent?: string;
  quiz?: {
    id: number;
    name: string;
    imageUrl?: string;
    startDate?: string;
    endDate?: string;
    rewardCash?: number;
  };
  [key: string]: unknown;
}

export interface DocpleCommunityAuthResult {
  success: boolean;
  communityToken?: string;
  message: string;
}

export interface DocpleCommunityPost {
  tid: number;
  bid: number;
  no: number;
  title: string;
  grpCode: string;
  subCode: string;
  subCodeName?: string;
  nickname?: string;
  isNotice?: boolean;
  isEvent?: boolean;
  isSOS?: boolean;
  isDeleted?: boolean;
  isRecommended?: boolean;
  recommendCnt?: number;
  commentCnt?: number;
  viewCnt?: number;
  createdDt?: string;
  [key: string]: unknown;
}

export interface DocpleRecommendResult {
  success: boolean;
  message: string;
  bid?: number | string;
  no?: number;
  rewardCash?: number;
}

interface DocpleApiResponse<T = unknown> {
  success?: boolean;
  code?: string | number;
  message?: string;
  data?: T;
  resultCode?: string | number;
  resultMsg?: string;
  result?: T;
  [key: string]: unknown;
}

function getCommonHeaders(accessToken?: string, communityToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Origin: DOCPLE_BASE_URL,
    Referer: `${DOCPLE_BASE_URL}/`,
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  if (communityToken) {
    headers['communityToken'] = communityToken;
    headers['Cookie'] = `communityToken=${communityToken}${accessToken ? `; accessToken=${accessToken}` : ''}`;
  }

  return headers;
}

/**
 * 닥플 플러스 통합 로그인 API 호출
 */
export async function loginDocple(id: string, password: string): Promise<DocpleLoginResult> {
  try {
    const res = await request(`${DOCPLE_BASE_URL}/api/season2/auth/login`, {
      method: 'POST',
      headers: getCommonHeaders(),
      body: JSON.stringify({ id, password }),
    });

    const bodyText = await res.body.text();
    let json: DocpleApiResponse<DocpleAuthTokens>;
    try {
      json = JSON.parse(bodyText) as DocpleApiResponse<DocpleAuthTokens>;
    } catch {
      return {
        success: false,
        message: `응답 파싱 실패 (HTTP ${res.statusCode}): ${bodyText.slice(0, 100)}`,
      };
    }

    if (res.statusCode === 200 && json?.success && json?.data?.accessToken) {
      return {
        success: true,
        message: '로그인 성공',
        data: json.data,
      };
    }

    return {
      success: false,
      code: String(json?.code || 'LOGIN_FAIL'),
      message: json?.message || `로그인 실패 (HTTP ${res.statusCode})`,
    };
  } catch (error) {
    logger.error('Docple loginDocple error', error);
    return {
      success: false,
      message: `네트워크 오류: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 닥플 플러스 토큰 갱신
 */
export async function refreshDocpleToken(refreshToken: string): Promise<DocpleLoginResult> {
  try {
    const res = await request(`${DOCPLE_BASE_URL}/api/season2/auth/token/refresh`, {
      method: 'POST',
      headers: {
        ...getCommonHeaders(),
        'Refresh-Token': refreshToken,
      },
      body: JSON.stringify(null),
    });

    const json = (await res.body.json()) as DocpleApiResponse<DocpleAuthTokens>;
    if (res.statusCode === 200 && json?.success && json?.data?.accessToken) {
      return {
        success: true,
        message: '토큰 갱신 성공',
        data: json.data,
      };
    }

    return {
      success: false,
      message: json?.message || '토큰 갱신 실패',
    };
  } catch (error) {
    logger.error('Docple refreshDocpleToken error', error);
    return {
      success: false,
      message: `토큰 갱신 오류: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 회원 정보 및 프로필 조회
 */
export async function getDocpleUserInfo(accessToken: string): Promise<DocpleUserInfo | null> {
  try {
    const res = await request(`${DOCPLE_BASE_URL}/api/season2/users/info`, {
      method: 'GET',
      headers: getCommonHeaders(accessToken),
    });

    if (res.statusCode !== 200) {
      return null;
    }

    const json = (await res.body.json()) as DocpleApiResponse<DocpleUserInfo>;
    return json?.data || null;
  } catch (error) {
    logger.error('Docple getDocpleUserInfo error', error);
    return null;
  }
}

/**
 * 캐시 잔액 및 최근 적립 내역 조회
 * userInfo(myCash)와 cash/recent 내역을 결합하여 정확한 잔액 산출
 */
export async function getDocpleCash(accessToken: string): Promise<DocpleCashInfo | null> {
  try {
    // 1. users/info에서 현재 보유 myCash 조회
    const userInfo = await getDocpleUserInfo(accessToken);
    const totalCash = userInfo?.myCash ?? 0;

    // 2. cash/recent에서 최근 적립 리스트 조회
    const res = await request(`${DOCPLE_BASE_URL}/api/season2/cash/recent`, {
      method: 'GET',
      headers: getCommonHeaders(accessToken),
    });

    let recentList: DocpleCashInfo['recentList'] = [];
    if (res.statusCode === 200) {
      const json = (await res.body.json()) as DocpleApiResponse<
        Array<{ type?: string; date?: string; cash?: number; [key: string]: unknown }>
      >;
      if (Array.isArray(json?.data)) {
        recentList = json.data;
      }
    }

    return {
      totalCash,
      recentList,
      user: userInfo,
    };
  } catch (error) {
    logger.error('Docple getDocpleCash error', error);
    return null;
  }
}

/**
 * 오늘 KST 날짜 문자열(YYYY-MM-DD) 반환
 */
function getKstDateString(): string {
  const d = new Date();
  const kstFormatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return kstFormatter.format(d);
}

/**
 * 출석 캘린더 조회
 */
export async function getDocpleAttendanceCalendar(
  accessToken: string,
  month?: string,
): Promise<{ attendedToday: boolean; items: DocpleAttendanceCalendarItem[]; raw?: unknown }> {
  try {
    const query = month ? `?month=${encodeURIComponent(month)}` : '';
    const res = await request(`${DOCPLE_BASE_URL}/api/season2/mission/attendance/calendar${query}`, {
      method: 'GET',
      headers: getCommonHeaders(accessToken),
    });

    if (res.statusCode !== 200) {
      return { attendedToday: false, items: [] };
    }

    const json = (await res.body.json()) as DocpleApiResponse<{
      yearMonth?: string;
      attendedDates?: string[];
      isAttended?: boolean;
      isTodayAttended?: boolean;
      items?: DocpleAttendanceCalendarItem[];
      [key: string]: unknown;
    }>;
    const data = json?.data || {};

    const todayKst = getKstDateString();
    const attendedDates = Array.isArray(data.attendedDates) ? data.attendedDates : [];
    const attendedToday = attendedDates.includes(todayKst) || !!(data.isAttended || data.isTodayAttended);

    const items: DocpleAttendanceCalendarItem[] = attendedDates.map((dateStr) => ({
      date: dateStr,
      attended: true,
    }));

    return { attendedToday, items, raw: data };
  } catch (error) {
    logger.error('Docple getDocpleAttendanceCalendar error', error);
    return { attendedToday: false, items: [] };
  }
}

/**
 * 출석체크 실행
 */
export async function checkDocpleAttendance(accessToken: string): Promise<DocpleAttendanceResult> {
  try {
    const res = await request(`${DOCPLE_BASE_URL}/api/season2/mission/attendance/check`, {
      method: 'POST',
      headers: getCommonHeaders(accessToken),
      body: JSON.stringify({}),
    });

    const bodyText = await res.body.text();
    let json: DocpleApiResponse<{
      todayDone?: boolean;
      dailyGranted?: boolean;
      dailyCash?: number;
      rewardCash?: number;
      cash?: number;
      [key: string]: unknown;
    }>;
    try {
      json = JSON.parse(bodyText) as DocpleApiResponse<{
        todayDone?: boolean;
        dailyGranted?: boolean;
        dailyCash?: number;
        rewardCash?: number;
        cash?: number;
        [key: string]: unknown;
      }>;
    } catch {
      return {
        status: 'FAILED',
        message: `응답 파싱 실패 (HTTP ${res.statusCode})`,
      };
    }

    if (res.statusCode === 200 && json?.success) {
      const data = json.data;
      const rewardCash = data?.dailyCash ?? data?.rewardCash ?? data?.cash ?? 50;

      if (data?.dailyGranted === false && data?.todayDone === true) {
        return {
          status: 'ALREADY',
          message: '이미 오늘 출석을 완료했습니다.',
          rewardCash: 0,
          raw: json.data,
        };
      }

      return {
        status: 'SUCCESS',
        rewardCash,
        message: `출석체크 성공 (+${rewardCash} 캐시)`,
        raw: json.data,
      };
    }

    const msg = json?.message || '';
    if (msg.includes('이미') || msg.includes('완료') || String(json?.code) === 'ALREADY_ATTENDED') {
      return {
        status: 'ALREADY',
        message: msg || '이미 오늘 출석을 완료했습니다.',
        raw: json,
      };
    }

    return {
      status: 'FAILED',
      message: msg || `출석체크 실패 (HTTP ${res.statusCode})`,
      raw: json,
    };
  } catch (error) {
    logger.error('Docple checkDocpleAttendance error', error);
    return {
      status: 'FAILED',
      message: `출석체크 네트워크 오류: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * e-디테일링 의약품 및 퀴즈 목록 조회
 */
export async function getDocpleEdetailingMedicines(
  accessToken: string,
  options: { page?: number; size?: number } = {},
): Promise<DocpleEdetailingMedicine[]> {
  try {
    const page = options.page ?? 0;
    const size = options.size ?? 50;
    const res = await request(`${DOCPLE_BASE_URL}/api/season2/e-detailing/medicines?page=${page}&size=${size}`, {
      method: 'GET',
      headers: getCommonHeaders(accessToken),
    });

    if (res.statusCode !== 200) {
      return [];
    }

    const json = (await res.body.json()) as DocpleApiResponse<{
      content?: Record<string, unknown>[];
      items?: Record<string, unknown>[];
      list?: Record<string, unknown>[];
    }>;
    const rawItems = json?.data?.content || json?.data?.items || json?.data?.list || [];

    return rawItems.map((item: Record<string, unknown>) => {
      const id = (item.id ?? item.medicineId ?? item.idx) as string | number;
      const name = String(item.medicineName ?? item.name ?? item.title ?? `의약품 #${id}`);
      const hasActiveQuiz = !!(item.hasActiveQuiz || item.hasQuiz || item.isQuiz);
      return {
        id,
        name,
        companyName: (item.pharmaCompanyName ?? item.companyName ?? item.sellerCompanyName) as string | undefined,
        hasQuiz: hasActiveQuiz,
        hasActiveQuiz,
        quizStatus: item.quizStatus as string | undefined,
        quizUrl: `${DOCPLE_BASE_URL}/e-detailing/${id}`,
        thumbnailUrl: (item.imageUrl ?? item.thumbnailUrl) as string | undefined,
        ...item,
      };
    });
  } catch (error) {
    logger.error('Docple getDocpleEdetailingMedicines error', error);
    return [];
  }
}

/**
 * 퀴즈 대상 의약품의 URL 목록 추출
 */
export function extractDocpleQuizUrls(
  medicines: DocpleEdetailingMedicine[],
): Array<{ id: number | string; name: string; url: string }> {
  return medicines
    .filter((m) => m.hasActiveQuiz === true || m.hasQuiz === true)
    .map((m) => ({
      id: m.id,
      name: m.name,
      url: m.quizUrl,
    }));
}

/**
 * 커뮤니티 비밀번호 인증 및 커뮤니티 세션 토큰 발급
 */
export async function authDocpleCommunityPassword(
  accessToken: string,
  dmzPwd: string,
): Promise<DocpleCommunityAuthResult> {
  try {
    const res = await request(`${DOCPLE_BASE_URL}/api/auth/communityLogin`, {
      method: 'POST',
      headers: getCommonHeaders(accessToken),
      body: JSON.stringify({ pw: dmzPwd, ispc: 'P' }),
    });

    const bodyText = await res.body.text();
    let json: DocpleApiResponse<{ communityToken?: string }>;
    try {
      json = JSON.parse(bodyText) as DocpleApiResponse<{ communityToken?: string }>;
    } catch {
      return {
        success: false,
        message: `커뮤니티 인증 응답 파싱 실패 (HTTP ${res.statusCode})`,
      };
    }

    const tokenVal = json?.result?.communityToken || json?.data?.communityToken;

    if (res.statusCode === 200 && (String(json?.resultCode) === '0' || json?.success || tokenVal)) {
      return {
        success: true,
        communityToken: tokenVal,
        message: '커뮤니티 비밀번호 인증 성공',
      };
    }

    return {
      success: false,
      message: json?.resultMsg || json?.message || `커뮤니티 비밀번호 인증 실패 (HTTP ${res.statusCode})`,
    };
  } catch (error) {
    logger.error('Docple authDocpleCommunityPassword error', error);
    return {
      success: false,
      message: `커뮤니티 인증 오류: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 커뮤니티 게시글 목록 조회
 */
export async function getDocpleCommunityPosts(
  accessToken: string,
  options: { grpCode?: string; subCode?: string; page?: number; size?: number; communityToken?: string } = {},
): Promise<DocpleCommunityPost[]> {
  try {
    const grpCode = options.grpCode ?? 'NI';
    const subCode = options.subCode ?? '';
    const page = options.page ?? 1;
    const size = options.size ?? 25;

    const res = await request(`${DOCPLE_BASE_URL}/api/community/list`, {
      method: 'POST',
      headers: getCommonHeaders(accessToken, options.communityToken),
      body: JSON.stringify({ grpCode, subCode, page, size }),
    });

    if (res.statusCode !== 200) {
      return [];
    }

    const json = (await res.body.json()) as DocpleApiResponse<{
      communityList?: Record<string, unknown>[];
      list?: Record<string, unknown>[];
    }>;
    const list = json?.result?.communityList || json?.data?.list || json?.result?.list || [];

    return list.map((item: Record<string, unknown>) => {
      const bid = Number(item.bid ?? item.id ?? item.boardId);
      const no = Number(item.no ?? item.idx ?? bid);
      const title = String(item.title ?? item.subject ?? '');
      const itemSubCode = String(item.subCode ?? subCode);
      const isNotice = !!(item.noticeYN === 'Y' || title.includes('[공지]'));
      const isEvent = !!(item.noticeYN === 'E' || title.includes('[이벤트]'));
      const isSOS = !!(item.noticeYN === 'P' || item.isSOS || title.includes('[SOS]'));
      const isDeleted = !!(item.useYN === 'N' || item.isDeleted || item.delYn === 'Y');
      const isRecommended = !!(item.reCom === 'R' || item.myRecommendYn === 'Y');

      return {
        tid: bid,
        bid,
        no,
        title,
        grpCode: (item.grpCode as string) ?? grpCode,
        subCode: itemSubCode,
        subCodeName: item.subCodeName as string | undefined,
        nickname: item.nickname as string | undefined,
        isNotice,
        isEvent,
        isSOS,
        isDeleted,
        isRecommended,
        recommendCnt: Number(item.rCnt ?? item.recommendCnt ?? 0),
        commentCnt: Number(item.replyCnt ?? item.commentCnt ?? 0),
        viewCnt: Number(item.nCnt ?? item.viewCnt ?? 0),
        createdDt: (item.insertDt ?? item.createdDt) as string | undefined,
        ...item,
      };
    });
  } catch (error) {
    logger.error('Docple getDocpleCommunityPosts error', error);
    return [];
  }
}

/**
 * 커뮤니티 게시글 추천
 */
export async function recommendDocpleCommunityPost(
  accessToken: string,
  params: {
    bid: number | string;
    no?: number | string;
    grpCode?: string;
    subCode?: string;
    communityToken?: string;
  },
): Promise<DocpleRecommendResult> {
  try {
    const { bid, no, grpCode = 'NI', communityToken } = params;
    const res = await request(`${DOCPLE_BASE_URL}/api/board/recommend`, {
      method: 'POST',
      headers: getCommonHeaders(accessToken, communityToken),
      body: JSON.stringify({
        kind: 'W',
        bid: String(bid),
        yesNo: 'Y',
        grpCode: grpCode || 'NI',
        ispc: 'P',
        no: no !== undefined ? no : Number(bid),
      }),
    });

    const bodyText = await res.body.text();
    let json: DocpleApiResponse<{
      cashGrantInfo?: { rewarded?: boolean; cashAmount?: number; message?: string };
      resultData?: string;
    }>;
    try {
      json = JSON.parse(bodyText) as DocpleApiResponse<{
        cashGrantInfo?: { rewarded?: boolean; cashAmount?: number; message?: string };
        resultData?: string;
      }>;
    } catch {
      return {
        success: false,
        bid,
        message: `추천 응답 파싱 실패 (HTTP ${res.statusCode})`,
      };
    }

    if (res.statusCode === 200 && (String(json?.resultCode) === '0' || json?.success)) {
      const rewardCash = json?.result?.cashGrantInfo?.cashAmount ?? 0;
      return {
        success: true,
        bid,
        no: Number(no ?? bid),
        rewardCash,
        message: rewardCash > 0 ? `게시글 추천 성공 (+${rewardCash} 캐시)` : '게시글 추천 성공',
      };
    }

    return {
      success: false,
      bid,
      no: Number(no ?? bid),
      message: json?.resultMsg || json?.message || `게시글 추천 실패 (HTTP ${res.statusCode})`,
    };
  } catch (error) {
    logger.error('Docple recommendDocpleCommunityPost error', error);
    return {
      success: false,
      bid: params.bid,
      message: `추천 오류: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 활성 e-디테일링 퀴즈 목록 조회
 */
export async function getDocpleActiveQuizzes(accessToken: string): Promise<DocpleActiveQuiz[]> {
  try {
    const res = await request(`${DOCPLE_BASE_URL}/api/season2/e-detailing/quiz`, {
      method: 'GET',
      headers: getCommonHeaders(accessToken),
    });

    if (res.statusCode !== 200) {
      return [];
    }

    const json = (await res.body.json()) as DocpleApiResponse<{
      quizzes?: DocpleActiveQuiz[];
      list?: DocpleActiveQuiz[];
    }>;
    return json?.data?.quizzes || json?.data?.list || [];
  } catch (error) {
    logger.error('Docple getDocpleActiveQuizzes error', error);
    return [];
  }
}

/**
 * e-디테일링 퀴즈 상세(문제, 보기 등) 조회
 */
export async function getDocpleQuizDetail(
  accessToken: string,
  quizId: number | string,
): Promise<DocpleQuizDetail | null> {
  try {
    const res = await request(`${DOCPLE_BASE_URL}/api/season2/e-detailing/quiz/${quizId}`, {
      method: 'GET',
      headers: getCommonHeaders(accessToken),
    });

    if (res.statusCode !== 200) {
      return null;
    }

    const json = (await res.body.json()) as DocpleApiResponse<DocpleQuizDetail>;
    return json?.data || null;
  } catch (error) {
    logger.error('Docple getDocpleQuizDetail error', error);
    return null;
  }
}

/**
 * e-디테일링 의약품 상세 정보 조회
 */
export async function getDocpleMedicineDetail(
  accessToken: string,
  medicineId: number | string,
): Promise<DocpleMedicineDetail | null> {
  try {
    const res = await request(`${DOCPLE_BASE_URL}/api/season2/e-detailing/medicines/${medicineId}`, {
      method: 'GET',
      headers: getCommonHeaders(accessToken),
    });

    if (res.statusCode !== 200) {
      return null;
    }

    const json = (await res.body.json()) as DocpleApiResponse<DocpleMedicineDetail>;
    return json?.data || null;
  } catch (error) {
    logger.error('Docple getDocpleMedicineDetail error', error);
    return null;
  }
}

export interface DocpleQuizSubmitResult {
  success: boolean;
  isPassed: boolean;
  isCashGranted: boolean;
  grantedCash?: number;
  remainingAttempts?: number;
  message: string;
  raw?: unknown;
}

/**
 * e-디테일링 퀴즈 정답 제출
 */
export async function submitDocpleQuiz(
  accessToken: string,
  quizId: number | string,
  answers: Array<{ questionId: number; selectedOptionId: number }>,
): Promise<DocpleQuizSubmitResult> {
  try {
    const res = await request(`${DOCPLE_BASE_URL}/api/season2/e-detailing/quiz/${quizId}/submit`, {
      method: 'POST',
      headers: getCommonHeaders(accessToken),
      body: JSON.stringify({ answers }),
    });

    const bodyText = await res.body.text();
    let json: DocpleApiResponse<{
      isPassed?: boolean;
      isCashGranted?: boolean;
      grantedCash?: number;
      remainingAttempts?: number;
      [key: string]: unknown;
    }>;
    try {
      json = JSON.parse(bodyText) as DocpleApiResponse<{
        isPassed?: boolean;
        isCashGranted?: boolean;
        grantedCash?: number;
        remainingAttempts?: number;
        [key: string]: unknown;
      }>;
    } catch {
      return {
        success: false,
        isPassed: false,
        isCashGranted: false,
        message: `응답 파싱 실패 (HTTP ${res.statusCode})`,
      };
    }

    if (res.statusCode === 200 && json?.success && json.data) {
      const data = json.data;
      const isPassed = !!data.isPassed;
      const isCashGranted = !!data.isCashGranted;
      const grantedCash = data.grantedCash ?? 0;
      const remainingAttempts = data.remainingAttempts ?? 0;

      let msg = isPassed ? '퀴즈 정답입니다!' : '오답입니다.';
      if (isCashGranted && grantedCash > 0) {
        msg += ` (+${grantedCash.toLocaleString()} 캐시 획득)`;
      }

      return {
        success: true,
        isPassed,
        isCashGranted,
        grantedCash,
        remainingAttempts,
        message: msg,
        raw: data,
      };
    }

    return {
      success: false,
      isPassed: false,
      isCashGranted: false,
      message: json?.message || `퀴즈 제출 실패 (HTTP ${res.statusCode})`,
      raw: json,
    };
  } catch (error) {
    logger.error('Docple submitDocpleQuiz error', error);
    return {
      success: false,
      isPassed: false,
      isCashGranted: false,
      message: `퀴즈 제출 오류: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * 세미나 퀴즈 정답 족보와 닥플 e-디테일링 퀴즈 문항 매칭
 */
export function matchDocpleQuizAnswersWithCheatsheet(
  quizDetail: DocpleQuizDetail,
  cheatsheet: Record<string, string>,
): {
  isFullyMatched: boolean;
  answers: Array<{ questionId: number; selectedOptionId: number; optionText: string; questionText: string }>;
  unmatchedQuestions: string[];
} {
  const answers: Array<{
    questionId: number;
    selectedOptionId: number;
    optionText: string;
    questionText: string;
  }> = [];
  const unmatchedQuestions: string[] = [];

  const cheatsheetEntries = Object.entries(cheatsheet);

  for (const q of quizDetail.questions) {
    const qText = q.questionText.trim();
    // 1. 문제 키워드 일치 검색
    let matchedAnswerText: string | undefined;

    // A. 질문에 족보 키워드가 포함되어 있거나 족보 키워드에 질문이 포함된 경우
    for (const [key, answer] of cheatsheetEntries) {
      const normKey = key.trim();
      if (!normKey) continue;
      if (qText.includes(normKey) || normKey.includes(qText.slice(0, 30))) {
        matchedAnswerText = String(answer).trim();
        break;
      }
    }

    if (!matchedAnswerText) {
      unmatchedQuestions.push(qText);
      continue;
    }

    // 2. 매칭된 정답 텍스트가 보기(options) 중 어디에 해당하는지 검색
    const targetOption = q.options.find((opt) => {
      const optText = opt.optionText.trim();
      return (
        optText === matchedAnswerText || optText.includes(matchedAnswerText!) || matchedAnswerText!.includes(optText)
      );
    });

    if (targetOption) {
      answers.push({
        questionId: q.questionId,
        selectedOptionId: targetOption.optionId,
        optionText: targetOption.optionText,
        questionText: q.questionText,
      });
    } else {
      unmatchedQuestions.push(qText);
    }
  }

  return {
    isFullyMatched: unmatchedQuestions.length === 0 && answers.length === quizDetail.questions.length,
    answers,
    unmatchedQuestions,
  };
}

/**
 * e-디테일링 퀴즈 상세 안내 메시지(문제, 보기, 상세정보) 포맷팅
 */
export function formatDocpleQuizTelegramMessage(params: {
  quiz: DocpleQuizDetail | DocpleActiveQuiz;
  medicine?: DocpleMedicineDetail | null;
  medicineId?: number | string;
}): string {
  const { quiz, medicine, medicineId } = params;
  const medId = medicineId || (quiz as DocpleActiveQuiz).medicineId || medicine?.id || '';
  const quizDetail = 'questions' in quiz ? (quiz as DocpleQuizDetail) : null;
  const activeQuiz = quiz as DocpleActiveQuiz;

  const rewardCash = quizDetail?.rewardCash ?? activeQuiz.rewardCash ?? 100;
  const pharma = [medicine?.pharmaCompanyName, medicine?.sellerCompanyName].filter(Boolean).join(' / ');

  const lines: string[] = [
    '💊 [닥플 e-디테일링 Quiz 안내]',
    `📌 퀴즈명: ${quiz.quizName}`,
    `💰 보상: +${rewardCash.toLocaleString()} 캐시`,
  ];

  if (quizDetail) {
    lines.push(
      `🎯 남은 도전 기회: ${quizDetail.remainingAttempts ?? quizDetail.maxDailyAttempts ?? 3}회 (최대 ${quizDetail.maxDailyAttempts ?? 3}회)`,
    );
  }
  if (medId) {
    lines.push(`🔗 바로가기: ${DOCPLE_BASE_URL}/e-detailing/${medId}`);
  }

  // 의약품 상세 정보
  if (medicine) {
    lines.push('\n📋 [의약품 상세 정보]');
    lines.push(`• 의약품명: ${medicine.medicineName}${pharma ? ` (${pharma})` : ''}`);
    if (medicine.mainIngredient) {
      lines.push(`• 주요 성분: ${medicine.mainIngredient}`);
    }
    const categories = [medicine.therapeuticCategory, medicine.diseaseCategoryName].filter(Boolean).join(' / ');
    if (categories) {
      lines.push(`• 효능/분류: ${categories}`);
    }
  }

  // 문제 및 보기 목록
  if (quizDetail && quizDetail.questions && quizDetail.questions.length > 0) {
    lines.push('\n📝 [문제 및 보기]');
    const numIcons = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣'];
    quizDetail.questions.forEach((q, qIdx) => {
      lines.push(`\n❓ [Q${qIdx + 1}] ${q.questionText}`);
      if (q.options && q.options.length > 0) {
        q.options.forEach((opt, oIdx) => {
          const icon = numIcons[oIdx] || `(${oIdx + 1})`;
          lines.push(`  ${icon} ${opt.optionText}`);
        });
      }
    });

    lines.push(
      '\n💡 이 메시지에 답장(Reply)으로 정답 번호(예: 1 2 또는 1,2)를 보내시면 족보 등록과 함께 자동 제출이 수행됩니다.',
    );
  }

  return lines.join('\n');
}
