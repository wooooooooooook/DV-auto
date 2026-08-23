import { httpGetJson } from '../modules/http_client';
import * as logger from '../services/logger';

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

function formatStatus(processState: number, seminarCompleted: number, useSurvey: string): string {
  // processState 의미 미검증: 알려진 값만 매핑, 나머지는 숫자 그대로 표시
  if (seminarCompleted === 1) return '진행 완료';
  if (processState === 8) return '진행 가능 (OPEN)'; // 예시에서 확인됨
  if (processState === 1) return '신청 마감 (추정)';
  if (processState === 2) return '진행 중 (추정)';
  if (processState === 3) return '신청 대기 (추정)';
  if (useSurvey === 'Y') return '설문 진행';
  return `상태:${processState}`;
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

export function formatSeminarDetail(data: SeminarDetail): string {
  const dateTime = formatDateTime(data.startDt, data.endDt, data.startTime, data.endTime, data.startMonthAndDay);
  const status = formatStatus(data.processState, data.seminarCompleted, data.useSurvey);
  const participantInfo = `${data.applyCnt} / ${data.maxPeopleCnt}`;
  const seminarUrl = buildSeminarUrl(data.seminarId);

  let introText = stripHtml(data.intro || '');
  if (introText.length > 200) {
    introText = introText.slice(0, 200) + '...';
  }

  return [
    `*세미나 상세* (ID: ${data.seminarId})`,
    '',
    `*제목:* ${data.seminarNm}`,
    `*일시:* ${dateTime} (${data.startDayOfWeek})`,
    `*진행자:* ${data.tutorNm}`,
    `*분야:* ${data.diseaseCategoryNm} (${data.categoryCdNm})`,
    `*인원:* ${participantInfo}`,
    `*상태:* ${status}`,
    `*VOD:* ${data.useVod === 'Y' ? '제공' : '미제공'}`,
    `*설문:* ${data.useSurvey === 'Y' ? '있음' : '없음'} (심화: ${data.useDepthSurvey === 'Y' ? '있음' : '없음'})`,
    `*설문ID:* ${data.surveyId ?? '없음'}`,
    `*URL:* ${seminarUrl}`,
    '',
    `*소개:*`,
    introText || '(소개 없음)',
  ].join('\n');
}

export function formatRawResponse(raw: SeminarDetailResponse): string[] {
  const rawJson = JSON.stringify(raw, null, 2);
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

  const formatted = formatSeminarDetail(result.data);
  const rawMessages = result.raw ? formatRawResponse(result.raw) : undefined;
  return { success: true, message: formatted, rawMessages };
}
