require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();
const scheduler = require('./scheduler');
const logger = require('./logger');
const telegram = require('./telegram');
const taskRegistry = require('./taskRegistry');

// Configuration
const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';

// Daily schedule: 08:01 Asia/Seoul (cron: minute hour day month weekday)
const CRON_EXPR = process.env.DAILY_CRON || '1 8 * * *';
const TIMEZONE = process.env.SCHEDULE_TZ || 'Asia/Seoul';

// Create a single composite scheduled task that will run login -> attendance -> apply_seminar
const scheduledTask = {
    name: 'daily_routine',
    schedule: CRON_EXPR,
    timezone: TIMEZONE,
    run: async () => {
        const { chromium } = require('playwright');
        const utils = require('./modules/utils');
        const attendanceTask = require('./tasks/attendance');
        const applySeminarTask = require('./tasks/apply_seminar');
        const todaySeminarCheckTask = require('./tasks/today_seminar_check');
        const todayQuizTask = require('./tasks/today_quiz');

        logger.info('daily_routine: launching browser to perform daily tasks');
        const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        try {
            const tasks = [
                { name: 'attendance', task: attendanceTask },
                { name: 'apply_seminar', task: applySeminarTask },
                { name: 'today_seminar_check', task: todaySeminarCheckTask },
                { name: 'today_quiz', task: todayQuizTask }
            ];

            for (const { name, task } of tasks) {
                try {
                    await utils.ensureLoggedIn({ page, context });
                    await task.run({ page, context });
                } catch (err) {
                    logger.error(`Error during ${name} task:`, err);
                    await utils.sendTelegram(`daily_routine 중 ${name} 작업 실패: ${err.message}`).catch(() => { });
                }
            }
        } finally {
            try { await context.close(); } catch (e) { }
            try { await browser.close(); } catch (e) { }
        }
        return true;
    }
};

// Register the scheduled task. The process will keep running so cron can trigger jobs.
scheduler.scheduleTaskCron(scheduledTask);
taskRegistry.registerTask(scheduledTask);
logger.info('Scheduled `daily_routine` at', CRON_EXPR, 'timezone=', TIMEZONE);

// --- Register individual tasks to be runnable from Telegram ---
const todaySeminarCheckTask = {
    name: 'today_seminar_check',
    run: async () => {
        const { chromium } = require('playwright');
        const utils = require('./modules/utils');
        const task = require('./tasks/today_seminar_check');
        const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
        const context = await browser.newContext();
        const page = await context.newPage();
        let _res;
        try {
            await utils.ensureLoggedIn({ page, context });
            _res = await task.run({ page, context });
        } finally {
            await browser.close();
        }
        return _res;
    }
};
taskRegistry.registerTask(todaySeminarCheckTask);

const todayQuizTask = {
    name: 'today_quiz',
    run: async () => {
        const { chromium } = require('playwright');
        const utils = require('./modules/utils');
        const task = require('./tasks/today_quiz');
        const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
        const context = await browser.newContext();
        const page = await context.newPage();
        let _res;
        try {
            await utils.ensureLoggedIn({ page, context });
            _res = await task.run({ page, context });
        } finally {
            await browser.close();
        }
        return _res;
    }
};
taskRegistry.registerTask(todayQuizTask);

const fiveDaysSeminarCheckTask = {
    name: '5days_seminar_check',
    run: async () => {
        const { chromium } = require('playwright');
        const utils = require('./modules/utils');
        const task = require('./tasks/5days_seminar_check');
        const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
        const context = await browser.newContext();
        const page = await context.newPage();
        let _res;
        try {
            await utils.ensureLoggedIn({ page, context });
            _res = await task.run({ page, context });
        } finally {
            await browser.close();
        }
        return _res;
    }
};
taskRegistry.registerTask(fiveDaysSeminarCheckTask);

const todayLinksTask = {
    name: 'today_links',
    run: async () => {
        const { chromium } = require('playwright');
        const utils = require('./modules/utils');
        const task = require('./tasks/today_links');
        const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
        const context = await browser.newContext();
        const page = await context.newPage();
        let _res;
        try {
            await utils.ensureLoggedIn({ page, context });
            _res = await task.run({ page, context });
        } finally {
            await browser.close();
        }
        return _res;
    }
};
taskRegistry.registerTask(todayLinksTask);

const monitorLunchSeminarsTask = {
    name: 'monitor_lunch_seminars',
    run: async () => {
        const { chromium } = require('playwright');
        const utils = require('./modules/utils');
        const task = require('./tasks/monitor_lunch_seminars');
        const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
        const context = await browser.newContext();
        const page = await context.newPage();
        let _res;
        try {
            await utils.ensureLoggedIn({ page, context });
            _res = await task.run({ page, context });
        } finally {
            await browser.close();
        }
        return _res;
    }
};
taskRegistry.registerTask(monitorLunchSeminarsTask);

const monitorDinnerSeminarsTask = {
    name: 'monitor_dinner_seminars',
    run: async () => {
        const { chromium } = require('playwright');
        const utils = require('./modules/utils');
        const task = require('./tasks/monitor_dinner_seminars');
        const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
        const context = await browser.newContext();
        const page = await context.newPage();
        let _res;
        try {
            await utils.ensureLoggedIn({ page, context });
            _res = await task.run({ page, context });
        } finally {
            await browser.close();
        }
        return _res;
    }
};
taskRegistry.registerTask(monitorDinnerSeminarsTask);

// Schedule the daily today_links broadcast
const broadcastTodayLinksTask = {
    name: 'broadcast_today_links_daily',
    schedule: '0 8 * * *', // Every day at 8:00
    timezone: TIMEZONE,
    run: async () => {
        const utils = require('./modules/utils');
        const task = require('./tasks/today_links');
        const { chromium } = require('playwright');

        logger.info('broadcast_today_links_daily: running scheduled task');
        const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
        const context = await browser.newContext();
        const page = await context.newPage();

        try {
            await utils.ensureLoggedIn({ page, context });
            const result = await task.run({ page, context });
            if (result && result.message) {
                await utils.sendNotificationToChannel(result.message);
                logger.info('broadcast_today_links_daily: successfully broadcasted links.');
                return { success: true, message: 'Broadcast successful.' };
            } else {
                logger.warn('broadcast_today_links_daily: task ran, but no message was produced to broadcast.');
                return { success: false, message: 'No message to broadcast.' };
            }
        } catch (e) {
            logger.error('broadcast_today_links_daily: scheduled task failed', e && e.stack ? e.stack : e);
            // Notify admin of failure
            await utils.sendTelegram(`❗ Daily link broadcast failed: ${e.message}`).catch(() => { });
            return { success: false, message: `Broadcast failed: ${e.message}` };
        } finally {
            try { await context.close(); } catch (e) { }
            try { await browser.close(); } catch (e) { }
        }
    }
};
scheduler.scheduleTaskCron(broadcastTodayLinksTask);
taskRegistry.registerTask(broadcastTodayLinksTask); // Also register it to be runnable
logger.info('Scheduled `broadcast_today_links_daily` at 08:00 timezone=', TIMEZONE);

// Schedule the lunch monitoring task
scheduler.scheduleTaskCron({
    name: 'monitor_lunch_seminars',
    schedule: '0 11 * * *', // Every day at 11:00
    timezone: TIMEZONE,
    run: monitorLunchSeminarsTask.run
});
logger.info('Scheduled `monitor_lunch_seminars` at 11:00 timezone=', TIMEZONE);

// Schedule the dinner monitoring task
scheduler.scheduleTaskCron({
    name: 'monitor_dinner_seminars',
    schedule: '0 17 * * *', // Every day at 17:00
    timezone: TIMEZONE,
    run: monitorDinnerSeminarsTask.run
});
logger.info('Scheduled `monitor_dinner_seminars` at 17:00 timezone=', TIMEZONE);


// Guidance: to add more scheduled jobs, create more task objects like `scheduledTask` above
// and call `scheduler.scheduleTaskCron(yourTask)`. Tasks should export `run` async function or be
// objects with `name`, `schedule`, `timezone`, and `run`.

// Keep the process alive explicitly (node-cron uses timers which usually keep the process alive,
// but calling `process.stdin.resume()` prevents accidental exit in some environments).
process.stdin.resume();

// --- Auto-resume logic on startup ---
function checkAndResumeTasks() {
    const runner = require('./runner');
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
    const currentHour = now.getHours();

    logger.info(`Startup check: current hour is ${currentHour} in ${TIMEZONE}`);

    // Check for lunch monitoring window (11 AM to 2 PM)
    if (currentHour >= 11 && currentHour < 14) {
        logger.info('Inside lunch monitoring window, attempting to resume task.');
        runner.runTask(monitorLunchSeminarsTask).catch(err => {
            logger.error('Failed to auto-resume lunch monitoring task:', err);
        });
    }

    // Check for dinner monitoring window (5 PM to 9 PM)
    if (currentHour >= 17 && currentHour < 21) {
        logger.info('Inside dinner monitoring window, attempting to resume task.');
        runner.runTask(monitorDinnerSeminarsTask).catch(err => {
            logger.error('Failed to auto-resume dinner monitoring task:', err);
        });
    }
}

checkAndResumeTasks();


// Launch the Telegram bot
telegram.launch();
