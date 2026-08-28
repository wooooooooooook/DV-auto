import { request } from 'undici';
import * as logger from '../services/logger';

export const KEYMEDI_STATIC_ACCESS_TOKEN =
  'eab08ef6278eb83448b1e12db0e33c18897060532e8425c3e2faee334e2d5ec19de474d1eee1dc621a0f223eefbf515804b7de28b4cb0d355dd498950e16ced7';

export const KEYMEDI_BASE_URL = 'https://api.keymedi.com/api';

export interface KeymediToken {
  access_token: string;
  refresh_token?: string;
}

export interface KeymediMember {
  idx?: number;
  uid?: string;
  name?: string;
  mobile?: string;
  email?: string;
  status?: string;
  point_balance?: number;
  total_point?: number;
  expired_total_point?: number;
  affiliation?: string;
  department?: string;
  [key: string]: unknown;
}

export interface KeymediLoginResult {
  success: boolean;
  code: number;
  message: string;
  accessToken?: string;
  member?: KeymediMember;
}

export interface KeymediAttendanceCalendarItem {
  point: number;
  day: number;
  accumulate: number;
}

export interface KeymediAttendanceCalendarData {
  current_date: string;
  attendance: KeymediAttendanceCalendarItem[];
  count_attendance: number;
  [key: string]: unknown;
}

export interface KeymediAttendanceResult {
  status: 'SUCCESS' | 'ALREADY' | 'FAILED';
  point?: number;
  message: string;
  rawCode?: number;
}

export interface KeymediAttendanceWorkflowResult {
  success: boolean;
  member?: KeymediMember;
  attendance: KeymediAttendanceResult;
  calendar?: KeymediAttendanceCalendarData;
  pointBalance: number;
  totalPoint: number;
  message: string;
}

export class KeymediClient {
  public baseUrl: string;
  private accessToken: string | null = null;
  public member: KeymediMember | null = null;

  constructor(baseUrl: string = KEYMEDI_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/plain, */*',
      AccessToken: KEYMEDI_STATIC_ACCESS_TOKEN,
      Origin: 'https://www.keymedi.com',
      Referer: 'https://www.keymedi.com/',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    };
    if (this.accessToken) {
      headers.Authorization = `Bearer ${this.accessToken}`;
    }
    return headers;
  }

  public setAccessToken(token: string): void {
    this.accessToken = token;
  }

  public getAccessToken(): string | null {
    return this.accessToken;
  }

  /**
   * 키메디 로그인
   */
  public async login(uid?: string, password?: string): Promise<KeymediLoginResult> {
    const username = uid || process.env.KEYMEDI_USER;
    const pass = password || process.env.KEYMEDI_PASS;

    if (!username || !pass) {
      return {
        success: false,
        code: -1,
        message: 'KEYMEDI_USER 또는 KEYMEDI_PASS 환경 변수가 설정되지 않았습니다.',
      };
    }

    try {
      const res = await request(`${this.baseUrl}/auth/login`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({ uid: username, password: pass, remember: false }),
      });

      const json = (await res.body.json()) as {
        code: number;
        message: string;
        data?: {
          token?: { access_token: string; refresh_token?: string } | string;
          member?: KeymediMember;
        };
      };

      if (json.code === 0 && json.data) {
        let tokenStr = '';
        if (typeof json.data.token === 'string') {
          tokenStr = json.data.token;
        } else if (json.data.token && typeof json.data.token === 'object' && json.data.token.access_token) {
          tokenStr = json.data.token.access_token;
        }

        if (tokenStr) {
          this.accessToken = tokenStr;
          this.member = json.data.member || null;
          return {
            success: true,
            code: 0,
            message: json.message || '로그인 성공',
            accessToken: tokenStr,
            member: this.member || undefined,
          };
        }
      }

      return {
        success: false,
        code: json.code,
        message: json.message || '로그인 실패',
      };
    } catch (err) {
      logger.error('KeymediClient.login error:', err);
      return {
        success: false,
        code: -500,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 출석 캘린더 조회
   */
  public async getAttendanceCalendar(year?: number, month?: number): Promise<KeymediAttendanceCalendarData | null> {
    try {
      const bodyPayload = year && month ? { year, month } : {};
      const res = await request(`${this.baseUrl}/member/attendanceCalendar`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(bodyPayload),
      });

      const json = (await res.body.json()) as {
        code: number;
        message: string;
        data?: KeymediAttendanceCalendarData;
      };

      if (json.code === 0 && json.data) {
        return json.data;
      }
      return null;
    } catch (err) {
      logger.error('KeymediClient.getAttendanceCalendar error:', err);
      return null;
    }
  }

  /**
   * 출석 체크 요청
   */
  public async addAttendance(): Promise<KeymediAttendanceResult> {
    try {
      const res = await request(`${this.baseUrl}/member/attendanceAdd`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({}),
      });

      const json = (await res.body.json()) as {
        code: number;
        message: string;
        data?: { point?: number };
      };

      if (json.code === 0) {
        return {
          status: 'SUCCESS',
          point: json.data?.point ?? 100,
          message: `출석 성공 (+${json.data?.point ?? 100}P)`,
          rawCode: 0,
        };
      } else if (json.code === 1601) {
        return {
          status: 'ALREADY',
          message: '이미 오늘 출석체크가 완료되었습니다.',
          rawCode: 1601,
        };
      } else {
        return {
          status: 'FAILED',
          message: json.message || '출석체크 실패',
          rawCode: json.code,
        };
      }
    } catch (err) {
      logger.error('KeymediClient.addAttendance error:', err);
      return {
        status: 'FAILED',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 내 정보 및 포인트 조회
   */
  public async getMyInfo(): Promise<KeymediMember | null> {
    try {
      const res = await request(`${this.baseUrl}/member/getMyInfo`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify({}),
      });

      const json = (await res.body.json()) as {
        code: number;
        message: string;
        data?: {
          info?: KeymediMember;
        };
      };

      if (json.code === 0 && json.data?.info) {
        this.member = json.data.info;
        return json.data.info;
      }
      return null;
    } catch (err) {
      logger.error('KeymediClient.getMyInfo error:', err);
      return null;
    }
  }

  /**
   * 전체 워크플로우 실행 (로그인 -> 출석체크 -> 캘린더/포인트 조회)
   */
  public async executeAttendanceAndPoints(uid?: string, password?: string): Promise<KeymediAttendanceWorkflowResult> {
    // 1. 로그인
    const loginResult = await this.login(uid, password);
    if (!loginResult.success) {
      return {
        success: false,
        attendance: {
          status: 'FAILED',
          message: `로그인 실패: ${loginResult.message}`,
        },
        pointBalance: 0,
        totalPoint: 0,
        message: `키메디 로그인에 실패했습니다 (${loginResult.message})`,
      };
    }

    // 2. 출석 체크 실행
    const attendance = await this.addAttendance();

    // 3. 최신 회원 정보 및 포인트 조회
    const memberInfo = await this.getMyInfo();

    // 4. 출석 캘린더 조회
    const calendar = await this.getAttendanceCalendar();

    const pointBalance = memberInfo?.point_balance ?? memberInfo?.total_point ?? 0;
    const totalPoint = memberInfo?.total_point ?? pointBalance;

    return {
      success: true,
      member: memberInfo || loginResult.member,
      attendance,
      calendar: calendar || undefined,
      pointBalance,
      totalPoint,
      message: attendance.message,
    };
  }
}
