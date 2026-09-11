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
  results: MedigateApplyItemResult[];
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
      results,
    };
  }
}
