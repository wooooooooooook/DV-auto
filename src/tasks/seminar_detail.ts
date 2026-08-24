import { httpGetJson } from '../modules/http_client';
import * as logger from '../services/logger';
import { ProcessState, SurveyState } from '../modules/seminar_api';

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

export async function fetchSeminarDetail(
  seminarId: string,
): Promise<{ success: boolean; data?: SeminarDetail; raw?: SeminarDetailResponse; error?: string }> {
  try {
    const url = `${SEMINAR_DETAIL_API}${seminarId}`;
    const response = await httpGetJson<SeminarDetailResponse>(url);

    if (!response.seminarDetail) {
      return { success: false, error: '세미나 정보를 찾을 수 없습니다.' };
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

function stripHtml(html: string): string {
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
  const isPointExcluded = !data.survey || data.survey.point === undefined || Number(data.survey.point) <= 0;

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
    `*포인트:* ${isPointExcluded ? '미지급' : `${Number(data.survey?.point).toLocaleString()}P 지급`}`,
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

export async function run({
  args,
}: {
  args: { seminarId: string };
}): Promise<{ success: boolean; message: string; rawMessages?: string[] }> {
  const seminarId = args?.seminarId;
  if (!seminarId) {
    return { success: false, message: '세미나 ID가 필요합니다. 예: /seminar_detail 5566' };
  }

  const result = await fetchSeminarDetail(seminarId);
  if (!result.success || !result.data) {
    return { success: false, message: result.error || '세미나 정보를 가져올 수 없습니다.' };
  }

  const formatted = formatSeminarDetail(result.data, result.raw);
  const rawMessages = result.raw ? formatRawResponse(result.raw) : undefined;
  return { success: true, message: formatted, rawMessages };
}
