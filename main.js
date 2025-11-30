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
            const loggedIn = await loginTask.run({ page, context, env });
            if (!loggedIn) throw new Error('login failed in scheduled daily_routine');
            await attendanceTask.run({ page, context, env }).catch(() => { });
            await applySeminarTask.run({ page, context, env }).catch(() => { });
            await todaySeminarCheckTask.run({ page, context, env }).catch(() => { });
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

// Guidance: to add more scheduled jobs, create more task objects like `scheduledTask` above
// and call `scheduler.scheduleTaskCron(yourTask)`. Tasks should export `run` async function or be
// objects with `name`, `schedule`, `timezone`, and `run`.

// Keep the process alive explicitly (node-cron uses timers which usually keep the process alive,
// but calling `process.stdin.resume()` prevents accidental exit in some environments).
process.stdin.resume();

// Launch the Telegram bot
telegram.launch();
