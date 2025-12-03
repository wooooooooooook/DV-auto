import dns from 'dns';
import dotenv from 'dotenv';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import * as utils from '../modules/utils';
import * as attendanceTask from '../tasks/attendance';
import * as applySeminarTask from '../tasks/apply_seminar';
import * as todayQuizTask from '../tasks/today_quiz';
import * as todayLinksTask from '../tasks/today_links';
import * as telegram from './telegram';

dns.setDefaultResultOrder('ipv4first');
dotenv.config();

async function main(): Promise<void> {
  console.log('macro.ts: Starting daily routine.');

  if (!process.env.DV_USER) {
    console.error('Error: ID environment variable is not set.');
    process.exit(1);
  }
  if (!process.env.DV_PASS) {
    console.error('Error: PASS environment variable is not set.');
    process.exit(1);
  }

  let TELEGRAM_ENABLED = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
  if (!TELEGRAM_ENABLED) {
    console.warn('macro.ts: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set. Telegram notifications will be skipped.');
  } else {
    console.log('macro.ts: Telegram notifications are enabled.');
    try {
      telegram.launch();
      console.log('macro.ts: Telegram bot launched successfully.');
    } catch (e) {
      console.error('macro.ts: Failed to launch Telegram bot:', e);
      TELEGRAM_ENABLED = false;
    }
  }

  const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
    context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    const tasks = [
      { name: 'attendance', task: attendanceTask },
      { name: 'apply_seminar', task: applySeminarTask },
      { name: 'today_quiz', task: todayQuizTask },
      { name: 'today_links', task: todayLinksTask },
    ];
    await utils.sendTelegram('🕗 데일리 루틴 작업을 시작합니다.(출석체크, 세미나등록, 브랜드퀴즈)').catch(() => { });
    for (const { name, task } of tasks) {
      try {
        console.log(`macro.ts: Running ${name} task.`);
        await utils.ensureLoggedIn({ page, context });
        const taskResult = await task.run({ page, context });
        if (
          taskResult &&
          typeof taskResult === 'object' &&
          (taskResult as { message?: string }).message &&
          TELEGRAM_ENABLED
        ) {
          await utils
            .sendTelegram(
              (taskResult as { message: string }).message,
              (taskResult as { imagePath?: string | null }).imagePath ?? null,
            )
            .catch((sendErr) => {
              console.error(`macro.ts: Failed to send Telegram message for ${name} task result:`, sendErr);
            });
        } else if (taskResult && typeof taskResult === 'object' && (taskResult as { message?: string }).message) {
          console.log(
            `macro.ts: Telegram is disabled, but ${name} task produced a message: ${(taskResult as { message: string }).message}`,
          );
        } else {
          console.log(`macro.ts: ${name} task completed successfully.`);
        }
      } catch (err) {
        console.error(`macro.ts: Error during ${name} task:`, err);
        const message = err instanceof Error ? err.message : String(err);
        if (TELEGRAM_ENABLED) {
          await utils.sendTelegram(`daily_routine 중 ${name} 작업 실패: ${message}`).catch((sendErr) => {
            console.error('macro.ts: Failed to send Telegram error notification:', sendErr);
          });
        }
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('macro.ts: Unhandled error in main routine:', e);
    if (TELEGRAM_ENABLED) {
      await utils.sendTelegram(`daily_routine 실행 중 치명적인 오류 발생: ${message}`).catch((sendErr) => {
        console.error('macro.ts: Failed to send Telegram fatal error notification:', sendErr);
      });
    }
  } finally {
    await utils.sendTelegram('🕗 데일리 루틴 작업이 종료되었습니다.').catch(() => { });
    if (context) {
      try {
        await context.close();
      } catch (e) {
        console.error('macro.ts: Error closing context:', e);
      }
    }
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.error('macro.ts: Error closing browser:', e);
      }
    }
    if (TELEGRAM_ENABLED) {
      try {
        telegram.stop();
        console.log('macro.ts: Telegram bot stopped successfully.');
      } catch (e) {
        console.error('macro.ts: Failed to stop Telegram bot:', e);
      }
    }
    console.log('macro.ts: Daily routine finished.');
  }
}

main().catch((e) => {
  console.error('macro.ts: Script terminated with unhandled error:', e);
  process.exit(1);
});
