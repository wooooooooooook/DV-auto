import * as logger from '../services/logger';

export interface HmpUserInfo {
  memId?: string;
  nick?: string;
  gradNm?: string;
  remanGradPnt?: number;
  capsules: number;
  chrPnt?: number;
  usePnt?: number;
  dstrctSchdPnt?: string;
}

export interface HmpAttendanceInfo {
  cntntCd: string;
  cntntSeq: string;
  pointTitle: string;
  bizGbn: string;
  loginCount: number;
  isAlreadyAttended: boolean;
}

export interface HmpAttendanceResult {
  status: 'SUCCESS' | 'ALREADY' | 'FAILED';
  point?: number;
  message: string;
}

export interface HmpAttendanceWorkflowResult {
  success: boolean;
  message?: string;
  userInfo?: HmpUserInfo;
  attendance: HmpAttendanceResult;
  loginCount?: number;
}

export class HmpClient {
  private cookies: Map<string, string> = new Map();
  private userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  private baseUrl = 'https://www.hmp.co.kr';

  private getCookieHeader(): string {
    return Array.from(this.cookies.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private extractCookies(response: Response): void {
    const setCookieHeaders = response.headers.getSetCookie?.() || [];
    if (setCookieHeaders.length === 0) {
      const singleSetCookie = response.headers.get('set-cookie');
      if (singleSetCookie) {
        setCookieHeaders.push(singleSetCookie);
      }
    }

    for (const header of setCookieHeaders) {
      const parts = header.split(';');
      if (parts.length > 0) {
        const [nameVal] = parts;
        const eqIdx = nameVal.indexOf('=');
        if (eqIdx !== -1) {
          const key = nameVal.slice(0, eqIdx).trim();
          const val = nameVal.slice(eqIdx + 1).trim();
          if (key) {
            this.cookies.set(key, val);
          }
        }
      }
    }
  }

  public async login(username?: string, password?: string): Promise<boolean> {
    const memId = username || process.env.HMP_USER;
    const passwd = password || process.env.HMP_PASS;

    if (!memId || !passwd) {
      throw new Error('HMP 로그인 정보(HMP_USER, HMP_PASS)가 설정되지 않았습니다.');
    }

    // 1. Initial GET to obtain session cookies (WMONID, JSESSIONID)
    logger.info('[HMP] 로그인 폼 접근 및 초기 세션 발급 중...');
    const formRes = await fetch(`${this.baseUrl}/login/loginForm.hm`, {
      method: 'GET',
      headers: {
        'User-Agent': this.userAgent,
      },
    });
    this.extractCookies(formRes);

    // 2. Submit credentials
    const params = new URLSearchParams({
      systemNm: 'prod',
      requestedUri: '',
      cesGroupId: '',
      tabGb: '',
      redirectPage: '',
      adminId: '',
      panelGisu: '',
      cesId: '',
      loginLoad: '',
      loginType: '',
      retUrl: '',
      admintoolMemberId: '',
      newsLetterId: '',
      emailCerty: '',
      searchFlag: 'id',
      externSite: '',
      externId: '',
      deepLink: '',
      memId,
      passwd,
    });

    const loginRes = await fetch(`${this.baseUrl}/login/loginProcess.hm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Cookie: this.getCookieHeader(),
        'User-Agent': this.userAgent,
        Referer: `${this.baseUrl}/login/loginForm.hm`,
      },
      body: params.toString(),
      redirect: 'manual',
    });

    this.extractCookies(loginRes);

    // Verify session
    const hasUserId = this.cookies.has('userId') || this.cookies.has('MEM_ID');
    if (!hasUserId && loginRes.status !== 302) {
      logger.error('[HMP] 로그인 실패 (인증 쿠키 미발급)');
      return false;
    }

    logger.info(`[HMP] 로그인 성공 (회원 ID: ${memId})`);
    return true;
  }

  public async getUserInfo(): Promise<HmpUserInfo> {
    const res = await fetch(`${this.baseUrl}/ajax/main/userInfo.hm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: this.getCookieHeader(),
        'User-Agent': this.userAgent,
        Referer: `${this.baseUrl}/main/hmpMain.hm`,
        'X-Requested-With': 'XMLHttpRequest',
      },
    });

    if (!res.ok) {
      throw new Error(`사용자 정보 조회 실패 (HTTP ${res.status})`);
    }

    const data = await res.json();
    let capsules = 0;
    let chrPnt = 0;
    let usePnt = 0;
    let dstrctSchdPnt = '0';

    if (Array.isArray(data.myBnftValList)) {
      const pointObj = data.myBnftValList.find((b: { bnftGbn?: string }) => b.bnftGbn === 'POINT');
      if (pointObj) {
        capsules = Number(pointObj.remanPnt || 0);
        chrPnt = Number(pointObj.chrPnt || 0);
        usePnt = Number(pointObj.usePnt || 0);
        dstrctSchdPnt = String(pointObj.dstrctSchdPnt || '0');
      }
    }

    const knowComm = data.knowCommUserInfo || {};

    return {
      memId: knowComm.memId,
      nick: knowComm.nick,
      gradNm: knowComm.gradNm,
      remanGradPnt: knowComm.remanGradPnt,
      capsules,
      chrPnt,
      usePnt,
      dstrctSchdPnt,
    };
  }

  public async getAttendanceInfo(): Promise<HmpAttendanceInfo> {
    const res = await fetch(`${this.baseUrl}/event/attendanceRouletteMain.hm?attendMain=Y`, {
      method: 'GET',
      headers: {
        Cookie: this.getCookieHeader(),
        'User-Agent': this.userAgent,
        Referer: `${this.baseUrl}/main/hmpMain.hm`,
      },
    });

    if (!res.ok) {
      throw new Error(`출석 이벤트 페이지 조회 실패 (HTTP ${res.status})`);
    }

    const html = await res.text();

    const cntntCd = html.match(/id=["']cntntCd["'][^>]+value=["']([^"']+)["']/)?.[1] || '09';
    const cntntSeq = html.match(/id=["']cntntSeq["'][^>]+value=["']([^"']+)["']/)?.[1] || '6712';
    const pointTitle = html.match(/id=["']pointTitle["'][^>]+value=["']([^"']+)["']/)?.[1] || '출석 체크 룰렛 이벤트';
    const capsule10 = html.match(/id=["']capsule10["'][^>]+value=["']([^"']+)["']/)?.[1] || '009';
    const loginCountStr = html.match(/id=["']loginCount["'][^>]+value=["']([^"']+)["']/)?.[1] || '0';
    const loginCount = parseInt(loginCountStr, 10) || 0;

    // Check if already attended today from HTML structure
    const isCapsuleBtnCompleteVisible =
      html.includes('id="capsuleBtnComplete" style="display:block;"') ||
      html.includes("id='capsuleBtnComplete' style='display:block;'") ||
      (html.includes('capsuleBtnComplete') && !html.includes('id="capsuleBtn" style="display:block;"'));

    return {
      cntntCd,
      cntntSeq,
      pointTitle,
      bizGbn: capsule10,
      loginCount,
      isAlreadyAttended: isCapsuleBtnCompleteVisible,
    };
  }

  public async submitAttendance(info: HmpAttendanceInfo): Promise<HmpAttendanceResult> {
    const params = new URLSearchParams({
      cntntCd: info.cntntCd,
      cntntSeq: info.cntntSeq,
      pointTitle: info.pointTitle,
      bizGbn: info.bizGbn,
      seq: info.cntntSeq,
    });

    const res = await fetch(`${this.baseUrl}/ajax/event/capsuleHist.hm`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        Cookie: this.getCookieHeader(),
        'User-Agent': this.userAgent,
        Referer: `${this.baseUrl}/event/attendanceRouletteMain.hm?attendMain=Y`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      body: params.toString(),
    });

    if (!res.ok) {
      return {
        status: 'FAILED',
        message: `출석 캡슐 요청 실패 (HTTP ${res.status})`,
      };
    }

    const data = await res.json();
    if (data.code === '800') {
      return {
        status: 'SUCCESS',
        point: 10,
        message: '출석 캡슐 받기 완료 (+10 캡슐)',
      };
    }

    if (data.message === '1.' || data.code !== '800') {
      return {
        status: 'ALREADY',
        message: '오늘 이미 출석 캡슐을 수령했습니다.',
      };
    }

    return {
      status: 'FAILED',
      message: data.message || `출석 처리 실패 (코드: ${data.code})`,
    };
  }

  public async runAttendanceWorkflow(username?: string, password?: string): Promise<HmpAttendanceWorkflowResult> {
    try {
      const loginSuccess = await this.login(username, password);
      if (!loginSuccess) {
        return {
          success: false,
          message: 'HMP 로그인에 실패했습니다. 아이디 및 비밀번호를 확인해주세요.',
          attendance: {
            status: 'FAILED',
            message: '로그인 실패',
          },
        };
      }

      // 1. Get attendance info
      const attInfo = await this.getAttendanceInfo();
      let attendanceResult: HmpAttendanceResult;

      if (attInfo.isAlreadyAttended) {
        logger.info('[HMP] 이미 당일 출석 캡슐 수령 완료 상태 확인');
        attendanceResult = {
          status: 'ALREADY',
          message: '오늘 이미 출석 캡슐을 수령했습니다.',
        };
      } else {
        logger.info('[HMP] 오늘의 출석 캡슐 받기 시도...');
        attendanceResult = await this.submitAttendance(attInfo);
      }

      // 2. Get latest user info & capsules
      const userInfo = await this.getUserInfo();

      return {
        success: true,
        userInfo,
        attendance: attendanceResult,
        loginCount: attInfo.loginCount,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[HMP] 출석 워크플로우 수행 중 오류:', err);
      return {
        success: false,
        message: msg,
        attendance: {
          status: 'FAILED',
          message: msg,
        },
      };
    }
  }
}
