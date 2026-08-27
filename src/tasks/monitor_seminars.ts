import type { BrowserContext, Page } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import {
  safeGoto,
  sendNotificationToChannel,
  sendTelegram,
  ensureLoggedIn,
  loadCookies,
  sleep,
} from '../modules/utils';
import {
  fetchMainFutureSeminars,
  fetchSeminarDetail,
  parseSeminarDateTime,
  checkIsAdvancedSurvey,
  checkIsPointExcluded,
  ProcessState,
  SurveyState,
  type FutureSeminarApiItem,
} from '../modules/seminar_api';
import { processSeminarQuiz } from './seminar_quiz';
import * as seminarRepo from '../services/seminar_repository';
import {
  editChannelMessage,
  getSeminarStatusChannelMessage,
  publishAndReplaceChannelNotice,
} from '../services/channel_message_repository';
import { sendToTopicSubscribers, type SubscriptionTopic } from '../services/subscription_service';

const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
const SEMINAR_DETAIL_PC_PAGE = 'https://www.doctorville.co.kr/seminar/seminarDetail';

const seoulDateString = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

// API 폴링 주기: 1분 (60초)
export const API_POLL_INTERVAL_MS = 60 * 1000;

export type SeminarStatus = '대기' | '입장가능' | '종료';

export interface MonitoredSeminarItem {
  seminarId: string | null;
  url: string;
  name: string;
  startDt?: string;
  endDt?: string;
  time?: string;
  status: SeminarStatus;
  hasSurvey?: boolean;
  isSurveyPointExcluded?: boolean;
  isAdvancedSurvey?: boolean;
  autoEnterDone?: boolean;
  isEntryStarted?: boolean;
  isEnded?: boolean;
  endedAt?: number;
  surveyEndTime?: number;
  quizResultMessage?: string | null;
  processState?: number;
  cancelProcessState?: number;
  seminarCompleted?: number;
  surveyState?: number;
  startNotified?: boolean;
  endNotified?: boolean;
  notifiedClosing20?: boolean;
  notifiedClosing10?: boolean;
}

export type SeminarInfo = MonitoredSeminarItem;

/**
 * 세미나의 설문 마감 시각(종료시각 + 60분)을 구합니다.
 * - endDt가 유효한 경우: endDt + 60분 (3600000ms)
 * - time이 유효한 경우: 당일 time 종료시간 + 60분
 * - endedAt(종료 감지 시각)이 유효한 경우: endedAt + 60분
 */
export function getSeminarSurveyEndTime(seminar: { endDt?: string; time?: string; endedAt?: number }): number | null {
  if (seminar.endDt) {
    const cleanEnd = seminar.endDt.trim().replace('T', ' ');
    const isoStr = cleanEnd.includes('+') ? cleanEnd : `${cleanEnd.replace(' ', 'T')}+09:00`;
    const endMs = new Date(isoStr).getTime();
    if (!Number.isNaN(endMs)) {
      return endMs + 60 * 60 * 1000;
    }
  }
  if (seminar.time && seminar.time.includes('~')) {
    const endHM = seminar.time.split('~')[1]?.trim();
    if (endHM && endHM.includes(':')) {
      const today = seoulDateString();
      const endMs = new Date(`${today}T${endHM}:00+09:00`).getTime();
      if (!Number.isNaN(endMs)) {
        return endMs + 60 * 60 * 1000;
      }
    }
  }
  if (seminar.endedAt) {
    return seminar.endedAt + 60 * 60 * 1000;
  }
  return null;
}

/**
 * 설문 마감까지 남은 시간(분)을 10분 단위로 계산합니다.
 * 예: 45~54분 -> 50분, 15~24분 -> 20분, 5~14분 -> 10분
 * 60분 초과 시 최대 60분으로 clamp, 0분 이하 시 0분 반환.
 */
export function getSurveyRemainingMinutes(
  seminar: { endDt?: string; time?: string; endedAt?: number },
  nowMs = Date.now(),
): number {
  const surveyEndTime = getSeminarSurveyEndTime(seminar);
  if (!surveyEndTime) return 0;
  const diffMs = surveyEndTime - nowMs;
  if (diffMs <= 0) return 0;

  const rawMinutes = diffMs / (60 * 1000);
  const rounded10 = Math.round(rawMinutes / 10) * 10;
  return Math.min(60, Math.max(0, rounded10));
}

/**
 * 세미나 상태 표시 이모지 및 상태 텍스트 반환
 */
export function getSeminarStatusDisplay(info: {
  status?: SeminarStatus | string;
  processState?: number;
  seminarCompleted?: number;
}): {
  emoji: string;
  text: string;
} {
  const ps = info.processState;
  const statusStr: string = info.status || '';
  const isCompleted =
    info.seminarCompleted === 1 ||
    statusStr === '종료' ||
    ps === ProcessState.PROCESS_END ||
    ps === ProcessState.PROCESS_COMPLETED;

  if (isCompleted) {
    return { emoji: '🔴', text: '종료' };
  }

  const isEnterReady =
    ps === ProcessState.PROCESS_ENTER ||
    ps === ProcessState.PROCESS_STARTED ||
    statusStr === '입장가능' ||
    statusStr === '입장하기' ||
    statusStr === '진행중';

  if (isEnterReady) {
    return { emoji: '🟢', text: '입장가능' };
  }

  return { emoji: '⏳', text: '대기' };
}

/**
 * 퀴즈 결과 메시지에서 퀴즈정답 요약(예: "퀴즈 정답 123", "[퀴즈] 정답 123", "정답 : 1번 O" 등)만 추출하고
 * 하단의 퀴즈:답 상세 내역(Q1: ..., → ...)은 제거합니다.
 */
export function extractQuizSummaryOnly(quizMessage?: string | null): string | null {
  if (!quizMessage) return null;
  const lines = quizMessage
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  return lines[0];
}

/**
 * 세미나 현황 통합 메시지 및 인라인 키보드 생성 (댓글 섹션 포함)
 * - 제목의 **(볼드) 제거
 * - 시작종료시각을 제목 앞에 표시
 * - 제목은 20글자로 트렁케이션
 * - 퀴즈정답은 요약(퀴즈정답: 123 등)만 표시 (상세 퀴즈 문항/답 제외)
 * - 종료된 세미나의 설문 가능 시간(약 몇분 남음) 표시
 */
export function buildSeminarStatusMessage(
  periodName: string,
  seminars: MonitoredSeminarItem[],
  isAllCompleted = false,
  comments: Array<{ userName: string; text: string }> = [],
  nowMs = Date.now(),
): { text: string; options: Record<string, unknown> } {
  if (seminars.length === 0) {
    return {
      text: `🔔 ${periodName}세미나\n\n예정된 세미나가 없습니다.`,
      options: { link_preview_options: { is_disabled: true } },
    };
  }

  let text = `🔔 ${periodName}세미나\n\n`;

  for (let i = 0; i < seminars.length; i++) {
    const s = seminars[i];
    const statusDisplay = getSeminarStatusDisplay(s);

    const timeStr = s.time ? `${s.time} ` : '';
    const truncatedName = s.name.length > 20 ? s.name.slice(0, 20) : s.name;
    const advancedSuffix = s.isAdvancedSurvey ? ' [심화설문]' : '';
    const targetUrl = s.url || (s.seminarId ? `${SEMINAR_DETAIL_PAGE}${s.seminarId}` : '');
    text += `${statusDisplay.emoji} ${statusDisplay.text} | ${timeStr}${truncatedName}${advancedSuffix}\n${targetUrl}`;

    if (s.status === '종료' || statusDisplay.text === '종료') {
      const summaryQuiz = extractQuizSummaryOnly(s.quizResultMessage);
      if (summaryQuiz) {
        text += `\n${summaryQuiz}`;
        if (s.hasSurvey !== false) {
          const minutesLeft = getSurveyRemainingMinutes(s, nowMs);
          if (minutesLeft > 0) {
            text += `\n(설문 마감 약 ${minutesLeft}분 남음)`;
          } else {
            text += `\n(설문 마감)`;
          }
        }
      } else if (s.hasSurvey === false) {
        text += `\n(설문이 없는 세미나)`;
      } else {
        const minutesLeft = getSurveyRemainingMinutes(s, nowMs);
        if (minutesLeft > 0) {
          text += `\n(설문 마감 약 ${minutesLeft}분 남음)`;
        } else {
          text += `\n(설문 마감)`;
        }
      }
    }

    if (i < seminars.length - 1) {
      text += '\n\n';
    }
  }

  // 이전 댓글 섹션 첨부 (최근 최대 5개)
  if (comments.length > 0) {
    text += `\n\n💬 [이전 댓글]\n`;
    const recentComments = comments.slice(-5);
    for (const c of recentComments) {
      const cleanText = c.text.replace(/\n/g, ' ').slice(0, 100);
      text += `• ${c.userName}: ${cleanText}\n`;
    }
  }

  if (isAllCompleted) {
    text += `\n━━━━━━━━━━━━━━━━━━\n🏁 ${periodName}세미나가 모두 종료되었습니다.`;
  }

  const options: Record<string, unknown> = {
    link_preview_options: {
      is_disabled: true,
    },
  };

  return { text, options };
}

/**
 * 세미나 모니터 현황 메시지 빌더 (문자열 반환)
 */
export function buildSeminarMonitorStatusMessage(
  periodName: string,
  seminars: SeminarInfo[] | Record<string, SeminarInfo>,
  nowMs = Date.now(),
): string {
  const list = Array.isArray(seminars) ? seminars : Object.values(seminars);
  return buildSeminarStatusMessage(periodName, list, false, [], nowMs).text;
}

/**
 * 세미나 라이브 시작(입장가능) 개별 알림 메시지 빌더
 */
export function buildSeminarLiveStartMessage(seminar: MonitoredSeminarItem): {
  text: string;
  options: Record<string, unknown>;
} {
  const timeStr = seminar.time ? `[${seminar.time}] ` : '';
  const advancedSuffix = seminar.isAdvancedSurvey ? ' [심화설문]' : '';
  const targetUrl = seminar.url || (seminar.seminarId ? `${SEMINAR_DETAIL_PAGE}${seminar.seminarId}` : '');

  const text = `🟢 <b>[세미나 시작]</b>\n\n${timeStr}<b>${seminar.name}</b>${advancedSuffix}\n${targetUrl}`;

  return {
    text,
    options: {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    },
  };
}

/**
 * 세미나 시작(입장가능) 시 seminar_live 토픽 구독자에게 개별 알림을 발송합니다.
 */
export async function sendSeminarLiveStartNotice(
  seminar: MonitoredSeminarItem,
): Promise<{ successCount: number; failCount: number }> {
  const { text, options } = buildSeminarLiveStartMessage(seminar);
  return sendToTopicSubscribers('seminar_live', text, options);
}

/**
 * 세미나 라이브 종료(퀴즈 결과 포함) 개별 알림 메시지 빌더
 */
export function buildSeminarLiveEndMessage(seminar: MonitoredSeminarItem): {
  text: string;
  options: Record<string, unknown>;
} {
  const timeStr = seminar.time ? `[${seminar.time}] ` : '';
  const advancedSuffix = seminar.isAdvancedSurvey ? ' [심화설문]' : '';
  const targetUrl = seminar.url || (seminar.seminarId ? `${SEMINAR_DETAIL_PAGE}${seminar.seminarId}` : '');

  let text = `🔴 <b>[세미나 종료]</b>\n\n${timeStr}<b>${seminar.name}</b>${advancedSuffix}\n${targetUrl}`;

  if (seminar.quizResultMessage) {
    text += `\n\n${seminar.quizResultMessage.trim()}`;
  } else if (seminar.hasSurvey === false) {
    text += `\n\n(설문이 없는 세미나)`;
  }

  return {
    text,
    options: {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    },
  };
}

/**
 * 세미나 종료 및 퀴즈 처리 완료 시 seminar_live 토픽 구독자에게 개별 알림을 발송합니다.
 */
export async function sendSeminarLiveEndNotice(
  seminar: MonitoredSeminarItem,
): Promise<{ successCount: number; failCount: number }> {
  const { text, options } = buildSeminarLiveEndMessage(seminar);
  return sendToTopicSubscribers('seminar_live', text, options);
}

/**
 * 설문 마감 임박(20분 전, 10분 전) 개별 알림 메시지 빌더
 */
export function buildSurveyClosingMessage(
  seminar: MonitoredSeminarItem,
  minutesLeft: number,
): {
  text: string;
  options: Record<string, unknown>;
} {
  const timeStr = seminar.time ? `[${seminar.time}] ` : '';
  const advancedSuffix = seminar.isAdvancedSurvey ? ' [심화설문]' : '';
  const targetUrl = seminar.url || (seminar.seminarId ? `${SEMINAR_DETAIL_PAGE}${seminar.seminarId}` : '');

  let text = `⏳ <b>[설문 마감 ${minutesLeft}분 전]</b>\n\n${timeStr}<b>${seminar.name}</b>${advancedSuffix}\n${targetUrl}`;

  if (seminar.quizResultMessage) {
    text += `\n\n${seminar.quizResultMessage.trim()}`;
  }
  text += `\n\n⚠️ <b>설문 참여 마감까지 약 ${minutesLeft}분 남았습니다.</b>`;
  text += `\n<i>(※ 본 알림은 설문 진행 여부와 관계없이 발송되며, 이미 설문을 완료하셨다면 무시하셔도 됩니다.)</i>`;

  return {
    text,
    options: {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    },
  };
}

/**
 * 설문 마감 20분전 / 10분전 알림을 해당 토픽 구독자들에게 발송합니다.
 */
export async function sendSurveyClosingNotice(
  seminar: MonitoredSeminarItem,
  minutesLeft: 20 | 10,
): Promise<{ successCount: number; failCount: number }> {
  const topic: SubscriptionTopic = minutesLeft === 20 ? 'survey_closing_20' : 'survey_closing_10';
  const { text, options } = buildSurveyClosingMessage(seminar, minutesLeft);
  return sendToTopicSubscribers(topic, text, options);
}

/**
 * 세미나 현황 통합 메시지를 채널에 발송하고 이전 메시지를 안전하게 삭제/교체합니다.
 * - 댓글 보존: 기존 메시지에 연결된 댓글 조회 후 새 메시지 본문에 첨부
 * - 안전 가드: 댓글 확보 실패 또는 새 메시지 발송 실패 시 기존 메시지 유지
 * - resume 시 기존 메시지와 내용(텍스트)이 완전히 동일하면 재발송하지 않고 기존 메시지 ID를 유지합니다.
 */
export async function publishSeminarStatusNotice(
  periodName: string,
  seminars: MonitoredSeminarItem[],
  prevMessageId: number | null,
  isAllCompleted = false,
  isAutoResume = false,
  comments?: Array<{ userName: string; text: string }>,
): Promise<number | null> {
  const result = await publishAndReplaceChannelNotice({
    prevMessageId,
    buildMessageFn: (commentsToAttach) =>
      buildSeminarStatusMessage(periodName, seminars, isAllCompleted, commentsToAttach),
    customComments: comments,
    logPrefix: periodName,
    skipIfSameContent: isAutoResume,
  });

  return result.newMessageId;
}

/**
 * 관리자가 족보를 등록했을 때 공지 채널의 최신 세미나 현황 메시지를 찾아 자동으로 수정(Edit)합니다.
 */
export async function syncChannelSeminarStatusOnQuizRegister(
  registeredKeywords: string[],
): Promise<{ success: boolean; modified: boolean; message: string }> {
  try {
    const today = seoulDateString();
    const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours();
    const periodName = currentHour < 16 ? '점심' : '저녁';

    const existingMsg = getSeminarStatusChannelMessage(periodName, today);
    if (!existingMsg || !existingMsg.text || existingMsg.status === 'deleted') {
      return { success: true, modified: false, message: '수정할 당일 공지 채널 메시지가 없습니다.' };
    }

    const updatedText = existingMsg.text;
    const { loadCheatsheet } = await import('./seminar_quiz');
    const cheatsheet = await loadCheatsheet();

    let hasReplacements = false;
    // 메시지 내에 미해결 퀴즈나 족보 키워드가 매칭되는 경우 텍스트 치환
    for (const kw of registeredKeywords) {
      const ans = cheatsheet[kw];
      if (ans && updatedText.includes(kw)) {
        hasReplacements = true;
      }
    }

    // 만약 "일부 미해결" 또는 "미해결" 문구가 있고 정답이 새로 등록된 경우
    if (updatedText.includes('미해결') || hasReplacements) {
      // 퀴즈 정답 요약 등 갱신 시도
      for (const [kw, ans] of Object.entries(cheatsheet)) {
        if (updatedText.includes(kw) && !updatedText.includes(`→ ${ans}`)) {
          hasReplacements = true;
        }
      }
    }

    if (hasReplacements) {
      const editRes = await editChannelMessage(existingMsg.messageId, updatedText);
      return { success: editRes.success, modified: true, message: editRes.message };
    }

    return { success: true, modified: false, message: '채널 메시지 수정 불필요' };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { success: false, modified: false, message: `채널 메시지 수정 오류: ${errMsg}` };
  }
}

const getSeminarTrackingKey = (url: string, seminarId: string | null | undefined): string => seminarId || url;

/**
 * 세미나 startDt 기반으로 세미나 시작 시간 도래 여부 판정
 * 한국 시간(KST, UTC+9) 기준으로 현재 시각(또는 referenceTimeMs) >= startDt 인지 비교
 */
export function isSeminarStartedByTime(startDt?: string, referenceTimeMs?: number): boolean {
  if (!startDt) return false;
  try {
    const clean = startDt.trim().replace('T', ' ');
    // "2026-08-25 13:00:00" -> "2026-08-25T13:00:00+09:00"
    const isoWithTz = clean.includes('+') || clean.endsWith('Z') ? clean : `${clean.replace(' ', 'T')}+09:00`;
    const targetMs = new Date(isoWithTz).getTime();
    if (isNaN(targetMs)) return false;
    const nowMs = referenceTimeMs !== undefined ? referenceTimeMs : Date.now();
    return nowMs >= targetMs;
  } catch {
    return false;
  }
}

/**
 * Playwright BrowserContext 온디맨드 획득 헬퍼
 * 전달받은 context가 있으면 재사용하고, 없으면 필요한 시점에만 Chromium을 실행하고 종료합니다.
 */
export async function withBrowserContext<T>(
  providedContext: BrowserContext | undefined,
  callback: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  if (providedContext) {
    return await callback(providedContext);
  }

  const { chromium } = await import('playwright');
  const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';
  const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await loadCookies(context).catch(() => {});
  try {
    return await callback(context);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * API 기반으로 당일 특정 시간대(startHour ~ endHour)의 세미나 목록을 조회하여 SeminarInfo 맵으로 반환
 */
export async function getTodaysSeminarsFromApi(
  startHour: number,
  endHour: number,
  referenceDate?: string,
): Promise<{
  success: boolean;
  isAuthExpired: boolean;
  seminars: Record<string, SeminarInfo>;
  rawItems: FutureSeminarApiItem[];
}> {
  const targetDate = referenceDate || seoulDateString();
  const apiRes = await fetchMainFutureSeminars();

  if (!apiRes.success) {
    return {
      success: false,
      isAuthExpired: !!apiRes.isAuthExpired,
      seminars: {},
      rawItems: [],
    };
  }

  const storedList = seminarRepo.getAllSeminars();
  const storedPointExcludedMap = new Map<string, boolean>();
  for (const s of storedList) {
    const sid = s.seminarId ? String(s.seminarId).trim() : '';
    if (sid && s.isPointExcluded !== undefined) {
      storedPointExcludedMap.set(sid, s.isPointExcluded);
    }
  }

  const seminars: Record<string, SeminarInfo> = {};
  const items = apiRes.items || [];

  for (const item of items) {
    const { date, startHour: itemStartHour, time } = parseSeminarDateTime(item.startDt, item.endDt);

    // 날짜가 오늘(targetDate)이고 모니터링 시간대(startHour <= h < endHour)인지 확인
    if (
      date === targetDate &&
      Number.isFinite(itemStartHour) &&
      itemStartHour >= startHour &&
      itemStartHour < endHour
    ) {
      const seminarId = String(item.seminarId ?? '').trim();
      const fullUrl = `${SEMINAR_DETAIL_PAGE}${seminarId}`;
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

      const isAdvancedSurvey = checkIsAdvancedSurvey(item.useDepthSurvey);
      const storedIsPointExcluded = seminarId ? storedPointExcludedMap.get(seminarId) : undefined;
      const isPointExcluded =
        storedIsPointExcluded !== undefined
          ? storedIsPointExcluded
          : typeof item.intro === 'string' && item.intro.trim().length > 0
            ? checkIsPointExcluded(item.intro)
            : false;
      const hasSurvey = item.useSurvey !== false && item.useSurvey !== 'N' && item.useSurvey !== 0;

      let statusText: SeminarStatus = '대기';
      if (
        processStateNum === ProcessState.PROCESS_END ||
        processStateNum === ProcessState.PROCESS_COMPLETED ||
        seminarCompletedNum === 1
      ) {
        statusText = '종료';
      } else if (
        processStateNum === ProcessState.PROCESS_ENTER ||
        processStateNum === ProcessState.PROCESS_STARTED ||
        isSeminarStartedByTime(item.startDt)
      ) {
        statusText = '입장가능';
      }

      seminars[fullUrl] = {
        status: statusText,
        name: item.seminarNm || '세미나',
        seminarId,
        url: fullUrl,
        startDt: item.startDt,
        endDt: item.endDt,
        time,
        hasSurvey,
        isSurveyPointExcluded: isPointExcluded,
        isAdvancedSurvey,
        processState: processStateNum,
        cancelProcessState: cancelProcessStateNum,
        seminarCompleted: seminarCompletedNum,
      };
    }
  }

  return {
    success: true,
    isAuthExpired: false,
    seminars,
    rawItems: items,
  };
}

/**
 * 개별 세미나의 종료 상태 및 설문 상태, 입장이력을 API(fetchSeminarDetail)로 확인
 */
export async function checkSeminarEndStatusFromApi(seminarId: string): Promise<{
  isEnded: boolean;
  isSurveyOpen: boolean;
  surveyState?: number;
  isPointExcluded: boolean;
  hasEntryHistory: boolean;
}> {
  const detailRes = await fetchSeminarDetail(seminarId);
  if (!detailRes.success) {
    return {
      isEnded: false,
      isSurveyOpen: false,
      isPointExcluded: false,
      hasEntryHistory: false,
    };
  }

  const raw = detailRes.rawResponse;
  const detail = raw?.seminarDetail;
  const surveyState = detailRes.surveyState;
  const processState = detail?.processState !== undefined ? Number(detail.processState) : undefined;
  const seminarCompleted = detail?.seminarCompleted !== undefined ? Number(detail.seminarCompleted) : undefined;

  // 설문 진행 중 상태 (SURVEY_PROGRESS === 1)
  const isSurveyOpen = surveyState === SurveyState.SURVEY_PROGRESS;

  // 세미나 종료 상태 판별:
  // 1) surveyState가 1(진행중)이거나 2(완료)인 경우
  // 2) processState가 7(PROCESS_END) 또는 8(PROCESS_COMPLETED)인 경우
  // 3) seminarCompleted가 1인 경우
  const isEnded =
    isSurveyOpen ||
    surveyState === SurveyState.SURVEY_COMPLETED ||
    processState === ProcessState.PROCESS_END ||
    processState === ProcessState.PROCESS_COMPLETED ||
    seminarCompleted === 1;

  return {
    isEnded,
    isSurveyOpen,
    surveyState,
    isPointExcluded: detailRes.isPointExcluded,
    hasEntryHistory: detailRes.hasEntryHistory ?? false,
  };
}

/**
 * 세미나 종료 후 Playwright로 설문참여 버튼을 클릭하고 퀴즈를 처리하는 함수
 */
export async function handleSeminarEndAndQuiz(
  context: BrowserContext,
  seminar: { name: string; seminarId: string | null; isSurveyPointExcluded?: boolean },
  fallbackUrl: string,
): Promise<{ message: string | null; foundSurveyButton: boolean }> {
  // 포인트미지급 세미나는 설문/퀴즈 처리 건너뛰기
  if (seminar.isSurveyPointExcluded) {
    console.log(
      `[monitor_seminars] Skipping quiz/survey handling for point-excluded seminar: ${seminar.name} (${seminar.seminarId})`,
    );
    return { message: null, foundSurveyButton: false };
  }
  const targetUrl = seminar.seminarId ? `${SEMINAR_DETAIL_PAGE}${seminar.seminarId}` : fallbackUrl;
  const surveyPage = await context.newPage();
  let popupPage: Page | null = null;
  let quizPage: Page = surveyPage;
  let quizResultMessage: string | null = null;
  let foundSurveyButton = false;

  try {
    await ensureLoggedIn({ page: surveyPage, context });
    await safeGoto(surveyPage, targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await surveyPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // "설문참여" 버튼 찾기
    const surveyBtn = surveyPage.locator('text="설문참여"').first();
    const isSurveyButtonVisible = await surveyBtn.isVisible({ timeout: 3000 }).catch(() => false);
    foundSurveyButton = isSurveyButtonVisible;

    if (isSurveyButtonVisible) {
      console.log(`[monitor_seminars] "설문참여" 버튼 발견, 클릭 (${seminar.seminarId})`);
      const firstPopupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
      await surveyBtn.click({ force: true }).catch(() => {});
      popupPage = (await firstPopupPromise) || null;
      if (popupPage) {
        quizPage = popupPage;
        await popupPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      } else {
        await surveyPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await surveyPage.waitForTimeout(1000); // 페이지 로드 대기
      }

      // 개인정보 동의 모달이 있을 경우 상태만 확인
      const consentModal = quizPage
        .locator('text="개인정보 활용에 대한 동의", text="개인정보 제3자 제공 동의서"')
        .first();
      const isConsentModalVisible = await consentModal.isVisible({ timeout: 1500 }).catch(() => false);
      if (isConsentModalVisible) {
        console.log(`[monitor_seminars] 개인정보 동의 모달 감지 (${seminar.seminarId})`);
        const agreeCheckbox = quizPage.locator('input[type="checkbox"]').first();
        const isChecked = await agreeCheckbox.isChecked().catch(() => false);
        console.log(
          `[monitor_seminars] 동의 체크박스 상태: ${isChecked ? 'checked' : 'unchecked'} (${seminar.seminarId})`,
        );
      }

      // "참여하기" 또는 "설문 참여하기" 요소 찾기 및 클릭
      const participateBtn = quizPage.locator(':text-is("설문 참여하기"), :text-is("참여하기")').first();
      const isParticipateBtnVisible = await participateBtn.isVisible({ timeout: 3000 }).catch(() => false);
      if (isParticipateBtnVisible) {
        const isParticipateBtnEnabled = await participateBtn.isEnabled().catch(() => true);
        console.log(
          `[monitor_seminars] "참여하기" 버튼 발견 (enabled=${isParticipateBtnEnabled}) (${seminar.seminarId})`,
        );

        await quizPage.waitForTimeout(1000); // UI 안정화 대기
        const beforeUrl = quizPage.url();

        const secondPopupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
        await participateBtn.click({ force: true }).catch(() => {});
        const secondPopup = (await secondPopupPromise) || null;
        if (secondPopup) {
          if (popupPage && popupPage !== quizPage) {
            await popupPage.close().catch(() => {});
          }
          popupPage = secondPopup;
          quizPage = secondPopup;
          await secondPopup.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          console.log(`[monitor_seminars] 2차 팝업 열림: ${quizPage.url()} (${seminar.seminarId})`);
        } else {
          await quizPage.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
          await quizPage.waitForTimeout(1000);
          const afterUrl = quizPage.url();
          console.log(
            `[monitor_seminars] 2차 팝업 미감지 (samePage: ${beforeUrl} -> ${afterUrl}) (${seminar.seminarId})`,
          );
        }
      } else {
        console.log(`[monitor_seminars] "참여하기" 버튼 미감지 (${seminar.seminarId})`);
      }

      // "설문을 시작합니다" 텍스트 확인 대신 5초 대기
      await quizPage.waitForTimeout(5000);

      // 퀴즈 처리 (댓글로 결과 전송)
      const quizResult = await processSeminarQuiz(quizPage, seminar.seminarId ?? undefined);
      if (quizResult.success && quizResult.hasQuizResult) {
        quizResultMessage = quizResult.message;
      }
    } else {
      console.log(`[monitor_seminars] "설문참여" 버튼을 찾지 못함 (${seminar.seminarId})`);
      // 버튼이 없어도 현재 페이지에서 퀴즈 찾기 시도
      const quizResult = await processSeminarQuiz(quizPage, seminar.seminarId ?? undefined);
      if (quizResult.success && quizResult.hasQuizResult) {
        quizResultMessage = quizResult.message;
      }
    }
  } catch (e) {
    console.error(
      `[monitor_seminars] 설문/퀴즈 처리 실패 (${seminar.seminarId})`,
      e && typeof e === 'object' && 'stack' in e ? (e as Error).stack : e,
    );
    const message = e instanceof Error ? e.message : String(e);
    const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
    const errShotPath = path.join(
      baseScreenshotDir,
      `seminar_quiz_failed_${seminar.seminarId || Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`,
    );
    try {
      await fs.mkdir(baseScreenshotDir, { recursive: true });
      await quizPage.screenshot({ path: errShotPath, fullPage: true }).catch(() => {});
    } catch (_ssErr) {
      /* ignore */
    }
    await sendTelegram(`❗ [${seminar.name}] 세미나 퀴즈 처리 실패: ${message}\n${targetUrl}`, errShotPath).catch(
      () => {},
    );
  } finally {
    if (popupPage) {
      await popupPage.close().catch(() => {});
    }
    await surveyPage.close().catch(() => {});
  }
  return { message: quizResultMessage, foundSurveyButton };
}

/**
 * Playwright로 세미나 라이브 방송에 자동 입장하는 함수
 */
export async function performAutoEnter(
  context: BrowserContext,
  seminarId: string | null,
  seminarName: string,
  targetUrl: string,
  screenshotKey: string,
): Promise<boolean> {
  const page = await context.newPage();
  let didEnter = false;

  try {
    console.log(`[monitor_seminars] Performing auto-enter for ${seminarId} (${targetUrl})`);

    await ensureLoggedIn({ page, context });
    await safeGoto(page, targetUrl, { waitUntil: 'networkidle', timeout: 15000 });

    const enterBtn = page.locator('text="입장하기"').first();
    if (!(await enterBtn.isVisible({ timeout: 5000 }))) {
      console.log(`[monitor_seminars] '입장하기' button not found for ${seminarId}. retry needed.`);
      const notFoundScreenshotPath = path.join(process.cwd(), `seminar_entry_notfound_${screenshotKey}.png`);
      try {
        await page.screenshot({ path: notFoundScreenshotPath, fullPage: false });
        await sendTelegram(
          `⚠️ '입장하기' 버튼을 찾지 못했습니다 (재시도 예정)\n${seminarName}\n${targetUrl}`,
          notFoundScreenshotPath,
        );
      } catch (ssErr) {
        console.error(`[monitor_seminars] Failed to take/send not-found screenshot for ${seminarId}`, ssErr);
      } finally {
        await fs.unlink(notFoundScreenshotPath).catch(() => {});
      }
      return false;
    }

    const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await enterBtn.click();

    const popup = await popupPromise;
    let activePage = page;

    if (popup) {
      console.log(`[monitor_seminars] Popup detected for ${seminarId}`);
      activePage = popup;
      await activePage.waitForLoadState('domcontentloaded');
    }

    // "채널 선택" 다이얼로그 감지 후 "확인" 버튼 클릭
    console.log(`[monitor_seminars] Checking for '채널 선택' dialog after clicking '입장하기' (${seminarId})`);
    await activePage.waitForTimeout(2000);
    const channelSelectText = activePage.locator('text="채널 선택"').first();
    const isChannelSelectVisible = await channelSelectText.isVisible({ timeout: 5000 }).catch(() => false);
    if (isChannelSelectVisible) {
      console.log(`[monitor_seminars] '채널 선택' dialog detected for ${seminarId}. Clicking '확인'.`);
      const confirmBtn = activePage.locator('text="확인"').first();
      await confirmBtn.click({ force: true }).catch(() => {
        console.warn(`[monitor_seminars] Failed to click '확인' button for ${seminarId}`);
      });
      console.log(`[monitor_seminars] Clicked '확인' for channel selection (${seminarId})`);
      await activePage.waitForTimeout(3000);
    } else {
      console.log(`[monitor_seminars] No '채널 선택' dialog detected for ${seminarId}`);
    }

    console.log(`[monitor_seminars] Waiting for chat iframe to confirm seminar entry (${seminarId})`);
    await activePage.waitForTimeout(5000);

    // Q&A 섹션 존재 여부로 입장 완료 판정: video.ibm.com/socialstream iframe 확인
    const chatFrame = page.frames().find((f) => f.url().includes('socialstream') || f.url().includes('video.ibm.com'));
    let isQnaVisible = !!chatFrame;

    if (isQnaVisible) {
      console.log(`[monitor_seminars] Chat iframe (socialstream) found for ${seminarId}. Entry confirmed.`);
    } else {
      const currentUrl = activePage.url();
      const urlPattern = /https:\/\/m\.doctorville\.co\.kr\/cme\/seminar\/attend\?seminarId=\d+/;
      const on24Pattern = /https:\/\/event\.on24\.com\/eventRegistration\/console\/apollox\/mainEvent/;
      if (urlPattern.test(currentUrl) || on24Pattern.test(currentUrl)) {
        isQnaVisible = true;
        console.log(`[monitor_seminars] Entry confirmed via URL pattern for ${seminarId}: ${currentUrl}`);
      } else {
        console.log(`[monitor_seminars] Chat iframe not found and URL mismatch for ${seminarId}: ${currentUrl}`);
      }
    }

    if (!isQnaVisible) {
      console.warn(
        `[monitor_seminars] Q&A section not found after entry attempt for ${seminarId}. Entry may have failed.`,
      );

      // 불확실 시 → PC 도메인 상세 페이지로 fallback 후 '입장하기' 클릭
      if (seminarId) {
        const pcFallbackUrl = `${SEMINAR_DETAIL_PC_PAGE}?seminarId=${seminarId}`;
        console.log(`[monitor_seminars] PC fallback for ${seminarId} -> ${pcFallbackUrl}`);
        try {
          await ensureLoggedIn({ page: activePage, context });
          await safeGoto(activePage, pcFallbackUrl, { waitUntil: 'networkidle', timeout: 15000 });
          const pcEnterBtn = activePage.locator('text="입장하기"').first();
          if (await pcEnterBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            const pcPopupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
            await pcEnterBtn.click().catch((e) => {
              console.warn(`[monitor_seminars] PC fallback '입장하기' click failed for ${seminarId}`, e);
            });
            const pcPopup = await pcPopupPromise;
            const pcActive = pcPopup ?? activePage;
            if (pcPopup) await pcActive.waitForLoadState('domcontentloaded').catch(() => {});
            await pcActive.waitForTimeout(5000);
            const pcChatFrame = pcActive
              .frames()
              .find((f) => f.url().includes('socialstream') || f.url().includes('video.ibm.com'));
            const pcUrlPattern = /https:\/\/m\.doctorville\.co\.kr\/cme\/seminar\/attend\?seminarId=\d+/;
            const pcOn24Pattern = /https:\/\/event\.on24\.com\/eventRegistration\/console\/apollox\/mainEvent/;
            if (pcChatFrame || pcUrlPattern.test(pcActive.url()) || pcOn24Pattern.test(pcActive.url())) {
              isQnaVisible = true;
              activePage = pcActive;
              console.log(`[monitor_seminars] PC fallback entry confirmed for ${seminarId}.`);
            } else {
              console.warn(`[monitor_seminars] PC fallback also failed for ${seminarId}: ${pcActive.url()}`);
            }
            if (pcPopup) await pcPopup.close().catch(() => {});
          } else {
            console.warn(`[monitor_seminars] PC fallback '입장하기' button not found for ${seminarId}`);
          }
        } catch (pcErr) {
          console.error(`[monitor_seminars] PC fallback threw for ${seminarId}`, pcErr);
        }
      }
    } else {
      console.log(`[monitor_seminars] Q&A section confirmed. Seminar entry successful for ${seminarId}.`);
    }

    const screenshotPath = path.join(process.cwd(), `seminar_entry_${screenshotKey}.png`);
    try {
      await activePage.screenshot({ path: screenshotPath, fullPage: false });
      didEnter = isQnaVisible;
    } catch (screenshotError) {
      console.error(`[monitor_seminars] Failed to take screenshot for ${seminarId}`, screenshotError);
    } finally {
      await fs.unlink(screenshotPath).catch(() => {});
    }

    if (popup) {
      await popup.close().catch(() => {});
    }
  } catch (e) {
    console.error(`[monitor_seminars] Auto-enter failed for ${seminarId}`, e);
  } finally {
    await page.close().catch(() => {});
  }

  return didEnter;
}

/**
 * 입장 상태 확인 및 자동 입장 실행 (첫 성공 시 텔레그램 스크린샷 알림 전송)
 */
/**
 * 입장 상태 확인 및 자동 입장 실행 (첫 성공 시 텔레그램 스크린샷 알림 전송)
 */
export async function checkAndPerformAutoEnter(
  context: BrowserContext,
  seminarId: string | null,
  seminarUrl: string,
  name: string,
  status: string,
  autoEnterDone: boolean | undefined,
): Promise<boolean> {
  const canEnter = status === '입장가능' || status === '입장하기';
  if (!canEnter || autoEnterDone) {
    return !!autoEnterDone;
  }

  const targetUrl = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : seminarUrl;
  const screenshotKey = seminarId || `url_${Date.now()}`;
  const didEnter = await performAutoEnter(context, seminarId, name, targetUrl, screenshotKey);

  // 첫 성공 시에만 관리자 알림 전송 (중복 방지)
  if (didEnter) {
    const entryMessage = `🟢세미나 입장 완료\n${name}\n${targetUrl}`;
    const screenshotPath = path.join(process.cwd(), `seminar_entry_${screenshotKey}.png`);
    try {
      const page = await context.newPage();
      await ensureLoggedIn({ page, context });
      await safeGoto(page, targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await page.screenshot({ path: screenshotPath, fullPage: false });
      await sendTelegram(entryMessage, screenshotPath);
      await page.close().catch(() => {});
    } catch (e) {
      console.error(`[monitor_seminars] Entry notification send failed for ${seminarId}`, e);
    } finally {
      await fs.unlink(screenshotPath).catch(() => {});
    }
  }

  return didEnter;
}

export type MonitorSeminarsOptions = {
  isAutoResume?: boolean;
  context?: BrowserContext;
  page?: Page;
  pollIntervalMs?: number;
  waitForSurveyClose?: boolean;
};

/**
 * API 기반 세미나 모니터링 메인 태스크
 * 1분마다 API로 상태를 감시하고, 입장/설문 참여 시에만 Playwright를 온디맨드로 구동합니다.
 */
async function monitorSeminars(
  periodName: string,
  startHour: number,
  endHour: number,
  options?: MonitorSeminarsOptions,
): Promise<boolean>;
async function monitorSeminars(
  args: { page?: Page; context?: BrowserContext },
  periodName: string,
  startHour: number,
  endHour: number,
  options?: MonitorSeminarsOptions,
): Promise<boolean>;
async function monitorSeminars(
  arg1: string | { page?: Page; context?: BrowserContext },
  arg2: string | number,
  arg3?: number,
  arg4?: number | MonitorSeminarsOptions,
  arg5?: MonitorSeminarsOptions,
): Promise<boolean> {
  let periodName: string;
  let startHour: number;
  let endHour: number;
  let options: MonitorSeminarsOptions;
  let providedContext: BrowserContext | undefined;

  if (typeof arg1 === 'object' && arg1 !== null) {
    providedContext = arg1.context;
    periodName = arg2 as string;
    startHour = arg3 as number;
    endHour = arg4 as number;
    options = arg5 || {};
  } else {
    periodName = arg1 as string;
    startHour = arg2 as number;
    endHour = arg3 as number;
    options = (arg4 as MonitorSeminarsOptions) || {};
    providedContext = options.context;
  }

  const {
    isAutoResume,
    pollIntervalMs = API_POLL_INTERVAL_MS,
    waitForSurveyClose = process.env.NODE_ENV !== 'test',
  } = options;
  const todayIsoDate = seoulDateString();
  const excludedSeminarKeys = new Set<string>();

  // 전체 모니터링 대상 세미나 목록 (URL -> MonitoredSeminarItem)
  const monitoredSeminarsMap = new Map<string, MonitoredSeminarItem>();
  let lastStatusNoticeMessageId: number | null = null;

  try {
    console.log(`[${periodName}] API 기반 세미나 모니터링 시작 (시간대: ${startHour}시 ~ ${endHour}시)`);

    // isAutoResume 시 당일 기존에 전송된 세미나 현황 메시지 ID 확인
    if (isAutoResume) {
      const existingMsg = getSeminarStatusChannelMessage(periodName, todayIsoDate);
      if (existingMsg) {
        lastStatusNoticeMessageId = existingMsg.messageId;
        console.log(`[${periodName}] [isAutoResume] 기존 세미나 현황 메시지 감지 (ID: ${lastStatusNoticeMessageId})`);
      }
    }

    // 1. 초기 세미나 목록 조회 (API)
    const initialFetch = await getTodaysSeminarsFromApi(startHour, endHour, todayIsoDate);
    if (!initialFetch.success) {
      if (initialFetch.isAuthExpired) {
        await sendTelegram(`🔒 [${periodName}] 세미나 모니터링: 세션이 만료되었습니다. 로그인이 필요합니다.`);
        return false;
      }
      console.warn(`[${periodName}] 초기 세미나 목록 API 조회 실패, 다음 주기에 재시도합니다.`);
    }

    // 초기 세미나 목록 등록 및 포인트 제외 세미나 필터링
    for (const [url, info] of Object.entries(initialFetch.seminars)) {
      const targetUrl = info.seminarId ? `${SEMINAR_DETAIL_PAGE}${info.seminarId}` : url;
      let isPointExcluded = info.isSurveyPointExcluded ?? false;
      let hasEntryHistory = false;
      let initialIsEnded = info.status === '종료';

      if (info.seminarId) {
        const detailCheck = await checkSeminarEndStatusFromApi(info.seminarId);
        isPointExcluded = detailCheck.isPointExcluded;
        hasEntryHistory = detailCheck.hasEntryHistory;
        info.isSurveyPointExcluded = isPointExcluded;
        if (detailCheck.isEnded) {
          initialIsEnded = true;
        }
      }

      // 포인트 미지급 세미나: 채널 공지 대상에서 제외
      if (isPointExcluded) {
        console.log(`[${periodName}] ${info.name} is point-excluded. Skipping channel notice.`);
        excludedSeminarKeys.add(getSeminarTrackingKey(url, info.seminarId));
        continue;
      }

      // 상태 초기화
      let currentStatus: SeminarStatus = initialIsEnded ? '종료' : info.status;
      const isEnded = initialIsEnded;
      const endedAt = isEnded ? Date.now() : undefined;
      const quizResultMessage: string | null = null;
      let startNotified = false;
      const endNotified = isEnded;

      const isReadyToEnter =
        currentStatus === '입장가능' ||
        info.processState === ProcessState.PROCESS_ENTER ||
        info.processState === ProcessState.PROCESS_STARTED ||
        isSeminarStartedByTime(info.startDt);

      if (isReadyToEnter && !isEnded) {
        currentStatus = '입장가능';
        info.isEntryStarted = true;

        if (isAutoResume) {
          startNotified = true;
        }

        // 온디맨드 자동 입장
        if (isAutoResume && hasEntryHistory) {
          console.log(
            `[${periodName}] [isAutoResume] 세미나(${info.seminarId}) 입장이력이 확인되어 자동입장 생략: ${info.name}`,
          );
          info.autoEnterDone = true;
        } else {
          await withBrowserContext(providedContext, async (ctx) => {
            info.autoEnterDone = await checkAndPerformAutoEnter(
              ctx,
              info.seminarId,
              targetUrl,
              info.name,
              '입장가능',
              info.autoEnterDone,
            );
          });
        }
      }

      const item: MonitoredSeminarItem = {
        ...info,
        url: targetUrl,
        status: currentStatus,
        isEnded,
        endedAt,
        quizResultMessage,
        startNotified,
        endNotified,
      };

      if (currentStatus === '입장가능' && !isEnded && !startNotified) {
        item.startNotified = true;
        await sendSeminarLiveStartNotice(item).catch(() => {});
      }

      monitoredSeminarsMap.set(url, item);
    }

    const seminarList = Array.from(monitoredSeminarsMap.values());
    if (seminarList.length === 0) {
      console.log(`[${periodName}] 예정된 세미나가 없어 알림 없이 모니터링을 종료합니다.`);
      return true;
    }

    const initialSeminarNames = seminarList.map((s) => `  - ${s.name} (${s.status})`).join('\n');
    await sendTelegram(
      `[${periodName}] 총 ${seminarList.length}개의 세미나 감시를 시작합니다.\n${initialSeminarNames}`,
    );

    // 초기 발송 조건 체크: 입장가능 또는 종료 상태인 세미나가 있는 경우에만 발송
    const hasInitialActiveOrEnded = seminarList.some((s) => s.status === '입장가능' || s.status === '종료');
    const isAllInitiallySeminarsEnded = seminarList.length > 0 && seminarList.every((s) => s.status === '종료');
    const isAllInitiallySurveysClosed = seminarList.every((s) => {
      if (s.status !== '종료') return false;
      if (s.hasSurvey === false) return true;
      return getSurveyRemainingMinutes(s) === 0;
    });
    const isAllInitiallyCompleted = isAllInitiallySeminarsEnded && (!waitForSurveyClose || isAllInitiallySurveysClosed);

    let lastStatusNoticeText: string | null = null;

    if (hasInitialActiveOrEnded) {
      lastStatusNoticeMessageId = await publishSeminarStatusNotice(
        periodName,
        seminarList,
        lastStatusNoticeMessageId,
        isAllInitiallyCompleted,
        isAutoResume,
      );
      lastStatusNoticeText = buildSeminarStatusMessage(periodName, seminarList, isAllInitiallyCompleted).text;
    }

    if (isAllInitiallyCompleted) {
      console.log(`[${periodName}] 모든 세미나 및 설문이 이미 종료 상태이므로 모니터링을 종료합니다.`);
      return true;
    }

    let loopIteration = 0;

    // 2. API 모니터링 루프 (1분 폴링)
    while (true) {
      loopIteration++;
      const currentTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
      if (currentTime.getHours() >= endHour) {
        const remainingSeminars = Array.from(monitoredSeminarsMap.values())
          .filter((s) => s.status !== '종료')
          .map((s) => `${s.name} (${s.url})`);
        if (remainingSeminars.length > 0) {
          const message = ` ${periodName} 모니터링 시간이 종료되었지만, 마치지 않은 세미나가 있습니다:\n${remainingSeminars.join('\n')}`;
          await sendNotificationToChannel(message);
        }
        break;
      }

      await sleep(pollIntervalMs);

      // 메인 세미나 목록 API 호출
      const pollRes = await getTodaysSeminarsFromApi(startHour, endHour, todayIsoDate);
      if (!pollRes.success) {
        if (pollRes.isAuthExpired) {
          await sendTelegram(`🔒 [${periodName}] 세미나 모니터링 중 세션이 만료되었습니다.`);
        }
        console.warn(`[${periodName}] 세미나 목록 API 폴링 실패, 다음 주기에 재시도합니다.`);
        continue;
      }

      let hasStateChanged = false;

      // 신규 발견된 세미나 추가
      for (const [url, info] of Object.entries(pollRes.seminars)) {
        const trackingKey = getSeminarTrackingKey(url, info.seminarId);
        if (excludedSeminarKeys.has(trackingKey)) continue;

        if (!monitoredSeminarsMap.has(url)) {
          const targetUrl = info.seminarId ? `${SEMINAR_DETAIL_PAGE}${info.seminarId}` : url;
          let isPointExcluded = info.isSurveyPointExcluded ?? false;
          let initialIsEnded = info.status === '종료';
          if (info.seminarId) {
            const detailCheck = await checkSeminarEndStatusFromApi(info.seminarId);
            isPointExcluded = detailCheck.isPointExcluded;
            info.isSurveyPointExcluded = isPointExcluded;
            if (detailCheck.isEnded) {
              initialIsEnded = true;
            }
          }
          if (isPointExcluded) {
            excludedSeminarKeys.add(trackingKey);
            continue;
          }

          monitoredSeminarsMap.set(url, {
            ...info,
            url: targetUrl,
            status: initialIsEnded ? '종료' : info.status || '대기',
            isEnded: initialIsEnded,
            endedAt: initialIsEnded ? Date.now() : undefined,
            quizResultMessage: null,
            startNotified: false,
            endNotified: initialIsEnded,
          });
        }
      }

      // 5분마다 하트비트 로깅
      if (loopIteration % 5 === 0) {
        const currentList = Array.from(monitoredSeminarsMap.values());
        const activeSummary = currentList
          .map((s) => `${s.name}(${s.status},입장=${s.autoEnterDone ? '완료' : '미완료'})`)
          .join(', ');
        console.log(`[${periodName}] 모니터링 진행 중 (총 ${currentList.length}건: ${activeSummary})`);
      }

      // 각 세미나 상태 감시
      for (const [url, currentSeminar] of monitoredSeminarsMap.entries()) {
        const apiInfo = pollRes.seminars[url];
        const seminarId = currentSeminar.seminarId || apiInfo?.seminarId;
        const name = apiInfo?.name || currentSeminar.name;
        const targetUrl = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : url;

        // ── A. 이미 종료된 세미나는 스킵
        if (currentSeminar.status === '종료' || currentSeminar.isEnded) {
          continue;
        }

        // ── B. 종료 감시
        // 1) 메인 API의 status/processState/seminarCompleted로 1차 판정
        let isEnded =
          apiInfo?.status === '종료' ||
          apiInfo?.processState === ProcessState.PROCESS_END ||
          apiInfo?.processState === ProcessState.PROCESS_COMPLETED ||
          apiInfo?.seminarCompleted === 1;

        let isSurveyOpen = false;
        let isDetailPointExcluded = currentSeminar.isSurveyPointExcluded;

        // 2) 활성 세미나 상세 API(checkSeminarEndStatusFromApi)로 실시간 설문 오픈(surveyState===1) 및 종료 상태 확인
        if (seminarId && !isEnded) {
          const endCheck = await checkSeminarEndStatusFromApi(seminarId);
          if (endCheck.isEnded) {
            isEnded = true;
            isSurveyOpen = endCheck.isSurveyOpen;
          }
          if (endCheck.isPointExcluded !== undefined) {
            isDetailPointExcluded = endCheck.isPointExcluded;
            currentSeminar.isSurveyPointExcluded = isDetailPointExcluded;
          }
        }

        if (isEnded) {
          console.log(`[${periodName}] 세미나 종료 감지됨: ${name} (${seminarId}), isSurveyOpen=${isSurveyOpen}`);

          // 1) Playwright 온디맨드로 설문 및 퀴즈 처리
          let quizResultMessage: string | null = null;

          if (!currentSeminar.isSurveyPointExcluded && !isDetailPointExcluded) {
            await withBrowserContext(providedContext, async (ctx) => {
              const res = await handleSeminarEndAndQuiz(
                ctx,
                {
                  name,
                  seminarId,
                  isSurveyPointExcluded: false,
                },
                url,
              );
              quizResultMessage = res.message;
            });
          }

          currentSeminar.status = '종료';
          currentSeminar.isEnded = true;
          currentSeminar.endedAt = currentSeminar.endedAt || Date.now();
          currentSeminar.quizResultMessage = quizResultMessage;
          hasStateChanged = true;

          if (!currentSeminar.endNotified) {
            currentSeminar.endNotified = true;
            await sendSeminarLiveEndNotice(currentSeminar).catch(() => {});
          }
          continue;
        }

        // ── C. 입장 감시 및 자동 입장
        const isReadyForEntry =
          currentSeminar.processState === ProcessState.PROCESS_ENTER ||
          currentSeminar.processState === ProcessState.PROCESS_STARTED ||
          apiInfo?.status === '입장가능' ||
          isSeminarStartedByTime(currentSeminar.startDt);

        if (isReadyForEntry) {
          if (currentSeminar.status === '대기') {
            console.log(`[${periodName}] Seminar newly ready for entry / started: ${name} (${seminarId})`);
            currentSeminar.status = '입장가능';
            currentSeminar.isEntryStarted = true;
            hasStateChanged = true;

            if (!currentSeminar.startNotified) {
              currentSeminar.startNotified = true;
              await sendSeminarLiveStartNotice(currentSeminar).catch(() => {});
            }

            // 자동 입장 시도
            await withBrowserContext(providedContext, async (ctx) => {
              currentSeminar.autoEnterDone = await checkAndPerformAutoEnter(
                ctx,
                seminarId,
                targetUrl,
                name,
                '입장가능',
                currentSeminar.autoEnterDone,
              );
            });
          } else if (!currentSeminar.autoEnterDone) {
            // 이미 입장가능 상태이나 아직 입장이 완료되지 않은 경우 재시도
            await withBrowserContext(providedContext, async (ctx) => {
              currentSeminar.autoEnterDone = await checkAndPerformAutoEnter(
                ctx,
                seminarId,
                targetUrl,
                name,
                '입장가능',
                currentSeminar.autoEnterDone,
              );
            });
          }
        }
      }

      // ── D. 설문 마감 임박 알림 (20분 전, 10분 전) 감시
      const currentNowMs = Date.now();
      for (const currentSeminar of monitoredSeminarsMap.values()) {
        if (
          currentSeminar.status === '종료' &&
          currentSeminar.hasSurvey !== false &&
          !currentSeminar.isSurveyPointExcluded
        ) {
          const surveyEndTime = getSeminarSurveyEndTime(currentSeminar);
          if (surveyEndTime) {
            const diffMs = surveyEndTime - currentNowMs;
            const rawMinutes = diffMs / (60 * 1000);

            // 20분 전 알림 (잔여 시간 20분 이하 0분 초과)
            if (rawMinutes <= 20 && rawMinutes > 0 && !currentSeminar.notifiedClosing20) {
              currentSeminar.notifiedClosing20 = true;
              await sendSurveyClosingNotice(currentSeminar, 20).catch((e) => {
                console.error(`[${periodName}] 설문 마감 20분전 알림 발송 실패 (${currentSeminar.name})`, e);
              });
            }

            // 10분 전 알림 (잔여 시간 10분 이하 0분 초과)
            if (rawMinutes <= 10 && rawMinutes > 0 && !currentSeminar.notifiedClosing10) {
              currentSeminar.notifiedClosing10 = true;
              await sendSurveyClosingNotice(currentSeminar, 10).catch((e) => {
                console.error(`[${periodName}] 설문 마감 10분전 알림 발송 실패 (${currentSeminar.name})`, e);
              });
            }
          }
        }
      }

      // ── E. 상태 변화 및 10분 단위 설문 잔여 시간 변경 시 공지 수정/발송
      const currentList = Array.from(monitoredSeminarsMap.values());
      const isAllSeminarsEnded = currentList.length > 0 && currentList.every((s) => s.status === '종료');
      const isAllSurveysClosed = currentList.every((s) => {
        if (s.status !== '종료') return false;
        if (s.hasSurvey === false) return true;
        return getSurveyRemainingMinutes(s, currentNowMs) === 0;
      });
      const isAllCompleted = isAllSeminarsEnded && (!waitForSurveyClose || isAllSurveysClosed);

      const currentStatusText = buildSeminarStatusMessage(
        periodName,
        currentList,
        isAllCompleted,
        undefined,
        currentNowMs,
      ).text;

      if (hasStateChanged) {
        // 주요 상태 변화 (대기->입장가능 또는 입장가능->종료): publishSeminarStatusNotice
        lastStatusNoticeMessageId = await publishSeminarStatusNotice(
          periodName,
          currentList,
          lastStatusNoticeMessageId,
          isAllCompleted,
          isAutoResume,
        );
        lastStatusNoticeText = currentStatusText;

        if (isAllCompleted) {
          console.log(`[${periodName}] 모든 세미나 및 설문이 종료되었습니다. 모니터링을 완료합니다.`);
          break;
        }
      } else if (lastStatusNoticeText !== currentStatusText && lastStatusNoticeMessageId) {
        // 10분 단위 설문 잔여 시간 변경 등 텍스트 변화 시: editChannelMessage로 인플레이스 수정
        const editRes = await editChannelMessage(lastStatusNoticeMessageId, currentStatusText);
        if (editRes.success) {
          lastStatusNoticeText = currentStatusText;
        } else {
          // 수정 실패 시 publishSeminarStatusNotice로 재시도
          lastStatusNoticeMessageId = await publishSeminarStatusNotice(
            periodName,
            currentList,
            lastStatusNoticeMessageId,
            isAllCompleted,
            isAutoResume,
          );
          lastStatusNoticeText = currentStatusText;
        }

        if (isAllCompleted) {
          console.log(`[${periodName}] 모든 세미나 및 설문이 종료되었습니다. 모니터링을 완료합니다.`);
          break;
        }
      }
    }

    await sendTelegram(`[${periodName}] 세미나 감시를 종료합니다.`);
    return true;
  } catch (e) {
    console.error(
      `[${periodName}] seminar monitoring task error`,
      e && typeof e === 'object' && 'stack' in e ? (e as Error).stack : e,
    );
    const message = e instanceof Error ? e.message : String(e);
    await sendTelegram(`❗ [${periodName}] 세미나 감시 작업 오류: ${message}`).catch(() => {});
    return false;
  }
}

export { monitorSeminars };
