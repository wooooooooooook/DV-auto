import { httpGet, type HttpResponse } from './http_client';
import type { RawSeminarData, SeminarListItem } from '../tasks/apply_seminar';
import { isAuthExpiredHtml } from './html_parser';

export const MAIN_FUTURE_SEMINARS_API_URL = 'https://m-api.doctorville.co.kr/api/mw/seminars/mainFuture';
export const SEMINAR_DETAIL_API_URL = 'https://m-api.doctorville.co.kr/api/mw/seminars';

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

export interface SeminarDetailApiResponse {
  seminarDetail?: {
    seminarId?: number | string;
    seminarNm?: string;
    survey?: SeminarSurveyInfo | null;
    payPoint?: number | string | null;
    [key: string]: unknown;
  };
  survey?: SeminarSurveyInfo | null;
  code?: number | string;
  message?: string;
  [key: string]: unknown;
}

export type FetchSeminarDetailResult =
  | {
      success: true;
      seminarId: string;
      survey?: SeminarSurveyInfo | null;
      isPointExcluded: boolean;
      isAuthExpired?: false;
      errorMessage?: undefined;
      rawResponse: SeminarDetailApiResponse;
    }
  | {
      success: false;
      seminarId: string;
      isPointExcluded?: undefined;
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
 * survey?.point 가 없거나 0 이하인 경우 true (포인트 미지급)
 */
export function checkIsPointExcluded(survey?: SeminarSurveyInfo | null): boolean {
  if (!survey) return true;
  if (survey.point === undefined || survey.point === null) return true;

  const pointNum = Number(survey.point);
  if (Number.isNaN(pointNum) || pointNum <= 0) {
    return true;
  }

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

  return {
    url,
    name: item.seminarNm || '세미나',
    date,
    time,
    currentCount: item.applyCnt !== undefined && item.applyCnt !== null ? String(item.applyCnt) : '',
    totalCount: item.maxPeopleCnt !== undefined && item.maxPeopleCnt !== null ? String(item.maxPeopleCnt) : '',
    nightTime,
    isAdvancedSurvey,
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
        success: true,
        items: [],
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

    return {
      success: true,
      seminarId: sid,
      survey,
      isPointExcluded,
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
