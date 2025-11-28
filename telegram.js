
const { Telegraf } = require('telegraf');
const logger = require('./logger');
const scheduler = require('./scheduler');
const runner = require('./runner');
const taskRegistry = require('./taskRegistry');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
    logger.warn('TELEGRAM_BOT_TOKEN is not set. The Telegram bot will not be initialized.');
}

const bot = new Telegraf(BOT_TOKEN);

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

bot.command('run-routine-now', async (ctx) => {
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


function launch() {
    if (!BOT_TOKEN) return;
    bot.launch();
    logger.info('Telegram bot started');
}

module.exports = {
    bot,
    launch
};
