import { MedigateClient, type MedigateSymposiumItem, type MedigateWatchResult } from '../modules/medigate_api';
import * as storage from './storage';
import * as logger from './logger';
import { isTaskRunning } from './seminar_monitor_trigger';
import * as taskRegistry from '../core/taskRegistry';
import { runTask } from '../core/runner';

export interface MedigateWatchedRecord {
  webinarIdx: number;
  subject: string;
  watchedAt: string;
  durationMinutes: number;
  heartbeatCount: number;
  success: boolean;
  surveyUrl?: string;
}

export function getTodayKstDateString(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export function getWatchedKey(webinarIdx: number, dateStr?: string): string {
  const date = dateStr || getTodayKstDateString();
  return `medigate_watched:${webinarIdx}:${date}`;
}

export function isSymposiumWatchedToday(webinarIdx: number, dateStr?: string): boolean {
  const key = getWatchedKey(webinarIdx, dateStr);
  const record = storage.get<MedigateWatchedRecord>(key);
  return record?.success === true;
}

export function markSymposiumWatchedToday(
  webinarIdx: number,
  record: Omit<MedigateWatchedRecord, 'webinarIdx'>,
  dateStr?: string,
): void {
  const key = getWatchedKey(webinarIdx, dateStr);
  storage.set(key, {
    webinarIdx,
    ...record,
  });
}

export interface CheckAndWatchResult {
  checked: boolean;
  totalOnAir: number;
  targets: MedigateSymposiumItem[];
  watchedCount: number;
  skippedCount: number;
  failedCount: number;
  results: MedigateWatchResult[];
  message?: string;
  silent?: boolean;
}

/**
 * 메디게이트 On-Air 심포지움을 감지하여 미시청 심포지움이 있는 경우 자동으로 시청을 실행합니다.
 */
export async function checkAndWatchMedigateSymposiums(
  options: {
    now?: Date;
    durationMinutes?: number;
    intervalSeconds?: number;
    client?: MedigateClient;
  } = {},
): Promise<CheckAndWatchResult> {
  const dateStr = getTodayKstDateString(options.now);

  if (isTaskRunning('medigate_watch_symposium') || isTaskRunning('medigate_watch')) {
    logger.info('[Medigate Monitor] 이미 메디게이트 시청 태스크가 실행 중입니다. 스킵합니다.');
    return {
      checked: true,
      totalOnAir: 0,
      targets: [],
      watchedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
      message: '이미 시청 태스크가 실행 중입니다.',
      silent: true,
    };
  }

  const client = options.client || new MedigateClient();
  const loginRes = await client.login();
  if (!loginRes.success) {
    logger.warn('[Medigate Monitor] 로그인 실패:', loginRes.message);
    return {
      checked: false,
      totalOnAir: 0,
      targets: [],
      watchedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
      message: `로그인 실패: ${loginRes.message}`,
      silent: true,
    };
  }

  const symposiums = await client.getSymposiumList();
  const onAirItems = symposiums.filter((item) => item.status === 'ING');

  if (onAirItems.length === 0) {
    logger.info('[Medigate Monitor] 현재 On-Air(방송 중)인 심포지움이 없습니다.');
    return {
      checked: true,
      totalOnAir: 0,
      targets: [],
      watchedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
      message: '현재 On-Air 심포지움 없음',
      silent: true,
    };
  }

  logger.info(
    `[Medigate Monitor] On-Air 심포지움 ${onAirItems.length}건 발견:`,
    onAirItems.map((i) => `[${i.webinarIdx}] ${i.subject}`),
  );

  const unwatchedTargets: MedigateSymposiumItem[] = [];
  let skippedCount = 0;

  for (const item of onAirItems) {
    if (isSymposiumWatchedToday(item.webinarIdx, dateStr)) {
      logger.info(`[Medigate Monitor] [${item.webinarIdx}] ${item.subject} - 오늘 이미 시청 완료됨 (스킵)`);
      skippedCount++;
    } else {
      unwatchedTargets.push(item);
    }
  }

  if (unwatchedTargets.length === 0) {
    logger.info(`[Medigate Monitor] 모든 On-Air 심포지움(${onAirItems.length}건)이 이미 시청 완료 상태입니다.`);
    return {
      checked: true,
      totalOnAir: onAirItems.length,
      targets: [],
      watchedCount: 0,
      skippedCount,
      failedCount: 0,
      results: [],
      message: '모든 On-Air 심포지움 시청 완료 상태',
      silent: true,
    };
  }

  // 미시청 On-Air 심포지움 시청 태스크 트리거
  const watchTask = taskRegistry.getByName('medigate_watch_symposium');
  if (watchTask) {
    logger.info(`[Medigate Monitor] 미시청 On-Air 심포지움 ${unwatchedTargets.length}건 시청 태스크 백그라운드 트리거`);
    const taskArgs: Record<string, string> = {};
    if (options.durationMinutes) taskArgs.duration = String(options.durationMinutes);
    if (options.intervalSeconds) taskArgs.interval = String(options.intervalSeconds);
    runTask(watchTask, { args: taskArgs }).catch((err) => {
      logger.error('[Medigate Monitor] medigate_watch_symposium 태스크 실행 실패:', err);
    });
  }

  return {
    checked: true,
    totalOnAir: onAirItems.length,
    targets: unwatchedTargets,
    watchedCount: 0,
    skippedCount,
    failedCount: 0,
    results: [],
    message: `${unwatchedTargets.length}건의 On-Air 심포지움 시청 태스크 트리거됨`,
    silent: true,
  };
}
