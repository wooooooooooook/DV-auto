require('dns').setDefaultResultOrder('ipv4first');
require('dotenv').config();
const { chromium } = require('playwright');
const utils = require('./modules/utils'); // Assuming utils.js has sendTelegram and ensureLoggedIn
const attendanceTask = require('./tasks/attendance');
const applySeminarTask = require('./tasks/apply_seminar');
const todaySeminarCheckTask = require('./tasks/today_seminar_check');
const todayQuizTask = require('./tasks/today_quiz');

async function main() {
    console.log('macro.js: Starting daily routine.');

    // Validate mandatory environment variables
    if (!process.env.DV_USER) {
        console.error('Error: ID environment variable is not set.');
        process.exit(1);
    }
    if (!process.env.DV_PASS) {
        console.error('Error: PASS environment variable is not set.');
        process.exit(1);
    }

    // Optional Telegram setup
    const TELEGRAM_ENABLED = process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID;
    if (!TELEGRAM_ENABLED) {
        console.warn('macro.js: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set. Telegram notifications will be skipped.');
    } else {
        console.log('macro.js: Telegram notifications are enabled.');
    }

    const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';
    let browser = null;
    let context = null;
    let page = null;

    try {
        browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
        context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
        });
        page = await context.newPage();

        const tasks = [
            { name: 'attendance', task: attendanceTask },
            { name: 'apply_seminar', task: applySeminarTask },
            { name: 'today_seminar_check', task: todaySeminarCheckTask },
            { name: 'today_quiz', task: todayQuizTask }
        ];

        for (const { name, task } of tasks) {
            try {
                console.log(`macro.js: Running ${name} task.`);
                await utils.ensureLoggedIn({ page, context });
                const taskResult = await task.run({ page, context }); // Capture the result
                if (taskResult && taskResult.message && TELEGRAM_ENABLED) {
                    await utils.sendTelegram(taskResult.message, taskResult.imagePath).catch(sendErr => {
                        console.error(`macro.js: Failed to send Telegram message for ${name} task result:`, sendErr);
                    });
                } else {
                    console.log(`macro.js: ${name} task completed successfully.`);
                }
            } catch (err) {
                console.error(`macro.js: Error during ${name} task:`, err);
                if (TELEGRAM_ENABLED) {
                    await utils.sendTelegram(`daily_routine 중 ${name} 작업 실패: ${err.message}`).catch(sendErr => {
                        console.error('macro.js: Failed to send Telegram error notification:', sendErr);
                    });
                }
            }
        }
    } catch (e) {
        console.error('macro.js: Unhandled error in main routine:', e);
        if (TELEGRAM_ENABLED) {
            await utils.sendTelegram(`daily_routine 실행 중 치명적인 오류 발생: ${e.message}`).catch(sendErr => {
                console.error('macro.js: Failed to send Telegram fatal error notification:', sendErr);
            });
        }
    } finally {
        if (context) {
            try { await context.close(); } catch (e) { console.error('macro.js: Error closing context:', e); }
        }
        if (browser) {
            try { await browser.close(); } catch (e) { console.error('macro.js: Error closing browser:', e); }
        }
        console.log('macro.js: Daily routine finished.');
    }
}

main().catch(e => {
    console.error('macro.js: Script terminated with unhandled error:', e);
    process.exit(1);
});
