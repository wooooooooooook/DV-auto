const cron = require('node-cron');
const logger = require('./logger');
const runner = require('./runner');

function scheduleTaskCron(task) {
    if (!task || !task.schedule) throw new Error('task.schedule is required for cron scheduling');
    const opts = { scheduled: true };
    // Allow explicit timezone on the task, or fall back to process TZ env
    if (task.timezone) opts.timezone = task.timezone;
    else if (process.env.TZ) opts.timezone = process.env.TZ;

    const job = cron.schedule(task.schedule, async () => {
        try {
            logger.info('scheduler: triggering task', task.name);
            await runner.runTask(task);
        } catch (e) {
            logger.error('scheduler: task error', task.name, e && e.stack ? e.stack : e);
        }
    }, opts);
    return job;
}

module.exports = { scheduleTaskCron };
