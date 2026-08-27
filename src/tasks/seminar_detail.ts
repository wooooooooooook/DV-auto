import { httpGetJson } from '../modules/http_client';
import * as logger from '../services/logger';
import {
  parseSeminarDateTime,
  checkIsAdvancedSurvey,
  checkIsPointExcluded,
  ProcessState,
  SurveyState,
} from '../modules/seminar_api';
import { type SeminarListItem } from './apply_seminar';
import * as seminarRepo from '../services/seminar_repository';
import { getSeminarIdFromUrl } from '../modules/utils';

const SEMINAR_DETAIL_API = 'https://m-api.doctorville.co.kr/api/mw/seminars/';

export interface SeminarDetail {
  seminarId: number;
  seminarTy: number;
  seminarNm: string;
  regUsn: number;
  startDt: string;
  endDt: string;
  maxPeopleCnt: number;
  intro: string;
  tutorId: number;
  tutorNm: string;
  surveyId: number | null;
  categoryCd: number;
  createDt: string;
  updateDt: string | null;
  introImg: string;
  attachFileOrigin: string;
  viewCnt: number;
  applyCnt: number;
  scrapId: string | null;
  userTy: number;
  memberCreateDt: string | null;
  broadcastUrl: string;
  broadcastUrl2: string;
  broadcastTy: number;
  broadcastTy2: number;
  diseaseCategoryNm: string;
  diseaseCategoryCd: string;
  hiddenYn: string;
  allowUsn: string | null;
  chattingRoom: string;
  payPoint: string | null;
  seminarVod: string | null;
  seminarVodReplay: string | null;
  seminarTutor: string | null;
  regUser: string | null;
  survey: SeminarSurvey | null;
  seminarMember: SeminarMember | null;
  tag: string | null;
  regChk: number;
  showFg: string | null;
  vodMarkerList: string | null;
  seminarCompleted: number;
  useSurvey: string;
  useDepthSurvey: string;
  useVod: string;
  useVodNotify: string;
  keyMessage: string;
  encIntroImg: string;
  encAttachFilePath: string;
  categoryCdNm: string;
  processState: number;
  cancelProcessState: number;
  startMonthAndDay: string;
  startDayOfWeek: string;
  endTime: string;
  startTime: string;
}

export interface SeminarSurvey {
  surveyId: number;
  surveyType: string | null;
  title: string;
  point: number;
  pointTy: string | null;
  pointPayDt: string | null;
  startDt: string;
  endDt: string;
  surveyResultImg: string | null;
  surveyQuizPass: string | null;
  hasQuiz: number;
  infoAgreeUse: number;
  infoReceiver: string;
  infoRange: string;
  infoPurpose: string;
  createDt: string;
  updateDt: string | null;
  availabiliTy: string | null;
  targetRangeList: string | null;
  surveyUrl: string | null;
  callbackParam: string | null;
  nowMemberCount: string | null;
  surveyTarget: string | null;
  usePick: string | null;
  useLimitUser: string | null;
  useEnterCount: string | null;
  pickStartDt: string | null;
  pickEndDt: string | null;
  validRangeStartDt: string | null;
  validRangeEndDt: string | null;
  itemCount: number;
  limitUserCount: number;
  limitEnterCount: number;
  isMember: number;
  surveyCode: string | null;
  seminarId: number;
  useTy: number;
  encryptSurveyResultImg: string;
  surveyTypeNm: string;
  fromToFormat1: string;
  payDtFormat1: string;
  ablePick: boolean;
  surveyMinutesLeft: number;
}

export interface SeminarMember {
  app: string | null;
  method: string | null;
  api: string | null;
  smId: number;
  seminarId: number;
  applyUsn: number;
  applyTy: number;
  shortUrl: string | null;
  fullUrl: string | null;
  createDt: string;
  joinDt: string;
  userTy: number;
  surveyApplyTy: number;
  surveyRewardPaid: string | null;
  surveyQuizPass: string | null;
  provideAgree: number;
  surveyJoinDt: string | null;
  isAggree: string | null;
}

export interface SeminarDetailResponse {
  seminarDetail: SeminarDetail;
  termsInfo: string | null;
  timeDiff: number;
  isScraped: boolean;
  seminarNotifyMember: SeminarNotifyMember;
  accessAllowed: boolean;
  replyCnt: number;
  seminarAggreeInfo: SeminarAggreeInfo;
  surveyState: number;
  isExistVod: boolean;
}

export interface SeminarNotifyMember {
  snmId: number;
  seminarId: number;
  usn: number;
  isReceive: string;
  isVodNotified: string;
  notifiedResult: string;
  createDt: string;
  updateDt: string | null;
  notifiedDt: string | null;
}

export interface SeminarAggreeInfo {
  aggreeId: number;
  seminarId: number;
  supplyer: string;
  supplyContent: string;
  purpose: string;
  createDt: number;
  contents: string | null;
  agreeType: string;
  isActive: number;
}

export function convertDetailToSeminarListItem(data: SeminarDetail, _raw?: SeminarDetailResponse): SeminarListItem {
  const { date, time, nightTime } = parseSeminarDateTime(data.startDt, data.endDt);
  const isAdvancedSurvey = checkIsAdvancedSurvey(data.useDepthSurvey);
  const isPointExcluded = checkIsPointExcluded(data.intro);
  const processStateNum = data.processState !== undefined ? Number(data.processState) : undefined;
  const cancelProcessStateNum = data.cancelProcessState !== undefined ? Number(data.cancelProcessState) : undefined;
  const seminarCompletedNum =
    data.seminarCompleted !== undefined
      ? typeof data.seminarCompleted === 'boolean'
        ? data.seminarCompleted
          ? 1
          : 0
        : Number(data.seminarCompleted)
      : undefined;
  const hiddenYn = typeof data.hiddenYn === 'string' ? data.hiddenYn : undefined;
  const isClosed = hiddenYn === 'Y' || hiddenYn === 'y';
  const diseaseCategoryNm = typeof data.diseaseCategoryNm === 'string' ? data.diseaseCategoryNm : undefined;

  let detectedDate = '';
  if (typeof data.createDt === 'string' && data.createDt.trim().length > 0) {
    detectedDate = data.createDt.split(' ')[0] || '';
  }
  if (!detectedDate) {
    detectedDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  }

  const now = new Date().toISOString();

  return {
    seminarId: String(data.seminarId),
    name: data.seminarNm || '',
    url: `https://m.doctorville.co.kr/cme/seminar/${data.seminarId}`,
    date: date || '',
    time: time || '',
    currentCount: data.applyCnt !== undefined && data.applyCnt !== null ? String(data.applyCnt) : '',
    totalCount: data.maxPeopleCnt !== undefined && data.maxPeopleCnt !== null ? String(data.maxPeopleCnt) : '',
    nightTime,
    isAdvancedSurvey,
    isPointExcluded,
    processState: processStateNum,
    cancelProcessState: cancelProcessStateNum,
    seminarCompleted: seminarCompletedNum,
    isClosed,
    hiddenYn,
    diseaseCategoryNm,
    detectedDate,
    detectedAt: now,
  };
}

const SEMINAR_RETENTION_DAYS = 60;

export function isSeminarExpired(
  seminarDate: string | undefined,
  referenceDate: string,
  retentionDays = SEMINAR_RETENTION_DAYS,
): boolean {
  if (!seminarDate) return false;
  const match = seminarDate.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  let isoDate = '';
  if (match) {
    isoDate = `${match[1]}-${String(match[2]).padStart(2, '0')}-${String(match[3]).padStart(2, '0')}`;
  } else {
    const md = seminarDate.match(/^(\d{1,2})\s*[-/.]\s*(\d{1,2})/);
    if (md) {
      const year = new Date().getFullYear();
      isoDate = `${year}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;
    }
  }
  if (!isoDate) return false;
  const todayMs = Date.parse(`${referenceDate}T00:00:00+09:00`);
  const dateMs = Date.parse(`${isoDate}T00:00:00+09:00`);
  if (Number.isNaN(todayMs) || Number.isNaN(dateMs)) return false;
  return todayMs - dateMs > retentionDays * 24 * 60 * 60 * 1000;
}

export function updateStoredSeminarFromDetail(data: SeminarDetail, raw?: SeminarDetailResponse): SeminarListItem[] {
  const sid = String(data.seminarId);
  const incoming = convertDetailToSeminarListItem(data, raw);
  const referenceDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

  // 60일 이상 지난 과거 세미나는 새로 추가하지 않음
  const isIncomingExpired = isSeminarExpired(incoming.date || data.startDt, referenceDate);

  if (!isIncomingExpired) {
    seminarRepo.upsertSeminar(incoming);
    logger.info(`Updated seminar_list with seminar ${sid} from detail inquiry`);
  } else {
    logger.info(`세미나 ${sid}는 60일 이상 지난 세미나이므로 seminar_list에 저장하지 않았습니다.`);
  }

  seminarRepo.deleteExpiredSeminars(referenceDate);
  return seminarRepo.getAllSeminars();
}

export async function fetchSeminarDetail(
  seminarId: string,
  options?: { updateList?: boolean },
): Promise<{ success: boolean; data?: SeminarDetail; raw?: SeminarDetailResponse; error?: string }> {
  try {
    const url = `${SEMINAR_DETAIL_API}${seminarId}`;
    const response = await httpGetJson<SeminarDetailResponse>(url);

    if (!response.seminarDetail) {
      return { success: false, error: '세미나 정보를 찾을 수 없습니다.' };
    }

    if (options?.updateList !== false) {
      try {
        updateStoredSeminarFromDetail(response.seminarDetail, response);
      } catch (err) {
        logger.warn(`Failed to update seminar list for seminar ${seminarId}:`, err);
      }
    }

    return { success: true, data: response.seminarDetail, raw: response };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('fetchSeminarDetail error', { seminarId, error: errorMsg });
    return { success: false, error: `세미나 상세 조회 실패: ${errorMsg}` };
  }
}

function formatDateTime(
  startDt: string,
  endDt: string,
  startTime: string,
  endTime: string,
  startMonthAndDay: string,
): string {
  // API가 이미 파싱된 시간 문자열 제공: startTime="13:00", endTime="14:00", startMonthAndDay="8/21"
  // 서버 timezone 의존성 제거: Date 파싱 없이 그대로 사용
  return `${startMonthAndDay} ${startTime}~${endTime}`;
}

export function formatStatus(processState?: number, seminarCompleted?: number, _cancelProcessState?: number): string {
  if (seminarCompleted === 1 || processState === ProcessState.PROCESS_COMPLETED) {
    return '진행 완료';
  }
  switch (processState) {
    case ProcessState.PROCESS_ENTER: // 1
      return '입장 가능 (LIVE)';
    case ProcessState.PROCESS_APPLY: // 2
      return '신청 가능';
    case ProcessState.PROCESS_CANCEL: // 3
      return '신청 완료 (진행 예정)';
    case ProcessState.PROCESS_PREPARING: // 4
      return '방송 준비 중';
    case ProcessState.PROCESS_EXCESS: // 5
      return '신청 마감 (정원 초과)';
    case ProcessState.PROCESS_STARTED: // 6
      return '방송 진행 중 (OnAir)';
    case ProcessState.PROCESS_END: // 7
      return '방송 종료';
    default:
      if (processState !== undefined && processState !== null) {
        return `상태:${processState}`;
      }
      return '알 수 없음';
  }
}

export function formatSurveyStatus(
  useSurvey?: string,
  surveyState?: number,
  survey?: SeminarSurvey | null,
  surveyApplyTy?: number,
): string {
  if (useSurvey === 'N') {
    return '설문 없음';
  }

  const pointText =
    survey?.point !== undefined && survey?.point !== null ? ` (${Number(survey.point).toLocaleString()}P)` : '';

  // 사용자가 이미 설문 제출을 완료한 경우
  if (surveyState === SurveyState.SURVEY_COMPLETED || surveyApplyTy === 1) {
    return `설문 참여 완료${pointText}`;
  }

  switch (surveyState) {
    case SurveyState.SURVEY_PROGRESS: // 1
      return `설문 진행 중 (참여 가능)${pointText}`;
    case SurveyState.SURVEY_CLOSED: // 3
      return `설문 마감 / 미제공${pointText}`;
    case SurveyState.SURVEY_UNOPENED: // 5
      return `설문 미오픈 (진행 예정)${pointText}`;
    default:
      if (useSurvey === 'Y') {
        return `설문 있음${pointText}`;
      }
      return '설문 미정';
  }
}

export function formatMyParticipation(member: SeminarMember | null): string {
  if (!member) {
    return '미신청';
  }

  const applyStatus = member.applyTy === 1 ? '입장/시청 완료' : '신청 완료';
  const applyDate = member.createDt ? ` (신청: ${member.createDt.substring(5, 16)})` : '';
  const joinDate = member.joinDt ? ` (입장: ${member.joinDt.substring(5, 16)})` : '';
  const surveyStatus = member.surveyApplyTy === 1 ? '설문완료' : '설문미참여';

  if (member.joinDt) {
    return `${applyStatus}${joinDate}, ${surveyStatus}`;
  }
  return `${applyStatus}${applyDate}, ${surveyStatus}`;
}

function _stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(
      /&(amp|lt|gt|quot|#39|apos|nbsp);/g,
      (m) =>
        ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' })[m] ?? m,
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSeminarUrl(seminarId: number): string {
  return `https://m.doctorville.co.kr/cme/seminar/${seminarId}`;
}

export function formatSeminarDetail(data: SeminarDetail, raw?: SeminarDetailResponse): string {
  const dateTime = formatDateTime(data.startDt, data.endDt, data.startTime, data.endTime, data.startMonthAndDay);
  const status = formatStatus(data.processState, data.seminarCompleted, data.cancelProcessState);
  const surveyState = raw?.surveyState;
  const surveyStatus = formatSurveyStatus(data.useSurvey, surveyState, data.survey, data.seminarMember?.surveyApplyTy);
  const myParticipation = formatMyParticipation(data.seminarMember);
  const participantInfo = `${data.applyCnt} / ${data.maxPeopleCnt}`;
  const seminarUrl = buildSeminarUrl(data.seminarId);
  const isPointExcluded = checkIsPointExcluded(data.intro);

  return [
    `*세미나 상세* (ID: ${data.seminarId})`,
    '',
    `*제목:* ${data.seminarNm}`,
    `*일시:* ${dateTime} (${data.startDayOfWeek})`,
    `*진행자:* ${data.tutorNm}`,
    `*분야:* ${data.diseaseCategoryNm} (${data.categoryCdNm})`,
    `*인원:* ${participantInfo}`,
    `*상태:* ${status}`,
    `*내 참여:* ${myParticipation}`,
    `*설문:* ${surveyStatus}${data.useDepthSurvey === 'Y' ? ' [심화설문]' : ''}`,
    `*포인트:* ${isPointExcluded ? '미지급' : data.survey?.point ? `${Number(data.survey.point).toLocaleString()}P 지급` : '지급 대상'}`,
    `*VOD:* ${data.useVod === 'Y' ? '제공' : '미제공'}`,
    `*URL:* ${seminarUrl}`,
  ].join('\n');
}

function cleanRawData(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(cleanRawData);
  }
  if (obj !== null && typeof obj === 'object') {
    const cleaned: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'intro' || value === null) continue;
      cleaned[key] = cleanRawData(value);
    }
    return cleaned;
  }
  return obj;
}

export function formatRawResponse(raw: SeminarDetailResponse): string[] {
  const cleaned = cleanRawData(raw);
  const rawJson = JSON.stringify(cleaned, null, 2);
  // 각 메시지가 텔레그램 4096자 제한 이내여야 하므로 배열로 분할해 별도 전송
  const chunks: string[] = [];
  for (let i = 0; i < rawJson.length; i += 3500) {
    chunks.push(rawJson.slice(i, i + 3500));
  }
  return chunks.map((chunk, idx) => `*Raw API Response (${idx + 1}/${chunks.length}):*\n\`\`\`json\n${chunk}\n\`\`\``);
}

export function extractSeminarIds(
  input?: string | string[] | { seminarId?: string | string[]; seminarIds?: string | string[] },
): string[] {
  if (!input) return [];
  const rawList: string[] = [];

  const addValue = (v: unknown) => {
    if (typeof v === 'number') {
      rawList.push(String(v));
    } else if (typeof v === 'string') {
      const tokens = v.split(/[\s,]+/);
      for (const token of tokens) {
        const cleaned = token.trim();
        if (/^\d+$/.test(cleaned)) {
          rawList.push(cleaned);
        } else {
          const matched = cleaned.match(/\b\d{4,6}\b/g);
          if (matched) rawList.push(...matched);
        }
      }
    } else if (Array.isArray(v)) {
      for (const item of v) addValue(item);
    }
  };

  if (typeof input === 'object' && !Array.isArray(input)) {
    if ('seminarIds' in input) addValue(input.seminarIds);
    if ('seminarId' in input) addValue(input.seminarId);
  } else {
    addValue(input);
  }

  return Array.from(new Set(rawList));
}

export interface SeminarDetailResultItem {
  seminarId: string;
  success: boolean;
  data?: SeminarDetail;
  message: string;
  error?: string;
}

export interface SeminarDetailRunResult {
  success: boolean;
  message: string;
  messages?: string[];
  rawMessages?: string[];
  results?: SeminarDetailResultItem[];
}

export function getStoredSeminar(seminarId: string): SeminarListItem | null {
  const found = seminarRepo.getSeminarById(seminarId);
  if (found && found.name) {
    return found;
  }
  return null;
}

export function formatStoredSeminarDetail(item: SeminarListItem): string {
  const sid = item.seminarId || getSeminarIdFromUrl(item.url) || '알 수 없음';
  const lines: string[] = [`*세미나 상세* (ID: ${sid})`, ''];
  lines.push(`*제목:* ${item.name || '제목 없음'}`);
  const dateTime = `${item.date || ''} ${item.time || ''}`.trim();
  if (dateTime) {
    lines.push(`*일시:* ${dateTime}`);
  }
  if (item.currentCount || item.totalCount) {
    const countInfo =
      item.currentCount && item.totalCount
        ? `${item.currentCount} / ${item.totalCount}`
        : item.totalCount
          ? `${item.totalCount}명 정원`
          : `${item.currentCount}명`;
    lines.push(`*인원:* ${countInfo}`);
  }
  if (item.processState !== undefined || item.seminarCompleted !== undefined) {
    lines.push(`*상태:* ${formatStatus(item.processState, item.seminarCompleted, item.cancelProcessState)}`);
  }
  if (item.isAdvancedSurvey !== undefined || item.isPointExcluded !== undefined) {
    const surveyText = item.isAdvancedSurvey
      ? '설문 있음 [심화설문]'
      : item.isPointExcluded
        ? '설문 없음'
        : '설문 있음';
    lines.push(`*설문:* ${surveyText}`);
  }
  if (item.pointPaid === true) {
    lines.push(`*포인트:* ✅ ${item.pointText ?? `${item.point ? Number(item.point).toLocaleString() : 0}P`} 지급됨`);
  } else if (item.isPointExcluded === true) {
    lines.push(`*포인트:* 미지급`);
  } else if (item.pointCheckedAt) {
    lines.push(`*포인트:* ❌ 미지급 (조회완료)`);
  } else if (item.point !== undefined && Number(item.point) > 0) {
    lines.push(`*포인트:* ${Number(item.point).toLocaleString()}P 지급`);
  } else if (item.isPointExcluded === false) {
    lines.push(`*포인트:* 지급 대상`);
  }
  const url = item.url || (item.seminarId ? `https://m.doctorville.co.kr/cme/seminar/${item.seminarId}` : '');
  if (url) {
    lines.push(`*URL:* ${url}`);
  }

  return lines.join('\n');
}

export function isForceRefresh(input?: unknown): boolean {
  if (typeof input === 'string') {
    return /(?:^|\s)(?:force|refresh|-f|--force|api)(?:\s|$)/i.test(input.trim());
  }
  if (Array.isArray(input)) {
    return input.some((item) => typeof item === 'string' && isForceRefresh(item));
  }
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    if (obj.preferStored === false || obj.force === true) return true;
    if (typeof obj.args === 'object' && obj.args !== null) {
      const argsObj = obj.args as Record<string, unknown>;
      if (argsObj.preferStored === false || argsObj.force === true) return true;
      if (typeof argsObj.rawText === 'string') return isForceRefresh(argsObj.rawText);
    }
  }
  return false;
}

export async function run(
  input?:
    | {
        args?: {
          seminarId?: string | string[];
          seminarIds?: string | string[];
          preferStored?: boolean;
          force?: boolean;
          rawText?: string;
        };
        seminarId?: string | string[];
        seminarIds?: string | string[];
        preferStored?: boolean;
        force?: boolean;
      }
    | string
    | string[],
  options?: { preferStored?: boolean; force?: boolean },
): Promise<SeminarDetailRunResult> {
  let ids: string[] = [];
  let preferStored = options?.preferStored ?? true;

  if (options?.force === true) {
    preferStored = false;
  }

  if (typeof input === 'string' || Array.isArray(input)) {
    ids = extractSeminarIds(input);
    if (isForceRefresh(input)) {
      preferStored = false;
    }
  } else if (input && typeof input === 'object') {
    ids = extractSeminarIds(input.args || input);
    if (input.args?.preferStored !== undefined) {
      preferStored = input.args.preferStored;
    } else if (input.preferStored !== undefined) {
      preferStored = input.preferStored;
    }

    if (input.args?.force === true || input.force === true || isForceRefresh(input.args?.rawText)) {
      preferStored = false;
    }
  }

  if (ids.length === 0) {
    return {
      success: false,
      message: '세미나 ID가 필요합니다. 예: /seminar_detail 5566 또는 /seminar_detail 5566 5567',
    };
  }

  // 단일 세미나 조회인 경우 (저장된 목록 우선 반환)
  if (ids.length === 1) {
    const seminarId = ids[0];
    if (preferStored) {
      const stored = getStoredSeminar(seminarId);
      if (stored) {
        const formatted = formatStoredSeminarDetail(stored);
        return {
          success: true,
          message: formatted,
          messages: [formatted],
          results: [
            {
              seminarId,
              success: true,
              message: formatted,
            },
          ],
        };
      }
    }

    const result = await fetchSeminarDetail(seminarId);
    if (!result.success || !result.data) {
      return { success: false, message: result.error || '세미나 정보를 가져올 수 없습니다.' };
    }

    const formatted = formatSeminarDetail(result.data, result.raw);
    const rawMessages = result.raw ? formatRawResponse(result.raw) : undefined;
    return {
      success: true,
      message: formatted,
      messages: [formatted],
      rawMessages,
      results: [
        {
          seminarId,
          success: true,
          data: result.data,
          message: formatted,
        },
      ],
    };
  }

  // 복수 세미나 조회인 경우
  const formattedMessages: string[] = [];
  const results: SeminarDetailResultItem[] = [];

  for (const seminarId of ids) {
    if (preferStored) {
      const stored = getStoredSeminar(seminarId);
      if (stored) {
        const formatted = formatStoredSeminarDetail(stored);
        formattedMessages.push(formatted);
        results.push({
          seminarId,
          success: true,
          message: formatted,
        });
        continue;
      }
    }

    const result = await fetchSeminarDetail(seminarId);
    if (result.success && result.data) {
      const formatted = formatSeminarDetail(result.data, result.raw);
      formattedMessages.push(formatted);
      results.push({
        seminarId,
        success: true,
        data: result.data,
        message: formatted,
      });
    } else {
      const errMsg = `*세미나 상세* (ID: ${seminarId})\n❌ 조회 실패: ${result.error || '정보를 찾을 수 없습니다.'}`;
      formattedMessages.push(errMsg);
      results.push({
        seminarId,
        success: false,
        message: errMsg,
        error: result.error,
      });
    }
  }

  const successCount = results.filter((r) => r.success).length;
  const overallSuccess = successCount > 0;

  return {
    success: overallSuccess,
    message: formattedMessages.join('\n\n────────────────\n\n'),
    messages: formattedMessages,
    results,
  };
}
