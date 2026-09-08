import type { BrowserContext, Page } from 'playwright';
import type { TaskContext } from '../types';
import { sendTelegram, sleep } from '../modules/utils';
import {
  fetchMainFutureSeminars,
  fetchSeminarDetail,
  applySeminarWithTerms,
  parseSeminarDateTime,
  checkIsAdvancedSurvey,
  checkIsPointExcluded,
  ProcessState,
  SurveyState,
  type FutureSeminarApiItem,
  type SeminarSurveyInfo,
} from '../modules/seminar_api';
import * as seminarRepo from '../services/seminar_repository';
import { syncSeminarsDetailToDb } from '../services/seminar_sync_service';
import {
  editChannelMessage,
  getSeminarStatusChannelMessage,
  getChannelCommentsByParentMessageId,
} from '../services/channel_message_repository';
import * as logger from '../services/logger';

import { tryFetchSeminarQuizHttpFast, handleSeminarEndAndQuiz } from './monitor_seminars_quiz';

import {
  SEMINAR_DETAIL_PAGE,
  seoulDateString,
  getSeminarTrackingKey,
  isSeminarStartedByTime,
  resolveSeminarEndedAt,
  getSeminarSurveyEndTime,
  getSurveyRemainingMinutes,
  buildSeminarStatusMessage,
  sendSeminarLiveStartNotice,
  sendSeminarLiveEndNotice,
  sendSurveyClosingNotice,
  publishSeminarStatusNotice,
  findPrevSeminarInfo,
  getPrevNoticeSeminarsForPeriod,
  activeMonitors,
  type SeminarStatus,
  type MonitoredSeminarItem,
  type SeminarInfo,
  type ParsedPrevSeminar,
} from './monitor_seminars_notice';

import { withBrowserContext, performAutoEnterForActiveSeminars, mapConcurrent } from './monitor_seminars_entry';

// API 폴링 주기: 1분 (60초)
export const API_POLL_INTERVAL_MS = 60 * 1000;

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

      const trackingKey = getSeminarTrackingKey(fullUrl, seminarId);
      seminars[trackingKey] = {
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
        hiddenYn: typeof item.hiddenYn === 'string' ? item.hiddenYn : undefined,
        diseaseCategoryNm: typeof item.diseaseCategoryNm === 'string' ? item.diseaseCategoryNm : undefined,
        processState: processStateNum,
        cancelProcessState: cancelProcessStateNum,
        seminarCompleted: seminarCompletedNum,
      };
    }
  }

  // 3. 메인 미래 세미나 API에 빠져있지만 로컬 DB에 당일 해당 시간대로 저장되어 있는 세미나 보충 (fallback)
  for (const stored of storedList) {
    if (stored.date !== targetDate) continue;
    if (stored.isClosed === true) continue;

    const sid = stored.seminarId ? String(stored.seminarId).trim() : '';
    const fullUrl = stored.url || (sid ? `${SEMINAR_DETAIL_PAGE}${sid}` : '');
    const trackingKey = getSeminarTrackingKey(fullUrl, sid);
    if (!trackingKey || seminars[trackingKey] || (fullUrl && seminars[fullUrl])) continue;

    let storedStartHour = NaN;
    if (stored.time) {
      const startHM = stored.time.split('~')[0]?.trim();
      if (startHM && startHM.includes(':')) {
        storedStartHour = parseInt(startHM.split(':')[0], 10);
      }
    }

    const inTimeWindow = Number.isFinite(storedStartHour)
      ? storedStartHour >= startHour && storedStartHour < endHour
      : startHour >= 16
        ? stored.nightTime === true
        : stored.nightTime === false;

    if (inTimeWindow) {
      const processStateNum = stored.processState;
      const cancelProcessStateNum = stored.cancelProcessState;
      const seminarCompletedNum = stored.seminarCompleted;

      let statusText: SeminarStatus = '대기';
      if (
        processStateNum === ProcessState.PROCESS_END ||
        processStateNum === ProcessState.PROCESS_COMPLETED ||
        seminarCompletedNum === 1
      ) {
        statusText = '종료';
      }

      seminars[trackingKey] = {
        status: statusText,
        name: stored.name || '세미나',
        seminarId: sid,
        url: fullUrl,
        time: stored.time,
        hasSurvey: true,
        isSurveyPointExcluded: stored.isPointExcluded ?? false,
        isAdvancedSurvey: stored.isAdvancedSurvey ?? false,
        hiddenYn: stored.hiddenYn,
        diseaseCategoryNm: stored.diseaseCategoryNm,
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

export async function checkSeminarEndStatusFromApi(seminarId: string): Promise<{
  isEnded: boolean;
  isSurveyOpen: boolean;
  surveyState?: number;
  isPointExcluded: boolean;
  hasEntryHistory: boolean;
  isPrivate?: boolean;
  hiddenYn?: string;
  diseaseCategoryNm?: string;
  survey?: SeminarSurveyInfo | null;
  surveyMinutesLeft?: number | null;
  surveyEndDt?: string | null;
  surveyStartDt?: string | null;
  isDeletedOrNotFound?: boolean;
  isClosedOrCancelled?: boolean;
  errorType?: 'not_found' | 'auth_expired' | 'network_or_server' | 'none';
}> {
  const detailRes = await fetchSeminarDetail(seminarId);
  if (!detailRes.success) {
    const isNotFound =
      detailRes.isNotFound === true ||
      detailRes.statusCode === 404 ||
      (typeof detailRes.errorMessage === 'string' &&
        (detailRes.errorMessage.includes('세미나 정보를 찾을 수 없습니다') ||
          detailRes.errorMessage.includes('찾을 수 없습니다')));

    const errorType = detailRes.isAuthExpired ? 'auth_expired' : isNotFound ? 'not_found' : 'network_or_server';

    return {
      isEnded: false,
      isSurveyOpen: false,
      isPointExcluded: false,
      hasEntryHistory: false,
      isPrivate: false,
      isDeletedOrNotFound: isNotFound,
      isClosedOrCancelled: false,
      errorType,
    };
  }

  const raw = detailRes.rawResponse as Record<string, unknown> | undefined;
  const detail = raw?.seminarDetail as Record<string, unknown> | undefined;
  const survey = (detail?.survey ?? raw?.survey ?? detailRes.survey ?? null) as SeminarSurveyInfo | null;
  const surveyState = detailRes.surveyState;
  const processState = detail?.processState !== undefined ? Number(detail.processState) : undefined;
  const seminarCompleted = detail?.seminarCompleted !== undefined ? Number(detail.seminarCompleted) : undefined;
  const hiddenYn = typeof detail?.hiddenYn === 'string' ? detail.hiddenYn : undefined;
  const isPrivate = hiddenYn === 'Y' || hiddenYn === 'y';
  // hiddenYn === 'Y'는 비공개 세미나일 뿐 삭제나 취소가 아님 (오직 명시적으로 취소된 경우만 판정)
  const isClosed = detail?.isClosed === true && !isPrivate;

  const isClosedOrCancelled = isClosed;
  const isDeletedOrNotFound = !detail && typeof raw?.message === 'string' && raw.message.includes('찾을 수 없습니다');

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

  const rawMinutesLeft = survey?.surveyMinutesLeft;
  const surveyMinutesLeft =
    typeof rawMinutesLeft === 'number'
      ? rawMinutesLeft
      : rawMinutesLeft !== undefined && rawMinutesLeft !== null && !Number.isNaN(Number(rawMinutesLeft))
        ? Number(rawMinutesLeft)
        : null;

  return {
    isEnded,
    isSurveyOpen,
    surveyState,
    isPointExcluded: detailRes.isPointExcluded,
    hasEntryHistory: detailRes.hasEntryHistory ?? false,
    isPrivate,
    hiddenYn,
    diseaseCategoryNm: typeof detail?.diseaseCategoryNm === 'string' ? detail.diseaseCategoryNm : undefined,
    survey,
    surveyMinutesLeft,
    surveyEndDt: survey?.endDt || null,
    surveyStartDt: survey?.startDt || null,
    isDeletedOrNotFound,
    isClosedOrCancelled,
    errorType: 'none',
  };
}

/**
 * 단건 세미나의 상태를 파싱/조회하고 모니터링 아이템(MonitoredSeminarItem)을 구성하는 공통 헬퍼
 * - 초기 등록(initialFetch) 및 폴링 중 신규 세미나 감지 시 공통 사용 (DRY)
 */
export async function setupMonitoredSeminarItem(
  key: string,
  info: SeminarInfo,
  prevNoticeSeminars: ParsedPrevSeminar[],
  deletedSeminarIds: Set<string>,
  excludedSeminarKeys: Set<string>,
  periodName: string,
  options: {
    isAutoResume?: boolean;
    isNewDiscovery?: boolean;
    providedContext?: BrowserContext;
  } = {},
): Promise<{ trackingKey: string; item: MonitoredSeminarItem | null }> {
  const { isAutoResume = false, isNewDiscovery = false, providedContext } = options;
  const trackingKey = getSeminarTrackingKey(info.url, info.seminarId) || key;
  const seminarId = info.seminarId ? String(info.seminarId).trim() : null;
  const targetUrl = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : info.url;

  if (deletedSeminarIds.has(trackingKey) || (seminarId && deletedSeminarIds.has(seminarId))) {
    return { trackingKey, item: null };
  }
  if (excludedSeminarKeys.has(trackingKey) || (seminarId && excludedSeminarKeys.has(seminarId))) {
    return { trackingKey, item: null };
  }

  if (isNewDiscovery) {
    console.log(`[${periodName}] 신규 세미나 감지됨: ${info.name} (${seminarId})`);
    await sendTelegram(
      `🔔 [${periodName}] 새 세미나 감지됨:\n${info.name} (ID: ${seminarId || '알수없음'})\n${targetUrl}`,
    ).catch(() => {});

    if (seminarId && info.processState === ProcessState.PROCESS_APPLY) {
      try {
        const applyRes = await applySeminarWithTerms(seminarId);
        if (applyRes.success) {
          info.processState = ProcessState.PROCESS_CANCEL;
        }
      } catch (applyErr) {
        console.warn(`[${periodName}] 신규 세미나(${seminarId}) 자동 신청 실패:`, applyErr);
      }
    }
  }

  let isPointExcluded = info.isSurveyPointExcluded ?? false;
  let initialIsEnded = info.status === '종료';
  let dynamicSurveyState: number | undefined;
  let surveyEndDt: string | null = null;
  let surveyStartDt: string | null = null;
  let surveyMinutesLeft: number | null = null;
  let hasEntryHistory = false;

  if (seminarId) {
    const detailCheck = await checkSeminarEndStatusFromApi(seminarId);
    if (detailCheck.isDeletedOrNotFound || detailCheck.isClosedOrCancelled) {
      console.log(`[${periodName}] 세미나 삭제/취소 확인됨: ${info.name} (${seminarId})`);
      deletedSeminarIds.add(trackingKey);
      deletedSeminarIds.add(seminarId);
      seminarRepo.markSeminarClosed(seminarId);
      if (!isNewDiscovery) {
        await sendTelegram(
          `⚠️ [${periodName}] 세미나가 삭제/취소되어 모니터링에서 제외되었습니다:\n${info.name} (ID: ${seminarId})`,
        ).catch(() => {});
      }
      return { trackingKey, item: null };
    }

    isPointExcluded = detailCheck.isPointExcluded;
    info.isSurveyPointExcluded = isPointExcluded;
    hasEntryHistory = detailCheck.hasEntryHistory;
    dynamicSurveyState = detailCheck.surveyState;
    surveyEndDt = detailCheck.surveyEndDt ?? null;
    surveyStartDt = detailCheck.surveyStartDt ?? null;
    surveyMinutesLeft = detailCheck.surveyMinutesLeft ?? null;
    if (detailCheck.hiddenYn) info.hiddenYn = detailCheck.hiddenYn;
    if (detailCheck.diseaseCategoryNm) info.diseaseCategoryNm = detailCheck.diseaseCategoryNm;
    if (detailCheck.isEnded) {
      initialIsEnded = true;
    }
  }

  if (isPointExcluded) {
    console.log(`[${periodName}] ${info.name} is point-excluded. Skipping channel notice.`);
    excludedSeminarKeys.add(trackingKey);
    if (seminarId) excludedSeminarKeys.add(seminarId);
    return { trackingKey, item: null };
  }

  let currentStatus: SeminarStatus = initialIsEnded ? '종료' : info.status || '대기';
  let quizResultMessage: string | null = null;

  const matchedPrev = findPrevSeminarInfo(prevNoticeSeminars, {
    seminarId,
    url: targetUrl,
    name: info.name,
  });
  if (matchedPrev?.quizResultMessage) {
    quizResultMessage = matchedPrev.quizResultMessage;
  }

  let startNotified = false;
  const endNotified = initialIsEnded;

  // 신규 감지 시 이미 종료 상태이고 퀴즈 결과가 없으면 선제 퀴즈 조회
  if (
    isNewDiscovery &&
    initialIsEnded &&
    info.hasSurvey !== false &&
    dynamicSurveyState === SurveyState.SURVEY_PROGRESS &&
    !quizResultMessage
  ) {
    const httpQuizRes = await tryFetchSeminarQuizHttpFast(seminarId, info.isAdvancedSurvey);
    if (httpQuizRes?.quizResultMessage) {
      quizResultMessage = httpQuizRes.quizResultMessage;
      if (httpQuizRes.isAdvancedSurvey !== undefined) {
        info.isAdvancedSurvey = httpQuizRes.isAdvancedSurvey;
      }
    }

    try {
      await withBrowserContext(providedContext, async (ctx) => {
        const res = await handleSeminarEndAndQuiz(
          ctx,
          {
            name: info.name,
            seminarId,
            isSurveyPointExcluded: false,
            isAdvancedSurvey: info.isAdvancedSurvey,
          },
          targetUrl,
        );
        if (res.message) {
          quizResultMessage = res.message;
        }
      });
    } catch (quizErr) {
      console.warn(`[${periodName}] 신규 세미나 퀴즈 처리 실패 (${info.name}):`, quizErr);
    }
  }

  const isReadyToEnter =
    currentStatus === '입장가능' ||
    info.processState === ProcessState.PROCESS_ENTER ||
    info.processState === ProcessState.PROCESS_STARTED ||
    isSeminarStartedByTime(info.startDt);

  if (isReadyToEnter && currentStatus !== '종료') {
    currentStatus = '입장가능';
    info.isEntryStarted = true;
    if (isAutoResume) {
      startNotified = true;
    }
  }

  const seminarItemForEndCheck = {
    ...info,
    surveyEndDt,
    surveyStartDt,
    surveyMinutesLeft,
  };

  const endedAt = initialIsEnded
    ? resolveSeminarEndedAt(seminarItemForEndCheck, dynamicSurveyState, info.seminarCompleted)
    : undefined;

  const item: MonitoredSeminarItem = {
    ...info,
    url: targetUrl,
    status: currentStatus,
    isEnded: initialIsEnded,
    endedAt,
    surveyEndDt,
    surveyStartDt,
    surveyMinutesLeft,
    quizResultMessage,
    surveyState: dynamicSurveyState,
    hasEntryHistory,
    startNotified,
    endNotified,
  };

  return { trackingKey, item };
}

/**
 * 공지 채널 현황판 갱신 및 발행을 일원화하여 처리하는 공통 헬퍼 (DRY)
 */
export async function updateStatusBoardNotice(
  periodName: string,
  monitoredSeminarsMap: Map<string, MonitoredSeminarItem>,
  lastStatusNoticeMessageId: number | null,
  options: {
    isAllCompleted?: boolean;
    isAutoResume?: boolean;
    forcePublish?: boolean;
    timeExpiredMessage?: string | null;
    currentNowMs?: number;
  } = {},
): Promise<{ messageId: number | null; statusText: string }> {
  const currentNowMs = options.currentNowMs ?? Date.now();
  const currentList = Array.from(monitoredSeminarsMap.values());
  const attachedComments = lastStatusNoticeMessageId
    ? getChannelCommentsByParentMessageId(lastStatusNoticeMessageId).map((r) => ({
        userName: r.userName,
        text: r.text,
      }))
    : [];

  const statusText = buildSeminarStatusMessage(
    periodName,
    currentList,
    options.isAllCompleted ?? false,
    attachedComments,
    currentNowMs,
    options.timeExpiredMessage,
  ).text;

  let messageId = lastStatusNoticeMessageId;

  if (options.forcePublish || !messageId) {
    messageId = await publishSeminarStatusNotice(
      periodName,
      currentList,
      lastStatusNoticeMessageId,
      options.isAllCompleted ?? false,
      options.isAutoResume ?? false,
      attachedComments,
      options.timeExpiredMessage,
    );
  } else {
    const editRes = await editChannelMessage(messageId, statusText).catch(() => null);
    if (!editRes || !editRes.success) {
      if (editRes) {
        logger.warn(
          `[${periodName}] 채널 메시지(ID: ${messageId}) 인플레이스 수정 실패 -> 재발행 진행: ${editRes.message}`,
        );
      }
      messageId = await publishSeminarStatusNotice(
        periodName,
        currentList,
        lastStatusNoticeMessageId,
        options.isAllCompleted ?? false,
        options.isAutoResume ?? false,
        attachedComments,
        options.timeExpiredMessage,
      );
    }
  }

  return { messageId, statusText };
}

export type MonitorSeminarsOptions = {
  isAutoResume?: boolean;
  context?: BrowserContext;
  page?: Page;
  pollIntervalMs?: number;
  waitForSurveyClose?: boolean;
  taskContext?: TaskContext;
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
  const deletedSeminarIds = new Set<string>();

  // 전체 모니터링 대상 세미나 목록 (canonical key -> MonitoredSeminarItem)
  const monitoredSeminarsMap = new Map<string, MonitoredSeminarItem>();
  activeMonitors.add(monitoredSeminarsMap);
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

    // 당일 기존 공지 메시지가 있는 경우 이전 퀴즈 정답 및 상태 정보 파싱
    const prevNoticeSeminars = getPrevNoticeSeminarsForPeriod(periodName, todayIsoDate, lastStatusNoticeMessageId);

    // 1. 초기 세미나 목록 조회 (API)
    const initialFetch = await getTodaysSeminarsFromApi(startHour, endHour, todayIsoDate);
    if (!initialFetch.success) {
      if (initialFetch.isAuthExpired) {
        await sendTelegram(`🔒 [${periodName}] 세미나 모니터링: 세션이 만료되었습니다. 로그인이 필요합니다.`);
        return false;
      }
      console.warn(`[${periodName}] 초기 세미나 목록 API 조회 실패, 다음 주기에 재시도합니다.`);
    }

    // 초기 세미나 목록 등록 및 포인트 제외 세미나 필터링 (동시성 2개 제한 병렬 처리)
    const initialEntries = Object.entries(initialFetch.seminars);
    const initialSetupResults = await mapConcurrent(initialEntries, 2, async ([key, info]) => {
      return setupMonitoredSeminarItem(
        key,
        info,
        prevNoticeSeminars,
        deletedSeminarIds,
        excludedSeminarKeys,
        periodName,
        { isAutoResume, isNewDiscovery: false, providedContext },
      );
    });

    for (const { trackingKey, item } of initialSetupResults) {
      if (item) {
        monitoredSeminarsMap.set(trackingKey, item);
      }
    }

    const seminarList = Array.from(monitoredSeminarsMap.values());
    if (seminarList.length === 0) {
      console.log(`[${periodName}] 예정된 세미나가 없어 알림 없이 모니터링을 종료합니다.`);
      return true;
    }

    const isAllInitiallySeminarsEnded = seminarList.length > 0 && seminarList.every((s) => s.status === '종료');
    const isAllInitiallySurveysClosed = seminarList.every((s) => {
      if (s.status !== '종료') return false;
      if (s.hasSurvey === false) return true;
      const minutesLeft = getSurveyRemainingMinutes(s);
      return minutesLeft === null || minutesLeft === 0;
    });
    const isAllInitiallyCompleted = isAllInitiallySeminarsEnded && (!waitForSurveyClose || isAllInitiallySurveysClosed);

    const initialSeminarNames = seminarList.map((s) => `  - ${s.name} (${s.status})`).join('\n');
    if (isAutoResume) {
      if (isAllInitiallyCompleted) {
        await sendTelegram(
          `🔄 [${periodName}] 세미나 감시가 재개(autoResume)되었으며, 모든 세미나 및 설문이 이미 종료되어 모니터링을 완료합니다.\n${initialSeminarNames}`,
        ).catch(() => {});
      } else {
        await sendTelegram(
          `🔄 [${periodName}] 세미나 감시가 재개(autoResume)되었습니다.\n${initialSeminarNames}`,
        ).catch(() => {});
      }
    } else {
      await sendTelegram(
        `[${periodName}] 총 ${seminarList.length}개의 세미나 감시를 시작합니다.\n${initialSeminarNames}`,
      ).catch(() => {});
    }

    // 1. 공지채널 메시지 발송 우선 처리 (초기 발송 조건 체크: 입장가능 또는 종료 상태인 세미나가 있는 경우)
    const hasInitialActiveOrEnded = seminarList.some((s) => s.status === '입장가능' || s.status === '종료');
    let lastStatusNoticeText: string | null = null;

    if (hasInitialActiveOrEnded) {
      if (isAutoResume && lastStatusNoticeMessageId) {
        const boardRes = await updateStatusBoardNotice(periodName, monitoredSeminarsMap, lastStatusNoticeMessageId, {
          isAllCompleted: isAllInitiallyCompleted,
          isAutoResume: true,
        });
        lastStatusNoticeMessageId = boardRes.messageId;
        lastStatusNoticeText = boardRes.statusText;
      } else {
        const boardRes = await updateStatusBoardNotice(periodName, monitoredSeminarsMap, null, {
          isAllCompleted: isAllInitiallyCompleted,
          isAutoResume: false,
          forcePublish: true,
        });
        lastStatusNoticeMessageId = boardRes.messageId;
        lastStatusNoticeText = boardRes.statusText;
      }
    }

    // 2. 공지채널 발송 완료 후, 개별 토픽 구독자 알림 발송 (공지채널 발송 우선)
    for (const item of seminarList) {
      if (item.status === '입장가능' && !item.isEnded && !item.startNotified) {
        item.startNotified = true;
        await sendSeminarLiveStartNotice(item).catch((err) => {
          logger.warn(`[${periodName}] 초기 토픽 구독자 입장 알림 발송 실패 (무시됨): ${item.name}`, err);
        });
      }
    }

    // 3. 공지채널 및 개별 알림 완료 후, 입장 가능 세미나에 대해 온디맨드 자동 입장(Playwright 폴백 포함) 실행
    await performAutoEnterForActiveSeminars(monitoredSeminarsMap.values(), {
      context: providedContext,
      isAutoResume: !!isAutoResume,
      periodName,
    });

    // 종료된 세미나 중 설문 진행 중인 세미나에 대한 온디맨드 퀴즈 처리 (공지 메시지 발송 후 실행)
    for (const item of monitoredSeminarsMap.values()) {
      const shouldAttemptQuiz =
        item.isEnded &&
        !item.isSurveyPointExcluded &&
        item.hasSurvey !== false &&
        item.surveyState === SurveyState.SURVEY_PROGRESS &&
        !item.quizResultMessage;

      if (shouldAttemptQuiz) {
        // 1. HTTP API 퀴즈 선제 조회 (1~2초)
        const httpQuizRes = await tryFetchSeminarQuizHttpFast(item.seminarId, item.isAdvancedSurvey);
        if (httpQuizRes?.quizResultMessage) {
          item.quizResultMessage = httpQuizRes.quizResultMessage;
          if (httpQuizRes.isAdvancedSurvey !== undefined) {
            item.isAdvancedSurvey = httpQuizRes.isAdvancedSurvey;
          }

          if (lastStatusNoticeMessageId) {
            const boardRes = await updateStatusBoardNotice(
              periodName,
              monitoredSeminarsMap,
              lastStatusNoticeMessageId,
              { isAllCompleted: isAllInitiallyCompleted },
            );
            lastStatusNoticeText = boardRes.statusText;
          }
        }

        // 2. Playwright 브라우저 실행 (심화: 문항체크+마지막페이지 / 일반: 문항체크+자동제출)
        let browserQuizMessage: string | null = null;
        try {
          await withBrowserContext(providedContext, async (ctx) => {
            const res = await handleSeminarEndAndQuiz(
              ctx,
              {
                name: item.name,
                seminarId: item.seminarId,
                isSurveyPointExcluded: false,
                isAdvancedSurvey: item.isAdvancedSurvey,
              },
              item.url,
            );
            browserQuizMessage = res.message;
          });
        } catch (quizErr) {
          console.warn(`[${periodName}] 초기 세미나 퀴즈 처리 건너뜀 (${item.name}):`, quizErr);
        }

        // 3. 브라우저에서 새로운 정답이 획득되었거나 갱신된 경우 현황판 2차 갱신
        if (browserQuizMessage && browserQuizMessage !== item.quizResultMessage) {
          item.quizResultMessage = browserQuizMessage;
          if (lastStatusNoticeMessageId) {
            const boardRes = await updateStatusBoardNotice(
              periodName,
              monitoredSeminarsMap,
              lastStatusNoticeMessageId,
              { isAllCompleted: isAllInitiallyCompleted },
            );
            lastStatusNoticeText = boardRes.statusText;
          }
        }
      }
    }

    if (isAllInitiallyCompleted) {
      console.log(`[${periodName}] 모든 세미나 및 설문이 이미 종료 상태이므로 모니터링을 종료합니다.`);
      await syncSeminarsDetailToDb(Array.from(monitoredSeminarsMap.values()), 3, 250).catch((err) =>
        logger.error(`[${periodName}] 세미나 초기 종료 후 detail 동기화 실패:`, err),
      );
      return true;
    }

    let loopIteration = 0;

    // 2. API 모니터링 루프 (1분 폴링)
    while (true) {
      // Lock 소유권 상실 감지 시 조기 종료
      if (options.taskContext?.isLockLost) {
        console.warn(
          `[${periodName}] 태스크 Lock 소유권 상실(새 인스턴스에 의한 선점) 감지됨 -> 모니터링 루프를 안전하게 조기 종료합니다.`,
        );
        break;
      }

      loopIteration++;
      const currentTime = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
      if (currentTime.getHours() >= endHour) {
        const remainingSeminars = Array.from(monitoredSeminarsMap.values())
          .filter((s) => s.status !== '종료')
          .map((s) => `${s.name} (${s.url})`);

        if (remainingSeminars.length > 0) {
          const timeExpiredMessage = `${periodName} 모니터링 시간이 종료되었지만, 마치지 않은 세미나가 있습니다:\n${remainingSeminars.join('\n')}`;
          await updateStatusBoardNotice(periodName, monitoredSeminarsMap, lastStatusNoticeMessageId, {
            isAllCompleted: false,
            isAutoResume,
            timeExpiredMessage,
          }).catch(() => {});
        }
        break;
      }

      await sleep(pollIntervalMs);

      if (options.taskContext?.isLockLost) {
        console.warn(
          `[${periodName}] 태스크 Lock 소유권 상실(새 인스턴스에 의한 선점) 감지됨 -> 모니터링 루프를 안전하게 조기 종료합니다.`,
        );
        break;
      }

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
      const detailCheckMap = new Map<string, Awaited<ReturnType<typeof checkSeminarEndStatusFromApi>>>();
      const getOrFetchDetailCheck = async (sid: string) => {
        const cached = detailCheckMap.get(sid);
        if (cached) return cached;
        const res = await checkSeminarEndStatusFromApi(sid);
        detailCheckMap.set(sid, res);
        return res;
      };

      // ── Step 1: 삭제 후보 세미나 감지 및 삭제 확정 처리
      const apiItemSeminarIds = new Set(
        (pollRes.rawItems || []).map((item) => String(item.seminarId ?? '').trim()).filter(Boolean),
      );

      for (const [key, currentSeminar] of Array.from(monitoredSeminarsMap.entries())) {
        if (currentSeminar.status === '종료' || currentSeminar.isEnded) {
          continue;
        }

        const sid = currentSeminar.seminarId || key;
        const isPresentInApiList = sid ? apiItemSeminarIds.has(sid) : false;

        if (!isPresentInApiList && sid) {
          const detailCheck = await getOrFetchDetailCheck(sid);
          const isConfirmedDeleted =
            detailCheck.isDeletedOrNotFound || detailCheck.isClosedOrCancelled || detailCheck.errorType === 'not_found';

          if (isConfirmedDeleted) {
            console.log(`[${periodName}] 세미나 삭제/취소 확인됨: ${currentSeminar.name} (${sid})`);
            deletedSeminarIds.add(key);
            if (currentSeminar.seminarId) deletedSeminarIds.add(currentSeminar.seminarId);
            monitoredSeminarsMap.delete(key);
            seminarRepo.markSeminarClosed(sid);
            await sendTelegram(
              `⚠️ [${periodName}] 세미나가 삭제/취소되어 모니터링에서 제외되었습니다:\n${currentSeminar.name} (ID: ${sid})`,
            ).catch(() => {});
            hasStateChanged = true;
          } else if (detailCheck.errorType === 'network_or_server' || detailCheck.errorType === 'auth_expired') {
            console.warn(`[${periodName}] 세미나(${sid}) 상세 조회 일시 오류(timeout/5xx/auth), 기존 상태 유지`);
          } else if (detailCheck.isPrivate) {
            console.log(`[${periodName}] 비공개 세미나(${sid}) 확인 (mainFuture API 미포함), 정상 모니터링 유지`);
          }
        }
      }

      // ── Step 2: 신규 세미나 감지 및 처리 (공통 헬퍼 활용)
      for (const [key, info] of Object.entries(pollRes.seminars)) {
        const trackingKey = getSeminarTrackingKey(info.url, info.seminarId) || key;
        if (!monitoredSeminarsMap.has(trackingKey)) {
          const { item: newItem } = await setupMonitoredSeminarItem(
            key,
            info,
            prevNoticeSeminars,
            deletedSeminarIds,
            excludedSeminarKeys,
            periodName,
            { isAutoResume: false, isNewDiscovery: true, providedContext },
          );
          if (newItem) {
            monitoredSeminarsMap.set(trackingKey, newItem);
            hasStateChanged = true;
          }
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

      // ── Step 3: 각 세미나 상태 감시
      // 활성 세미나 중 상세 조회가 필요한 항목들을 Concurrency: 2 로 사전 병렬 조회
      const activeSeminarsNeedingDetailCheck: string[] = [];
      for (const [key, currentSeminar] of monitoredSeminarsMap.entries()) {
        if (currentSeminar.status === '종료' || currentSeminar.isEnded) continue;
        const apiInfo =
          pollRes.seminars[key] ||
          (currentSeminar.seminarId ? pollRes.seminars[currentSeminar.seminarId] : undefined) ||
          (currentSeminar.url ? pollRes.seminars[currentSeminar.url] : undefined);
        const isEndedFromApi =
          apiInfo?.status === '종료' ||
          apiInfo?.processState === ProcessState.PROCESS_END ||
          apiInfo?.processState === ProcessState.PROCESS_COMPLETED ||
          apiInfo?.seminarCompleted === 1;
        const seminarId = currentSeminar.seminarId || apiInfo?.seminarId;
        if (seminarId && !isEndedFromApi && !detailCheckMap.has(seminarId)) {
          activeSeminarsNeedingDetailCheck.push(seminarId);
        }
      }

      if (activeSeminarsNeedingDetailCheck.length > 0) {
        await mapConcurrent(activeSeminarsNeedingDetailCheck, 2, async (sid) => {
          const endCheck = await checkSeminarEndStatusFromApi(sid);
          detailCheckMap.set(sid, endCheck);
        });
      }

      for (const [key, currentSeminar] of monitoredSeminarsMap.entries()) {
        const apiInfo =
          pollRes.seminars[key] ||
          (currentSeminar.seminarId ? pollRes.seminars[currentSeminar.seminarId] : undefined) ||
          (currentSeminar.url ? pollRes.seminars[currentSeminar.url] : undefined);
        const seminarId = currentSeminar.seminarId || apiInfo?.seminarId;
        const name = apiInfo?.name || currentSeminar.name;
        const targetUrl = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : currentSeminar.url;

        // ── A. 이미 종료된 세미나는 스킵
        if (currentSeminar.status === '종료' || currentSeminar.isEnded) {
          continue;
        }

        // ── B. 종료 감시
        let isEnded =
          apiInfo?.status === '종료' ||
          apiInfo?.processState === ProcessState.PROCESS_END ||
          apiInfo?.processState === ProcessState.PROCESS_COMPLETED ||
          apiInfo?.seminarCompleted === 1;

        let isSurveyOpen = false;
        let isDetailPointExcluded = currentSeminar.isSurveyPointExcluded;
        let realtimeSurveyEndDt: string | null = null;
        let realtimeSurveyStartDt: string | null = null;
        let realtimeSurveyMinutesLeft: number | null = null;

        if (seminarId && !isEnded) {
          const endCheck = detailCheckMap.get(seminarId) || (await getOrFetchDetailCheck(seminarId));
          if (endCheck.isEnded) {
            isEnded = true;
            isSurveyOpen = endCheck.isSurveyOpen;
            realtimeSurveyEndDt = endCheck.surveyEndDt ?? null;
            realtimeSurveyStartDt = endCheck.surveyStartDt ?? null;
            realtimeSurveyMinutesLeft = endCheck.surveyMinutesLeft ?? null;
          }
          if (endCheck.isPointExcluded !== undefined) {
            isDetailPointExcluded = endCheck.isPointExcluded;
            currentSeminar.isSurveyPointExcluded = isDetailPointExcluded;
          }
        }

        if (isEnded) {
          console.log(`[${periodName}] 세미나 종료 감지됨: ${name} (${seminarId}), isSurveyOpen=${isSurveyOpen}`);

          const isPointExcludedSeminar = Boolean(currentSeminar.isSurveyPointExcluded || isDetailPointExcluded);

          if (isPointExcludedSeminar) {
            console.log(`[${periodName}] 포인트 미지급 세미나 종료 감지 (${name}, ${seminarId}) - 알림/퀴즈/공지 생략`);
            currentSeminar.status = '종료';
            currentSeminar.isEnded = true;
            if (realtimeSurveyEndDt) currentSeminar.surveyEndDt = realtimeSurveyEndDt;
            if (realtimeSurveyStartDt) currentSeminar.surveyStartDt = realtimeSurveyStartDt;
            if (realtimeSurveyMinutesLeft !== null) currentSeminar.surveyMinutesLeft = realtimeSurveyMinutesLeft;
            currentSeminar.endedAt = currentSeminar.endedAt || Date.now();
            continue;
          }

          // 1. HTTP API를 통한 초고속 퀴즈 사전 조회 시도 (1~2초)
          let quizResultMessage: string | null = currentSeminar.quizResultMessage || null;
          const httpQuizRes = await tryFetchSeminarQuizHttpFast(seminarId, currentSeminar.isAdvancedSurvey);
          if (httpQuizRes?.quizResultMessage) {
            quizResultMessage = httpQuizRes.quizResultMessage;
            if (httpQuizRes.isAdvancedSurvey !== undefined) {
              currentSeminar.isAdvancedSurvey = httpQuizRes.isAdvancedSurvey;
            }
          }

          // 2. 상태 갱신 및 구독자 종료 알림 + 공지채널 현황판 1차 갱신 즉시 발송
          currentSeminar.status = '종료';
          currentSeminar.isEnded = true;
          if (realtimeSurveyEndDt) currentSeminar.surveyEndDt = realtimeSurveyEndDt;
          if (realtimeSurveyStartDt) currentSeminar.surveyStartDt = realtimeSurveyStartDt;
          if (realtimeSurveyMinutesLeft !== null) currentSeminar.surveyMinutesLeft = realtimeSurveyMinutesLeft;
          currentSeminar.endedAt = currentSeminar.endedAt || Date.now();
          currentSeminar.quizResultMessage = quizResultMessage;
          hasStateChanged = true;

          // 공지채널 현황판 1차 즉시 갱신 (선제 갱신)
          if (lastStatusNoticeMessageId) {
            const boardRes = await updateStatusBoardNotice(
              periodName,
              monitoredSeminarsMap,
              lastStatusNoticeMessageId,
              { isAllCompleted: false },
            );
            lastStatusNoticeText = boardRes.statusText;
          }

          // 공지채널 현황판 갱신 완료 후 개별 구독자 종료 알림 발송 (공지채널 발송 우선)
          if (!currentSeminar.endNotified) {
            currentSeminar.endNotified = true;
            await sendSeminarLiveEndNotice(currentSeminar).catch(() => {});
          }

          // 3. Playwright 브라우저 실행 (심화: 문항체크+마지막페이지 / 일반: 문항체크+자동제출)
          let browserQuizMessage: string | null = null;
          await withBrowserContext(providedContext, async (ctx) => {
            const res = await handleSeminarEndAndQuiz(
              ctx,
              {
                name,
                seminarId,
                isSurveyPointExcluded: false,
                isAdvancedSurvey: currentSeminar.isAdvancedSurvey,
              },
              currentSeminar.url || targetUrl,
            );
            browserQuizMessage = res.message;
          });

          // 4. 브라우저에서 새로운 정답이 획득되었거나 갱신된 경우 현황판 2차 갱신
          if (browserQuizMessage && browserQuizMessage !== quizResultMessage) {
            currentSeminar.quizResultMessage = browserQuizMessage;
            if (lastStatusNoticeMessageId) {
              const boardRes = await updateStatusBoardNotice(
                periodName,
                monitoredSeminarsMap,
                lastStatusNoticeMessageId,
                { isAllCompleted: false },
              );
              lastStatusNoticeText = boardRes.statusText;
            }
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
        const minutesLeft = getSurveyRemainingMinutes(s, currentNowMs);
        return minutesLeft === null || minutesLeft === 0;
      });
      const isAllCompleted = isAllSeminarsEnded && (!waitForSurveyClose || isAllSurveysClosed);

      const attachedComments = lastStatusNoticeMessageId
        ? getChannelCommentsByParentMessageId(lastStatusNoticeMessageId).map((r) => ({
            userName: r.userName,
            text: r.text,
          }))
        : [];

      const currentStatusText = buildSeminarStatusMessage(
        periodName,
        currentList,
        isAllCompleted,
        attachedComments,
        currentNowMs,
      ).text;

      if (hasStateChanged) {
        // 주요 상태 변화: 이전 메시지 삭제 후 재전송하여 채널 알림 발송
        const boardRes = await updateStatusBoardNotice(periodName, monitoredSeminarsMap, lastStatusNoticeMessageId, {
          isAllCompleted,
          isAutoResume,
          forcePublish: true,
          currentNowMs,
        });
        lastStatusNoticeMessageId = boardRes.messageId;
        lastStatusNoticeText = boardRes.statusText;

        if (isAllCompleted) {
          console.log(`[${periodName}] 모든 세미나 및 설문이 종료되었습니다. 모니터링을 완료합니다.`);
          await syncSeminarsDetailToDb(currentList, 3, 250).catch((err) =>
            logger.error(`[${periodName}] 세미나 종료 후 detail 동기화 실패:`, err),
          );
          break;
        }
      } else if (lastStatusNoticeText !== currentStatusText) {
        // 인플레이스 수정
        const boardRes = await updateStatusBoardNotice(periodName, monitoredSeminarsMap, lastStatusNoticeMessageId, {
          isAllCompleted,
          isAutoResume,
          forcePublish: !lastStatusNoticeMessageId,
          currentNowMs,
        });
        lastStatusNoticeMessageId = boardRes.messageId;
        lastStatusNoticeText = currentStatusText;

        if (isAllCompleted) {
          console.log(`[${periodName}] 모든 세미나 및 설문이 종료되었습니다. 모니터링을 완료합니다.`);
          await syncSeminarsDetailToDb(currentList, 3, 250).catch((err) =>
            logger.error(`[${periodName}] 세미나 종료 후 detail 동기화 실패:`, err),
          );
          break;
        }
      }

      // ── F. 공지채널 발송/수정 완료 후, 개별 토픽 구독자 알림 발송 (공지채널 발송 우선)
      for (const item of monitoredSeminarsMap.values()) {
        if (item.status === '입장가능' && !item.isEnded && !item.startNotified) {
          item.startNotified = true;
          await sendSeminarLiveStartNotice(item).catch((err) => {
            logger.warn(`[${periodName}] 토픽 구독자 입장 알림 발송 실패 (무시됨): ${item.name}`, err);
          });
        }
      }

      // ── G. 공지채널 및 개별 알림 완료 후, 입장 가능 세미나에 대해 온디맨드 자동 입장(Playwright 폴백 포함) 실행
      await performAutoEnterForActiveSeminars(monitoredSeminarsMap.values(), {
        context: providedContext,
        isAutoResume: false,
        periodName,
      });
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
  } finally {
    activeMonitors.delete(monitoredSeminarsMap);
  }
}

export { monitorSeminars };
