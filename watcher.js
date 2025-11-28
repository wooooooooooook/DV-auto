const logger = require('./logger');
const { sleep } = require('./modules/utils');
const runner = require('./runner');

/**
 * startMonitor wraps a task module's existing run method in a managed page loop.
 * It's intentionally simple: it opens a new page from the provided context and
 * calls task.run(page, context, env, options). If persistent=true, it will
 * restart on error after a delay.
 */
async function startMonitor(taskModule, context, env = {}, options = {}) {
    const persistent = !!options.persistent;
    const restartDelayMs = options.restartDelayMs || 5000;

    async function _oneRun() {
        const page = await context.newPage();
        try {
            logger.info('watcher: starting task', taskModule && taskModule.run ? taskModule.run.name || 'task' : 'task');
            // taskModule.run expects ({page, context}, options)
            const res = await taskModule.run({ page, context }, options);
            logger.info('watcher: task finished', res === undefined ? '' : String(res));
        } finally {
            try { await page.close(); } catch (e) { }
        }
    }

    if (!persistent) {
        // single-run monitor
        return _oneRun();
    }

    // persistent monitor: loop forever, restart on errors
    while (true) {
        try {
            await _oneRun();
            logger.info('watcher: run completed, restarting because persistent=true');
        } catch (e) {
            logger.error('watcher: error during monitor run', e && e.stack ? e.stack : e);
        }
        await sleep(restartDelayMs);
    }
}

module.exports = { startMonitor };
