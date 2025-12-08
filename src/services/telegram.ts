import { Telegraf, type Context } from 'telegraf';
import fs from 'fs/promises';
import https from 'https';
import path from 'path';
import { setBot } from './bot_instance';
import * as logger from './logger';
import * as scheduler from '../core/scheduler';
import * as runner from '../core/runner';
import * as taskRegistry from '../core/taskRegistry';
import { inspect } from '../modules/inspect';
import { sendNotificationToChannel } from '../modules/utils';

const ADMIN_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const NOTICE_BOT_TOKEN = process.env.NOTICE_BOT_TOKEN;
const QUIZ_DATA_PATH = path.join(process.cwd(), 'data/quiz.json');

type QuizMapping = Record<string, Array<string | number>>;

async function loadQuizData(): Promise<QuizMapping> {
  try {
    const raw = await fs.readFile(QUIZ_DATA_PATH, 'utf8');
    return JSON.parse(raw) as QuizMapping;
  } catch (error) {
    logger.error('퀴즈 데이터 로드 실패', error);
    throw new Error('퀴즈 데이터 파일을 읽을 수 없습니다.');
  }
}

async function saveQuizData(data: QuizMapping): Promise<void> {
  try {
    await fs.writeFile(QUIZ_DATA_PATH, `${JSON.stringify(data, null, 4)}\n`, 'utf8');
  } catch (error) {
    logger.error('퀴즈 데이터 저장 실패', error);
    throw new Error('퀴즈 데이터 파일을 저장할 수 없습니다.');
  }
}

function parseQuizAnswers(answerText: string): Array<string | number> {
  try {
    const parsed = JSON.parse(answerText);
    if (!Array.isArray(parsed)) {
      throw new Error('배열 형식이 아닙니다.');
    }
    return parsed.map((item) => {
      const num = Number(item);
      return Number.isNaN(num) ? item : num;
    });
  } catch (_e) {
    const parts = answerText
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (!parts.length) {
      throw new Error('정답 배열을 해석할 수 없습니다. 예) [1,2,3] 또는 1,2,3');
    }
    return parts.map((part) => {
      const num = Number(part);
      return Number.isNaN(num) ? part : num;
    });
  }
}

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
    tasks.forEach((task) => {
      message += `Name: ${task.name}\n`;
      message += `Schedule: ${task.schedule}\n`;
      message += `Timezone: ${task.timezone}\n\n`;
    });

    ctx.reply(message);
  });

  adminBot.command('run_routine_now', async (ctx) => {
    logger.info('User requested to run daily_routine now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('daily_routine');
    if (!task) {
      logger.error('daily_routine task not found, cannot run');
      return ctx.reply('daily_routine task not found!');
    }

    try {
      await ctx.reply('Starting daily_routine...');
      const result = await runner.runTask(task);
      if (result && typeof result === 'object' && (result as { message?: string }).message) {
        await ctx.reply(
          (result as { message: string }).message,
          (result as { options?: Record<string, unknown> }).options,
        );
        if ((result as { imagePath?: string }).imagePath) {
          await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
          await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
        }
      } else if (typeof result === 'string') {
        await ctx.reply(result);
      } else if (result === true) {
        await ctx.reply('daily_routine finished successfully.');
      } else {
        await ctx.reply('daily_routine finished successfully.');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`daily_routine failed: ${message}`);
    }
  });

  adminBot.command('run_quiz_now', async (ctx) => {
    logger.info('User requested to run today_quiz now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('today_quiz');
    if (!task) {
      logger.error('today_quiz task not found, cannot run');
      return ctx.reply('today_quiz task not found!');
    }

    try {
      await ctx.reply('Starting today_quiz...');
      const result = await runner.runTask(task);
      if (result && typeof result === 'object' && (result as { message?: string }).message) {
        await ctx.reply(
          (result as { message: string }).message,
          (result as { options?: Record<string, unknown> }).options,
        );
        if ((result as { imagePath?: string }).imagePath) {
          await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
          await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
        }
      } else if (typeof result === 'string') {
        await ctx.reply(result);
      } else if (result === true) {
        await ctx.reply('today_quiz finished successfully.');
      } else {
        await ctx.reply('today_quiz finished successfully.');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`today_quiz failed: ${message}`);
    }
  });

  adminBot.command('add_quiz_answer', async (ctx) => {
    logger.info('User requested to add quiz answer', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const args = messageText.split(' ').slice(1);

    if (args.length < 2) {
      return ctx.reply('사용법: /add_quiz_answer <제품명> <정답 배열(JSON)>\n예) /add_quiz_answer 시너지아정 [1,2,3]');
    }

    const productName = args[0];
    const answerText = args.slice(1).join(' ');

    let answers: Array<string | number>;
    try {
      answers = parseQuizAnswers(answerText);
      if (!answers.length) {
        throw new Error('정답 배열이 비어있습니다.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return ctx.reply(`정답 배열을 해석하지 못했습니다. ${message}`);
    }

    try {
      const data = await loadQuizData();
      data[productName] = answers;
      await saveQuizData(data);

      await ctx.reply(`퀴즈 정답이 등록되었습니다.\n제품: ${productName}\n정답: ${JSON.stringify(answers)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('퀴즈 정답 등록 실패', error);
      await ctx.reply(`퀴즈 정답을 저장하지 못했습니다: ${message}`);
    }
  });

  adminBot.command('broadcast_today_links', async (ctx) => {
    logger.info('Admin requested to broadcast today_links', { from: ctx.from?.username });
    const task = taskRegistry.getByName('today_links');
    if (!task) {
      logger.error('today_links task not found, cannot run broadcast');
      return ctx.reply('today_links task not found!');
    }

    try {
      await ctx.reply('Running today_links and broadcasting to channel...');
      const result = await runner.runTask(task);
      if (result && (result as { message?: string }).message) {
        await sendNotificationToChannel(
          (result as { message: string }).message,
          null,
          (result as { options?: Record<string, unknown> }).options,
        );
        await ctx.reply('Broadcast successful.');
      } else {
        await ctx.reply('Task ran, but no message was produced to broadcast.');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`Broadcast failed: ${message}`);
    }
  });

  adminBot.command('naverpay_point_exchange', async (ctx) => {
    logger.info('User requested to run naverpay_point_exchange now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('네이버페이포인트교환');
    if (!task) {
      logger.error('네이버페이포인트교환 task not found, cannot run');
      return ctx.reply('네이버페이포인트교환 task not found!');
    }

    try {
      await ctx.reply('네이버페이포인트교환 작업을 시작합니다...');
      const result = await runner.runTask(task);
      if (result && typeof result === 'object' && (result as { message?: string }).message) {
        await ctx.reply(
          (result as { message: string }).message,
          (result as { options?: Record<string, unknown> }).options,
        );
        if ((result as { imagePath?: string }).imagePath) {
          await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
          await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
        }
      } else if (typeof result === 'string') {
        await ctx.reply(result);
      } else if (result === true) {
        await ctx.reply('네이버페이포인트교환 작업이 완료되었습니다.');
      } else {
        await ctx.reply('네이버페이포인트교환 작업이 완료되었습니다.');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`네이버페이포인트교환 실패: ${message}`);
    }
  });

  adminBot.command('help', (ctx) => {
    const message = `사용 가능한 명령어:

- /schedules: 스케줄된 작업 목록을 확인합니다.
- /run_routine_now: 즉시 daily_routine 작업을 실행합니다.
- /run_quiz_now: 즉시 오늘의 퀴즈 작업(today_quiz)을 실행합니다.
- /naverpay_point_exchange: 네이버페이포인트교환 작업을 실행합니다.
- /add_quiz_answer: 오늘의 퀴즈 정답을 등록합니다. 예) /add_quiz_answer 시너지아정 [1,2,3]
- /broadcast_today_links: 즉시 오늘의 링크를 채널에 공지합니다.
- /inspect <url> <selector> [waitUntil]: 지정한 URL에서 셀렉터에 해당하는 요소를 검사하고 스크린샷을 전송합니다. (waitUntil: load, domcontentloaded, networkidle, commit)
- /5days_seminar_check: 향후 5일간의 세미나 일정을 확인합니다.
- /today_links: 오늘의 세미나와 퀴즈 링크, 출석 링크를 한 번에 가져옵니다.
- /broadcast_today_links: 오늘의 링크를 채널에 공지합니다.
- /monitor_lunch_seminar_now: 즉시 점심 세미나 모니터링을 시작합니다.
- /monitor_dinner_seminar_now: 즉시 저녁 세미나 모니터링을 시작합니다.

명령어 사용 예: /inspect https://example.com "div.article" networkidle`;
    ctx.reply(message);
  });

  adminBot.command('monitor_lunch_seminar_now', async (ctx) => {
    logger.info('User requested to run monitor_lunch_seminars now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('monitor_lunch_seminars');
    if (!task) {
      logger.error('monitor_lunch_seminars task not found, cannot run');
      return ctx.reply('monitor_lunch_seminars task not found!');
    }

    try {
      await ctx.reply('Starting monitor_lunch_seminars...');
      const result = await runner.runTask(task);
      if (result && typeof result === 'object' && (result as { message?: string }).message) {
        await ctx.reply(
          (result as { message: string }).message,
          (result as { options?: Record<string, unknown> }).options,
        );
        if ((result as { imagePath?: string }).imagePath) {
          await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
          await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
        }
      } else if (typeof result === 'string') {
        await ctx.reply(result);
      } else if (result === true) {
        await ctx.reply('monitor_lunch_seminars finished successfully.');
      } else {
        await ctx.reply('monitor_lunch_seminars finished successfully.');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`monitor_lunch_seminars failed: ${message}`);
    }
  });

  adminBot.command('monitor_dinner_seminar_now', async (ctx) => {
    logger.info('User requested to run monitor_dinner_seminars now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('monitor_dinner_seminars');
    if (!task) {
      logger.error('monitor_dinner_seminars task not found, cannot run');
      return ctx.reply('monitor_dinner_seminars task not found!');
    }

    try {
      await ctx.reply('Starting monitor_dinner_seminars...');
      const result = await runner.runTask(task);
      if (result && typeof result === 'object' && (result as { message?: string }).message) {
        await ctx.reply(
          (result as { message: string }).message,
          (result as { options?: Record<string, unknown> }).options,
        );
        if ((result as { imagePath?: string }).imagePath) {
          await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
          await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
        }
      } else if (typeof result === 'string') {
        await ctx.reply(result);
      } else if (result === true) {
        await ctx.reply('monitor_dinner_seminars finished successfully.');
      } else {
        await ctx.reply('monitor_dinner_seminars finished successfully.');
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`monitor_dinner_seminars failed: ${message}`);
    }
  });

  adminBot.command('inspect', async (ctx) => {
    logger.info('User requested to inspect a page', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const args = messageText.split(' ').slice(1);

    if (args.length < 2) {
      return ctx.reply('Usage: /inspect <url> <selector> [waitUntil]');
    }

    const url = args[0];
    let selector: string;
    let waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' | undefined;

    const lastArg = args[args.length - 1];
    const validWaitUntil = ['load', 'domcontentloaded', 'networkidle', 'commit'];

    if (args.length > 2 && validWaitUntil.includes(lastArg)) {
      waitUntil = lastArg as 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
      selector = args.slice(1, args.length - 1).join(' ');
    } else {
      selector = args.slice(1).join(' ');
    }

    // Remove quotes from selector if present
    if ((selector.startsWith('"') && selector.endsWith('"')) || (selector.startsWith("'") && selector.endsWith("'"))) {
      selector = selector.substring(1, selector.length - 1);
    }

    let screenshotPath: string | null = null;

    try {
      ctx.reply(`Inspecting ${url} with selector "${selector}"... (waitUntil: ${waitUntil || 'load'})`);
      const result = await inspect(url, selector, { waitUntil });
      screenshotPath = result.screenshotPath;
      let message = `Found ${result.count} elements matching selector "${selector}".\n\n`;

      if (result.warnings && result.warnings.length > 0) {
        message += 'Warnings:\n';
        result.warnings.forEach((warning) => {
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
          if (element.selectorPath) message += `  - Selector Path: ${element.selectorPath}\n`;

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
      if (e instanceof Error && e.message.includes('Timeout')) {
        errorMessage = `Navigation timeout: The page at ${url} took too long to load or was unreachable.`;
      } else if (e instanceof Error) {
        errorMessage += `\nDetails: ${e.message}`;
      }
      ctx.reply(errorMessage);
    } finally {
      if (screenshotPath) {
        await fs
          .unlink(screenshotPath)
          .catch((err) => logger.error(`Failed to delete screenshot: ${screenshotPath}`, err));
      }
    }
  });
}

// --- Shared Commands ---
const seminarCheck5Days = async (ctx: Context) => {
  logger.info('User requested to run 5days_seminar_check now', { from: ctx.from?.username });
  const task = taskRegistry.getByName('5days_seminar_check');
  if (!task) {
    logger.error('5days_seminar_check task not found, cannot run');
    return ctx.reply('5days_seminar_check task not found!');
  }

  try {
    await ctx.reply('5일간의 세미나를 확인합니다...');
    const result = await runner.runTask(task);
    if (result && typeof result === 'object' && (result as { message?: string }).message) {
      await ctx.reply(
        (result as { message: string }).message,
        (result as { options?: Record<string, unknown> }).options,
      );
      if ((result as { imagePath?: string }).imagePath) {
        await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
        await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
      }
    } else if (typeof result === 'string') {
      await ctx.reply(result);
    } else if (result === true) {
      await ctx.reply('세미나 확인이 완료되었습니다.');
    } else {
      await ctx.reply('세미나 확인이 완료되었습니다.');
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.reply(`세미나 확인 중 오류 발생: ${message}`);
  }
};

const todayLinks = async (ctx: Context) => {
  logger.info('User requested to run today_links now', { from: ctx.from?.username });
  const task = taskRegistry.getByName('today_links');
  if (!task) {
    logger.error('today_links task not found, cannot run');
    return ctx.reply('today_links task not found!');
  }

  try {
    await ctx.reply('오늘의 링크를 수집합니다...');
    const result = await runner.runTask(task);
    if (result && typeof result === 'object' && (result as { message?: string }).message) {
      await ctx.reply(
        (result as { message: string }).message,
        (result as { options?: Record<string, unknown> }).options,
      );
    } else if (typeof result === 'string') {
      await ctx.reply(result);
    } else if (result === true) {
      await ctx.reply('작업이 완료되었습니다.');
    } else {
      await ctx.reply('작업이 완료되었습니다.');
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.reply(`링크 수집 중 오류 발생: ${message}`);
  }
};

if (adminBot) {
  adminBot.command('5days_seminar_check', seminarCheck5Days);
  adminBot.command('today_links', todayLinks);
}

if (noticeBot) {
  noticeBot.command('5days_seminar_check', seminarCheck5Days);
  noticeBot.command('today_links', todayLinks);
}

// Help command for notice bot (limited)
if (noticeBot) {
  noticeBot.command('help', (ctx) => {
    const message = `사용 가능한 명령어:

- /5days_seminar_check: 향후 5일간의 세미나 일정을 확인합니다.
- /today_links: 오늘의 세미나와 퀴즈 링크, 출석 링크를 한 번에 가져옵니다.`;
    ctx.reply(message);
  });
}

function launch(): void {
  if (adminBot) {
    adminBot.launch();
    logger.info('Admin bot started');
  }
  if (noticeBot) {
    noticeBot.launch();
    logger.info('Notice bot started');
  }
}

function stop(): void {
  if (adminBot) {
    adminBot.stop();
    logger.info('Admin bot stopped');
  }
  if (noticeBot) {
    noticeBot.stop();
    logger.info('Notice bot stopped');
  }
}

export { launch, stop };
