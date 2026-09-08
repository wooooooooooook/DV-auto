import { ProcessState, SurveyState } from '../modules/seminar_api';
import {
  editChannelMessage,
  getSeminarStatusChannelMessage,
  getChannelMessageById,
  publishAndReplaceChannelNotice,
  getRecentChannelMessages,
  updateChannelMessageStatus,
  DEFAULT_NOTICE_OPTIONS,
  formatRecentCommentsSection,
} from '../services/channel_message_repository';
import { sendToTopicSubscribers, type SubscriptionTopic } from '../services/subscription_service';
import { formatPrivateSeminarTag, truncateSeminarName, formatSeminarDisplayName } from '../modules/utils';

export { formatPrivateSeminarTag, truncateSeminarName, formatSeminarDisplayName };

export const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
export const SEMINAR_DETAIL_PC_PAGE = 'https://www.doctorville.co.kr/seminar/seminarDetail';

export const seoulDateString = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

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
  hasEntryHistory?: boolean;
  autoEnterDone?: boolean;
  isEntryStarted?: boolean;
  isEnded?: boolean;
  endedAt?: number;
  surveyEndTime?: number;
  surveyEndDt?: string | null;
  surveyStartDt?: string | null;
  surveyMinutesLeft?: number | null;
  quizResultMessage?: string | null;
  processState?: number;
  cancelProcessState?: number;
  seminarCompleted?: number;
  surveyState?: number;
  hiddenYn?: string;
  diseaseCategoryNm?: string;
  startNotified?: boolean;
  endNotified?: boolean;
  notifiedClosing20?: boolean;
  notifiedClosing10?: boolean;
}

export type SeminarInfo = MonitoredSeminarItem;

/**
 * 설문 마감/시작 시각 문자열(예: "2026-08-28 14:41:57.0")을 파싱하여 timestamp(ms)를 반환합니다.
 */
export function parseSurveyEndTimestamp(surveyDt?: string | null): number | null {
  if (!surveyDt) return null;
  try {
    const clean = surveyDt.trim().replace('T', ' ');
    const iso = clean.includes('+') || clean.endsWith('Z') ? clean : `${clean.replace(' ', 'T')}+09:00`;
    const ts = new Date(iso).getTime();
    if (!Number.isNaN(ts)) return ts;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 종료된 세미나의 실제 endedAt(종료 감지 timestamp)을 산출합니다.
 * - 이미 endedAt이 존재하는 경우 기존 값 유지 (덮어씌우지 않음)
 * - 서버의 survey.startDt(실제 오픈 시각) 또는 survey.endDt(실제 마감 시각 - 60분) 파싱값 우선 반영
 * - 설문이 공식 마감(surveyState === SurveyState.SURVEY_CLOSED: 3)된 경우 마감 시각 반환
 * - 실시간 종료 감지 또는 종료 상태로 확인된 시점: 감지 시점(nowMs) 반환
 */
export function resolveSeminarEndedAt(
  seminar: {
    endedAt?: number;
    surveyEndTime?: number;
    surveyEndDt?: string | null;
    surveyStartDt?: string | null;
    surveyMinutesLeft?: number | null;
  },
  surveyState?: number,
  seminarCompleted?: number,
  nowMs = Date.now(),
): number {
  // 0. 이미 endedAt이 존재하는 경우 덮어씌우지 않고 기존 값 유지
  if (seminar.endedAt) {
    return seminar.endedAt;
  }

  // 1. 서버 API에서 내려준 설문 오픈 시각(surveyStartDt) 파싱값 우선
  const parsedSurveyStart = parseSurveyEndTimestamp(seminar.surveyStartDt);
  if (parsedSurveyStart && nowMs >= parsedSurveyStart) {
    return parsedSurveyStart;
  }

  // 2. 서버 API에서 내려준 설문 마감 시각(surveyEndDt) 기준 시작 시각 추정
  const parsedSurveyEnd = parseSurveyEndTimestamp(seminar.surveyEndDt);
  if (parsedSurveyEnd) {
    const estimatedStart = parsedSurveyEnd - 60 * 60 * 1000;
    if (nowMs >= estimatedStart) {
      return estimatedStart;
    }
  }

  // 3. 설문이 공식 마감(SURVEY_CLOSED: 3)된 경우 마감 시각(60분 이상 지난 과거 시각) 반환
  if (surveyState === SurveyState.SURVEY_CLOSED) {
    return nowMs - 2 * 60 * 60 * 1000;
  }

  // 4. 실시간 종료 감지 또는 새로 확인된 종료 세미나: 현재 감지 시각 반환
  return nowMs;
}

/**
 * 세미나의 설문 마감 시각을 구합니다.
 * 1순위: 세미나 객체의 surveyEndTime
 * 2순위: 서버 API의 실제 설문 마감 시각(surveyEndDt) 파싱값
 * 3순위: 서버 API의 설문 잔여 시간(surveyMinutesLeft > 0) 기준 산출
 * 4순위: endedAt(종료 감지 시각) + 60분 (3600000ms)
 */
export function getSeminarSurveyEndTime(
  seminar: {
    endedAt?: number;
    surveyEndTime?: number;
    surveyEndDt?: string | null;
    surveyMinutesLeft?: number | null;
  },
  nowMs = Date.now(),
): number | null {
  if (seminar.surveyEndTime) {
    return seminar.surveyEndTime;
  }

  const parsedSurveyEnd = parseSurveyEndTimestamp(seminar.surveyEndDt);
  if (parsedSurveyEnd) {
    return parsedSurveyEnd;
  }

  if (typeof seminar.surveyMinutesLeft === 'number' && Number.isFinite(seminar.surveyMinutesLeft)) {
    if (seminar.surveyMinutesLeft <= 0) return nowMs;
    return nowMs + seminar.surveyMinutesLeft * 60 * 1000;
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
  seminar: {
    endedAt?: number;
    surveyEndTime?: number;
    surveyEndDt?: string | null;
    surveyMinutesLeft?: number | null;
  },
  nowMs = Date.now(),
): number | null {
  const surveyEndTime = getSeminarSurveyEndTime(seminar, nowMs);
  if (!surveyEndTime) return null;
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

export interface ParsedPrevSeminar {
  status: SeminarStatus;
  seminarId: string | null;
  url: string | null;
  title: string | null;
  quizResultMessage?: string | null;
}

const STATUS_PREFIX_REGEX = /^(?:(🔴)\s*종료|(🟢)\s*입장가능|(⏳)\s*대기)/;

/**
 * 기존 공지 메시지 본문에서 세미나 항목별 상태, seminarId, url, 제목 및 퀴즈 정답 정보를 정규식으로 파싱합니다.
 */
export function parsePrevNoticeSeminars(prevText: string): ParsedPrevSeminar[] {
  if (!prevText || !prevText.trim()) return [];

  const results: ParsedPrevSeminar[] = [];
  const lines = prevText.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const match = line.match(STATUS_PREFIX_REGEX);
    if (!match) continue;

    let status: SeminarStatus = '대기';
    if (match[1]) {
      status = '종료';
    } else if (match[2]) {
      status = '입장가능';
    } else if (match[3]) {
      status = '대기';
    }

    // 상태 라인에서 title 추출 (예: "🔴 종료 | 18:30~20:00 제목")
    let title: string | null = null;
    const pipeIdx = line.indexOf('|');
    if (pipeIdx !== -1) {
      title = line.slice(pipeIdx + 1).trim();
    }

    // 바로 다음 줄(들)에서 URL / seminarId 및 퀴즈 정답 탐색
    let seminarId: string | null = null;
    let url: string | null = null;
    let quizResultMessage: string | null = null;
    let urlFound = false;

    for (let j = i + 1; j < lines.length; j++) {
      const nextLine = lines[j].trim();
      if (
        STATUS_PREFIX_REGEX.test(nextLine) ||
        nextLine.startsWith('💬') ||
        nextLine.startsWith('━') ||
        nextLine.startsWith('🏁') ||
        nextLine.startsWith('🔔')
      ) {
        break;
      }
      if (!urlFound) {
        if (nextLine.startsWith('http://') || nextLine.startsWith('https://')) {
          url = nextLine;
          urlFound = true;
          const idMatch = nextLine.match(/(?:\/seminar\/|seminar_id=)(\d+)/);
          if (idMatch) {
            seminarId = idMatch[1];
          }
        }
      } else {
        if (!nextLine) continue;
        const isSurveyLine =
          (nextLine.startsWith('(') && (nextLine.includes('설문') || nextLine.includes('마감'))) ||
          nextLine === '(설문이 없는 세미나)';
        if (!isSurveyLine) {
          quizResultMessage = quizResultMessage ? `${quizResultMessage}\n${nextLine}` : nextLine;
        }
      }
    }

    results.push({ status, seminarId, url, title, quizResultMessage: quizResultMessage || undefined });
  }

  return results;
}

/**
 * 당일 공지 메시지(또는 지정된 메시지 ID)에서 이전 세미나별 정보(상태 및 퀴즈 정답 등)를 파싱하여 복원합니다.
 */
export function getPrevNoticeSeminarsForPeriod(
  periodName: string,
  todayIsoDate: string,
  lastStatusNoticeMessageId?: number | null,
): ParsedPrevSeminar[] {
  const existingMsg =
    (lastStatusNoticeMessageId ? getChannelMessageById(lastStatusNoticeMessageId) : null) ||
    getSeminarStatusChannelMessage(periodName, todayIsoDate);
  if (!existingMsg?.text) return [];
  return parsePrevNoticeSeminars(existingMsg.text);
}

/**
 * 이전 공지 파싱 목록에서 특정 세미나와 일치하는 정보를 찾습니다.
 */
export function findPrevSeminarInfo(
  prevSeminars: ParsedPrevSeminar[],
  info: { seminarId?: string | null; url?: string; name: string },
): ParsedPrevSeminar | undefined {
  if (!prevSeminars || prevSeminars.length === 0) return undefined;
  const targetSeminarId = info.seminarId ? String(info.seminarId).trim() : null;
  const targetUrl = info.url;
  const truncatedName = info.name && info.name.length > 20 ? info.name.slice(0, 20) : info.name;

  return prevSeminars.find((p) => {
    if (targetSeminarId && p.seminarId && targetSeminarId === String(p.seminarId).trim()) return true;
    if (targetUrl && p.url && targetUrl === p.url) return true;
    if (p.title && truncatedName && (p.title.includes(truncatedName) || info.name.includes(p.title))) return true;
    return false;
  });
}

/**
 * 기존 공지 메시지 본문과 현재 세미나 목록을 비교하여,
 * 세미나의 시작(대기 -> 입장가능) 또는 종료(입장가능/대기 -> 종료), 신규 세미나 추가 등
 * 주요 상태 전이(State Transition)가 발생했는지 판별합니다.
 * - 신규 세미나 추가 또는 세미나 상태(시작/종료) 변화 시: true (새 공지 발행)
 * - 단순 설문 시간 갱신, 댓글 추가, 세미나 취소/삭제 시: false (기존 메시지 edit)
 * - currentSeminars가 빈 배열인 경우: false
 */
export function hasSeminarStatusTransition(prevText: string, currentSeminars: MonitoredSeminarItem[]): boolean {
  if (!prevText || !prevText.trim()) {
    return true;
  }
  if (currentSeminars.length === 0) {
    return false;
  }

  const prevSeminars = parsePrevNoticeSeminars(prevText);

  // 현재 세미나 목록의 각 세미나와 이전 세미나 목록 매칭 및 상태 비교
  for (const current of currentSeminars) {
    const currentId = current.seminarId ? String(current.seminarId).trim() : null;

    let matched: ParsedPrevSeminar | undefined;

    if (currentId) {
      // seminarId 존재 시 ID 매칭만 사용
      matched = prevSeminars.find((p) => p.seminarId === currentId);
    } else {
      // seminarId가 없는 경우에만 URL 또는 제목으로 매칭
      matched = prevSeminars.find((p) => {
        if (current.url && p.url && p.url === current.url) return true;
        const truncatedName = current.name.length > 20 ? current.name.slice(0, 20) : current.name;
        if (p.title && (p.title.includes(truncatedName) || current.name.includes(p.title))) return true;
        return false;
      });
    }

    if (!matched) {
      // 이전 공지에 없던 세미나 -> 상태 전이 발생
      return true;
    }

    // 상태 비교 (대기 -> 입장가능, 입장가능 -> 종료 등)
    if (matched.status !== current.status) {
      return true;
    }
  }

  return false;
}

/**
 * 세미나의 시작 시간(startDt 또는 time) 파싱 정보 반환
 */
export function getSeminarStartTimeValue(s: { startDt?: string; time?: string }): {
  date: string;
  timeStr: string;
  timestamp: number;
} {
  let date = '';
  let timeStr = '';
  let timestamp = Infinity;

  if (s.startDt) {
    const clean = s.startDt.trim().replace('T', ' ');
    const parts = clean.split(' ');
    date = parts[0] || '';
    const fullTime = parts[1] || '';
    timeStr = fullTime.slice(0, 5); // "HH:mm"
    const iso = clean.includes('+') || clean.endsWith('Z') ? clean : `${clean.replace(' ', 'T')}+09:00`;
    const ts = new Date(iso).getTime();
    if (!Number.isNaN(ts)) {
      timestamp = ts;
    }
  }

  if (!timeStr && s.time) {
    const startHM = s.time.split('~')[0]?.trim();
    if (startHM && startHM.includes(':')) {
      timeStr = startHM.slice(0, 5);
    }
  }

  return { date, timeStr, timestamp };
}

/**
 * 세미나 항목을 시작 시간 순(오름차순: 이른 시간 우선)으로 비교합니다.
 * 1순위: startDt timestamp (유효한 경우)
 * 2순위: time 문자열 ("HH:mm")
 * 3순위: seminarId (숫자 오름차순)
 * 4순위: name (사전순)
 */
export function compareSeminarsByStartTime(a: MonitoredSeminarItem, b: MonitoredSeminarItem): number {
  const valA = getSeminarStartTimeValue(a);
  const valB = getSeminarStartTimeValue(b);

  // 1. timestamp가 둘 다 유효한 경우 timestamp로 비교
  if (Number.isFinite(valA.timestamp) && Number.isFinite(valB.timestamp)) {
    if (valA.timestamp !== valB.timestamp) {
      return valA.timestamp - valB.timestamp;
    }
  } else if (Number.isFinite(valA.timestamp)) {
    return -1;
  } else if (Number.isFinite(valB.timestamp)) {
    return 1;
  }

  // 2. timeStr("HH:mm") 비교
  if (valA.timeStr && valB.timeStr && valA.timeStr !== valB.timeStr) {
    return valA.timeStr.localeCompare(valB.timeStr);
  } else if (valA.timeStr && !valB.timeStr) {
    return -1;
  } else if (!valA.timeStr && valB.timeStr) {
    return 1;
  }

  // 3. seminarId 비교 (오름차순)
  const idA = a.seminarId ? String(a.seminarId).trim() : '';
  const idB = b.seminarId ? String(b.seminarId).trim() : '';
  if (idA && idB && idA !== idB) {
    const numA = parseInt(idA, 10);
    const numB = parseInt(idB, 10);
    if (!isNaN(numA) && !isNaN(numB)) {
      return numA - numB;
    }
    return idA.localeCompare(idB);
  }

  // 4. name 비교
  return (a.name || '').localeCompare(b.name || '');
}

/**
 * 세미나 목록을 시작 시간 순(오름차순: 이른 시간 우선)으로 정렬합니다.
 */
export function sortSeminarsByStartTime(seminars: MonitoredSeminarItem[]): MonitoredSeminarItem[] {
  return [...seminars].sort(compareSeminarsByStartTime);
}

/**
 * 세미나 현황 통합 메시지 및 인라인 키보드 생성 (댓글 섹션 포함)
 * - 세미나 항목을 시작 시간 순(오름차순)으로 정렬하여 표시
 * - 제목의 **(볼드) 제거
 * - 시작종료시각을 제목 앞에 표시
 * - 제목은 20글자로 트렁케이션
 * - 퀴즈정답은 요약(퀴즈정답: 123 등)만 표시 (상세 퀴즈 문항/답 제외)
 * - 종료된 세미나의 설문 가능 시간(약 몇분 남음) 표시 (endedAt이 있는 경우)
 */
export function buildSeminarStatusMessage(
  periodName: string,
  seminars: MonitoredSeminarItem[],
  isAllCompleted = false,
  comments: Array<{ userName: string; text: string }> = [],
  nowMs = Date.now(),
  timeExpiredMessage?: string | null,
): { text: string; options: Record<string, unknown> } {
  if (seminars.length === 0) {
    return {
      text: `🔔 ${periodName}세미나\n\n예정된 세미나가 없습니다.`,
      options: { link_preview_options: { is_disabled: true } },
    };
  }

  const sortedList = sortSeminarsByStartTime(seminars);

  let text = `🔔 ${periodName}세미나\n\n`;

  for (let i = 0; i < sortedList.length; i++) {
    const s = sortedList[i];
    const statusDisplay = getSeminarStatusDisplay(s);

    const seminarTitle = formatSeminarDisplayName(s, {
      includeTime: true,
      maxLen: 20,
    });
    const targetUrl = s.url || (s.seminarId ? `${SEMINAR_DETAIL_PAGE}${s.seminarId}` : '');
    text += `${statusDisplay.emoji} ${statusDisplay.text} | ${seminarTitle}\n${targetUrl}`;

    if (s.status === '종료' || statusDisplay.text === '종료') {
      const summaryQuiz = extractQuizSummaryOnly(s.quizResultMessage);
      if (summaryQuiz) {
        text += `\n${summaryQuiz}`;
      }
      if (s.hasSurvey === false) {
        text += `\n(설문이 없는 세미나)`;
      } else {
        const minutesLeft = getSurveyRemainingMinutes(s, nowMs);
        if (minutesLeft !== null) {
          if (minutesLeft > 0) {
            text += `\n(설문 마감 약 ${minutesLeft}분 남음)`;
          } else {
            text += `\n(설문 마감)`;
          }
        }
      }
    }

    if (i < sortedList.length - 1) {
      text += '\n\n';
    }
  }

  // 이전 댓글 섹션 첨부 (최근 최대 5개)
  text += formatRecentCommentsSection(comments);

  if (isAllCompleted) {
    text += `\n━━━━━━━━━━━━━━━━━━\n🏁 ${periodName}세미나가 모두 종료되었습니다.`;
  } else if (timeExpiredMessage) {
    text += `\n━━━━━━━━━━━━━━━━━━\n⚠️ ${timeExpiredMessage}`;
  }

  return { text, options: DEFAULT_NOTICE_OPTIONS };
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
  const seminarTitle = formatSeminarDisplayName(seminar, {
    includeTime: true,
    maxLen: false,
  });
  const targetUrl = seminar.url || (seminar.seminarId ? `${SEMINAR_DETAIL_PAGE}${seminar.seminarId}` : '');

  const text = `🟢 <b>[세미나 시작]</b>\n\n${seminarTitle}\n${targetUrl}`;

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
  const seminarTitle = formatSeminarDisplayName(seminar, {
    includeTime: true,
    maxLen: false,
  });
  const targetUrl = seminar.url || (seminar.seminarId ? `${SEMINAR_DETAIL_PAGE}${seminar.seminarId}` : '');

  let text = `🔴 <b>[세미나 종료]</b>\n\n${seminarTitle}\n${targetUrl}`;

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
  const seminarTitle = formatSeminarDisplayName(seminar, {
    includeTime: true,
    maxLen: false,
  });
  const targetUrl = seminar.url || (seminar.seminarId ? `${SEMINAR_DETAIL_PAGE}${seminar.seminarId}` : '');

  let text = `⏳ <b>[설문 마감 ${minutesLeft}분 전]</b>\n\n${seminarTitle}\n${targetUrl}`;

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
  timeExpiredMessage?: string | null,
): Promise<number | null> {
  const result = await publishAndReplaceChannelNotice({
    prevMessageId,
    buildMessageFn: (commentsToAttach) =>
      buildSeminarStatusMessage(periodName, seminars, isAllCompleted, commentsToAttach, undefined, timeExpiredMessage),
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

export const activeMonitors = new Set<Map<string, MonitoredSeminarItem>>();

/**
 * 사용자가 입력한 퀴즈 정답 텍스트를 공지 표준 형식으로 포맷팅합니다.
 * "단순하게 퀴즈정답 뒤에 입력한 텍스트를 붙인다"
 * - 예: "112" -> "퀴즈 정답 112"
 * - 예: "1번 O, 2번 X" -> "퀴즈 정답 1번 O, 2번 X"
 * - 이미 "퀴즈 정답" / "퀴즈정답" 으로 시작하는 경우 중복 추가 방지
 */
export function formatQuizAnswerInput(rawAnswer: string): string {
  const trimmed = rawAnswer.trim();
  if (!trimmed) return '';
  if (
    trimmed.startsWith('퀴즈 정답') ||
    trimmed.startsWith('퀴즈정답') ||
    /^\[.+?\]\s*(?:퀴즈\s*)?정답/i.test(trimmed) ||
    /^정답\s*[:\s]/i.test(trimmed)
  ) {
    return trimmed;
  }
  return `퀴즈 정답 ${trimmed}`;
}

/**
 * 실행 중인 세미나 모니터링 인메모리 맵에 퀴즈 정답을 반영합니다.
 */
export function updateActiveSeminarQuiz(seminarId: string, formattedQuizAnswer: string): boolean {
  const cleanId = seminarId.trim();
  let updated = false;
  for (const monitorMap of activeMonitors) {
    for (const item of monitorMap.values()) {
      if (item.seminarId === cleanId || (item.url && item.url.includes(`/seminar/${cleanId}`))) {
        item.quizResultMessage = formattedQuizAnswer;
        updated = true;
      }
    }
  }
  return updated;
}

/**
 * 공지방 메시지 텍스트에서 특정 세미나 항목의 퀴즈 정답을 삽입하거나 교체합니다.
 */
export function updateSeminarQuizInMessageText(
  originalText: string,
  seminarId: string,
  formattedQuizAnswer: string,
): { updatedText: string; success: boolean } {
  const lines = originalText.split('\n');
  const cleanSeminarId = seminarId.trim();

  let targetUrlLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith('http') &&
      (line.includes(`/seminar/${cleanSeminarId}`) ||
        line.includes(`seminar_id=${cleanSeminarId}`) ||
        line.endsWith(`/${cleanSeminarId}`))
    ) {
      targetUrlLineIdx = i;
      break;
    }
  }

  if (targetUrlLineIdx === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(cleanSeminarId)) {
        targetUrlLineIdx = i;
        break;
      }
    }
  }

  if (targetUrlLineIdx === -1) {
    return { updatedText: originalText, success: false };
  }

  const nextLineIdx = targetUrlLineIdx + 1;
  const nextLine = nextLineIdx < lines.length ? lines[nextLineIdx].trim() : '';

  const isSurveyLine = (l: string) => l.startsWith('(') && (l.includes('설문') || l.includes('마감'));
  const isSectionBoundary = (l: string) =>
    l === '' ||
    l.startsWith('🔔') ||
    l.startsWith('💬') ||
    l.startsWith('━') ||
    l.startsWith('🏁') ||
    /^[🔴🟢⏳]/u.test(l);

  if (nextLineIdx >= lines.length || isSectionBoundary(nextLine)) {
    // URL 바로 뒤에 새 라인 삽입
    lines.splice(targetUrlLineIdx + 1, 0, formattedQuizAnswer);
  } else if (isSurveyLine(nextLine)) {
    // 설문 라인 앞에 퀴즈 정답 삽입
    lines.splice(nextLineIdx, 0, formattedQuizAnswer);
  } else {
    // 기존 퀴즈 라인이 있는 경우 교체
    lines[nextLineIdx] = formattedQuizAnswer;
  }

  return { updatedText: lines.join('\n'), success: true };
}

/**
 * 특정 세미나의 퀴즈 정답을 공지방(채널) 메시지 및 활성 모니터링 상태에 수동으로 등록/수정합니다.
 */
export async function setSeminarQuizAnswer(
  seminarId: string,
  rawAnswer: string,
): Promise<{
  success: boolean;
  message: string;
  formattedAnswer: string;
  channelMessageId?: number;
  isLiveUpdated: boolean;
}> {
  const cleanSeminarId = seminarId.trim();
  const formattedAnswer = formatQuizAnswerInput(rawAnswer);

  if (!cleanSeminarId) {
    return {
      success: false,
      message: '세미나 번호(seminarId)가 입력되지 않았습니다.',
      formattedAnswer: '',
      isLiveUpdated: false,
    };
  }

  if (!formattedAnswer) {
    return {
      success: false,
      message: '퀴즈 정답 내용이 입력되지 않았습니다.',
      formattedAnswer: '',
      isLiveUpdated: false,
    };
  }

  // 1. 활성 모니터링 맵 업데이트 (실행 중인 모니터링이 있는 경우)
  const isLiveUpdated = updateActiveSeminarQuiz(cleanSeminarId, formattedAnswer);

  // 2. 공지방(채널) 메시지 검색 (getRecentChannelMessages는 이미 최신순 DESC 정렬)
  const recentMessages = getRecentChannelMessages(50).filter((m) => m.status !== 'deleted' && m.text);

  // seminarId가 포함된 가장 최근의 세미나 현황 메시지 검색 (최신순에서 첫 번째 매칭)
  const targetMsg = recentMessages.find(
    (m) =>
      m.text &&
      (m.text.includes(`/seminar/${cleanSeminarId}`) ||
        m.text.includes(`seminar_id=${cleanSeminarId}`) ||
        m.text.includes(cleanSeminarId)),
  );

  if (!targetMsg) {
    return {
      success: true,
      message: isLiveUpdated
        ? `✅ 활성 세미나 모니터링에 퀴즈 정답이 반영되었습니다. (공지방 메시지는 아직 전송되지 않음)\n• 정답: ${formattedAnswer}`
        : `⚠️ 공지방에서 세미나(${cleanSeminarId})가 포함된 메시지를 찾지 못했습니다.\n• 정답: ${formattedAnswer}${isLiveUpdated ? ' (활성 모니터링 반영됨)' : ''}`,
      formattedAnswer,
      isLiveUpdated,
    };
  }

  const { updatedText, success: updateSuccess } = updateSeminarQuizInMessageText(
    targetMsg.text!,
    cleanSeminarId,
    formattedAnswer,
  );

  if (!updateSuccess) {
    return {
      success: false,
      message: `❌ 공지 메시지(ID: ${targetMsg.messageId}) 내에서 세미나(${cleanSeminarId}) 항목의 위치를 찾지 못했습니다.`,
      formattedAnswer,
      channelMessageId: targetMsg.messageId,
      isLiveUpdated,
    };
  }

  // Telegram 채널 메시지 수정
  const editRes = await editChannelMessage(targetMsg.messageId, updatedText, {
    channelId: targetMsg.channelId,
  });

  if (!editRes.success) {
    return {
      success: false,
      message: `❌ 공지방 메시지(ID: ${targetMsg.messageId}) 수정 실패: ${editRes.message}`,
      formattedAnswer,
      channelMessageId: targetMsg.messageId,
      isLiveUpdated,
    };
  }

  // DB 갱신
  updateChannelMessageStatus(targetMsg.messageId, 'edited', updatedText, targetMsg.channelId);

  return {
    success: true,
    message: `📢 공지방 세미나(${cleanSeminarId}) 퀴즈 정답 수정 완료!\n\n• 수정된 내용: ${formattedAnswer}\n• 메시지 ID: ${targetMsg.messageId}${isLiveUpdated ? '\n• 실시간 모니터링 상태 동기화 완료' : ''}`,
    formattedAnswer,
    channelMessageId: targetMsg.messageId,
    isLiveUpdated,
  };
}

export const getSeminarTrackingKey = (url: string, seminarId: string | null | undefined): string => {
  if (seminarId && String(seminarId).trim()) {
    return String(seminarId).trim();
  }
  const match = url ? url.match(/(?:seminarId=|\/)(\d+)$/) : null;
  if (match && match[1]) {
    return match[1];
  }
  return url || '';
};

/**
 * 세미나 startDt 기반으로 세미나 시작 시간 도래 여부 판정
 * 한국 시간(KST, UTC+9) 기준으로 현재 시각(또는 referenceTimeMs) >= startDt 인지 비교
 */
export function isSeminarStartedByTime(startDt?: string, referenceTimeMs?: number): boolean {
  if (!startDt) return false;
  try {
    const clean = startDt.trim().replace('T', ' ');
    const iso = clean.includes('+') || clean.endsWith('Z') ? clean : `${clean.replace(' ', 'T')}+09:00`;
    const startMs = new Date(iso).getTime();
    if (Number.isNaN(startMs)) return false;

    const now = referenceTimeMs !== undefined ? referenceTimeMs : Date.now();
    return now >= startMs;
  } catch {
    return false;
  }
}
