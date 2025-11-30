
const { Telegraf } = require('telegraf');
const fs = require('fs/promises');
const https = require('https');
const { setBot } = require('./bot_instance');
const logger = require('./logger');
const scheduler = require('./scheduler');
const runner = require('./runner');
const taskRegistry = require('./taskRegistry');
const { inspect } = require('./modules/inspect');

const ADMIN_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const NOTICE_BOT_TOKEN = process.env.NOTICE_BOT_TOKEN;

if (!ADMIN_BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN is not set. The admin bot will not be initialized.');
}
if (!NOTICE_BOT_TOKEN) {
    logger.warn('NOTICE_BOT_TOKEN is not set. The notice bot will not be initialized.');
}

// Force IPv4 for Telegram API requests to work around network issues
const ipv4Agent = new https.Agent({ family: 4 });

const adminBot = ADMIN_BOT_TOKEN ? new Telegraf(ADMIN_BOT_TOKEN, { telegram: { agent: ipv4Agent } }) : null;
const noticeBot = NOTICE_BOT_TOKEN ? new Telegraf(NOTICE_BOT_TOKEN, { telegram: { agent: ipv4Agent } }) : null;

if (adminBot) {
    setBot('admin', adminBot);
    adminBot.start((ctx) => ctx.reply('Welcome, Admin!'));
}

if (noticeBot) {
    setBot('notice', noticeBot);
    noticeBot.start((ctx) => ctx.reply('Welcome!'));
}

// --- Admin Bot Commands ---
if (adminBot) {
    adminBot.command('schedules', (ctx) => {
        const tasks = scheduler.getScheduledTasks();
        if (tasks.length === 0) {
            return ctx.reply('No scheduled tasks.');
        }

        let message = 'Scheduled Tasks:\n\n';
        tasks.forEach(task => {
            message += `Name: ${task.name}\n`;
            message += `Schedule: ${task.schedule}\n`;
            message += `Timezone: ${task.timezone}\n\n`;
        });

        ctx.reply(message);
    });

    adminBot.command('run_routine_now', async (ctx) => {
        logger.info('User requested to run daily_routine now', { from: ctx.from.username });
        const task = taskRegistry.getByName('daily_routine');
        if (!task) {
            logger.error('daily_routine task not found, cannot run');
            return ctx.reply('daily_routine task not found!');
        }

        try {
            ctx.reply('Starting daily_routine...');
            await runner.runTask(task);
            ctx.reply('daily_routine finished successfully.');
        } catch (e) {
            ctx.reply(`daily_routine failed: ${e && e.message ? e.message : e}`);
        }
    });

    adminBot.command('inspect', async (ctx) => {
        logger.info('User requested to inspect a page', { from: ctx.from.username });
        const args = ctx.message.text.split(' ').slice(1);
        if (args.length < 2) {
            return ctx.reply('Usage: /inspect <url> <selector>');
        }
        const url = args[0];
        const selector = args.slice(1).join(' ');
        let screenshotPath = null;

        try {
            ctx.reply(`Inspecting ${url} with selector "${selector}"...`);
            const result = await inspect(url, selector);
            screenshotPath = result.screenshotPath;
            let message = `Found ${result.count} elements matching selector "${selector}".\n\n`;

            if (result.warnings && result.warnings.length > 0) {
                message += 'Warnings:\n';
                result.warnings.forEach(warning => {
                    message += `- ${warning}\n`;
                });
                message += '\n';
            }

            if (result.count > 0) {
                result.elements.forEach((element, i) => {
                    message += `Element ${i + 1}:\n`;
                    message += `  - Inner Text: ${element.innerText}\n`;
                    if (element.id) message += `  - ID: ${element.id}\n`;
                    if (element.className) message += `  - Class: ${element.className}\n`;

                    const otherAttributes = Object.entries(element.attributes).filter(([key]) => key !== 'id' && key !== 'class');
                    if (otherAttributes.length > 0) {
                        message += `  - Other Attributes:\n`;
                        otherAttributes.forEach(([key, value]) => {
                            message += `    - ${key}: ${value}\n`;
                        });
                    }
                    message += '\n';
                });
            }
            await ctx.reply(message);

            if (screenshotPath) {
                await ctx.replyWithPhoto({ source: screenshotPath });
            }
        } catch (e) {
            let errorMessage = `An error occurred while inspecting ${url}.`;
            if (e.message && e.message.includes('Timeout')) {
                errorMessage = `Navigation timeout: The page at ${url} took too long to load or was unreachable.`;
            } else if (e.message) {
                errorMessage += `\nDetails: ${e.message}`;
            }
            ctx.reply(errorMessage);
        } finally {
            if (screenshotPath) {
                await fs.unlink(screenshotPath).catch(err => logger.error(`Failed to delete screenshot: ${screenshotPath}`, err));
            }
        }
    });
}

// --- Shared Commands ---
const seminarCheck5Days = async (ctx) => {
    logger.info('User requested to run 5days_seminar_check now', { from: ctx.from.username });
    const task = taskRegistry.getByName('5days_seminar_check');
    if (!task) {
        logger.error('5days_seminar_check task not found, cannot run');
        return ctx.reply('5days_seminar_check task not found!');
    }

    try {
        ctx.reply('5일간의 세미나를 확인합니다...');
        await runner.runTask(task);
        ctx.reply('세미나 확인이 완료되었습니다.');
    } catch (e) {
        ctx.reply(`세미나 확인 중 오류 발생: ${e && e.message ? e.message : e}`);
    }
};

const seminarCheckToday = async (ctx) => {
    logger.info('User requested to run today_seminar_check now', { from: ctx.from.username });
    const task = taskRegistry.getByName('today_seminar_check');
    if (!task) {
        logger.error('today_seminar_check task not found, cannot run');
        return ctx.reply('today_seminar_check task not found!');
    }

    try {
        ctx.reply('오늘의 세미나를 확인합니다...');
        await runner.runTask(task);
        ctx.reply('세미나 확인이 완료되었습니다.');
    } catch (e) {
        ctx.reply(`세미나 확인 중 오류 발생: ${e && e.message ? e.message : e}`);
    }
};

if (adminBot) {
    adminBot.command('5days_seminar_check', seminarCheck5Days);
    adminBot.command('today_seminar_check', seminarCheckToday);
}
if (noticeBot) {
    noticeBot.command('5days_seminar_check', seminarCheck5Days);
    noticeBot.command('today_seminar_check', seminarCheckToday);
}


function launch() {
    if (adminBot) {
        adminBot.launch();
        logger.info('Admin bot started');
    }
    if (noticeBot) {
        noticeBot.launch();
        logger.info('Notice bot started');
    }
}

module.exports = {
    launch
};
