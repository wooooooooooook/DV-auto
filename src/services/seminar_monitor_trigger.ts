import { ProcessState } from '../modules/seminar_api';
import { isSeminarStartedByTime } from '../tasks/monitor_seminars';
import type { SeminarListItem } from './seminar_repository';
import type { RawSeminarData } from '../tasks/apply_seminar';
import { isSeminarNoticeCompleted } from './channel_message_repository';
import * as taskRegistry from '../core/taskRegistry';
import { runTask, DEFAULT_LOCK_TTL_MS } from '../core/runner';
import type { TaskLockData } from '../types';
import * as logger from './logger';
import * as storage from './storage';

export function getSeoulDateString(d: Date = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

/**
 * 세미나가 현재 '입장가능' 상태인지 판별합니다.
 * - 이미 종료된 세미나(processState 7, 8, completed 1)는 제외
 * - 포인트 미지급 세미나(isPointExcluded)는 제외
 * - processState 1(입장하기), 6(진행중) 또는 시작 시간 도래 시 true
 */
export function isSeminarEnterable(seminar: SeminarListItem | RawSeminarData, nowMs: number = Date.now()): boolean {
  if (seminar.isPointExcluded === true) return false;

  const ps = seminar.processState;
  const isEnded =
    ps === ProcessState.PROCESS_END || ps === ProcessState.PROCESS_COMPLETED || seminar.seminarCompleted === 1;

  if (isEnded) return false;

  const isEnterState = ps === ProcessState.PROCESS_ENTER || ps === ProcessState.PROCESS_STARTED;

  if (isEnterState) return true;

  const startDt = (seminar as { startDt?: string }).startDt;
  if (startDt && isSeminarStartedByTime(startDt, nowMs)) {
    return true;
  }

  // startDt가 없는 경우 date와 time으로 시작 시간 도래 여부 검사
  if (seminar.date && seminar.time) {
    const startTimeStr = seminar.time.split('~')[0]?.trim();
    if (startTimeStr && startTimeStr.includes(':')) {
      const dtStr = `${seminar.date} ${startTimeStr}:00`;
      if (isSeminarStartedByTime(dtStr, nowMs)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * 세미나가 활성(입장가능)이거나 이미 종료된 상태인지 판별합니다.
 * (앱 다운타임 중 세미나가 시작 후 종료된 경우도 모니터링 대상으로 감지하기 위함)
 */
export function isSeminarActiveOrEnded(seminar: SeminarListItem | RawSeminarData, nowMs: number = Date.now()): boolean {
  if (seminar.isPointExcluded === true) return false;

  const ps = seminar.processState;
  const isEnded =
    ps === ProcessState.PROCESS_END || ps === ProcessState.PROCESS_COMPLETED || seminar.seminarCompleted === 1;

  if (isEnded) return true;

  return isSeminarEnterable(seminar, nowMs);
}

/**
 * 세미나 시간대(점심/저녁)를 판별합니다.
 */
export function getSeminarPeriod(seminar: SeminarListItem | RawSeminarData): '점심' | '저녁' {
  if (seminar.nightTime !== undefined) {
    return seminar.nightTime ? '저녁' : '점심';
  }

  if (seminar.time) {
    const startHM = seminar.time.split('~')[0]?.trim();
    if (startHM && startHM.includes(':')) {
      const startHour = parseInt(startHM.split(':')[0], 10);
      if (Number.isFinite(startHour)) {
        return startHour >= 16 ? '저녁' : '점심';
      }
    }
  }

  const startDt = (seminar as { startDt?: string }).startDt;
  if (startDt) {
    try {
      const clean = startDt.trim().replace('T', ' ');
      const iso = clean.includes('+') || clean.endsWith('Z') ? clean : `${clean.replace(' ', 'T')}+09:00`;
      const hour = new Date(iso).getHours();
      if (Number.isFinite(hour)) {
        return hour >= 16 ? '저녁' : '점심';
      }
    } catch {
      /* ignore */
    }
  }

  return '점심';
}

/**
 * 특정 태스크가 현재 락 상태(실행 중)인지 확인합니다.
 */
export function isTaskRunning(taskName: string, ttlMs = DEFAULT_LOCK_TTL_MS): boolean {
  const key = `lock:${taskName}`;
  const now = Date.now();
  const current = storage.get<TaskLockData>(key);
  if (!current || !current.ts || now - current.ts >= ttlMs) return false;
  if (current.owner && !storage.isPidAlive(current.owner)) return false;
  return true;
}

/**
 * 세미나 목록을 검사하여 점심/저녁 세미나 모니터링이 필요한 경우 백그라운드로 트리거합니다.
 */
export async function checkAndTriggerSeminarMonitors(
  seminars: (SeminarListItem | RawSeminarData)[],
  options: { now?: Date; targetDate?: string } = {},
): Promise<{ triggeredLunch: boolean; triggeredDinner: boolean }> {
  const targetDate = options.targetDate || (options.now ? getSeoulDateString(options.now) : getSeoulDateString());
  const nowMs = options.now ? options.now.getTime() : Date.now();

  const todaySeminars = seminars.filter((s) => s.date === targetDate);
  let triggeredLunch = false;
  let triggeredDinner = false;

  // 1. 점심 세미나 트리거 검사
  const lunchSeminars = todaySeminars.filter((s) => getSeminarPeriod(s) === '점심');
  const hasActiveOrEndedLunch = lunchSeminars.some((s) => isSeminarActiveOrEnded(s, nowMs));
  const isLunchNoticeCompleted = isSeminarNoticeCompleted('점심', targetDate);
  const isLunchRunning = isTaskRunning('monitor_lunch_seminars');

  if (lunchSeminars.length > 0) {
    if (hasActiveOrEndedLunch && !isLunchNoticeCompleted && !isLunchRunning) {
      const lunchTask = taskRegistry.getByName('monitor_lunch_seminars');
      if (lunchTask) {
        logger.info(
          `[점심세미나 트리거] 입장 가능/진행 중인 세미나 감지 -> monitor_lunch_seminars 시작 (세미나: ${lunchSeminars.length}건, activeOrEnded: true, noticeCompleted: false, running: false)`,
        );
        triggeredLunch = true;
        runTask(lunchTask).catch((err) => {
          logger.error('monitor_lunch_seminars 비동기 트리거 실패:', err);
        });
      }
    } else if (hasActiveOrEndedLunch) {
      logger.info(
        `[점심세미나 트리거 스킵] 입장 가능 세미나가 있으나 트리거 조건 미충족 (activeOrEnded: true, noticeCompleted: ${isLunchNoticeCompleted}, running: ${isLunchRunning})`,
      );
    }
  }

  // 2. 저녁 세미나 트리거 검사
  const dinnerSeminars = todaySeminars.filter((s) => getSeminarPeriod(s) === '저녁');
  const hasActiveOrEndedDinner = dinnerSeminars.some((s) => isSeminarActiveOrEnded(s, nowMs));
  const isDinnerNoticeCompleted = isSeminarNoticeCompleted('저녁', targetDate);
  const isDinnerRunning = isTaskRunning('monitor_dinner_seminars');

  if (dinnerSeminars.length > 0) {
    if (hasActiveOrEndedDinner && !isDinnerNoticeCompleted && !isDinnerRunning) {
      const dinnerTask = taskRegistry.getByName('monitor_dinner_seminars');
      if (dinnerTask) {
        logger.info(
          `[저녁세미나 트리거] 입장 가능/진행 중인 세미나 감지 -> monitor_dinner_seminars 시작 (세미나: ${dinnerSeminars.length}건, activeOrEnded: true, noticeCompleted: false, running: false)`,
        );
        triggeredDinner = true;
        runTask(dinnerTask).catch((err) => {
          logger.error('monitor_dinner_seminars 비동기 트리거 실패:', err);
        });
      }
    } else if (hasActiveOrEndedDinner) {
      logger.info(
        `[저녁세미나 트리거 스킵] 입장 가능 세미나가 있으나 트리거 조건 미충족 (activeOrEnded: true, noticeCompleted: ${isDinnerNoticeCompleted}, running: ${isDinnerRunning})`,
      );
    }
  }

  return { triggeredLunch, triggeredDinner };
}
