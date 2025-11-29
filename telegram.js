
const { Telegraf } = require('telegraf');
const https = require('https');
const { setBot } = require('./bot_instance');
const logger = require('./logger');
const scheduler = require('./scheduler');
const runner = require('./runner');
const taskRegistry = require('./taskRegistry');
const { inspect } = require('./modules/inspect');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN is not set. The Telegram bot will not be initialized.');
}

// Force IPv4 for Telegram API requests to work around network issues
const ipv4Agent = new https.Agent({ family: 4 });

const bot = new Telegraf(BOT_TOKEN, {
    telegram: {
        agent: ipv4Agent
    }
});
setBot(bot);

bot.start((ctx) => ctx.reply('Welcome!'));

bot.command('schedules', (ctx) => {
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

bot.command('run_routine_now', async (ctx) => {
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

bot.command('inspect', async (ctx) => {
    logger.info('User requested to inspect a page', { from: ctx.from.username });
    const args = ctx.message.text.split(' ').slice(1);
    if (args.length < 2) {
        return ctx.reply('Usage: /inspect <url> <selector>');
    }
    const url = args[0];
    const selector = args.slice(1).join(' ');

    try {
        ctx.reply(`Inspecting ${url} with selector "${selector}"...`);
        const result = await inspect(url, selector);
        let message = `Found ${result.count} elements matching selector "${selector}".\n\n`;
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
        ctx.reply(message);
    } catch (e) {
        ctx.reply(`Error inspecting ${url}: ${e && e.message ? e.message : e}`);
    }
});


function launch() {
    if (!BOT_TOKEN) return;
    bot.launch();
    logger.info('Telegram bot started');
}

module.exports = {
    launch
};
