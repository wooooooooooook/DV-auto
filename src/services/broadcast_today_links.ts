import dns from 'dns';
import dotenv from 'dotenv';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import * as utils from '../modules/utils';
import * as todayLinksTask from '../tasks/today_links';
import type { SeminarTaskData } from '../tasks/today_links';
import * as telegram from './telegram';
import * as storage from './storage';

dns.setDefaultResultOrder('ipv4first');
dotenv.config();

function ensureEnv(varName: 'DV_USER' | 'DV_PASS' | 'NOTICE_BOT_TOKEN' | 'NOTICE_CHANNEL_ID'): void {
  if (!process.env[varName]) {
    console.error(`broadcast_today_links: ${varName} is not set.`);
    process.exit(1);
  }
}

const TODAY_SEMINAR_KEY = 'today_seminars';
const seoulDateString = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

function saveSeminarIds(seminarData: SeminarTaskData | undefined): void {
  const data = seminarData || {
    date: seoulDateString(),
    lunchSeminarIds: [],
    dinnerSeminarIds: [],
    allSeminarIds: [],
  };
  const normalized = {
    date: data.date || seoulDateString(),
    lunchSeminarIds: Array.from(new Set((data.lunchSeminarIds || []).filter(Boolean))),
    dinnerSeminarIds: Array.from(new Set((data.dinnerSeminarIds || []).filter(Boolean))),
  };
  storage.set(TODAY_SEMINAR_KEY, normalized);
}

async function main(): Promise<void> {
  ensureEnv('DV_USER');
  ensureEnv('DV_PASS');
  ensureEnv('NOTICE_BOT_TOKEN');
  ensureEnv('NOTICE_CHANNEL_ID');

  const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    telegram.launch();
  } catch (e) {
    console.error('broadcast_today_links: Failed to launch Telegram bot:', e);
  }

  try {
    browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    await utils.ensureLoggedIn({ page, context });
    const linksResult = await todayLinksTask.run({ page, context });
    const seminarData = (linksResult as { seminarData?: SeminarTaskData }).seminarData;
    saveSeminarIds(seminarData);

    if (
      linksResult &&
      (linksResult as { success?: boolean }).success !== false &&
      (linksResult as { message?: string }).message
    ) {
      const messageOptions = (linksResult as { options?: Record<string, unknown> }).options ?? {};
      await utils.sendNotificationToChannel((linksResult as { message: string }).message, null, messageOptions);
      console.log('broadcast_today_links: successfully broadcasted message from today_links.');
      return;
    }

    console.warn('broadcast_today_links: task ran, but no message was produced to broadcast.');
    process.exitCode = 1;
  } catch (e) {
    console.error('broadcast_today_links: failed to broadcast today_links.', e);
    process.exitCode = 1;
  } finally {
    if (context) {
      try {
        await context.close();
      } catch (e) {
        console.error('broadcast_today_links: Error closing context:', e);
      }
    }

    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('broadcast_today_links: Error closing browser:', e);
      }
    }

    try {
      telegram.stop();
    } catch (e) {
      console.error('broadcast_today_links: Failed to stop Telegram bot:', e);
    }
  }
}

main().catch((e) => {
  console.error('broadcast_today_links: Script terminated with unhandled error:', e);
  process.exit(1);
});
