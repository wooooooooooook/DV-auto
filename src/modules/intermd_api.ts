import fs from 'fs';
import path from 'path';
import { request } from 'undici';
import * as dbStorage from '../services/storage';

export interface InterMDMemberInfo {
  intermdMemberPseq?: number;
  memberId?: string;
  memberName?: string;
  memberAuth?: number;
  memberPoint?: number;
  memberMajorsNm?: string;
  memberHospitalType?: string;
  [key: string]: unknown;
}

export interface InterMDQuizItem {
  item_pseq: number;
  title: string;
  order: number;
  is_answer_hint: boolean;
}

export interface InterMDQuizQuestion {
  ques_pseq: number;
  title: string;
  order: number;
  type: number;
  items: InterMDQuizItem[];
}

export interface InterMDTodayQuiz {
  quiz_pseq: number;
  poll_pseq: number;
  page_pseq: number;
  quiz_group_pseq: number;
  quiz_group_type: number;
  quiz_group_title: string;
  quiz_title: string;
  date: string;
  hint: string;
  guide: string;
  already_submitted: boolean;
  questions: InterMDQuizQuestion[];
}

export interface InterMDSubmitResult {
  success: boolean;
  already_submitted?: boolean;
  message: string;
  quiz_title?: string;
  submitted_item?: InterMDQuizItem;
  is_correct?: boolean;
  raw?: unknown;
}

export interface InterMDLoginResult {
  success: boolean;
  status_code: string;
  message: string;
  session_key?: string;
  member_info?: InterMDMemberInfo;
  raw?: unknown;
}

export interface InterMDClientOptions {
  baseUrl?: string;
  envPath?: string;
}

const STORAGE_SESSION_COOKIES_KEY = 'intermd:session_cookies';
const STORAGE_MEMBER_INFO_KEY = 'intermd:member_info';
const STORAGE_SESSION_KEY = 'intermd:session_key';

export function loadEnvFromFile(filePath: string): Record<string, string> {
  const envVars: Record<string, string> = {};
  if (!fs.existsSync(filePath)) {
    return envVars;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([a-zA-Z0-9_]+)\s*[:=]\s*["']?(.*?)["']?$/);
      if (match) {
        envVars[match[1]] = match[2];
      }
    }
  } catch (_e) {
    /* ignore */
  }
  return envVars;
}

export class InterMDClient {
  public baseUrl: string;
  private cookies: Map<string, string> = new Map();
  public memberInfo: InterMDMemberInfo | null = null;
  public sessionKey: string | null = null;
  private envPath: string;

  constructor(options: InterMDClientOptions = {}) {
    this.baseUrl = options.baseUrl || 'https://www.intermd.co.kr';
    this.envPath = options.envPath || path.join(process.cwd(), '.env');
    this.loadSessionFromStorage();
  }

  public getCookieString(): string {
    const pairs: string[] = [];
    for (const [key, value] of this.cookies.entries()) {
      pairs.push(`${key}=${value}`);
    }
    return pairs.join('; ');
  }

  public setCookies(cookies: Record<string, string>): void {
    for (const [key, value] of Object.entries(cookies)) {
      this.cookies.set(key, value);
    }
    this.saveSessionToStorage();
  }

  public extractAndStoreCookies(setCookieHeader: string | string[] | undefined): void {
    if (!setCookieHeader) return;
    const headers = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
    for (const header of headers) {
      const parts = header.split(';');
      if (parts.length > 0) {
        const cookiePair = parts[0].trim();
        const eqIdx = cookiePair.indexOf('=');
        if (eqIdx !== -1) {
          const key = cookiePair.substring(0, eqIdx).trim();
          const val = cookiePair.substring(eqIdx + 1).trim();
          if (key) {
            this.cookies.set(key, val);
          }
        }
      }
    }
    this.saveSessionToStorage();
  }

  public saveSessionToStorage(): void {
    const cookiesObj: Record<string, string> = {};
    for (const [key, value] of this.cookies.entries()) {
      cookiesObj[key] = value;
    }
    dbStorage.set(STORAGE_SESSION_COOKIES_KEY, cookiesObj);
    if (this.memberInfo) {
      dbStorage.set(STORAGE_MEMBER_INFO_KEY, this.memberInfo);
    }
    if (this.sessionKey) {
      dbStorage.set(STORAGE_SESSION_KEY, this.sessionKey);
    }
  }

  public loadSessionFromStorage(): boolean {
    try {
      const storedCookies = dbStorage.get<Record<string, string>>(STORAGE_SESSION_COOKIES_KEY, null);
      if (storedCookies && typeof storedCookies === 'object') {
        for (const [key, value] of Object.entries(storedCookies)) {
          this.cookies.set(key, value);
        }
      }
      this.memberInfo = dbStorage.get<InterMDMemberInfo>(STORAGE_MEMBER_INFO_KEY, null);
      this.sessionKey = dbStorage.get<string>(STORAGE_SESSION_KEY, null);
      return this.cookies.size > 0;
    } catch (_e) {
      return false;
    }
  }

  public getCredentials(): { userId: string; userPw: string } {
    let userId = process.env.INTERMD_USER_ID?.trim() || '';
    let userPw = process.env.INTERMD_USER_PW?.trim() || '';

    if (!userId || !userPw) {
      if (fs.existsSync(this.envPath)) {
        const envs = loadEnvFromFile(this.envPath);
        if (!userId) userId = envs.INTERMD_USER_ID?.trim() || '';
        if (!userPw) userPw = envs.INTERMD_USER_PW?.trim() || '';
      }
    }

    return { userId, userPw };
  }

  public async requestHttp(
    endpoint: string,
    options: {
      method?: 'GET' | 'POST';
      body?: Record<string, string | number | undefined> | string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; data: any; headers: Record<string, string | string[]> }> {
    const url = endpoint.startsWith('http') ? endpoint : `${this.baseUrl}${endpoint}`;
    const method = options.method || 'GET';
    const reqHeaders: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: `${this.baseUrl}/home.do`,
      Origin: this.baseUrl,
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      ...options.headers,
    };

    const cookieStr = this.getCookieString();
    if (cookieStr) {
      reqHeaders['Cookie'] = cookieStr;
    }

    let bodyData: string | undefined = undefined;
    if (options.body) {
      if (typeof options.body === 'string') {
        bodyData = options.body;
      } else {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(options.body)) {
          if (v !== undefined) {
            params.append(k, String(v));
          }
        }
        bodyData = params.toString();
        if (!reqHeaders['Content-Type']) {
          reqHeaders['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
        }
      }
    }

    const res = await request(url, {
      method,
      headers: reqHeaders,
      body: bodyData,
    });

    const resHeaders: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(res.headers)) {
      if (v !== undefined) {
        resHeaders[k.toLowerCase()] = v;
      }
    }

    this.extractAndStoreCookies(resHeaders['set-cookie']);

    const text = await res.body.text();
    let data: any = null;
    try {
      data = JSON.parse(text);
    } catch (_e) {
      data = text;
    }

    return {
      status: res.statusCode,
      data,
      headers: resHeaders,
    };
  }

  public async login(memberId?: string, memberPw?: string): Promise<InterMDLoginResult> {
    const creds = this.getCredentials();
    const id = memberId || creds.userId;
    const pw = memberPw || creds.userPw;

    if (!id || !pw) {
      return {
        success: false,
        status_code: '-1',
        message: '인터엠디 로그인 계정 정보(ID/PW)가 설정되지 않았습니다.',
      };
    }

    const res = await this.requestHttp('/login/login.do', {
      method: 'POST',
      body: {
        memberId: id,
        memberPw: pw,
        renewYn: '',
        uuid: '',
        pushKey: '',
        device: 'W',
        DM_FINAL_DATA: 'A',
      },
    });

    const data = res.data || {};
    const status = String(data.loginStatus || '');

    if (['1', '5', '6'].includes(status)) {
      this.sessionKey = data.sessionKey || null;
      this.memberInfo = data.memberInfo || null;
      this.saveSessionToStorage();
      return {
        success: true,
        status_code: status,
        message: '로그인 성공',
        session_key: this.sessionKey || undefined,
        member_info: this.memberInfo || undefined,
        raw: data,
      };
    } else {
      const errorMessages: Record<string, string> = {
        '0': '회원 가입 승인 대기 중입니다.',
        '4': '아이디/비밀번호 오류 또는 의사면허 갱신이 필요합니다.',
        '-7': 'UUID 또는 푸시키가 유효하지 않습니다.',
        '-8': '로그인 처리 중 서버 오류가 발생하였습니다.',
        '-9': '입력한 아이디와 비밀번호가 일치하지 않습니다.',
      };
      const msg = errorMessages[status] || `로그인 실패 (코드: ${status})`;
      return {
        success: false,
        status_code: status,
        message: msg,
        raw: data,
      };
    }
  }

  public async getSession(): Promise<{ code: string; memberInfo: InterMDMemberInfo | null }> {
    const res = await this.requestHttp('/login/getSession.do', {
      method: 'POST',
      body: {},
    });
    return res.data;
  }

  public async checkAuth(): Promise<boolean> {
    try {
      const res = await this.getSession();
      return !!(res && res.memberInfo);
    } catch (_e) {
      return false;
    }
  }

  public async ensureAuthenticated(): Promise<boolean> {
    const isAuthed = await this.checkAuth();
    if (isAuthed) return true;

    const loginRes = await this.login();
    return loginRes.success;
  }

  public async getTodayQuiz(): Promise<InterMDTodayQuiz | null> {
    const resToday = await this.requestHttp('/quiz/getTodayQuiz.do', { method: 'GET' });
    const todayData = resToday.data?.data;
    if (!todayData || !todayData.quizPseq) {
      return null;
    }

    const quizPseq = Number(todayData.quizPseq);
    const pollPseq = Number(todayData.pollPseq);

    const resQuiz = await this.requestHttp('/quiz/getQuiz.do', {
      method: 'POST',
      body: { quizPseq },
    });

    const quizInfo = resQuiz.data?.quizInfo || {};
    const pageInfo = resQuiz.data?.pageInfo || {};
    const quesList = resQuiz.data?.quesInfo || [];
    const quizUserCheck = Number(resQuiz.data?.quizUserCheck || 0);

    const questions: InterMDQuizQuestion[] = [];
    for (const ques of quesList) {
      const quesPseq = Number(ques.quesPseq);
      const resItems = await this.requestHttp('/poll/getQuesItemInfo.do', {
        method: 'POST',
        body: { pollPseq, quesPseq },
      });

      const itemsRaw = resItems.data?.quesItemInfo || [];
      const items: InterMDQuizItem[] = itemsRaw.map((item: any) => ({
        item_pseq: Number(item.quesItemPseq),
        title: String(item.quesItemTitle || ''),
        order: Number(item.quesItemOrder || 0),
        is_answer_hint: String(item.quesItemTitleAdd || '').toUpperCase() === 'Y',
      }));

      questions.push({
        ques_pseq: quesPseq,
        title: String(ques.quesTitle || ''),
        order: Number(ques.quesOrder || 0),
        type: Number(ques.quesType || 0),
        items,
      });
    }

    return {
      quiz_pseq: quizPseq,
      poll_pseq: pollPseq,
      page_pseq: Number(pageInfo.pagePseq || 0),
      quiz_group_pseq: Number(quizInfo.quizGroupPseq || 0),
      quiz_group_type: Number(quizInfo.quizGroupType || 0),
      quiz_group_title: String(quizInfo.quizGroupTitle || ''),
      quiz_title: String(quizInfo.quizTitle || ''),
      date: `${quizInfo.showDtFrm || ''} (${quizInfo.showDtWeek || ''})`.trim(),
      hint: String(quizInfo.quizHintText || ''),
      guide: String(quizInfo.quizGuideText || ''),
      already_submitted: quizUserCheck > 0,
      questions,
    };
  }

  public async submitTodayQuiz(quiz?: InterMDTodayQuiz | null, choiceItemPseq?: number): Promise<InterMDSubmitResult> {
    const targetQuiz = quiz || (await this.getTodayQuiz());
    if (!targetQuiz) {
      return { success: false, message: '오늘의 퀴즈 데이터를 찾을 수 없습니다.' };
    }

    if (targetQuiz.already_submitted) {
      return {
        success: true,
        already_submitted: true,
        message: '이미 오늘의 퀴즈 참여를 완료하였습니다.',
        quiz_title: targetQuiz.quiz_title,
      };
    }

    if (!targetQuiz.questions || targetQuiz.questions.length === 0) {
      return { success: false, message: '퀴즈 문제 목록이 비어있습니다.' };
    }

    const ques = targetQuiz.questions[0];
    const items = ques.items || [];

    let targetItem: InterMDQuizItem | undefined = undefined;
    if (choiceItemPseq !== undefined) {
      targetItem = items.find((it) => it.item_pseq === choiceItemPseq);
    } else {
      // 자동 정답 선택 (is_answer_hint == true)
      targetItem = items.find((it) => it.is_answer_hint) || items[0];
    }

    if (!targetItem) {
      return { success: false, message: '제출할 유효한 보기를 선택하지 못했습니다.' };
    }

    const isCorrect = targetItem.is_answer_hint ? 'Y' : 'N';

    const pollResult = {
      quesitemtitleadd: isCorrect,
      quizPseq: targetQuiz.quiz_pseq,
      pollPseq: targetQuiz.poll_pseq,
      quizGroupPseq: targetQuiz.quiz_group_pseq,
      quizGroupType: targetQuiz.quiz_group_type,
      quizGroupTitle: targetQuiz.quiz_group_title,
      pagePseq: targetQuiz.page_pseq,
      checkItemTitle: targetItem.title,
      answers: [
        {
          quesPseq: ques.ques_pseq,
          quesItemPseq: targetItem.item_pseq,
        },
      ],
    };

    const res = await this.requestHttp('/quiz/saveAjax.do', {
      method: 'POST',
      body: {
        data: JSON.stringify(pollResult),
        finishYn: 'Y',
        progress: 0,
        pollPseq: targetQuiz.poll_pseq,
        quizPseq: targetQuiz.quiz_pseq,
        quizGroupPseq: targetQuiz.quiz_group_pseq,
        quizGroupType: targetQuiz.quiz_group_type,
        quesitemtitleadd: isCorrect,
      },
    });

    const resData = res.data || {};
    if (resData.code === 'SUCC') {
      return {
        success: true,
        already_submitted: false,
        message: '답안 제출 및 퀴즈 완료 성공',
        quiz_title: targetQuiz.quiz_title,
        submitted_item: targetItem,
        is_correct: isCorrect === 'Y',
        raw: resData,
      };
    } else {
      return {
        success: false,
        message: resData.msg || '답안 제출 실패',
        quiz_title: targetQuiz.quiz_title,
        raw: resData,
      };
    }
  }
}
