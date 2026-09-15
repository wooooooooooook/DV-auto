import { request } from 'undici';
import * as logger from '../services/logger';

export const MEDIGATE_BASE_URL = 'https://apis.medigate.net';
export const MEDIGATE_WEB_URL = 'https://new.medigate.net';

export interface MedigateUser {
  uId?: string;
  uName?: string;
  uKind?: string;
  uSpcCode?: string;
  uWtpCode?: string;
  uHtpCode?: string;
  uLocCode?: string;
  [key: string]: unknown;
}

export interface MedigateAuthTokens {
  accessToken: string;
  refreshToken?: string;
  user?: MedigateUser;
  pkg?: string;
  isTestUser?: string;
}

export interface MedigateLoginResult {
  success: boolean;
  code?: number;
  message: string;
  tokens?: MedigateAuthTokens;
}

export interface MedigateSymposiumItem {
  webinarIdx: number;
  webinarType?: string;
  subject: string;
  instructorSummary?: string;
  clientName?: string;
  logoDesc?: string;
  titleImg?: string;
  titleImg2?: string;
  bgColor?: string;
  startDate?: string;
  endDate?: string;
  regDate?: string;
  yoil?: string;
  dateDesc?: string;
  status: string; // 'APPLY', 'ING', 'CLOSED', etc.
  mainOrder?: string;
  applyFlag: string; // 'Y' or 'N'
  applyCnt?: number;
  diseaseCode?: string;
  diseaseCodeName?: string;
  brandNames?: string;
  [key: string]: unknown;
}

export interface MedigateAgreementItem {
  idx: number;
  title: string;
  content: string;
  sort?: number;
}

export interface MedigateSymposiumDetail {
  webinar: MedigateSymposiumItem & {
    timeline?: string;
    guide?: string;
  };
  applyInfo: {
    applyFlag: string; // 'Y' | 'N'
    pollAnsweredFlag?: string; // 'Y' | 'N'
    [key: string]: unknown;
  };
  agreements: {
    required: MedigateAgreementItem[];
    optional: MedigateAgreementItem[];
  };
  instructors?: Array<{
    instructorIdx: number;
    instructorName: string;
    instructorCompany?: string;
    instructorProfile?: string;
    [key: string]: unknown;
  }>;
  polls?: Array<{
    pollIdx: number;
    title: string;
    maxAns: number;
    questions: Array<{ qstNo: number; question: string }>;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface MedigateApplyItemResult {
  webinarIdx: number;
  subject: string;
  success: boolean;
  alreadyApplied: boolean;
  message: string;
  dateDesc?: string;
  completeType?: string;
}

export interface MedigatePointSummary {
  usablePoint: number;
  usableMgPoint: number;
  usableResearchPoint: number;
  expiringPoint: number;
  expiringStartYear?: string;
  expiringEndYear?: string;
  expiringBaseYear?: string;
  [key: string]: unknown;
}

export interface MedigatePointHistoryItem {
  grantDate?: string;
  useDate?: string;
  title?: string;
  point?: number;
  category?: string;
  [key: string]: unknown;
}

export interface MedigatePointHistoryResult {
  totalItems: number;
  totalPages: number;
  items: MedigatePointHistoryItem[];
  [key: string]: unknown;
}

export interface MedigatePointFlowChartItem {
  yyyymm: string;
  grantPoint: number;
  usedPoint: number;
}

export interface MedigateLiveSession {
  webinarIdx: number;
  subject?: string;
  watchUrl: string;
  platform: 'nownnow' | 'custom' | 'unknown';
  cookieHeader?: string;
  roomUrl?: string;
  heartbeatUrl?: string;
  heartbeatParams?: Record<string, string>;
  surveyUrl?: string;
}

export interface MedigateHeartbeatResult {
  success: boolean;
  status?: number;
  body?: string;
  surveyTriggered?: boolean;
  surveyUrl?: string;
  message?: string;
}

export interface MedigateWatchResult {
  webinarIdx: number;
  subject: string;
  success: boolean;
  message: string;
  startedAt: string;
  endedAt: string;
  durationMinutes: number;
  heartbeatCount: number;
  surveyUrl?: string;
  platform: string;
}

export interface MedigateWatchWorkflowResult {
  success: boolean;
  message: string;
  userName?: string;
  userId?: string;
  totalOnAir: number;
  watchedCount: number;
  failedCount: number;
  results: MedigateWatchResult[];
}

export interface MedigateApplyWorkflowResult {
  success: boolean;
  message: string;
  userName?: string;
  userId?: string;
  totalFound: number;
  targetCount: number;
  appliedCount: number;
  alreadyCount: number;
  failedCount: number;
  pointSummary?: MedigatePointSummary | null;
  results: MedigateApplyItemResult[];
  todaySymposiums?: MedigateSymposiumItem[];
}

export class MedigateClient {
  private accessToken: string | null = null;
  private refreshTokenVal: string | null = null;
  private currentUser: MedigateUser | null = null;
  private userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  constructor(tokens?: { accessToken: string; refreshToken?: string; user?: MedigateUser }) {
    if (tokens?.accessToken) {
      this.accessToken = tokens.accessToken;
      this.refreshTokenVal = tokens.refreshToken || null;
      this.currentUser = tokens.user || null;
    }
  }

  public getAccessToken(): string | null {
    return this.accessToken;
  }

  public getCurrentUser(): MedigateUser | null {
    return this.currentUser;
  }

  /**
   * 메디게이트 로그인 처리
   */
  async login(username?: string, password?: string): Promise<MedigateLoginResult> {
    const id = username || process.env.MEDIGATE_USER;
    const pw = password || process.env.MEDIGATE_PASS;

    if (!id || !pw) {
      return {
        success: false,
        message: 'MEDIGATE_USER 또는 MEDIGATE_PASS 환경변수가 설정되지 않았습니다.',
      };
    }

    try {
      const body = new URLSearchParams({ username: id, password: pw }).toString();

      const res = await request(`${MEDIGATE_BASE_URL}/signin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Origin: MEDIGATE_WEB_URL,
          Referer: `${MEDIGATE_WEB_URL}/auth/login`,
          'User-Agent': this.userAgent,
        },
        body,
      });

      if (res.statusCode !== 200) {
        const errorText = await res.body.text();
        return {
          success: false,
          code: res.statusCode,
          message: `로그인 HTTP 실패 (Status: ${res.statusCode}): ${errorText.substring(0, 100)}`,
        };
      }

      const data = (await res.body.json()) as {
        accessToken?: string;
        refreshToken?: string;
        user?: MedigateUser;
        pkg?: string;
        isTestUser?: string;
        message?: string;
        error?: string;
      };

      if (!data.accessToken) {
        return {
          success: false,
          message: data.message || data.error || '로그인 응답에 accessToken이 없습니다.',
        };
      }

      this.accessToken = data.accessToken;
      this.refreshTokenVal = data.refreshToken || null;
      this.currentUser = data.user || null;

      logger.info(
        `[Medigate] 로그인 성공: ID=${this.currentUser?.uId || id}, 이름=${this.currentUser?.uName || '회원'}`,
      );

      return {
        success: true,
        code: 200,
        message: '로그인 성공',
        tokens: {
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          user: data.user,
          pkg: data.pkg,
          isTestUser: data.isTestUser,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[Medigate] 로그인 예외 발생:', err);
      return {
        success: false,
        message: `로그인 중 오류 발생: ${msg}`,
      };
    }
  }

  /**
   * 토큰 갱신
   */
  async refreshToken(): Promise<boolean> {
    if (!this.refreshTokenVal) return false;

    try {
      const res = await request(`${MEDIGATE_BASE_URL}/token/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: MEDIGATE_WEB_URL,
          'User-Agent': this.userAgent,
        },
        body: JSON.stringify({ refreshToken: this.refreshTokenVal }),
      });

      if (res.statusCode !== 200) return false;

      const data = (await res.body.json()) as { accessToken?: string };
      if (data.accessToken) {
        this.accessToken = data.accessToken;
        return true;
      }
      return false;
    } catch (e) {
      logger.warn('[Medigate] 토큰 갱신 실패:', e);
      return false;
    }
  }

  /**
   * 인증된 API 요청 헬퍼 (401 시 자동 토큰 리프레시 후 1회 재시도)
   */
  private async authenticatedRequest<T>(
    endpoint: string,
    options: {
      method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
      body?: string;
      searchParams?: Record<string, string | number | undefined>;
    } = {},
  ): Promise<{ status: number; data?: T; error?: string }> {
    if (!this.accessToken) {
      const loginRes = await this.login();
      if (!loginRes.success || !this.accessToken) {
        return { status: 401, error: loginRes.message };
      }
    }

    const makeCall = async (token: string) => {
      let url = `${MEDIGATE_BASE_URL}/${endpoint.replace(/^\//, '')}`;
      if (options.searchParams) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(options.searchParams)) {
          if (v !== undefined && v !== null) params.append(k, String(v));
        }
        const qs = params.toString();
        if (qs) url += (url.includes('?') ? '&' : '?') + qs;
      }

      return await request(url, {
        method: options.method || 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Origin: MEDIGATE_WEB_URL,
          Referer: `${MEDIGATE_WEB_URL}/symposium`,
          'User-Agent': this.userAgent,
        },
        body: options.body,
      });
    };

    let res = await makeCall(this.accessToken);

    if (res.statusCode === 401) {
      logger.info('[Medigate] 401 응답 수신, 토큰 갱신 시도...');
      const refreshed = await this.refreshToken();
      if (refreshed && this.accessToken) {
        res = await makeCall(this.accessToken);
      } else {
        const relogin = await this.login();
        if (relogin.success && this.accessToken) {
          res = await makeCall(this.accessToken);
        }
      }
    }

    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        const data = (await res.body.json()) as T;
        return { status: res.statusCode, data };
      } catch (err) {
        return { status: res.statusCode, error: `JSON 파싱 실패: ${String(err)}` };
      }
    }

    const errText = await res.body.text();
    return { status: res.statusCode, error: errText.substring(0, 200) };
  }

  /**
   * 심포지움 메인 전체 목록 조회
   */
  async getSymposiumList(diseaseCodes?: string): Promise<MedigateSymposiumItem[]> {
    const res = await this.authenticatedRequest<{
      code: number;
      message: string;
      data?: { items?: MedigateSymposiumItem[] };
    }>('w/symposium/main/list', {
      method: 'GET',
      searchParams: diseaseCodes ? { diseaseCodes } : undefined,
    });

    if (res.data?.data?.items && Array.isArray(res.data.data.items)) {
      return res.data.data.items;
    }
    return [];
  }

  /**
   * 심포지움 상세 정보 조회
   */
  async getSymposiumDetail(webinarIdx: number): Promise<MedigateSymposiumDetail | null> {
    const res = await this.authenticatedRequest<{
      code: number;
      message: string;
      data?: MedigateSymposiumDetail;
    }>(`w/symposium/${webinarIdx}`, {
      method: 'GET',
    });

    if (res.data?.data?.webinar) {
      return res.data.data;
    }
    return null;
  }

  /**
   * 단일 심포지움 신청
   */
  async applySymposium(
    webinarIdx: number,
    agreementsPayload?: Array<{ agreeIdx: number; agreeFlag: string }>,
  ): Promise<MedigateApplyItemResult> {
    // 약관 페이로드가 없으면 상세 조회를 통해 약관 목록을 채움
    let agreements = agreementsPayload;
    let subject = `심포지움 #${webinarIdx}`;
    let dateDesc = '';

    const detail = await this.getSymposiumDetail(webinarIdx);
    if (detail) {
      subject = detail.webinar.subject || subject;
      dateDesc = detail.webinar.dateDesc || '';

      if (detail.applyInfo?.applyFlag === 'Y') {
        return {
          webinarIdx,
          subject,
          dateDesc,
          success: true,
          alreadyApplied: true,
          message: '이미 신청 완료된 심포지움입니다.',
        };
      }

      if (!agreements) {
        const requiredList = detail.agreements?.required || [];
        const optionalList = detail.agreements?.optional || [];
        const allAgreements = [...requiredList, ...optionalList];

        agreements = allAgreements.map((a) => ({
          agreeIdx: a.idx,
          agreeFlag: 'Y',
        }));
      }
    }

    if (!agreements || agreements.length === 0) {
      // 약관이 명시되지 않은 경우 빈 배열 전달
      agreements = [];
    }

    const res = await this.authenticatedRequest<{
      code: number;
      message: string;
      data?: { completeType?: string; [key: string]: unknown };
    }>(`w/symposium/${webinarIdx}/apply`, {
      method: 'POST',
      body: JSON.stringify({ agreements }),
    });

    if (res.status === 200 && res.data && res.data.code === 200) {
      return {
        webinarIdx,
        subject,
        dateDesc,
        success: true,
        alreadyApplied: false,
        completeType: res.data.data?.completeType,
        message: '신청이 성공적으로 완료되었습니다.',
      };
    }

    return {
      webinarIdx,
      subject,
      dateDesc,
      success: false,
      alreadyApplied: false,
      message: res.error || res.data?.message || '신청 실패',
    };
  }

  /**
   * 라이브 심포지움 시청 URL 획득 (방송 진행 중 상태일 때 발급 가능)
   */
  async getSymposiumWatchUrl(
    webinarIdx: number,
  ): Promise<{ success: boolean; watchUrl?: string; message?: string; status?: number }> {
    const res = await this.authenticatedRequest<{
      code: number;
      message: string;
      data?: { watchUrl?: string };
    }>(`w/symposium/${webinarIdx}/watch-url`, {
      method: 'GET',
    });

    if (res.status === 200 && res.data?.data?.watchUrl) {
      return {
        success: true,
        watchUrl: res.data.data.watchUrl,
        message: '시청 URL 획득 성공',
        status: 200,
      };
    }

    return {
      success: false,
      message: res.error || res.data?.message || '시청 URL 획득 실패 (방송 시작 전이거나 신청되지 않음)',
      status: res.status,
    };
  }

  /**
   * 라이브 심포지움 시청 이력 기록
   */
  async recordSymposiumView(webinarIdx: number): Promise<boolean> {
    const res = await this.authenticatedRequest<{ code: number }>(`w/symposium/${webinarIdx}/view`, {
      method: 'POST',
    });
    return res.status === 200;
  }

  /**
   * VOD 심포지움 상세 및 비디오 URL 조회
   */
  async getVodDetail(webinarIdx: number): Promise<{ success: boolean; vodUrl?: string; data?: unknown }> {
    const res = await this.authenticatedRequest<{
      code: number;
      data?: { webinar?: { vodUrl?: string; [key: string]: unknown }; [key: string]: unknown };
    }>(`w/symposium/me/vods/${webinarIdx}`, {
      method: 'GET',
    });

    if (res.status === 200 && res.data?.data?.webinar?.vodUrl) {
      return {
        success: true,
        vodUrl: res.data.data.webinar.vodUrl,
        data: res.data.data,
      };
    }

    return {
      success: false,
      data: res.data,
    };
  }

  /**
   * VOD 심포지움 시청 이력 기록
   */
  async recordVodView(webinarIdx: number): Promise<boolean> {
    const res = await this.authenticatedRequest<{ code: number }>(`w/symposium/${webinarIdx}/vod/view`, {
      method: 'POST',
    });
    return res.status === 200;
  }

  /**
   * 신청 가능한 모든 심포지움 일괄 자동 신청 워크플로우
   */
  async applyAllAvailableSymposiums(): Promise<MedigateApplyWorkflowResult> {
    const loginRes = await this.login();
    if (!loginRes.success) {
      return {
        success: false,
        message: loginRes.message,
        totalFound: 0,
        targetCount: 0,
        appliedCount: 0,
        alreadyCount: 0,
        failedCount: 0,
        results: [],
      };
    }

    const userName = this.currentUser?.uName;
    const userId = this.currentUser?.uId;

    const list = await this.getSymposiumList();
    const totalFound = list.length;

    // status === 'APPLY' 인 심포지움 필터링
    const applyAvailable = list.filter((item) => item.status === 'APPLY');
    const results: MedigateApplyItemResult[] = [];

    let appliedCount = 0;
    let alreadyCount = 0;
    let failedCount = 0;

    for (const item of applyAvailable) {
      // 이미 신청한 경우
      if (item.applyFlag === 'Y') {
        alreadyCount++;
        results.push({
          webinarIdx: item.webinarIdx,
          subject: item.subject,
          dateDesc: item.dateDesc,
          success: true,
          alreadyApplied: true,
          message: '이미 신청됨',
        });
        continue;
      }

      logger.info(`[Medigate] 심포지움 신청 시도: [${item.webinarIdx}] ${item.subject}`);
      const applyRes = await this.applySymposium(item.webinarIdx);
      results.push(applyRes);

      if (applyRes.success) {
        if (applyRes.alreadyApplied) {
          alreadyCount++;
        } else {
          appliedCount++;
          logger.info(`[Medigate] 신청 완료: [${item.webinarIdx}] ${item.subject}`);
        }
      } else {
        failedCount++;
        logger.warn(`[Medigate] 신청 실패: [${item.webinarIdx}] ${item.subject} - ${applyRes.message}`);
      }

      // 서버 부하 방지를 위해 짧은 대기
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    // 오늘 예정된 심포지움 목록 추출
    const todayKst = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const todayKstDots = todayKst.replace(/-/g, '.');
    const todaySymposiums = list.filter((item) => {
      if (item.startDate && item.startDate.startsWith(todayKst)) return true;
      if (item.dateDesc && (item.dateDesc.includes(todayKst) || item.dateDesc.includes(todayKstDots))) return true;
      return false;
    });

    // MG포인트 요약 정보 조회
    let pointSummary: MedigatePointSummary | null = null;
    try {
      pointSummary = await this.getPointSummary();
    } catch (err) {
      logger.warn('[Medigate] 포인트 요약 조회 실패:', err);
    }

    return {
      success: true,
      message: '심포지움 신청 작업 완료',
      userName,
      userId,
      totalFound,
      targetCount: applyAvailable.length,
      appliedCount,
      alreadyCount,
      failedCount,
      pointSummary,
      results,
      todaySymposiums,
    };
  }

  /**
   * MG포인트 요약 정보 조회 (총 사용가능, MG포인트, 리서치포인트, 소멸예정 등)
   */
  async getPointSummary(): Promise<MedigatePointSummary | null> {
    const res = await this.authenticatedRequest<{
      code: number;
      message: string;
      data?: MedigatePointSummary;
    }>('w/point/mg/summary', {
      method: 'GET',
    });

    if (res.status === 200 && res.data?.data) {
      return res.data.data;
    }
    return null;
  }

  /**
   * MG포인트 지급/적립 내역 조회
   */
  async getPointGrantHistory(
    year: number = new Date().getFullYear(),
    pageNo: number = 1,
    pageSize: number = 20,
  ): Promise<MedigatePointHistoryResult | null> {
    const res = await this.authenticatedRequest<{
      code: number;
      message: string;
      data?: MedigatePointHistoryResult;
    }>('w/point/mg/grant', {
      method: 'GET',
      searchParams: {
        year,
        pageNo,
        pageSize,
      },
    });

    if (res.status === 200 && res.data?.data) {
      return res.data.data;
    }
    return null;
  }

  /**
   * MG포인트 사용 내역 조회
   */
  async getPointUsedHistory(
    year: number = new Date().getFullYear(),
    pageNo: number = 1,
    pageSize: number = 20,
  ): Promise<MedigatePointHistoryResult | null> {
    const res = await this.authenticatedRequest<{
      code: number;
      message: string;
      data?: MedigatePointHistoryResult;
    }>('w/point/mg/used', {
      method: 'GET',
      searchParams: {
        year,
        pageNo,
        pageSize,
      },
    });

    if (res.status === 200 && res.data?.data) {
      return res.data.data;
    }
    return null;
  }

  /**
   * MG포인트 월별 추이 플로우 차트 조회
   */
  async getPointFlowChart(): Promise<MedigatePointFlowChartItem[]> {
    const res = await this.authenticatedRequest<{
      code: number;
      message: string;
      data?: { items?: MedigatePointFlowChartItem[] };
    }>('w/point/mg/flow_chart', {
      method: 'GET',
    });

    if (res.status === 200 && res.data?.data?.items) {
      return res.data.data.items;
    }
    return [];
  }

  /**
   * 실시간(On-Air) 심포지움 시청 세션 초기화 및 파싱
   */
  async enterSymposiumLive(
    webinarIdx: number,
  ): Promise<{ success: boolean; session?: MedigateLiveSession; message: string }> {
    // 1. 상세 정보 조회
    const detail = await this.getSymposiumDetail(webinarIdx);
    const subject = detail?.webinar?.subject || `심포지움 #${webinarIdx}`;

    // 2. 메디게이트 자체 서버 시청 이력 로깅 (선행 필수 호출)
    const viewLogged = await this.recordSymposiumView(webinarIdx);
    if (!viewLogged) {
      logger.warn(`[Medigate] 시청 시작 로깅(recordSymposiumView) 실패 (webinarIdx: ${webinarIdx})`);
    }

    // 3. 시청 URL 획득
    const watchUrlRes = await this.getSymposiumWatchUrl(webinarIdx);
    if (!watchUrlRes.success || !watchUrlRes.watchUrl) {
      return {
        success: false,
        message: watchUrlRes.message || '시청 URL을 발급받을 수 없습니다. (방송 진행 중이 아니거나 미신청 상태)',
      };
    }

    const watchUrl = watchUrlRes.watchUrl;
    logger.info(`[Medigate] [${webinarIdx}] 시청 URL 획득: ${watchUrl}`);

    // nownnow 플랫폼 검사
    if (watchUrl.includes('nownnow.com')) {
      try {
        const parsed = await this.setupNownnowSession(webinarIdx, subject, watchUrl);
        if (parsed) {
          return {
            success: true,
            session: parsed,
            message: 'nownnow 스트리밍 시청 세션 초기화 성공',
          };
        }
      } catch (err) {
        logger.error(`[Medigate] nownnow 세션 초기화 예외:`, err);
      }
    }

    // fallback: 일반 플랫폼 세션
    return {
      success: true,
      session: {
        webinarIdx,
        subject,
        watchUrl,
        platform: 'unknown',
      },
      message: '일반 시청 세션 초기화 완료',
    };
  }

  /**
   * nownnow 플랫폼 세션 연결, 리다이렉트 추적 및 Heartbeat 파라미터 파싱
   */
  private async setupNownnowSession(
    webinarIdx: number,
    subject: string,
    watchUrl: string,
  ): Promise<MedigateLiveSession | null> {
    const cookies: Record<string, string> = {};
    const mergeCookies = (setCookieHeaders?: string | string[]) => {
      if (!setCookieHeaders) return;
      const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
      for (const str of arr) {
        const parts = str.split(';')[0].trim();
        const eqIdx = parts.indexOf('=');
        if (eqIdx > 0) {
          const k = parts.substring(0, eqIdx).trim();
          const v = parts.substring(eqIdx + 1).trim();
          cookies[k] = v;
        }
      }
    };
    const getCookieHeader = () =>
      Object.entries(cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');

    // 1단계: watchUrl GET (302 리다이렉트 추적)
    let currentUrl = watchUrl;
    let res = await request(currentUrl, {
      method: 'GET',
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    mergeCookies(res.headers['set-cookie']);

    let redirectCount = 0;
    while ([301, 302, 303, 307, 308].includes(res.statusCode) && redirectCount < 5) {
      redirectCount++;
      const locHeader = res.headers['location'];
      const loc = Array.isArray(locHeader) ? locHeader[0] : locHeader;
      if (!loc) break;
      currentUrl = new URL(loc, currentUrl).toString();
      res = await request(currentUrl, {
        method: 'GET',
        headers: {
          'User-Agent': this.userAgent,
          Cookie: getCookieHeader(),
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      mergeCookies(res.headers['set-cookie']);
    }

    let html = await res.body.text();

    // 2단계: JS location.href 리다이렉트 검사
    const hrefMatch = html.match(/location\.href\s*=\s*['"]([^'"]+)['"]/);
    let roomUrl = currentUrl;
    if (hrefMatch && hrefMatch[1]) {
      roomUrl = new URL(hrefMatch[1], currentUrl).toString();
      const roomRes = await request(roomUrl, {
        method: 'GET',
        headers: {
          'User-Agent': this.userAgent,
          Cookie: getCookieHeader(),
          Referer: currentUrl,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
      });
      mergeCookies(roomRes.headers['set-cookie']);
      html = await roomRes.body.text();
    }

    // 3단계: room HTML에서 videoClose_mj.php Heartbeat 파라미터 추출
    const postMatch = html.match(/\$\.post\s*\(\s*['"](\.[^'"]*videoClose_mj\.php)['"]\s*,\s*\{([\s\S]*?)\}/);
    let heartbeatUrl = '';
    const heartbeatParams: Record<string, string> = {};

    if (postMatch) {
      heartbeatUrl = new URL(postMatch[1], roomUrl).toString();
      const paramsBlock = postMatch[2];
      const paramRegex = /['"]?([a-zA-Z0-9_]+)['"]?\s*:\s*['"]([^'"]*)['"]/g;
      let m: RegExpExecArray | null;
      while ((m = paramRegex.exec(paramsBlock)) !== null) {
        heartbeatParams[m[1]] = m[2];
      }
    } else {
      const keys = [
        'agent',
        'nAspNo',
        'hAspCode',
        'userid',
        'username',
        'connType',
        'emailaddr',
        'sess_id',
        'nUserIdn',
        'webinar_seq',
        'webinarTitle',
      ];
      for (const k of keys) {
        const kMatch = html.match(new RegExp(`['"]?${k}['"]?\\s*:\\s*['"]([^'"]*)['"]`));
        if (kMatch) heartbeatParams[k] = kMatch[1];
      }
      heartbeatUrl = new URL('./videoClose_mj.php', roomUrl).toString();
    }

    // 기본 필수값 보정
    if (!heartbeatParams['agent']) heartbeatParams['agent'] = 'medigate';
    if (!heartbeatParams['webinar_seq']) heartbeatParams['webinar_seq'] = String(webinarIdx);
    if (!heartbeatParams['connType']) heartbeatParams['connType'] = 'PC';
    if (!heartbeatParams['webinarTitle']) heartbeatParams['webinarTitle'] = 'live';

    // 4단계: 설문 iframe URL 파싱
    let surveyUrl: string | undefined;
    const surveyMatch =
      html.match(/const\s+iframeUrl\s*=\s*['"]([^'"]+)['"]/i) ||
      html.match(/<iframe[^>]+src=['"]([^'"]+)['"][^>]*id=['"]iframe-survey['"]/i);
    if (surveyMatch && surveyMatch[1]) {
      surveyUrl = surveyMatch[1].trim();
      if (surveyUrl.startsWith('//')) {
        surveyUrl = `https:${surveyUrl}`;
      }
    }

    return {
      webinarIdx,
      subject,
      watchUrl,
      platform: 'nownnow',
      cookieHeader: getCookieHeader(),
      roomUrl,
      heartbeatUrl,
      heartbeatParams,
      surveyUrl,
    };
  }

  /**
   * 심포지움 시청 Heartbeat(체류 시간) 1회 전송
   */
  async sendSymposiumHeartbeat(session: MedigateLiveSession): Promise<MedigateHeartbeatResult> {
    if (session.platform === 'nownnow' && session.heartbeatUrl && session.heartbeatParams) {
      try {
        const bodyStr = new URLSearchParams(session.heartbeatParams).toString();
        const res = await request(session.heartbeatUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'User-Agent': this.userAgent,
            Referer: session.roomUrl || session.watchUrl,
            Origin: new URL(session.heartbeatUrl).origin,
            Cookie: session.cookieHeader || '',
          },
          body: bodyStr,
        });

        const resText = await res.body.text();
        const isSurveyTriggered = resText.includes('survey');

        return {
          success: res.statusCode === 200,
          status: res.statusCode,
          body: resText.trim(),
          surveyTriggered: isSurveyTriggered,
          surveyUrl: session.surveyUrl,
          message: res.statusCode === 200 ? 'Heartbeat 전송 성공' : `HTTP 상태: ${res.statusCode}`,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          success: false,
          message: `Heartbeat 전송 오류: ${msg}`,
        };
      }
    }

    // fallback: 메디게이트 자체 view 로깅
    const ok = await this.recordSymposiumView(session.webinarIdx);
    return {
      success: ok,
      message: ok ? '메디게이트 뷰 로깅 성공' : '메디게이트 뷰 로깅 실패',
    };
  }

  /**
   * 실시간 심포지움 시청 루프 실행 (지정 시간 동안 주기적 Heartbeat 전송 및 세션 유지)
   */
  async watchSymposiumLive(
    webinarIdx: number,
    options: {
      durationMinutes?: number;
      intervalSeconds?: number;
      onHeartbeat?: (count: number, elapsedMinutes: number) => void;
      onStart?: (info: { webinarIdx: number; subject: string; durationMinutes: number }) => Promise<void> | void;
      onProgress?: (info: {
        webinarIdx: number;
        subject: string;
        elapsedMinutes: number;
        durationMinutes: number;
        heartbeatCount: number;
      }) => Promise<void> | void;
    } = {},
  ): Promise<MedigateWatchResult> {
    const durationMinutes = options.durationMinutes ?? 20;
    const intervalSeconds = options.intervalSeconds ?? 120; // 2분 주기
    const startedAt = new Date().toISOString();

    logger.info(
      `[Medigate] [${webinarIdx}] 실시간 심포지움 시청 시작 (목표: ${durationMinutes}분, 주기: ${intervalSeconds}초)`,
    );

    // 1. 세션 진입
    const enterRes = await this.enterSymposiumLive(webinarIdx);
    if (!enterRes.success || !enterRes.session) {
      return {
        webinarIdx,
        subject: `심포지움 #${webinarIdx}`,
        success: false,
        message: enterRes.message,
        startedAt,
        endedAt: new Date().toISOString(),
        durationMinutes: 0,
        heartbeatCount: 0,
        platform: 'unknown',
      };
    }

    const session = enterRes.session;
    const subject = session.subject || `심포지움 #${webinarIdx}`;

    // 시작 콜백 호출
    if (options.onStart) {
      try {
        await options.onStart({ webinarIdx, subject, durationMinutes });
      } catch (err) {
        logger.warn(`[Medigate] onStart 콜백 실행 중 오류:`, err);
      }
    }

    // 2. 초기 1회 Heartbeat 전송
    let heartbeatCount = 0;
    const firstHb = await this.sendSymposiumHeartbeat(session);
    if (firstHb.success) {
      heartbeatCount++;
      logger.info(`[Medigate] [${webinarIdx}] 초기 Heartbeat 전송 완료`);
    } else {
      logger.warn(`[Medigate] [${webinarIdx}] 초기 Heartbeat 전송 경고: ${firstHb.message}`);
    }

    const startTimeMs = Date.now();
    const totalDurationMs = durationMinutes * 60 * 1000;
    const intervalMs = intervalSeconds * 1000;
    let lastReportedMinutes = 0;

    // 3. 주기적 Heartbeat 전송 루프
    while (Date.now() - startTimeMs < totalDurationMs) {
      const remainingMs = totalDurationMs - (Date.now() - startTimeMs);
      const sleepMs = Math.min(intervalMs, remainingMs);
      if (sleepMs <= 0) break;

      await new Promise((resolve) => setTimeout(resolve, sleepMs));

      // Heartbeat 전송
      const hbRes = await this.sendSymposiumHeartbeat(session);
      if (hbRes.success) {
        heartbeatCount++;
        const elapsedMinutes = Math.round(((Date.now() - startTimeMs) / 60000) * 10) / 10;
        logger.info(
          `[Medigate] [${webinarIdx}] Heartbeat #${heartbeatCount} 전송 완료 (${elapsedMinutes}/${durationMinutes}분)`,
        );
        if (options.onHeartbeat) {
          options.onHeartbeat(heartbeatCount, elapsedMinutes);
        }

        // 매 5분(5, 10, 15분 등) 경과 시 onProgress 콜백 호출
        if (options.onProgress && elapsedMinutes - lastReportedMinutes >= 4.9 && elapsedMinutes < durationMinutes) {
          lastReportedMinutes = elapsedMinutes;
          try {
            await options.onProgress({
              webinarIdx,
              subject,
              elapsedMinutes,
              durationMinutes,
              heartbeatCount,
            });
          } catch (progressErr) {
            logger.warn(`[Medigate] onProgress 콜백 실행 중 오류:`, progressErr);
          }
        }
      } else {
        logger.warn(`[Medigate] [${webinarIdx}] Heartbeat 전송 실패: ${hbRes.message}`);
      }

      // 세미나 방송 종료 여부 검사 (On-Air 상태 해제 시 안전하게 조기 종료)
      try {
        const currentDetail = await this.getSymposiumDetail(webinarIdx);
        if (!currentDetail || currentDetail.webinar?.status !== 'ING') {
          const statusDesc = currentDetail?.webinar?.status || '종료(CLOSED)';
          logger.info(
            `[Medigate] [${webinarIdx}] 심포지움 방송 종료 감지 (상태: ${statusDesc}). 시청 세션을 즉시 안전하게 종료합니다.`,
          );
          break;
        }
      } catch {
        // 일시적 네트워크 오류 시 루프 유지
      }
    }

    // 4. 퇴장 Heartbeat (beforeunload 이벤트에 상응)
    try {
      await this.sendSymposiumHeartbeat(session);
      logger.info(`[Medigate] [${webinarIdx}] 퇴장 Heartbeat 전송 완료`);
    } catch {
      // 무시
    }

    const endedAt = new Date().toISOString();
    const actualDurationMinutes = Math.round(((Date.now() - startTimeMs) / 60000) * 10) / 10;

    logger.info(
      `[Medigate] [${webinarIdx}] 심포지움 시청 완료: ${subject} (${actualDurationMinutes}분 시청, Heartbeat ${heartbeatCount}회)`,
    );

    return {
      webinarIdx,
      subject,
      success: true,
      message: `성공적으로 ${actualDurationMinutes}분 동안 시청(Heartbeat ${heartbeatCount}회)을 완료했습니다.`,
      startedAt,
      endedAt,
      durationMinutes: actualDurationMinutes,
      heartbeatCount,
      surveyUrl: session.surveyUrl,
      platform: session.platform,
    };
  }

  /**
   * 현재 진행 중인(On-Air) 모든 심포지움 자동 시청
   */
  async watchAllOnAirSymposiums(
    options: {
      durationMinutes?: number;
      intervalSeconds?: number;
      onStart?: (info: { webinarIdx: number; subject: string; durationMinutes: number }) => Promise<void> | void;
      onProgress?: (info: {
        webinarIdx: number;
        subject: string;
        elapsedMinutes: number;
        durationMinutes: number;
        heartbeatCount: number;
      }) => Promise<void> | void;
    } = {},
  ): Promise<MedigateWatchWorkflowResult> {
    const loginRes = await this.login();
    if (!loginRes.success) {
      return {
        success: false,
        message: loginRes.message,
        totalOnAir: 0,
        watchedCount: 0,
        failedCount: 0,
        results: [],
      };
    }

    const userName = this.currentUser?.uName;
    const userId = this.currentUser?.uId;

    const list = await this.getSymposiumList();
    // status === 'ING' 인 심포지움 필터링
    const onAirList = list.filter((item) => item.status === 'ING');

    if (onAirList.length === 0) {
      return {
        success: true,
        message: '현재 On-Air(진행 중)인 심포지움이 없습니다.',
        userName,
        userId,
        totalOnAir: 0,
        watchedCount: 0,
        failedCount: 0,
        results: [],
      };
    }

    logger.info(`[Medigate] 현재 On-Air 심포지움 ${onAirList.length}건 감지`);
    const results: MedigateWatchResult[] = [];
    let watchedCount = 0;
    let failedCount = 0;

    for (const item of onAirList) {
      // 미신청 상태인 경우 사전 신청 시도
      if (item.applyFlag !== 'Y') {
        logger.info(`[Medigate] [${item.webinarIdx}] 미신청 심포지움, 신청 시도...`);
        await this.applySymposium(item.webinarIdx);
      }

      logger.info(`[Medigate] [${item.webinarIdx}] ${item.subject} 시청 작업 시작`);
      const watchRes = await this.watchSymposiumLive(item.webinarIdx, options);
      results.push(watchRes);

      if (watchRes.success) {
        watchedCount++;
      } else {
        failedCount++;
      }
    }

    return {
      success: watchedCount > 0 || onAirList.length === 0,
      message: `On-Air 심포지움 시청 완료 (성공 ${watchedCount}건, 실패 ${failedCount}건)`,
      userName,
      userId,
      totalOnAir: onAirList.length,
      watchedCount,
      failedCount,
      results,
    };
  }
}
