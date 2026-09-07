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
  [key: string]: unknown;
}

export interface DocpleCashInfo {
  totalCash?: number;
  recentList?: Array<{
    id?: number;
    cash?: number;
    title?: string;
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
  quizStatus?: string;
  quizUrl: string;
  thumbnailUrl?: string;
  [key: string]: unknown;
}

export interface DocpleCommunityAuthResult {
  success: boolean;
  communityToken?: string;
  message: string;
}

export interface DocpleCommunityPost {
  tid: number;
  title: string;
  grpCode: string;
  subCode: string;
  subCodeName?: string;
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
  tid?: number;
}

interface DocpleApiResponse<T = unknown> {
  success?: boolean;
  code?: string | number;
  message?: string;
  data?: T;
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
 */
export async function getDocpleCash(accessToken: string): Promise<DocpleCashInfo | null> {
  try {
    const res = await request(`${DOCPLE_BASE_URL}/api/season2/cash/recent`, {
      method: 'GET',
      headers: getCommonHeaders(accessToken),
    });

    if (res.statusCode !== 200) {
      return null;
    }

    const json = (await res.body.json()) as DocpleApiResponse<{
      totalCash?: number;
      cash?: number;
      recentList?: DocpleCashInfo['recentList'];
      list?: DocpleCashInfo['recentList'];
      [key: string]: unknown;
    }>;
    const data = json?.data;
    if (!data) return null;

    return {
      totalCash: typeof data.totalCash === 'number' ? data.totalCash : (data.cash ?? 0),
      recentList: Array.isArray(data.recentList) ? data.recentList : data.list || [],
      ...data,
    };
  } catch (error) {
    logger.error('Docple getDocpleCash error', error);
    return null;
  }
}

/**
 * 출석 캘린더 조회
 */
export async function getDocpleAttendanceCalendar(
  accessToken: string,
  month?: string,
): Promise<{ attendedToday: boolean; items: DocpleAttendanceCalendarItem[] }> {
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
      isAttended?: boolean;
      isTodayAttended?: boolean;
      todayAttended?: boolean;
      items?: DocpleAttendanceCalendarItem[];
      calendar?: DocpleAttendanceCalendarItem[];
    }>;
    const data = json?.data || {};
    const attendedToday = !!(data.isAttended || data.isTodayAttended || data.todayAttended);
    const items = Array.isArray(data.items) ? data.items : Array.isArray(data.calendar) ? data.calendar : [];

    return { attendedToday, items };
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
      rewardCash?: number;
      cash?: number;
      rewardPoint?: number;
      [key: string]: unknown;
    }>;
    try {
      json = JSON.parse(bodyText) as DocpleApiResponse<{
        rewardCash?: number;
        cash?: number;
        rewardPoint?: number;
        [key: string]: unknown;
      }>;
    } catch {
      return {
        status: 'FAILED',
        message: `응답 파싱 실패 (HTTP ${res.statusCode})`,
      };
    }

    if (res.statusCode === 200 && json?.success) {
      const rewardCash = json.data?.rewardCash ?? json.data?.cash ?? json.data?.rewardPoint ?? 0;
      return {
        status: 'SUCCESS',
        rewardCash,
        message: `출석체크 성공 (+${rewardCash} 캐시)`,
        raw: json.data,
      };
    }

    // 이미 출석한 경우 판별
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
    const page = options.page ?? 1;
    const size = options.size ?? 50;
    const res = await request(`${DOCPLE_BASE_URL}/api/season2/e-detailing/medicines?page=${page}&size=${size}`, {
      method: 'GET',
      headers: getCommonHeaders(accessToken),
    });

    if (res.statusCode !== 200) {
      return [];
    }

    const json = (await res.body.json()) as DocpleApiResponse<{
      items?: Record<string, unknown>[];
      list?: Record<string, unknown>[];
    }>;
    const rawItems = json?.data?.items || json?.data?.list || (Array.isArray(json?.data) ? json.data : []);

    return rawItems.map((item: Record<string, unknown>) => {
      const id = (item.id ?? item.medicineId ?? item.idx) as string | number;
      const name = String(item.name ?? item.title ?? item.medicineName ?? `의약품 #${id}`);
      const hasQuiz = (item.hasQuiz ?? item.isQuiz ?? item.quizExist ?? true) as boolean;
      return {
        id,
        name,
        companyName: (item.companyName ?? item.pharmaName) as string | undefined,
        hasQuiz,
        quizStatus: item.quizStatus as string | undefined,
        quizUrl: `${DOCPLE_BASE_URL}/e-detailing/${id}`,
        thumbnailUrl: (item.thumbnailUrl ?? item.imageUrl) as string | undefined,
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
    .filter((m) => m.hasQuiz !== false)
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
    const res = await request(`${DOCPLE_BASE_URL}/api/v3/member/community/pwd`, {
      method: 'POST',
      headers: getCommonHeaders(accessToken),
      body: JSON.stringify({ dmzPwd }),
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

    const tokenVal = json?.data?.communityToken || (typeof json?.data === 'string' ? json.data : undefined);

    if (res.statusCode === 200 && (json?.success || tokenVal)) {
      return {
        success: true,
        communityToken: tokenVal,
        message: '커뮤니티 비밀번호 인증 성공',
      };
    }

    return {
      success: false,
      message: json?.message || `커뮤니티 비밀번호 인증 실패 (HTTP ${res.statusCode})`,
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
    const size = options.size ?? 20;

    const res = await request(`${DOCPLE_BASE_URL}/api/community/list`, {
      method: 'POST',
      headers: getCommonHeaders(accessToken, options.communityToken),
      body: JSON.stringify({ grpCode, subCode, page, size }),
    });

    if (res.statusCode !== 200) {
      return [];
    }

    const json = (await res.body.json()) as DocpleApiResponse<{
      list?: Record<string, unknown>[];
      items?: Record<string, unknown>[];
    }>;
    const list = json?.data?.list || json?.data?.items || (Array.isArray(json?.data) ? json.data : []);

    return list.map((item: Record<string, unknown>) => {
      const tid = Number(item.tid ?? item.id ?? item.boardId);
      const title = String(item.title ?? item.subject ?? '');
      const itemSubCode = String(item.subCode ?? subCode);
      const isNotice = !!(item.isNotice || item.noticeYn === 'Y' || title.includes('[공지]'));
      const isEvent = !!(item.isEvent || item.eventYn === 'Y' || title.includes('[이벤트]'));
      const isSOS = !!(item.isSOS || item.sosYn === 'Y' || title.includes('[SOS]'));
      const isDeleted = !!(item.isDeleted || item.delYn === 'Y' || item.status === 'DELETED');
      const isRecommended = !!(item.isRecommended || item.myRecommendYn === 'Y');

      return {
        tid,
        title,
        grpCode: (item.grpCode as string) ?? grpCode,
        subCode: itemSubCode,
        subCodeName: item.subCodeName as string | undefined,
        isNotice,
        isEvent,
        isSOS,
        isDeleted,
        isRecommended,
        recommendCnt: Number(item.recommendCnt ?? item.likeCount ?? 0),
        commentCnt: Number(item.commentCnt ?? item.commentCount ?? 0),
        viewCnt: Number(item.viewCnt ?? item.readCount ?? 0),
        createdDt: (item.createdDt ?? item.regDt ?? item.createdAt) as string | undefined,
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
  tid: number,
  grpCode: string = 'NI',
  subCode: string = '',
  communityToken?: string,
): Promise<DocpleRecommendResult> {
  try {
    const res = await request(`${DOCPLE_BASE_URL}/api/board/recommend`, {
      method: 'POST',
      headers: getCommonHeaders(accessToken, communityToken),
      body: JSON.stringify({ tid, grpCode, subCode }),
    });

    const bodyText = await res.body.text();
    let json: DocpleApiResponse;
    try {
      json = JSON.parse(bodyText) as DocpleApiResponse;
    } catch {
      return {
        success: false,
        tid,
        message: `추천 응답 파싱 실패 (HTTP ${res.statusCode})`,
      };
    }

    if (res.statusCode === 200 && (json?.success || json?.code === 200 || json?.data)) {
      return {
        success: true,
        tid,
        message: '게시글 추천 성공',
      };
    }

    return {
      success: false,
      tid,
      message: json?.message || `게시글 추천 실패 (HTTP ${res.statusCode})`,
    };
  } catch (error) {
    logger.error('Docple recommendDocpleCommunityPost error', error);
    return {
      success: false,
      tid,
      message: `추천 오류: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
