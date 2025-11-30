require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();
const scheduler = require('./scheduler');
const logger = require('./logger');
const telegram = require('./telegram');
const taskRegistry = require('./taskRegistry');

// Configuration
const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';
const LOGIN_URL = process.env.LOGIN_URL;
const TARGET_PAGE = process.env.TARGET_PAGE;
const DV_USER = process.env.DV_USER;
const DV_PASS = process.env.DV_PASS;

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
        const loginTask = require('./tasks/login');
        const attendanceTask = require('./tasks/attendance');
        const applySeminarTask = require('./tasks/apply_seminar');
        const todaySeminarCheckTask = require('./tasks/today_seminar_check');

        logger.info('daily_routine: launching browser to perform daily tasks');
        const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        await utils.loadCookies(context).catch(err => logger.warn('Failed to load cookies', err));
        await utils.loadLocalStorage(page, LOGIN_URL).catch(err => logger.warn('Failed to load local storage', err));

        try {
            const env = { LOGIN_URL, TARGET_PAGE, DV_USER, DV_PASS };
            const tasks = [
                { name: 'attendance', task: attendanceTask },
                { name: 'apply_seminar', task: applySeminarTask },
                { name: 'today_seminar_check', task: todaySeminarCheckTask }
            ];

            for (const { name, task } of tasks) {
                try {
                    await utils.ensureLoggedIn({ page, context, env });
                    await task.run({ page, context, env });
                } catch (err) {
                    logger.error(`Error during ${name} task:`, err);
                    await utils.sendNotificationToChannel(`daily_routine 중 ${name} 작업 실패: ${err.message}`).catch(() => {});
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
        await utils.loadCookies(context).catch(err => logger.warn('Failed to load cookies', err));
        await utils.loadLocalStorage(page, LOGIN_URL).catch(err => logger.warn('Failed to load local storage', err));
        const env = { LOGIN_URL, TARGET_PAGE, DV_USER, DV_PASS };
        try {
            await utils.ensureLoggedIn({ page, context, env });
            await task.run({ page, context, env });
        } finally {
            await browser.close();
        }
    }
};
taskRegistry.registerTask(todaySeminarCheckTask);

const fiveDaysSeminarCheckTask = {
    name: '5days_seminar_check',
    run: async () => {
        const { chromium } = require('playwright');
        const utils = require('./modules/utils');
        const task = require('./tasks/5days_seminar_check');
        const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
        const context = await browser.newContext();
        const page = await context.newPage();
        await utils.loadCookies(context).catch(err => logger.warn('Failed to load cookies', err));
        await utils.loadLocalStorage(page, LOGIN_URL).catch(err => logger.warn('Failed to load local storage', err));
        const env = { LOGIN_URL, TARGET_PAGE, DV_USER, DV_PASS };
        try {
            await utils.ensureLoggedIn({ page, context, env });
            await task.run({ page, context, env });
        } finally {
            await browser.close();
        }
    }
};
taskRegistry.registerTask(fiveDaysSeminarCheckTask);

const monitorLunchSeminarsTask = {
    name: 'monitor_lunch_seminars',
    run: async () => {
        const { chromium } = require('playwright');
        const utils = require('./modules/utils');
        const task = require('./tasks/monitor_lunch_seminars');
        const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
        const context = await browser.newContext();
        const page = await context.newPage();
        await utils.loadCookies(context).catch(err => logger.warn('Failed to load cookies', err));
        await utils.loadLocalStorage(page, LOGIN_URL).catch(err => logger.warn('Failed to load local storage', err));
        const env = { LOGIN_URL, TARGET_PAGE, DV_USER, DV_PASS };
        try {
            await utils.ensureLoggedIn({ page, context, env });
            await task.run({ page, context, env });
        } finally {
            await browser.close();
        }
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
        await utils.loadCookies(context).catch(err => logger.warn('Failed to load cookies', err));
        await utils.loadLocalStorage(page, LOGIN_URL).catch(err => logger.warn('Failed to load local storage', err));
        const env = { LOGIN_URL, TARGET_PAGE, DV_USER, DV_PASS };
        try {
            await utils.ensureLoggedIn({ page, context, env });
            await task.run({ page, context, env });
        } finally {
            await browser.close();
        }
    }
};
taskRegistry.registerTask(monitorDinnerSeminarsTask);

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
