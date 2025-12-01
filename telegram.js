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
            await ctx.reply('Starting daily_routine...');
            const result = await runner.runTask(task);
            if (result && typeof result === 'object' && result.message) {
                await ctx.reply(result.message);
                if (result.imagePath) {
                    await ctx.replyWithPhoto({ source: result.imagePath });
                    // try to cleanup screenshot
                    await fs.unlink(result.imagePath).catch(() => { });
                }
            } else if (typeof result === 'string') {
                await ctx.reply(result);
            } else if (result === true) {
                await ctx.reply('daily_routine finished successfully.');
            } else {
                await ctx.reply('daily_routine finished successfully.');
            }
        } catch (e) {
            ctx.reply(`daily_routine failed: ${e && e.message ? e.message : e}`);
        }
    });

    adminBot.command('run_quiz_now', async (ctx) => {
        logger.info('User requested to run today_quiz now', { from: ctx.from.username });
        const task = taskRegistry.getByName('today_quiz');
        if (!task) {
            logger.error('today_quiz task not found, cannot run');
            return ctx.reply('today_quiz task not found!');
        }

        try {
            await ctx.reply('Starting today_quiz...');
            const result = await runner.runTask(task);
            if (result && typeof result === 'object' && result.message) {
                await ctx.reply(result.message);
                if (result.imagePath) {
                    await ctx.replyWithPhoto({ source: result.imagePath });
                    await fs.unlink(result.imagePath).catch(() => { });
                }
            } else if (typeof result === 'string') {
                await ctx.reply(result);
            } else if (result === true) {
                await ctx.reply('today_quiz finished successfully.');
            } else {
                await ctx.reply('today_quiz finished successfully.');
            }
        } catch (e) {
            ctx.reply(`today_quiz failed: ${e && e.message ? e.message : e}`);
        }
    });

    adminBot.command('broadcast_today_links', async (ctx) => {
        logger.info('Admin requested to broadcast today_links', { from: ctx.from.username });
        const task = taskRegistry.getByName('today_links');
        if (!task) {
            logger.error('today_links task not found, cannot run broadcast');
            return ctx.reply('today_links task not found!');
        }

        try {
            await ctx.reply('Running today_links and broadcasting to channel...');
            const result = await runner.runTask(task);
            if (result && result.message) {
                const { sendNotificationToChannel } = require('./modules/utils');
                await sendNotificationToChannel(result.message);
                await ctx.reply('Broadcast successful.');
            } else {
                await ctx.reply('Task ran, but no message was produced to broadcast.');
            }
        } catch (e) {
            ctx.reply(`Broadcast failed: ${e && e.message ? e.message : e}`);
        }
    });

    // Help command for admin bot
    adminBot.command('help', (ctx) => {
        const message = `사용 가능한 명령어:

- /schedules: 스케줄된 작업 목록을 확인합니다.
- /run_routine_now: 즉시 daily_routine 작업을 실행합니다.
- /run_quiz_now: 즉시 오늘의 퀴즈 작업(today_quiz)을 실행합니다.
- /broadcast_today_links: 즉시 오늘의 링크를 채널에 공지합니다.
- /inspect <url> <selector>: 지정한 URL에서 셀렉터에 해당하는 요소를 검사하고 스크린샷을 전송합니다.
- /5days_seminar_check: 향후 5일간의 세미나 일정을 확인합니다.
- /today_seminar_check: 오늘의 세미나를 확인합니다.
- /today_links: 오늘의 세미나 링크들과 오늘의 퀴즈 링크를 가져옵니다.
- /broadcast_today_links: 오늘의 링크를 채널에 공지합니다.

명령어 사용 예: /inspect https://example.com "div.article"`;
        ctx.reply(message);
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
        await ctx.reply('5일간의 세미나를 확인합니다...');
        const result = await runner.runTask(task);
        if (result && typeof result === 'object' && result.message) {
            await ctx.reply(result.message);
            if (result.imagePath) {
                await ctx.replyWithPhoto({ source: result.imagePath });
                await fs.unlink(result.imagePath).catch(() => { });
            }
        } else if (typeof result === 'string') {
            await ctx.reply(result);
        } else if (result === true) {
            await ctx.reply('세미나 확인이 완료되었습니다.');
        } else {
            await ctx.reply('세미나 확인이 완료되었습니다.');
        }
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
        await ctx.reply('오늘의 세미나를 확인합니다...');
        const result = await runner.runTask(task);
        if (result && typeof result === 'object' && result.message) {
            await ctx.reply(result.message);
            if (result.imagePath) {
                await ctx.replyWithPhoto({ source: result.imagePath });
                await fs.unlink(result.imagePath).catch(() => { });
            }
        } else if (typeof result === 'string') {
            await ctx.reply(result);
        } else if (result === true) {
            await ctx.reply('세미나 확인이 완료되었습니다.');
        } else {
            await ctx.reply('세미나 확인이 완료되었습니다.');
        }
    } catch (e) {
        ctx.reply(`세미나 확인 중 오류 발생: ${e && e.message ? e.message : e}`);
    }
};

const todayLinks = async (ctx) => {
    logger.info('User requested to run today_links now', { from: ctx.from.username });
    const task = taskRegistry.getByName('today_links');
    if (!task) {
        logger.error('today_links task not found, cannot run');
        return ctx.reply('today_links task not found!');
    }

    try {
        await ctx.reply('오늘의 링크를 수집합니다...');
        const result = await runner.runTask(task);
        if (result && typeof result === 'object' && result.message) {
            await ctx.reply(result.message);
        } else if (typeof result === 'string') {
            await ctx.reply(result);
        } else if (result === true) {
            await ctx.reply('작업이 완료되었습니다.');
        } else {
            await ctx.reply('작업이 완료되었습니다.');
        }
    } catch (e) {
        ctx.reply(`링크 수집 중 오류 발생: ${e && e.message ? e.message : e}`);
    }
};

if (adminBot) {
    adminBot.command('5days_seminar_check', seminarCheck5Days);
    adminBot.command('today_seminar_check', seminarCheckToday);
    adminBot.command('today_links', todayLinks);
}
if (noticeBot) {
    noticeBot.command('5days_seminar_check', seminarCheck5Days);
    noticeBot.command('today_seminar_check', seminarCheckToday);
    noticeBot.command('today_links', todayLinks);
}

// Help command for notice bot (limited)
if (noticeBot) {
    noticeBot.command('help', (ctx) => {
        const message = `사용 가능한 명령어:

- /5days_seminar_check: 향후 5일간의 세미나 일정을 확인합니다.
- /today_seminar_check: 오늘의 세미나를 확인합니다.
- /today_links: 오늘의 세미나 링크들과 오늘의 퀴즈 링크를 가져옵니다.`;
        ctx.reply(message);
    });
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
