import dns from 'dns';
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
import * as fiveDaysSeminarTaskModule from '../tasks/5days_seminar_check';
import * as todayLinksTaskModule from '../tasks/today_links';
import * as monitorLunchSeminars from '../tasks/monitor_lunch_seminars';
import * as monitorDinnerSeminars from '../tasks/monitor_dinner_seminars';
import * as naverpayPointExchangeTask from '../tasks/naverpay_point_exchange';
import type { Task } from '../types';

dns.setDefaultResultOrder('ipv4first');
dotenv.config();

// Configuration
const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';

// Daily schedule: 08:00 Asia/Seoul (cron: minute hour day month weekday)
const TIMEZONE = process.env.SCHEDULE_TZ || 'Asia/Seoul';
const DAILY_ROUTINE_CRON = process.env.DAILY_CRON || '1 0 * * *';
const BROADCAST_TODAY_LINKS_CRON = '0 9 * * *';
const APPLY_SEMINAR_EXTRA_CRON = '0 11,14,17 * * *';
const LUNCH_MONITOR_CRON = '0 11 * * *';
const DINNER_MONITOR_CRON = '0 17 * * *';
const MONITOR_RESUME_DURATION_HOURS = 5;

function getStartHourFromCron(cronExpr: string): number | null {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const hour = Number(parts[1]);
  return Number.isNaN(hour) ? null : hour;
}

function isWithinWindow(currentHour: number, startHour: number, durationHours: number): boolean {
  const endHour = (startHour + durationHours) % 24;
  if (startHour < endHour) {
    return currentHour >= startHour && currentHour < endHour;
  }
  return currentHour >= startHour || currentHour < endHour;
}

// Create a single composite scheduled task that will run login -> attendance -> apply_seminar
const scheduledTask: Task = {
  name: 'daily_routine',
  schedule: DAILY_ROUTINE_CRON,
  timezone: TIMEZONE,
  run: async () => {
    logger.info('daily_routine: launching browser to perform daily tasks');
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
          const taskResult = await task.run({ page, context }); // Capture the result
          if (taskResult && typeof taskResult === 'object' && (taskResult as { message?: string }).message) {
            await utils
              .sendTelegram(
                (taskResult as { message: string }).message,
                (taskResult as { imagePath?: string | null }).imagePath ?? null,
                (taskResult as { options?: Record<string, unknown> }).options ?? {},
              )
              .catch((e) => logger.error(`Failed to send Telegram message for ${name} task result:`, e));
          }
        } catch (err) {
          logger.error(`Error during ${name} task:`, err);
          const message = err instanceof Error ? err.message : String(err);
          await utils.sendTelegram(`daily_routine 중 ${name} 작업 실패: ${message}`).catch(() => {});
        }
      }
    } finally {
      await utils.sendTelegram('🕗 데일리 루틴 작업이 종료되었습니다.').catch(() => {});
      try {
        await context.close();
      } catch (_e) {
        // ignore
      }
      try {
        await browser.close();
      } catch (_e) {
        // ignore
      }
    }
    return true;
  },
};

scheduler.scheduleTaskCron(scheduledTask);
taskRegistry.registerTask(scheduledTask);

// --- Register individual tasks to be runnable from Telegram ---
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
        { notifyNewSeminarsToChannel: true, notifyNewSeminarsToTelegram: false },
      );
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(applySeminarExtraTask);
scheduler.scheduleTaskCron(applySeminarExtraTask);

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

const fiveDaysSeminarCheckTask: Task = {
  name: '5days_seminar_check',
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await fiveDaysSeminarTaskModule.run({ page, context });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(fiveDaysSeminarCheckTask);

const todayLinksTask: Task = {
  name: 'today_links',
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await todayLinksTaskModule.run({ page, context });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(todayLinksTask);

const monitorLunchSeminarsTask: Task = {
  name: 'monitor_lunch_seminars',
  schedule: LUNCH_MONITOR_CRON,
  timezone: TIMEZONE,
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      await applySeminarTask.run({ page, context }).catch((err) => {
        logger.warn(
          'monitor_lunch_seminars: apply_seminar 선실행 실패, 모니터링은 계속 진행합니다',
          err && (typeof err === 'object' && 'stack' in err ? (err as Error).stack : err),
        );
      });
      return await monitorLunchSeminars.run({ page, context });
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
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      await applySeminarTask.run({ page, context }).catch((err) => {
        logger.warn(
          'monitor_dinner_seminars: apply_seminar 선실행 실패, 모니터링은 계속 진행합니다',
          err && (typeof err === 'object' && 'stack' in err ? (err as Error).stack : err),
        );
      });
      return await monitorDinnerSeminars.run({ page, context });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(monitorDinnerSeminarsTask);
scheduler.scheduleTaskCron(monitorDinnerSeminarsTask);

const naverpayPointExchange: Task = {
  name: '네이버페이포인트교환',
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await naverpayPointExchangeTask.run({ page, context });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(naverpayPointExchange);

const broadcastTodayLinksTask: Task = {
  name: 'broadcast_today_links_daily',
  schedule: BROADCAST_TODAY_LINKS_CRON, // Every day at 09:00
  timezone: TIMEZONE,
  run: async () => {
    logger.info('broadcast_today_links_daily: running scheduled task');
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
        const messageOptions = (linksResult as { options?: Record<string, unknown> }).options ?? {};
        await utils.sendNotificationToChannel((linksResult as { message: string }).message, null, messageOptions);
        logger.info('broadcast_today_links_daily: successfully broadcasted message from today_links.');
        return { success: true, message: 'Broadcast successful.' };
      }

      logger.warn('broadcast_today_links_daily: all sub-tasks ran, but no message was produced to broadcast.');
      return { success: false, message: 'No message to broadcast.' };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error(
        'broadcast_today_links_daily: scheduled task failed',
        e && (typeof e === 'object' && 'stack' in e ? (e as Error).stack : e),
      );
      await utils.sendTelegram(`❗ Daily link broadcast failed: ${message}`).catch(() => {});
      return { success: false, message: `Broadcast failed: ${message}` };
    } finally {
      try {
        await context.close();
      } catch (_e) {
        // ignore
      }
      try {
        await browser.close();
      } catch (_e) {
        // ignore
      }
    }
  },
};
scheduler.scheduleTaskCron(broadcastTodayLinksTask);
taskRegistry.registerTask(broadcastTodayLinksTask);

// Keep the process alive explicitly (node-cron uses timers which usually keep the process alive,
// but calling process.stdin.resume() prevents accidental exit in some environments).
process.stdin.resume();

// --- Auto-resume logic on startup ---
function checkAndResumeTasks(): void {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
  const currentHour = now.getHours();

  logger.info(`Startup check: current hour is ${currentHour} in ${TIMEZONE}`);

  const lunchStartHour = getStartHourFromCron(LUNCH_MONITOR_CRON);
  if (lunchStartHour !== null && isWithinWindow(currentHour, lunchStartHour, MONITOR_RESUME_DURATION_HOURS)) {
    logger.info('Inside lunch monitoring window, attempting to resume task.');
    runTask(monitorLunchSeminarsTask).catch((err) => {
      logger.error('Failed to auto-resume lunch monitoring task:', err);
    });
  }

  const dinnerStartHour = getStartHourFromCron(DINNER_MONITOR_CRON);
  if (dinnerStartHour !== null && isWithinWindow(currentHour, dinnerStartHour, MONITOR_RESUME_DURATION_HOURS)) {
    logger.info('Inside dinner monitoring window, attempting to resume task.');
    runTask(monitorDinnerSeminarsTask).catch((err) => {
      logger.error('Failed to auto-resume dinner monitoring task:', err);
    });
  }
}

checkAndResumeTasks();

// Launch the Telegram bot
telegram.launch();
