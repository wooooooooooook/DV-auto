
const { Telegraf } = require('telegraf');
const logger = require('./logger');
const scheduler = require('./scheduler');

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


function launch() {
    if (!BOT_TOKEN) return;
    bot.launch();
    logger.info('Telegram bot started');
}

module.exports = {
    bot,
    launch
};
