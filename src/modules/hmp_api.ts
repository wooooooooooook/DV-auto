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

export interface HmpRoulettePrize {
  type: 'CAPSULE' | 'PRODUCT';
  name: string;
  point?: number;
}

export const HMP_ROULETTE_PRIZES: Record<string, HmpRoulettePrize> = {
  '1': { type: 'PRODUCT', name: '[GS25] 5000원 상품권' },
  '2': { type: 'CAPSULE', name: '700 캡슐', point: 700 },
  '3': { type: 'CAPSULE', name: '1000 캡슐', point: 1000 },
  '4': { type: 'CAPSULE', name: '200 캡슐', point: 200 },
  '5': { type: 'PRODUCT', name: '[스타벅스] 아이스 아메리카노 Tall' },
  '6': { type: 'CAPSULE', name: '500 캡슐', point: 500 },
  '7': { type: 'CAPSULE', name: '1500 캡슐', point: 1500 },
  '8': { type: 'CAPSULE', name: '100 캡슐', point: 100 },
};

export interface HmpAttendanceInfo {
  cntntCd: string;
  cntntSeq: string;
  pointTitle: string;
  bizGbn: string;
  loginCount: number;
  isAlreadyAttended: boolean;
  maxLoginCount?: number;
  month?: string;
  memId?: string;
  phoneNo?: string;
  rouelette10?: string;
  rouelette20?: string;
  rouelette30?: string;
  win10?: string;
  win20?: string;
  win30?: string;
  win10Yn?: string;
  win20Yn?: string;
  win30Yn?: string;
}

export interface HmpAttendanceResult {
  status: 'SUCCESS' | 'ALREADY' | 'FAILED';
  point?: number;
  message: string;
}

export interface HmpRouletteSpinResult {
  step: '1' | '2' | '3';
  stepDays: number;
  success: boolean;
  winNum?: string;
  prizeName?: string;
  prizeType?: 'CAPSULE' | 'PRODUCT';
  point?: number;
  message?: string;
  giftiShowSent?: boolean;
}

export interface HmpRouletteWorkflowResult {
  attempted: boolean;
  spins: HmpRouletteSpinResult[];
  message?: string;
}

export interface HmpAttendanceWorkflowResult {
  success: boolean;
  message?: string;
  userInfo?: HmpUserInfo;
  attendance: HmpAttendanceResult;
  loginCount?: number;
  roulette?: HmpRouletteWorkflowResult;
  /**
   * 출석 등 상태 변경은 이미 성공했지만, 그 뒤 조회/처리 단계가 실패한 사유.
   * 이 경우에도 success 는 true 다. 실제로 완료된 작업이 실패로 보고되면 안 되기 때문.
   */
  degradedReason?: string;
}

export class HmpClient {
  private cookies: Map<string, string> = new Map();
  private userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  private baseUrl = 'https://www.hmp.co.kr';
  private currentMemId = '';

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

  /** 읽기 계열(GET, 조회, 로그인) 요청의 타임아웃. */
  private static readonly READ_TIMEOUT_MS = 3_000;
  /** 상태 변경 요청(출석 캡슐 수령, 룰렛 회전, 경품 신청)의 타임아웃. 정상 처리에 시간이 더 걸릴 수 있어 넉넉하게 잡는다. */
  private static readonly WRITE_TIMEOUT_MS = 10_000;
  /** 멱등 요청의 최대 시도 횟수 (최초 1회 + 재시도 2회). */
  private static readonly MAX_ATTEMPTS = 3;
  /** 재시도 대기 시간의 기준값. */
  private static readonly RETRY_BASE_DELAY_MS = 500;
  private static readonly RETRY_MAX_DELAY_MS = 5_000;

  /**
   * 지수 백오프 대기 시간. 1회째 실패 500ms, 2회째 1000ms, ...
   * 고정 간격으로 재시도하면 부하가 걸린 서버에 같은 속도로 계속 부딪혀
   * 429·5xx 를 악화시키므로 실패 횟수에 따라 간격을 늘린다.
   * attempt 는 1부터 시작한다.
   */
  private static retryDelayMs(attempt: number): number {
    return Math.min(HmpClient.RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), HmpClient.RETRY_MAX_DELAY_MS);
  }

  /** 일시적인 서버 부하로 판단하여 재시도할 수 있는 응답 코드. */
  private static isRetryableStatus(status: number): boolean {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }

  private static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * fetch 래퍼. 모든 요청에 타임아웃을 적용하고, 멱등 요청에 한해 재시도한다.
   *
   * 상태를 변경하는 요청(출석 캡슐 수령, 룰렛 회전, 경품 신청)은 재시도하지 않는다.
   * 타임아웃은 요청이 실패했다는 뜻이 아니라 응답이 늦게 도착했다는 뜻이며,
   * 서버는 이미 처리를 마쳤을 수 있다. 재시도하면 출석 캡슐 중복 수령이나
   * 룰렛 두 회전처럼 되돌릴 수 없는 부작용이 생긴다.
   */
  private async fetchWithRetry(
    url: string,
    init: RequestInit,
    { timeoutMs, retryable }: { timeoutMs: number; retryable: boolean },
  ): Promise<Response> {
    const maxAttempts = retryable ? HmpClient.MAX_ATTEMPTS : 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        // signal 은 시도마다 새로 만들어야 한다. 한 번 abort 된 signal 은 재사용할 수 없다.
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });

        if (attempt < maxAttempts && HmpClient.isRetryableStatus(res.status)) {
          const wait = HmpClient.retryDelayMs(attempt);
          logger.warn(
            `[HMP] HTTP ${res.status} 응답으로 ${attempt}/${maxAttempts}차 시도 실패. ${wait}ms 후 재시도합니다.`,
          );
          await HmpClient.delay(wait);
          continue;
        }

        return res;
      } catch (error) {
        if (attempt >= maxAttempts) throw error;

        const msg = error instanceof Error ? error.message : String(error);
        const wait = HmpClient.retryDelayMs(attempt);
        logger.warn(`[HMP] 요청 오류(${msg})로 ${attempt}/${maxAttempts}차 시도 실패. ${wait}ms 후 재시도합니다.`);
        await HmpClient.delay(wait);
      }
    }

    throw new Error('HMP 요청 실패: 재시도를 모두 사용했으나 응답을 받지 못했습니다.');
  }

  public async login(username?: string, password?: string): Promise<boolean> {
    const memId = username || process.env.HMP_USER;
    const passwd = password || process.env.HMP_PASS;

    if (!memId || !passwd) {
      throw new Error('HMP 로그인 정보(HMP_USER, HMP_PASS)가 설정되지 않았습니다.');
    }

    this.currentMemId = memId;

    // 1. Initial GET to obtain session cookies (WMONID, JSESSIONID)
    logger.info('[HMP] 로그인 폼 접근 및 초기 세션 발급 중...');
    const formRes = await this.fetchWithRetry(
      `${this.baseUrl}/login/loginForm.hm`,
      {
        method: 'GET',
        headers: {
          'User-Agent': this.userAgent,
        },
      },
      { timeoutMs: HmpClient.READ_TIMEOUT_MS, retryable: true },
    );
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

    const loginRes = await this.fetchWithRetry(
      `${this.baseUrl}/login/loginProcess.hm`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Cookie: this.getCookieHeader(),
          'User-Agent': this.userAgent,
          Referer: `${this.baseUrl}/login/loginForm.hm`,
        },
        body: params.toString(),
        redirect: 'manual',
      },
      { timeoutMs: HmpClient.READ_TIMEOUT_MS, retryable: true },
    );

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
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/ajax/main/userInfo.hm`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Cookie: this.getCookieHeader(),
          'User-Agent': this.userAgent,
          Referer: `${this.baseUrl}/main/hmpMain.hm`,
          'X-Requested-With': 'XMLHttpRequest',
        },
      },
      { timeoutMs: HmpClient.READ_TIMEOUT_MS, retryable: true },
    );

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

  private getPhoneFromEnv(): string {
    const p1 = process.env.USER_PHONE_1 || '';
    const p2 = process.env.USER_PHONE_2 || '';
    const p3 = process.env.USER_PHONE_3 || '';
    const phone = `${p1}${p2}${p3}`.replace(/[^0-9]/g, '');
    return phone.length === 11 ? phone : '';
  }

  public async getAttendanceInfo(seq: string = '6712'): Promise<HmpAttendanceInfo> {
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/event/attendanceRouletteMain.hm?seq=${seq}`,
      {
        method: 'GET',
        headers: {
          Cookie: this.getCookieHeader(),
          'User-Agent': this.userAgent,
          Referer: `${this.baseUrl}/main/hmpMain.hm`,
        },
      },
      { timeoutMs: HmpClient.READ_TIMEOUT_MS, retryable: true },
    );

    if (!res.ok) {
      throw new Error(`출석 이벤트 페이지 조회 실패 (HTTP ${res.status})`);
    }

    const html = await res.text();

    const getVal = (id: string): string => {
      const idMatch = html.match(new RegExp(`<input[^>]*id=["']${id}["'][^>]*>`, 'i'));
      if (idMatch) {
        return idMatch[0].match(/value=["']([^"']*)["']/i)?.[1] ?? '';
      }
      const nameMatch = html.match(new RegExp(`<input[^>]*name=["']${id}["'][^>]*>`, 'i'));
      if (nameMatch) {
        return nameMatch[0].match(/value=["']([^"']*)["']/i)?.[1] ?? '';
      }
      return '';
    };

    const cntntCd = getVal('cntntCd') || '09';
    const cntntSeq = getVal('cntntSeq') || seq;
    const pointTitle = getVal('pointTitle') || '출석 체크 룰렛 이벤트';
    const capsule10 = getVal('capsule10') || '009';
    const loginCountStr = getVal('loginCount') || '0';
    const loginCount = parseInt(loginCountStr, 10) || 0;
    const maxLoginCountStr = getVal('maxLoginCount') || loginCountStr;
    const maxLoginCount = parseInt(maxLoginCountStr, 10) || loginCount;
    const month = getVal('month') || '';
    const memId = getVal('memGbn') || getVal('memId') || this.currentMemId || '';

    const p1 = getVal('phoneNum1');
    const p2 = getVal('phoneNum2');
    const p3 = getVal('phoneNum3');
    const parsedPhone = p1 && p2 && p3 ? `${p1}${p2}${p3}`.replace(/[^0-9]/g, '') : '';
    const phoneNo = parsedPhone.length === 11 ? parsedPhone : this.getPhoneFromEnv();

    const rouelette10 = getVal('rouelette10');
    const rouelette20 = getVal('rouelette20');
    const rouelette30 = getVal('rouelette30');

    const win10 = getVal('win10');
    const win20 = getVal('win20');
    const win30 = getVal('win30');

    const win10Yn = getVal('win10Yn');
    const win20Yn = getVal('win20Yn');
    const win30Yn = getVal('win30Yn');

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
      maxLoginCount,
      month,
      memId,
      phoneNo,
      rouelette10,
      rouelette20,
      rouelette30,
      win10,
      win20,
      win30,
      win10Yn,
      win20Yn,
      win30Yn,
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

    // 출석 캡슐 수령은 상태를 바꾸므로 재시도하지 않는다.
    const res = await this.fetchWithRetry(
      `${this.baseUrl}/ajax/event/capsuleHist.hm`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Cookie: this.getCookieHeader(),
          'User-Agent': this.userAgent,
          Referer: `${this.baseUrl}/event/attendanceRouletteMain.hm?seq=${info.cntntSeq}`,
          'X-Requested-With': 'XMLHttpRequest',
        },
        body: params.toString(),
      },
      { timeoutMs: HmpClient.WRITE_TIMEOUT_MS, retryable: false },
    );

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

  public getNextAvailableRouletteStep(info: HmpAttendanceInfo): { step: '1' | '2' | '3'; days: number } | null {
    const month = info.month || '';
    const fullDays = month === '02' ? 28 : 30;
    const count = Math.max(info.loginCount || 0, info.maxLoginCount || 0);

    // Step 1: 10일 연속 출석 달성 및 미참여
    if (count >= 10 && info.rouelette10 !== 'Y') {
      return { step: '1', days: 10 };
    }
    // Step 2: 20일 연속 출석 달성 및 Step 1 완료 및 미참여
    if (count >= 20 && info.rouelette10 === 'Y' && info.rouelette20 !== 'Y') {
      return { step: '2', days: 20 };
    }
    // Step 3: 만근 연속 출석 달성 및 Step 2 완료 및 미참여
    if (count >= fullDays && info.rouelette20 === 'Y' && info.rouelette30 !== 'Y') {
      return { step: '3', days: fullDays };
    }

    return null;
  }

  public async spinRoulette(
    step: '1' | '2' | '3',
    memId?: string,
    seq: string = '6712',
  ): Promise<HmpRouletteSpinResult> {
    const daysMap: Record<'1' | '2' | '3', number> = { '1': 10, '2': 20, '3': 30 };
    const stepDays = daysMap[step];

    const params = new URLSearchParams({
      memId: memId || this.currentMemId || '',
      step,
      seq,
    });

    try {
      // 룰렛 회전은 당첨 결과가 이미 확정되었을 수 있으므로 재시도하지 않는다.
      const res = await this.fetchWithRetry(
        `${this.baseUrl}/ajax/event/rouelettePercentage.hm`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Cookie: this.getCookieHeader(),
            'User-Agent': this.userAgent,
            Referer: `${this.baseUrl}/event/attendanceRouletteMain.hm?seq=${seq}`,
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: params.toString(),
        },
        { timeoutMs: HmpClient.WRITE_TIMEOUT_MS, retryable: false },
      );

      if (!res.ok) {
        return {
          step,
          stepDays,
          success: false,
          message: `룰렛 요청 실패 (HTTP ${res.status})`,
        };
      }

      const data = await res.json();
      if (data.code === '800') {
        const winNum = String(data.winNum ?? '');
        const prize = HMP_ROULETTE_PRIZES[winNum] || { type: 'CAPSULE', name: `${winNum}번 경품` };
        return {
          step,
          stepDays,
          success: true,
          winNum,
          prizeName: prize.name,
          prizeType: prize.type,
          point: prize.point,
          message: `${prize.name} 당첨`,
        };
      }

      return {
        step,
        stepDays,
        success: false,
        message: data.message || `룰렛 참여 실패 (코드: ${data.code})`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        step,
        stepDays,
        success: false,
        message: `룰렛 참여 중 오류: ${msg}`,
      };
    }
  }

  public async sendRouletteProduct(
    step: '1' | '2' | '3',
    phoneNo: string,
    seq: string = '6712',
  ): Promise<{ success: boolean; message: string }> {
    const cleanPhone = phoneNo.replace(/[^0-9]/g, '');
    if (cleanPhone.length !== 11) {
      return { success: false, message: `전화번호 형식이 올바르지 않습니다: ${phoneNo}` };
    }

    const params = new URLSearchParams({
      phoneNo: cleanPhone,
      step,
    });

    try {
      // 경품 신청은 중복 제출을 막기 위해 재시도하지 않는다.
      const res = await this.fetchWithRetry(
        `${this.baseUrl}/ajax/event/arSendGiftiShow.hm`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            Cookie: this.getCookieHeader(),
            'User-Agent': this.userAgent,
            Referer: `${this.baseUrl}/event/attendanceRouletteMain.hm?seq=${seq}`,
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: params.toString(),
        },
        { timeoutMs: HmpClient.WRITE_TIMEOUT_MS, retryable: false },
      );

      if (!res.ok) {
        return { success: false, message: `기프티쇼 전송 실패 (HTTP ${res.status})` };
      }

      const data = await res.json();
      if (data.rtn_code === '0000') {
        return { success: true, message: '기프티쇼 전송 완료' };
      }

      return {
        success: false,
        message: data.message || `기프티쇼 전송 오류 (코드: ${data.rtn_code})`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, message: `기프티쇼 전송 중 오류: ${msg}` };
    }
  }

  public async processPendingGifts(info: HmpAttendanceInfo): Promise<void> {
    const phoneNo = info.phoneNo || this.getPhoneFromEnv();
    if (!phoneNo) return;

    const pendingList: Array<{ step: '1' | '2' | '3'; win: string; yn: string }> = [
      { step: '1', win: info.win10 || '', yn: info.win10Yn || '' },
      { step: '2', win: info.win20 || '', yn: info.win20Yn || '' },
      { step: '3', win: info.win30 || '', yn: info.win30Yn || '' },
    ];

    for (const p of pendingList) {
      if (p.yn === 'N' && (p.win === '1' || p.win === '5')) {
        const prizeName = HMP_ROULETTE_PRIZES[p.win]?.name || '경품';
        logger.info(`[HMP] 미수령 당첨 상품 발견 (${prizeName}, step ${p.step}) -> 기프티쇼 발송 시도...`);
        const giftRes = await this.sendRouletteProduct(p.step, phoneNo, info.cntntSeq);
        if (giftRes.success) {
          logger.info(`[HMP] 미수령 기프티쇼 발송 성공 (${prizeName})`);
        } else {
          logger.warn(`[HMP] 미수령 기프티쇼 발송 실패: ${giftRes.message}`);
        }
      }
    }
  }

  public async runRouletteWorkflow(info: HmpAttendanceInfo): Promise<HmpRouletteWorkflowResult> {
    const spins: HmpRouletteSpinResult[] = [];
    const currentInfo: HmpAttendanceInfo = { ...info };

    // 1. 기존 미수령 상품 기프티쇼 발송 처리
    await this.processPendingGifts(currentInfo);

    // 2. 참여 가능한 룰렛 단계 순차 실행
    while (true) {
      const nextStep = this.getNextAvailableRouletteStep(currentInfo);
      if (!nextStep) {
        break;
      }

      logger.info(`[HMP] 연속 ${nextStep.days}일 룰렛 참여 시도 (step: ${nextStep.step})...`);
      const spinRes = await this.spinRoulette(nextStep.step, currentInfo.memId, currentInfo.cntntSeq);
      spins.push(spinRes);

      if (!spinRes.success) {
        logger.warn(`[HMP] 룰렛 step ${nextStep.step} 참여 실패: ${spinRes.message}`);
        break;
      }

      logger.info(`[HMP] 룰렛 step ${nextStep.step} 당첨: ${spinRes.prizeName || spinRes.winNum}`);

      // 상품 당첨인 경우 기프티쇼 발송
      if (spinRes.prizeType === 'PRODUCT') {
        const phoneNo = currentInfo.phoneNo || this.getPhoneFromEnv();
        if (phoneNo) {
          logger.info(`[HMP] 당첨 상품 기프티쇼 발송 시도 (${phoneNo})...`);
          const giftRes = await this.sendRouletteProduct(nextStep.step, phoneNo, currentInfo.cntntSeq);
          spinRes.giftiShowSent = giftRes.success;
          if (giftRes.success) {
            logger.info(`[HMP] 기프티쇼 발송 완료 (${spinRes.prizeName})`);
          } else {
            logger.warn(`[HMP] 기프티쇼 발송 실패: ${giftRes.message}`);
          }
        } else {
          logger.warn('[HMP] 기프티쇼 발송을 위한 휴대폰 번호 부재');
        }
      }

      // 상태 업데이트하여 다음 step 판정 가능하게 함
      if (nextStep.step === '1') currentInfo.rouelette10 = 'Y';
      else if (nextStep.step === '2') currentInfo.rouelette20 = 'Y';
      else if (nextStep.step === '3') currentInfo.rouelette30 = 'Y';
    }

    return {
      attempted: spins.length > 0,
      spins,
    };
  }

  public async runAttendanceWorkflow(username?: string, password?: string): Promise<HmpAttendanceWorkflowResult> {
    const failResult = (message: string): HmpAttendanceWorkflowResult => ({
      success: false,
      message,
      attendance: { status: 'FAILED', message },
    });

    // === 1단계: 로그인. 실패 시 아직 아무 요청도 하지 않은 상태이므로 전체 실패 ===
    let loginSuccess: boolean;
    try {
      loginSuccess = await this.login(username, password);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[HMP] 로그인 중 오류:', err);
      return failResult(`HMP 로그인 중 오류: ${msg}`);
    }

    if (!loginSuccess) {
      return failResult('HMP 로그인에 실패했습니다. 아이디 및 비밀번호를 확인해주세요.');
    }

    // === 2단계: 출석 이벤트 정보 조회. 여기서 실패해도 아직 아무것도 실행되지 않은 상태 ===
    let attInfo: HmpAttendanceInfo;
    try {
      attInfo = await this.getAttendanceInfo();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[HMP] 출석 정보 조회 중 오류:', err);
      return failResult(`출석 이벤트 정보 조회 실패: ${msg}`);
    }

    let attendanceResult: HmpAttendanceResult;
    if (attInfo.isAlreadyAttended) {
      logger.info('[HMP] 이미 당일 출석 캡슐 수령 완료 상태 확인');
      attendanceResult = {
        status: 'ALREADY',
        message: '오늘 이미 출석 캡슐을 수령했습니다.',
      };
    } else {
      logger.info('[HMP] 오늘의 출석 캡슐 받기 시도...');
      try {
        attendanceResult = await this.submitAttendance(attInfo);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('[HMP] 출석 캡슐 요청 중 오류:', err);
        return failResult(`출석 캡슐 요청 실패: ${msg}`);
      }
    }

    // === 3단계 이후: 출석 상태가 이미 확정됨 ===
    // 여기부터는 이후 조회/처리 단계가 실패해도 출석 결과 자체는 성공이다.
    // 기존 구현처럼 전체를 하나의 try/catch로 감싸면 캡슐을 이미 수령했는데도
    // '출석 실패'로 보고되어, 재실행하면 '이미 수령 완료'로 보여 원인을 알 수 없었다.
    const degraded: string[] = [];
    let loginCount = attInfo.loginCount;

    if (attendanceResult.status === 'SUCCESS') {
      try {
        const refreshed = await this.getAttendanceInfo(attInfo.cntntSeq);
        attInfo = refreshed;
        loginCount = refreshed.loginCount;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn('[HMP] 출석 후 상태 재조회 실패 (출석 결과 자체는 정상):', msg);
        degraded.push(`출석 후 상태 재조회 실패: ${msg}`);
      }
    }

    // 4. 룰렛 참여 가능한 경우 룰렛 참여
    let rouletteResult: HmpRouletteWorkflowResult | undefined;
    try {
      rouletteResult = await this.runRouletteWorkflow(attInfo);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[HMP] 룰렛 참여 중 오류 (출석 결과 자체는 정상):', msg);
      degraded.push(`룰렛 참여 실패: ${msg}`);
    }

    // 5. 최신 사용자 정보 및 캡슐 조회
    let userInfo: HmpUserInfo | undefined;
    try {
      userInfo = await this.getUserInfo();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn('[HMP] 사용자 정보 조회 실패 (출석 결과 자체는 정상):', msg);
      degraded.push(`캡슐 현황 조회 실패: ${msg}`);
    }

    return {
      success: true,
      userInfo,
      attendance: attendanceResult,
      loginCount,
      roulette: rouletteResult,
      ...(degraded.length > 0 ? { degradedReason: degraded.join('\n') } : {}),
    };
  }
}
