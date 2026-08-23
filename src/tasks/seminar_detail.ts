import { httpGetJson } from '../modules/http_client';
import * as logger from '../services/logger';

const SEMINAR_DETAIL_API = 'https://m-api.doctorville.co.kr/api/mw/seminars/';

export interface SeminarDetail {
  seminarId: number;
  seminarNm: string;
  startDt: string;
  endDt: string;
  startTime: string;
  endTime: string;
  startMonthAndDay: string;
  startDayOfWeek: string;
  maxPeopleCnt: number;
  applyCnt: number;
  processState: number;
  seminarCompleted: number;
  useSurvey: string;
  useDepthSurvey: string;
  useVod: string;
  tutorNm: string;
  diseaseCategoryNm: string;
  intro: string;
  broadcastUrl: string;
  isScraped: boolean;
  isSurveyPointExcluded?: boolean;
  surveyId?: number | null;
}

export async function fetchSeminarDetail(
  seminarId: string,
): Promise<{ success: boolean; data?: SeminarDetail; error?: string }> {
  try {
    const url = `${SEMINAR_DETAIL_API}${seminarId}`;
    const response = await httpGetJson<{ seminarDetail: SeminarDetail }>(url);

    if (!response.seminarDetail) {
      return { success: false, error: '세미나 정보를 찾을 수 없습니다.' };
    }

    return { success: true, data: response.seminarDetail };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error('fetchSeminarDetail error', { seminarId, error: errorMsg });
    return { success: false, error: `세미나 상세 조회 실패: ${errorMsg}` };
  }
}

function formatDateTime(startDt: string, endDt: string): string {
  // "2026-08-21 13:00:00.0" -> "8/21 13:00~14:00"
  const start = new Date(startDt.replace('.0', ''));
  const end = new Date(endDt.replace('.0', ''));
  const month = start.getMonth() + 1;
  const day = start.getDate();
  const startTime = start.toTimeString().slice(0, 5);
  const endTime = end.toTimeString().slice(0, 5);
  return `${month}/${day} ${startTime}~${endTime}`;
}

function formatStatus(processState: number, seminarCompleted: number, useSurvey: string): string {
  if (seminarCompleted === 1) return '진행 완료';
  if (processState === 8) return '진행 가능'; // OPEN
  if (processState === 1) return '신청 마감';
  if (processState === 2) return '진행 중';
  if (processState === 3) return '신청 대기';
  if (useSurvey === 'Y') return '설문 진행';
  return `상태:${processState}`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/&/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatSeminarDetail(data: SeminarDetail): string {
  const dateTime = formatDateTime(data.startDt, data.endDt);
  const status = formatStatus(data.processState, data.seminarCompleted, data.useSurvey);
  const pointExcluded = data.isSurveyPointExcluded === true ? ' 🚫[포인트미지급]' : '';
  const participantInfo = `${data.applyCnt} / ${data.maxPeopleCnt}`;

  let introText = stripHtml(data.intro || '');
  if (introText.length > 200) {
    introText = introText.slice(0, 200) + '...';
  }

  return [
    `*세미나 상세* (ID: ${data.seminarId})`,
    '',
    `*제목:* ${data.seminarNm}${pointExcluded}`,
    `*일시:* ${dateTime} (${data.startDayOfWeek})`,
    `*진행자:* ${data.tutorNm}`,
    `*분야:* ${data.diseaseCategoryNm}`,
    `*인원:* ${participantInfo}`,
    `*상태:* ${status}`,
    `*VOD:* ${data.useVod === 'Y' ? '제공' : '미제공'}`,
    '',
    `*소개:*`,
    introText || '(소개 없음)',
  ].join('\n');
}

export async function run({ args }: { args: { seminarId: string } }): Promise<{ success: boolean; message: string }> {
  const seminarId = args?.seminarId;
  if (!seminarId) {
    return { success: false, message: '세미나 ID가 필요합니다. 예: /seminar_detail 5566' };
  }

  const result = await fetchSeminarDetail(seminarId);
  if (!result.success || !result.data) {
    return { success: false, message: result.error || '세미나 정보를 가져올 수 없습니다.' };
  }

  const formatted = formatSeminarDetail(result.data);
  return { success: true, message: formatted };
}
