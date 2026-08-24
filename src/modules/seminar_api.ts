import { httpGet, type HttpResponse } from './http_client';
import type { RawSeminarData, SeminarListItem } from '../tasks/apply_seminar';
import { isAuthExpiredHtml } from './html_parser';

export const MAIN_FUTURE_SEMINARS_API_URL = 'https://m-api.doctorville.co.kr/api/mw/seminars/mainFuture';
export const SEMINAR_DETAIL_API_URL = 'https://m-api.doctorville.co.kr/api/mw/seminars';

export const ProcessState = {
  PROCESS_ENTER: 1, // 입장하기 (라이브 입장 가능)
  PROCESS_APPLY: 2, // 신청하기 (신청 필요/신청 가능)
  PROCESS_CANCEL: 3, // 신청취소 (이미 신청 완료)
  PROCESS_PREPARING: 4, // 대기 중 / 준비 중
  PROCESS_EXCESS: 5, // 신청마감 (정원 초과)
  PROCESS_STARTED: 6, // 라이브 진행 중 (OnAir)
  PROCESS_END: 7, // 방송 종료
  PROCESS_COMPLETED: 8, // 세미나 진행 완료
} as const;

export type ProcessStateType = (typeof ProcessState)[keyof typeof ProcessState];

export const SurveyState = {
  SURVEY_PROGRESS: 1, // 설문 진행 중 (참여 가능)
  SURVEY_COMPLETED: 2, // 설문 참여 완료
  SURVEY_CLOSED: 3, // 설문 마감 / 미제공 / 대상 아님
  SURVEY_UNOPENED: 5, // 설문 미오픈 (진행 예정 / 설문 없음)
} as const;

export type SurveyStateType = (typeof SurveyState)[keyof typeof SurveyState];

export interface SeminarSurveyInfo {
  point?: number | string | null;
  surveyId?: number | string | null;
  hasQuiz?: number | string | null;
  useTy?: number | string | null;
  [key: string]: unknown;
}

export interface FutureSeminarApiItem {
  seminarId: number | string;
  seminarNm: string;
  startDt: string; // e.g. "2026-08-24 13:00:00"
  endDt?: string; // e.g. "2026-08-24 14:00:00"
  tutorNm?: string;
  categoryCdNm?: string;
  diseaseCategoryNm?: string;
  maxPeopleCnt?: number | string;
  applyCnt?: number | string;
  broadcastUrl?: string;
  processState?: string | number;
  cancelProcessState?: string | number;
  seminarCompleted?: boolean | string | number;
  useSurvey?: boolean | string | number | null;
  useDepthSurvey?: boolean | string | number | null;
  survey?: SeminarSurveyInfo | null;
  [key: string]: unknown;
}

export interface MainFutureSeminarsApiResponse {
  futureSeminarList?: {
    items?: FutureSeminarApiItem[];
    [key: string]: unknown;
  };
  code?: number | string;
  message?: string;
  [key: string]: unknown;
}

export type FetchFutureSeminarsResult =
  | {
      success: true;
      items: FutureSeminarApiItem[];
      isAuthExpired?: false;
      errorMessage?: undefined;
      rawResponse: MainFutureSeminarsApiResponse;
    }
  | {
      success: false;
      isAuthExpired: boolean;
      errorMessage: string;
      rawResponse?: unknown;
    };

export interface SeminarMemberInfo {
  applyTy?: number | string | null;
  joinDt?: string | null;
  createDt?: string | null;
  surveyApplyTy?: number | string | null;
  [key: string]: unknown;
}

export interface SeminarDetailApiResponse {
  seminarDetail?: {
    seminarId?: number | string;
    seminarNm?: string;
    survey?: SeminarSurveyInfo | null;
    seminarMember?: SeminarMemberInfo | null;
    payPoint?: number | string | null;
    processState?: number | string;
    cancelProcessState?: number | string;
    seminarCompleted?: number | string | boolean;
    useSurvey?: string | boolean;
    useDepthSurvey?: string | boolean;
    [key: string]: unknown;
  };
  seminarMember?: SeminarMemberInfo | null;
  survey?: SeminarSurveyInfo | null;
  surveyState?: number | string;
  isExistVod?: boolean;
  code?: number | string;
  message?: string;
  [key: string]: unknown;
}

export type FetchSeminarDetailResult =
  | {
      success: true;
      seminarId: string;
      survey?: SeminarSurveyInfo | null;
      surveyState?: number;
      isPointExcluded: boolean;
      hasEntryHistory: boolean;
      isAuthExpired?: false;
      errorMessage?: undefined;
      rawResponse: SeminarDetailApiResponse;
    }
  | {
      success: false;
      seminarId: string;
      isPointExcluded?: undefined;
      hasEntryHistory?: undefined;
      isAuthExpired: boolean;
      errorMessage: string;
      rawResponse?: unknown;
    };

/**
 * 24시간제 기준 야간(저녁) 세미나 여부 판별 (16시 이후 시작)
 */
export function isNightTimeSeminar(startHour: number): boolean {
  return Number.isFinite(startHour) && startHour >= 16;
}

/**
 * 심화 설문 사용 여부 판별
 */
export function checkIsAdvancedSurvey(useDepthSurvey?: boolean | string | number | null): boolean {
  if (useDepthSurvey === true || useDepthSurvey === 1 || useDepthSurvey === '1') return true;
  if (typeof useDepthSurvey === 'string') {
    const trimmed = useDepthSurvey.trim().toUpperCase();
    return trimmed === 'Y' || trimmed === 'TRUE';
  }
  return false;
}

/**
 * 포인트 미지급 세미나 여부 판별
 * survey 객체가 없거나, point 값이 없거나 0 이하인 경우 true (포인트 미지급)
 *
 * 방어적 판정: survey 객체가 있어도 point가 undefined/null이면
 * API 스키마 변경 등으로 인한 누락 가능성이 있으므로 미지급으로 간주
 */
export function checkIsPointExcluded(survey?: SeminarSurveyInfo | null): boolean {
  if (!survey) return true;
  if (survey.point === undefined || survey.point === null) {
    return true;
  }

  const pointNum = Number(survey.point);
  if (Number.isNaN(pointNum) || pointNum <= 0) {
    return true;
  }

  return false;
}

/**
 * 세미나 상세 정보에서 회원 입장이력(joinDt 존재 또는 applyTy === 1) 여부 판별
 */
export function checkHasEntryHistory(
  seminarDetail?: { seminarMember?: SeminarMemberInfo | null } | null,
  seminarMember?: SeminarMemberInfo | null,
): boolean {
  const member = seminarDetail?.seminarMember ?? seminarMember;
  if (!member) return false;
  if (typeof member.joinDt === 'string' && member.joinDt.trim().length > 0) return true;
  if (member.applyTy !== undefined && member.applyTy !== null && Number(member.applyTy) === 1) return true;
  return false;
}

/**
 * startDt, endDt로부터 { date, time, startHour, nightTime } 추출
 * 예: "2026-08-24 13:00:00", "2026-08-24 14:00:00" -> { date: "2026-08-24", time: "13:00~14:00", startHour: 13, nightTime: false }
 */
export function parseSeminarDateTime(
  startDt?: string,
  endDt?: string,
): {
  date: string;
  time: string;
  startHour: number;
  nightTime: boolean;
} {
  if (!startDt) {
    return { date: '', time: '', startHour: NaN, nightTime: false };
  }

  const cleanStart = startDt.trim().replace('T', ' ');
  const parts = cleanStart.split(' ');
  const datePart = parts[0] || '';
  const startTimeFull = parts[1] || '';

  // 시간 추출 (HH:mm)
  const startHM = startTimeFull.slice(0, 5);
  let startHour = NaN;
  if (startHM.includes(':')) {
    startHour = parseInt(startHM.split(':')[0], 10);
  }

  let timeRange = startHM;
  if (endDt) {
    const cleanEnd = endDt.trim().replace('T', ' ');
    const endParts = cleanEnd.split(' ');
    const endTimeFull = endParts[1] || endParts[0] || '';
    const endHM = endTimeFull.slice(0, 5);
    if (endHM) {
      timeRange = `${startHM}~${endHM}`;
    }
  }

  const nightTime = isNightTimeSeminar(startHour);

  return {
    date: datePart,
    time: timeRange,
    startHour,
    nightTime,
  };
}

/**
 * API 응답 아이템을 RawSeminarData 구조로 변환
 */
export function convertApiItemToRawSeminar(item: FutureSeminarApiItem): RawSeminarData {
  const { date, time, nightTime } = parseSeminarDateTime(item.startDt, item.endDt);
  const seminarId = String(item.seminarId ?? '');
  const url = `https://m.doctorville.co.kr/cme/seminar/${seminarId}`;
  const isAdvancedSurvey = checkIsAdvancedSurvey(item.useDepthSurvey);
  const processStateNum = item.processState !== undefined ? Number(item.processState) : undefined;
  const cancelProcessStateNum = item.cancelProcessState !== undefined ? Number(item.cancelProcessState) : undefined;
  const seminarCompletedNum =
    item.seminarCompleted !== undefined
      ? typeof item.seminarCompleted === 'boolean'
        ? item.seminarCompleted
          ? 1
          : 0
        : Number(item.seminarCompleted)
      : undefined;
  const hasIcoApply = processStateNum === ProcessState.PROCESS_APPLY;

  return {
    seminarId,
    url,
    name: item.seminarNm || '세미나',
    date,
    time,
    currentCount: item.applyCnt !== undefined && item.applyCnt !== null ? String(item.applyCnt) : '',
    totalCount: item.maxPeopleCnt !== undefined && item.maxPeopleCnt !== null ? String(item.maxPeopleCnt) : '',
    nightTime,
    isAdvancedSurvey,
    hasIcoApply,
    processState: processStateNum,
    cancelProcessState: cancelProcessStateNum,
    seminarCompleted: seminarCompletedNum,
  };
}

/**
 * API 응답 아이템을 SeminarListItem 구조로 변환
 */
export function convertApiItemToSeminarListItem(item: FutureSeminarApiItem, referenceDate?: string): SeminarListItem {
  const { date, time, nightTime } = parseSeminarDateTime(item.startDt, item.endDt);
  const seminarId = String(item.seminarId ?? '');
  const url = `https://m.doctorville.co.kr/cme/seminar/${seminarId}`;
  const isAdvancedSurvey = checkIsAdvancedSurvey(item.useDepthSurvey);
  const nowIso = referenceDate || new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  const processStateNum = item.processState !== undefined ? Number(item.processState) : undefined;
  const cancelProcessStateNum = item.cancelProcessState !== undefined ? Number(item.cancelProcessState) : undefined;
  const seminarCompletedNum =
    item.seminarCompleted !== undefined
      ? typeof item.seminarCompleted === 'boolean'
        ? item.seminarCompleted
          ? 1
          : 0
        : Number(item.seminarCompleted)
      : undefined;

  return {
    seminarId,
    name: item.seminarNm || '세미나',
    url,
    date,
    time,
    currentCount: item.applyCnt !== undefined && item.applyCnt !== null ? String(item.applyCnt) : '',
    totalCount: item.maxPeopleCnt !== undefined && item.maxPeopleCnt !== null ? String(item.maxPeopleCnt) : '',
    nightTime,
    isAdvancedSurvey,
    processState: processStateNum,
    cancelProcessState: cancelProcessStateNum,
    seminarCompleted: seminarCompletedNum,
    detectedDate: nowIso,
  };
}

/**
 * 메인 세미나 리스트 API (GET /api/mw/seminars/mainFuture) 호출
 */
export async function fetchMainFutureSeminars(
  customUrl: string = MAIN_FUTURE_SEMINARS_API_URL,
): Promise<FetchFutureSeminarsResult> {
  try {
    const res: HttpResponse = await httpGet(customUrl, {
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://m.doctorville.co.kr/',
    });

    if (res.resultType === 'AUTH_EXPIRED' || isAuthExpiredHtml(res.body)) {
      return {
        success: false,
        isAuthExpired: true,
        errorMessage: '세션이 만료되었습니다. 로그인이 필요합니다.',
      };
    }

    if (res.status !== 200 || !res.body) {
      return {
        success: false,
        isAuthExpired: false,
        errorMessage: `HTTP GET ${customUrl} 실패 (상태 코드: ${res.status}, ${res.statusText})`,
      };
    }

    let parsed: MainFutureSeminarsApiResponse;
    try {
      parsed = JSON.parse(res.body);
    } catch (parseErr) {
      return {
        success: false,
        isAuthExpired: false,
        errorMessage: `API 응답 JSON 파싱 실패: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        rawResponse: res.body,
      };
    }

    if (parsed.code === 401 || parsed.code === '401' || parsed.message?.includes('로그인')) {
      return {
        success: false,
        isAuthExpired: true,
        errorMessage: parsed.message || '로그인이 필요합니다.',
        rawResponse: parsed,
      };
    }

    const items = parsed.futureSeminarList?.items;
    if (!Array.isArray(items)) {
      return {
        success: false,
        isAuthExpired: false,
        errorMessage: `API 응답 구조 이상: futureSeminarList.items가 배열이 아닙니다 (타입: ${typeof items}, futureSeminarList 타입: ${typeof parsed.futureSeminarList})`,
        rawResponse: parsed,
      };
    }

    return {
      success: true,
      items,
      rawResponse: parsed,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      isAuthExpired: false,
      errorMessage: `fetchMainFutureSeminars 요청 중 예외 발생: ${errorMessage}`,
    };
  }
}

/**
 * 개별 세미나 상세 API (GET /api/mw/seminars/${seminarId}) 호출하여
 * 정확한 설문 포인트 정보 및 포인트 미지급 여부 판정
 */
export async function fetchSeminarDetail(
  seminarId: number | string,
  baseUrl: string = SEMINAR_DETAIL_API_URL,
): Promise<FetchSeminarDetailResult> {
  const sid = String(seminarId).trim();
  const url = `${baseUrl}/${sid}`;

  try {
    const res: HttpResponse = await httpGet(url, {
      Accept: 'application/json, text/plain, */*',
      Referer: 'https://m.doctorville.co.kr/',
    });

    if (res.resultType === 'AUTH_EXPIRED' || isAuthExpiredHtml(res.body)) {
      return {
        success: false,
        seminarId: sid,
        isAuthExpired: true,
        errorMessage: '세션이 만료되었습니다. 로그인이 필요합니다.',
      };
    }

    if (res.status !== 200 || !res.body) {
      return {
        success: false,
        seminarId: sid,
        isAuthExpired: false,
        errorMessage: `HTTP GET ${url} 실패 (상태 코드: ${res.status}, ${res.statusText})`,
      };
    }

    let parsed: SeminarDetailApiResponse;
    try {
      parsed = JSON.parse(res.body);
    } catch (parseErr) {
      return {
        success: false,
        seminarId: sid,
        isAuthExpired: false,
        errorMessage: `세미나 상세 API 응답 JSON 파싱 실패: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        rawResponse: res.body,
      };
    }

    if (parsed.code === 401 || parsed.code === '401' || parsed.message?.includes('로그인')) {
      return {
        success: false,
        seminarId: sid,
        isAuthExpired: true,
        errorMessage: parsed.message || '로그인이 필요합니다.',
        rawResponse: parsed,
      };
    }

    // seminarDetail?.survey 또는 survey 객체 추출
    const survey = parsed.seminarDetail?.survey ?? parsed.survey ?? null;
    const isPointExcluded = checkIsPointExcluded(survey);
    const hasEntryHistory = checkHasEntryHistory(parsed.seminarDetail, parsed.seminarMember);
    const surveyState =
      parsed.surveyState !== undefined
        ? Number(parsed.surveyState)
        : parsed.seminarDetail && (parsed.seminarDetail as { surveyState?: unknown }).surveyState !== undefined
          ? Number((parsed.seminarDetail as { surveyState?: unknown }).surveyState)
          : undefined;

    return {
      success: true,
      seminarId: sid,
      survey,
      surveyState,
      isPointExcluded,
      hasEntryHistory,
      rawResponse: parsed,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      seminarId: sid,
      isAuthExpired: false,
      errorMessage: `fetchSeminarDetail(${sid}) 요청 중 예외 발생: ${errorMessage}`,
    };
  }
}
