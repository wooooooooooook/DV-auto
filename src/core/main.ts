import dns from 'dns';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import * as scheduler from './scheduler';
import { runTask } from './runner';
import * as taskRegistry from './taskRegistry';
import * as logger from '../services/logger';
import * as telegram from '../services/telegram';
import * as utils from '../modules/utils';
import * as attendanceTask from '../tasks/attendance';
import * as applySeminarTask from '../tasks/apply_seminar';
import * as todayQuizTaskModule from '../tasks/today_quiz';
import * as todayLinksTaskModule from '../tasks/today_links';
import * as monitorLunchSeminars from '../tasks/monitor_lunch_seminars';
import * as monitorDinnerSeminars from '../tasks/monitor_dinner_seminars';
import * as naverpayPointExchangeTask from '../tasks/naverpay_point_exchange';
import * as baeminPointExchangeTask from '../tasks/baemin_point_exchange';
import * as refreshSeminarPointExclusionTaskModule from '../tasks/refresh_seminar_point_exclusion';
import * as checkPointTaskModule from '../tasks/check_point';
import * as checkSeminarPointTaskModule from '../tasks/check_seminar_point';
import * as checkAdvancedSeminarsTaskModule from '../tasks/check_advanced_seminars';
import * as runSeminarQuizTaskModule from '../tasks/run_seminar_quiz';
import type { Task, TaskResult } from '../types';

dns.setDefaultResultOrder('ipv4first');
dotenv.config();
const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';
const TIMEZONE = process.env.SCHEDULE_TZ || 'Asia/Seoul';
const DAILY_ROUTINE_CRON = process.env.DAILY_CRON || '1 0 * * *';
const BROADCAST_TODAY_LINKS_CRON = '0 9 * * *';
const APPLY_SEMINAR_EXTRA_CRON = '*/10 6-23 * * *';
const LUNCH_MONITOR_CRON = '0 11 * * *';
const DINNER_MONITOR_CRON = '0 16 * * *';
const MONITOR_RESUME_DURATION_HOURS = 5;
const POINT_CONVERSION_API_URL = 'https://api.doctorville.co.kr/api/point/conversion/availability';
const POINT_CONVERSION_STATE_FILE = path.join(process.cwd(), 'storage', 'point_conversion_state.json');
type PointConversionResponse = { data?: { available?: boolean; availablePlannedAt?: string; meridiem?: string } };
let isFastPolling = false;
let fastPollingInterval: NodeJS.Timeout | null = null;
function readConversionState(): boolean | null {
  try {
    const raw = fs.readFileSync(POINT_CONVERSION_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as { lastAvailable?: boolean };
    return typeof parsed.lastAvailable === 'boolean' ? parsed.lastAvailable : null;
  } catch {
    return null;
  }
}
function writeConversionState(available: boolean): void {
  try {
    fs.mkdirSync(path.dirname(POINT_CONVERSION_STATE_FILE), { recursive: true });
    fs.writeFileSync(POINT_CONVERSION_STATE_FILE, JSON.stringify({ lastAvailable: available }, null, 2));
  } catch (err) {
    logger.warn('point conversion state 저장 실패', err);
  }
}
function getTodayKoreanString(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const month = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kst.getUTCDate()).padStart(2, '0');
  return `${month}월 ${day}일`;
}
function isAfterFivePMKST(): boolean {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.getUTCHours() >= 17;
}
async function checkAndNotifyPointConversion(): Promise<void> {
  if (isAfterFivePMKST() && isFastPolling) stopFastPolling();
  const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await utils.ensureLoggedIn({ page, context });
    await page
      .goto('https://www.doctorville.co.kr/main', { waitUntil: 'domcontentloaded', timeout: 15000 })
      .catch(() => {});
    let response: PointConversionResponse | null = null;
    try {
      response = (await page.evaluate(async (apiUrl: string) => {
        const res = await fetch(apiUrl, { credentials: 'include' });
        const text = await res.text();
        if (!res.ok || !text) return null;
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      }, POINT_CONVERSION_API_URL)) as PointConversionResponse | null;
    } catch {}
    if (!response || response.data === undefined) return;
    const available = response.data.available === true;
    const plannedAt = response.data.availablePlannedAt ?? '';
    const meridiem = response.data.meridiem ?? '';
    const isToday = plannedAt === getTodayKoreanString();
    if (!isToday) {
      if (isFastPolling) stopFastPolling();
    } else if (!isFastPolling && !isAfterFivePMKST()) startFastPolling();
    const prev = readConversionState();
    if (prev === available) return;
    writeConversionState(available);
    if (prev !== null) {
      if (available)
        await utils.sendNotificationToChannel(
          '네이버페이포인트 전환이 가능해졌습니다\nhttps://www.doctorville.co.kr/my/point/pointUseHistoryList',
        );
      else
        await utils.sendNotificationToChannel(
          `네이버페이포인트 전환 마감되었습니다. 다음 전환 가능 예정: ${plannedAt} ${meridiem}`,
        );
    }
  } finally {
    await browser.close();
  }
}
function startFastPolling(): void {
  isFastPolling = true;
  if (fastPollingInterval) clearInterval(fastPollingInterval);
  fastPollingInterval = setInterval(
    () => checkAndNotifyPointConversion().catch((err) => logger.error('point_conversion_check 고속 폴링 에러:', err)),
    2 * 60 * 1000,
  );
}
function stopFastPolling(): void {
  isFastPolling = false;
  if (fastPollingInterval) {
    clearInterval(fastPollingInterval);
    fastPollingInterval = null;
  }
}
function getStartHourFromCron(cronExpr: string): number | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const hour = Number(parts[1]);
  return Number.isNaN(hour) ? null : hour;
}
function isWithinWindow(currentHour: number, startHour: number, durationHours: number): boolean {
  const endHour = (startHour + durationHours) % 24;
  if (startHour < endHour) return currentHour >= startHour && currentHour < endHour;
  return currentHour >= startHour || currentHour < endHour;
}

const scheduledTask: Task = {
  name: 'daily_routine',
  schedule: DAILY_ROUTINE_CRON,
  timezone: TIMEZONE,
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    try {
      const tasks = [
        { name: 'attendance', task: attendanceTask },
        { name: 'apply_seminar', task: applySeminarTask },
        { name: 'today_quiz', task: todayQuizTaskModule },
        { name: 'today_links', task: todayLinksTaskModule },
      ];
      await utils.sendTelegram('🕗 데일리 루틴 작업을 시작합니다.(출석체크, 세미나등록, 브랜드퀴즈)').catch(() => {});
      for (const { name, task } of tasks) {
        try {
          await utils.ensureLoggedIn({ page, context });
          const taskResultRaw = await task.run({ page, context });
          const taskResult: TaskResult =
            typeof taskResultRaw === 'object' && taskResultRaw !== null
              ? (taskResultRaw as TaskResult)
              : { success: Boolean(taskResultRaw) };
          if (taskResult.message)
            await utils
              .sendTelegram(taskResult.message, taskResult.imagePath ?? null, taskResult.options ?? {})
              .catch((e) => logger.error(`Failed to send Telegram message for ${name} task result:`, e));
        } catch (err) {
          logger.error(`Error during ${name} task:`, err);
          const message = err instanceof Error ? err.message : String(err);
          await utils.sendTelegram(`daily_routine 중 ${name} 작업 실패: ${message}`).catch(() => {});
        }
      }
    } finally {
      await utils.sendTelegram('🕗 데일리 루틴 작업이 종료되었습니다.').catch(() => {});
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
    return true;
  },
};
scheduler.scheduleTaskCron(scheduledTask);
taskRegistry.registerTask(scheduledTask);

const applySeminarExtraTask: Task = {
  name: 'apply_seminar_extra',
  schedule: APPLY_SEMINAR_EXTRA_CRON,
  timezone: TIMEZONE,
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await applySeminarTask.run(
        { page, context },
        {
          notifyNewSeminarsToChannel: true,
          notifyNewSeminarsToTelegram: true,
          silentIfNoNew: true,
          checkAdvancedPointStatus: true,
        },
      );
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(applySeminarExtraTask);
scheduler.scheduleTaskCron(applySeminarExtraTask);
const POINT_CONVERSION_CHECK_CRON = '0 9-16 * * *';
const pointConversionCheckTask: Task = {
  name: 'point_conversion_check',
  schedule: POINT_CONVERSION_CHECK_CRON,
  timezone: TIMEZONE,
  run: async () => {
    await checkAndNotifyPointConversion();
  },
};
taskRegistry.registerTask(pointConversionCheckTask);
scheduler.scheduleTaskCron(pointConversionCheckTask);
const applySeminarTaskStandalone: Task = {
  name: 'apply_seminar',
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await applySeminarTask.run(
        { page, context },
        { notifyNewSeminarsToChannel: false, notifyNewSeminarsToTelegram: true },
      );
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(applySeminarTaskStandalone);
const todayQuizTask: Task = {
  name: 'today_quiz',
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await todayQuizTaskModule.run({ page, context });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(todayQuizTask);
const todayLinksTask: Task = {
  name: 'today_links',
  run: async (ctx, options) => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await todayLinksTaskModule.run({ page, context, args: ctx.args }, options);
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(todayLinksTask);
const checkPointTask: Task = {
  name: 'check_point',
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await checkPointTaskModule.run({ page, context });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(checkPointTask);
const checkSeminarPointTask: Task = {
  name: 'check_seminar_point',
  run: async (ctx) => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      const seminarIdsRaw = ctx.args?.seminarIds;
      let seminarIds: string[] = [];
      if (seminarIdsRaw) {
        if (Array.isArray(seminarIdsRaw)) seminarIds = seminarIdsRaw;
        else if (typeof seminarIdsRaw === 'string')
          seminarIds = seminarIdsRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
      } else if (ctx.args?.seminarId) seminarIds = [ctx.args.seminarId];
      if (seminarIds.length === 0)
        return { success: false, message: '세미나 번호가 필요합니다. 예: /check_seminar_point 12345' };
      const searchRes = await checkSeminarPointTaskModule.searchSeminarPoints(context, seminarIds, 60);
      if (!searchRes.success) return { success: false, message: `포인트 조회 실패: ${searchRes.error || '조회 실패'}` };
      const results = searchRes.points;
      const messages: string[] = [];
      for (const seminarId of seminarIds) {
        const r = results.get(seminarId);
        if (r?.found)
          messages.push(
            `[${seminarId}] 세미나 ${seminarId} 포인트 ${r.type === '적립' ? '지급됨' : '사용됨'}: ${r.pointText} (${r.date} / ${r.content})`,
          );
        else messages.push(`[${seminarId}] 세미나 ${seminarId} 포인트 내역을 찾을 수 없습니다 (최근 60일간).`);
      }
      return { success: true, message: messages.join('\n') };
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(checkSeminarPointTask);
const checkAdvancedSeminarsTask: Task = {
  name: 'check_advanced_seminars',
  run: async () => checkAdvancedSeminarsTaskModule.run(),
};
taskRegistry.registerTask(checkAdvancedSeminarsTask);
const runSeminarQuizTask: Task = {
  name: 'run_seminar_quiz',
  run: async (ctx) => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await runSeminarQuizTaskModule.run({ page, context }, { args: ctx.args ?? {} });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(runSeminarQuizTask);
const refreshSeminarPointExclusionTask: Task = {
  name: 'refresh_seminar_point_exclusion',
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await refreshSeminarPointExclusionTaskModule.run({ page, context });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(refreshSeminarPointExclusionTask);
const monitorLunchSeminarsTask: Task = {
  name: 'monitor_lunch_seminars',
  schedule: LUNCH_MONITOR_CRON,
  timezone: TIMEZONE,
  run: async (ctx) => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      await applySeminarTask
        .run({ page, context })
        .catch((err) =>
          logger.warn('monitor_lunch_seminars: apply_seminar 선실행 실패, 모니터링은 계속 진행합니다', err),
        );
      return await monitorLunchSeminars.run({ page, context, isAutoResume: ctx.isAutoResume });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(monitorLunchSeminarsTask);
scheduler.scheduleTaskCron(monitorLunchSeminarsTask);
const monitorDinnerSeminarsTask: Task = {
  name: 'monitor_dinner_seminars',
  schedule: DINNER_MONITOR_CRON,
  timezone: TIMEZONE,
  run: async (ctx) => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      await applySeminarTask
        .run({ page, context })
        .catch((err) =>
          logger.warn('monitor_dinner_seminars: apply_seminar 선실행 실패, 모니터링은 계속 진행합니다', err),
        );
      return await monitorDinnerSeminars.run({ page, context, isAutoResume: ctx.isAutoResume });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(monitorDinnerSeminarsTask);
scheduler.scheduleTaskCron(monitorDinnerSeminarsTask);

const naverpayPointExchange: Task = {
  name: '네이버페이포인트교환',
  run: async (ctx) => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await naverpayPointExchangeTask.run({ page, context, maxIterations: ctx.maxIterations });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(naverpayPointExchange);
const baeminPointExchange: Task = {
  name: '배민포인트교환',
  run: async (ctx) => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await baeminPointExchangeTask.run({ page, context, maxIterations: ctx.maxIterations });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(baeminPointExchange);
const broadcastTodayLinksTask: Task = {
  name: 'broadcast_today_links_daily',
  schedule: BROADCAST_TODAY_LINKS_CRON,
  timezone: TIMEZONE,
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      const linksResult = await todayLinksTaskModule.run({ page, context });
      if (
        linksResult &&
        (linksResult as { success?: boolean }).success !== false &&
        (linksResult as { message?: string }).message
      ) {
        await utils.sendNotificationToChannel(
          (linksResult as { message: string }).message,
          null,
          (linksResult as { options?: Record<string, unknown> }).options ?? {},
        );
        return { success: true, message: 'Broadcast successful.' };
      }
      return { success: false, message: 'No message to broadcast.' };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      await utils.sendTelegram(`❗ Daily link broadcast failed: ${message}`).catch(() => {});
      return { success: false, message: `Broadcast failed: ${message}` };
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  },
};
scheduler.scheduleTaskCron(broadcastTodayLinksTask);
taskRegistry.registerTask(broadcastTodayLinksTask);
process.stdin.resume();
function checkAndResumeTasks(): void {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
  const currentHour = now.getHours();
  const lunchStartHour = getStartHourFromCron(LUNCH_MONITOR_CRON);
  if (lunchStartHour !== null && isWithinWindow(currentHour, lunchStartHour, MONITOR_RESUME_DURATION_HOURS))
    runTask(monitorLunchSeminarsTask, { isAutoResume: true }).catch((err) =>
      logger.error('Failed to auto-resume lunch monitoring task:', err),
    );
  const dinnerStartHour = getStartHourFromCron(DINNER_MONITOR_CRON);
  if (dinnerStartHour !== null && isWithinWindow(currentHour, dinnerStartHour, MONITOR_RESUME_DURATION_HOURS))
    runTask(monitorDinnerSeminarsTask, { isAutoResume: true }).catch((err) =>
      logger.error('Failed to auto-resume dinner monitoring task:', err),
    );
}
checkAndNotifyPointConversion().catch((err) => logger.error('Startup point-conversion check failed:', err));
checkAndResumeTasks();
telegram.launch();
const nowStr = new Date().toLocaleString('ko-KR', { timeZone: TIMEZONE });
utils
  .sendTelegram(`🚀 앱이 온라인 상태입니다. (${nowStr})`)
  .catch((err) => logger.error('Failed to send startup notification:', err));
