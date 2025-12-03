import dns from 'dns';
import dotenv from 'dotenv';
import { chromium } from 'playwright';
import * as scheduler from './scheduler';
import * as logger from './logger';
import * as telegram from './telegram';
import * as taskRegistry from './taskRegistry';
import * as utils from './modules/utils';
import * as attendanceTask from './tasks/attendance';
import * as applySeminarTask from './tasks/apply_seminar';
import * as todaySeminarCheckTaskModule from './tasks/today_seminar_check';
import * as todayQuizTaskModule from './tasks/today_quiz';
import * as fiveDaysSeminarTaskModule from './tasks/5days_seminar_check';
import * as todayLinksTaskModule from './tasks/today_links';
import * as monitorLunchSeminars from './tasks/monitor_lunch_seminars';
import * as monitorDinnerSeminars from './tasks/monitor_dinner_seminars';
import { runTask } from './runner';
import type { Task } from './types';

dns.setDefaultResultOrder('ipv4first');
dotenv.config();

// Configuration
const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';

// Daily schedule: 08:01 Asia/Seoul (cron: minute hour day month weekday)
const CRON_EXPR = process.env.DAILY_CRON || '1 8 * * *';
const TIMEZONE = process.env.SCHEDULE_TZ || 'Asia/Seoul';

// Create a single composite scheduled task that will run login -> attendance -> apply_seminar
const scheduledTask: Task = {
  name: 'daily_routine',
  schedule: CRON_EXPR,
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
        { name: 'today_seminar_check', task: todaySeminarCheckTaskModule },
        { name: 'today_quiz', task: todayQuizTaskModule },
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
          await utils.sendTelegram(`daily_routine 중 ${name} 작업 실패: ${utils.escapeMarkdown(message)}`).catch(() => {});
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
logger.info('Scheduled `daily_routine` at', CRON_EXPR, 'timezone=', TIMEZONE);

// --- Register individual tasks to be runnable from Telegram ---
const todaySeminarCheckTask: Task = {
  name: 'today_seminar_check',
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await todaySeminarCheckTaskModule.run({ page, context });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(todaySeminarCheckTask);

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
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await monitorLunchSeminars.run({ page, context });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(monitorLunchSeminarsTask);

const monitorDinnerSeminarsTask: Task = {
  name: 'monitor_dinner_seminars',
  run: async () => {
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await utils.ensureLoggedIn({ page, context });
      return await monitorDinnerSeminars.run({ page, context });
    } finally {
      await browser.close();
    }
  },
};
taskRegistry.registerTask(monitorDinnerSeminarsTask);

const broadcastTodayLinksTask: Task = {
  name: 'broadcast_today_links_daily',
  schedule: '0 8 * * *', // Every day at 8:00
  timezone: TIMEZONE,
  run: async () => {
    logger.info('broadcast_today_links_daily: running scheduled task');
    const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await utils.ensureLoggedIn({ page, context });

      const linksResult = await todayLinksTaskModule.run({ page, context });
      const seminarResult = await todaySeminarCheckTaskModule.run({ page, context });

      let finalMessage = '';
      let messageOptions: Record<string, unknown> = {};
      if (linksResult && (linksResult as { success?: boolean }).success && (linksResult as { message?: string }).message) {
        finalMessage += (linksResult as { message: string }).message;
        const linksOptions = (linksResult as { options?: Record<string, unknown> }).options;
        if (linksOptions) {
          messageOptions = { ...messageOptions, ...linksOptions };
        }
      } else if (linksResult && !(linksResult as { success?: boolean }).success) {
        logger.warn(`broadcast_today_links_daily: today_links sub-task failed: ${(linksResult as { message?: string }).message}`);
      }

      if (seminarResult && (seminarResult as { success?: boolean }).success && (seminarResult as { message?: string }).message) {
        if (finalMessage) finalMessage += '\n';
        finalMessage += (seminarResult as { message: string }).message;
        const seminarOptions = (seminarResult as { options?: Record<string, unknown> }).options;
        if (seminarOptions) {
          messageOptions = { ...messageOptions, ...seminarOptions };
        }
      } else if (seminarResult && !(seminarResult as { success?: boolean }).success) {
        logger.warn(`broadcast_today_links_daily: today_seminar_check sub-task failed: ${(seminarResult as { message?: string }).message}`);
      }

      if (finalMessage) {
        await utils.sendNotificationToChannel(finalMessage, null, messageOptions);
        logger.info('broadcast_today_links_daily: successfully broadcasted combined message.');
        return { success: true, message: 'Broadcast successful.' };
      } else {
        logger.warn('broadcast_today_links_daily: all sub-tasks ran, but no message was produced to broadcast.');
        return { success: false, message: 'No message to broadcast.' };
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error('broadcast_today_links_daily: scheduled task failed', e && (typeof e === 'object' && 'stack' in e ? (e as Error).stack : e));
      await utils.sendTelegram(`❗ Daily link broadcast failed: ${utils.escapeMarkdown(message)}`).catch(() => {});
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
logger.info('Scheduled `broadcast_today_links_daily` at 08:00 timezone=', TIMEZONE);

// Schedule the lunch monitoring task
scheduler.scheduleTaskCron({
  name: 'monitor_lunch_seminars',
  schedule: '0 11 * * *', // Every day at 11:00
  timezone: TIMEZONE,
  run: monitorLunchSeminarsTask.run,
});
logger.info('Scheduled `monitor_lunch_seminars` at 11:00 timezone=', TIMEZONE);

// Schedule the dinner monitoring task
scheduler.scheduleTaskCron({
  name: 'monitor_dinner_seminars',
  schedule: '0 17 * * *', // Every day at 17:00
  timezone: TIMEZONE,
  run: monitorDinnerSeminarsTask.run,
});
logger.info('Scheduled `monitor_dinner_seminars` at 17:00 timezone=', TIMEZONE);

// Keep the process alive explicitly (node-cron uses timers which usually keep the process alive,
// but calling process.stdin.resume() prevents accidental exit in some environments).
process.stdin.resume();

// --- Auto-resume logic on startup ---
function checkAndResumeTasks(): void {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
  const currentHour = now.getHours();

  logger.info(`Startup check: current hour is ${currentHour} in ${TIMEZONE}`);

  if (currentHour >= 11 && currentHour < 14) {
    logger.info('Inside lunch monitoring window, attempting to resume task.');
    runTask(monitorLunchSeminarsTask).catch((err) => {
      logger.error('Failed to auto-resume lunch monitoring task:', err);
    });
  }

  if (currentHour >= 17 && currentHour < 21) {
    logger.info('Inside dinner monitoring window, attempting to resume task.');
    runTask(monitorDinnerSeminarsTask).catch((err) => {
      logger.error('Failed to auto-resume dinner monitoring task:', err);
    });
  }
}

checkAndResumeTasks();

// Launch the Telegram bot
telegram.launch();
