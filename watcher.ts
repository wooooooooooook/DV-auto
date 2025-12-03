import type { BrowserContext } from 'playwright';
import * as logger from './logger';
import { sleep } from './modules/utils';

interface MonitorTaskModule {
  run: (ctx: { page: any; context: BrowserContext }, options?: Record<string, unknown>) => Promise<unknown> | unknown;
}

/**
 * startMonitor wraps a task module's existing run method in a managed page loop.
 * It's intentionally simple: it opens a new page from the provided context and
 * calls task.run(page, context, env, options). If persistent=true, it will
 * restart on error after a delay.
 */
async function startMonitor(
  taskModule: MonitorTaskModule,
  context: BrowserContext,
  _env: Record<string, unknown> = {},
  options: { persistent?: boolean; restartDelayMs?: number } = {},
): Promise<unknown> {
  const persistent = !!options.persistent;
  const restartDelayMs = options.restartDelayMs ?? 5000;

  async function oneRun(): Promise<void> {
    const page = await context.newPage();
    try {
      logger.info('watcher: starting task', taskModule && taskModule.run ? taskModule.run.name || 'task' : 'task');
      // taskModule.run expects ({page, context}, options)
      const res = await taskModule.run({ page, context }, options);
      logger.info('watcher: task finished', res === undefined ? '' : String(res));
    } finally {
      try {
        await page.close();
      } catch (_e) {
        // ignore
      }
    }
  }

  if (!persistent) {
    // single-run monitor
    return oneRun();
  }

  // persistent monitor: loop forever, restart on errors
  while (true) {
    try {
      await oneRun();
      logger.info('watcher: run completed, restarting because persistent=true');
    } catch (_e) {
      logger.error('watcher: error during monitor run', _e && (typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e));
    }
    await sleep(restartDelayMs);
  }
}

export { startMonitor };
