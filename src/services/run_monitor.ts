import dns from 'dns';
import dotenv from 'dotenv';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import * as utils from '../modules/utils';
import * as telegram from './telegram';
import * as monitorLunchTask from '../tasks/monitor_lunch_seminars';
import * as monitorDinnerTask from '../tasks/monitor_dinner_seminars';

dns.setDefaultResultOrder('ipv4first');
dotenv.config();

type MonitorTaskKey = 'lunch' | 'dinner';

const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';
const MONITOR_TASKS: Record<MonitorTaskKey, typeof monitorLunchTask> = {
  lunch: monitorLunchTask,
  dinner: monitorDinnerTask,
};

function ensureEnv(varName: 'DV_USER' | 'DV_PASS'): void {
  if (!process.env[varName]) {
    console.error(`run_monitor: ${varName} is not set.`);
    process.exit(1);
  }
}

async function runMonitor(taskKey: MonitorTaskKey): Promise<void> {
  ensureEnv('DV_USER');
  ensureEnv('DV_PASS');

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    telegram.launch();
  } catch (e) {
    console.error('run_monitor: Failed to launch Telegram bot:', e);
  }

  try {
    browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await utils.ensureLoggedIn({ page, context });
    const result = await MONITOR_TASKS[taskKey].run({ page, context });
    if (result === false) {
      console.error(`run_monitor: ${taskKey} monitor returned false (failure).`);
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(`run_monitor: Unhandled error while running ${taskKey} monitor:`, e);
    process.exitCode = 1;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch (e) {
        console.error('run_monitor: Error closing context:', e);
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('run_monitor: Error closing browser:', e);
      }
    }
    try {
      telegram.stop();
    } catch (e) {
      console.error('run_monitor: Failed to stop Telegram bot:', e);
    }
  }
}

const taskKey = process.argv[2];
if (taskKey !== 'lunch' && taskKey !== 'dinner') {
  console.error('Usage: ts-node src/services/run_monitor.ts <lunch|dinner>');
  process.exit(1);
}

runMonitor(taskKey as MonitorTaskKey).catch((e) => {
  console.error('run_monitor: Fatal error:', e);
  process.exit(1);
});
