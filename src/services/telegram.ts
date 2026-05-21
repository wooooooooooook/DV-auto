import { Telegraf, type Context } from 'telegraf';
import { exec } from 'child_process';
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
const QUIZ_DATA_FILE = 'data/quiz.json';
const SEMINAR_QUIZ_CHEATSHEET_FILE = 'data/seminar_quiz_cheatsheet.json';
const QUIZ_DATA_PATH = path.join(process.cwd(), QUIZ_DATA_FILE);
const SEMINAR_QUIZ_CHEATSHEET_PATH = path.join(process.cwd(), SEMINAR_QUIZ_CHEATSHEET_FILE);

type QuizMapping = Record<string, Array<string | number>>;
type SeminarQuizCheatsheet = Record<string, string>;
type CommandResult = { stdout: string; stderr: string };
type CommandResultWithExitCode = CommandResult & { exitCode?: number };

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

function truncateMessage(text: string, maxLength = 3500): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}... (truncated)`;
}

function runShellCommand(command: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const wrappedError = new Error(error.message);
        (wrappedError as Error & { stdout?: string; stderr?: string }).stdout = stdout;
        (wrappedError as Error & { stdout?: string; stderr?: string }).stderr = stderr;
        return reject(wrappedError);
      }
      resolve({ stdout, stderr });
    });
  });
}

function runShellCommandWithAllowedExitCodes(
  command: string,
  allowedExitCodes: number[] = [],
): Promise<CommandResultWithExitCode> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const rawExitCode = (error as unknown as NodeJS.ErrnoException & { code?: number | string }).code;
        const exitCode = typeof rawExitCode === 'number' ? rawExitCode : Number.parseInt(String(rawExitCode), 10);
        if (!Number.isNaN(exitCode) && allowedExitCodes.includes(exitCode)) {
          return resolve({ stdout, stderr, exitCode });
        }
        const wrappedError = new Error(error.message);
        (wrappedError as Error & { stdout?: string; stderr?: string }).stdout = stdout;
        (wrappedError as Error & { stderr?: string }).stderr = stderr;
        return reject(wrappedError);
      }
      resolve({ stdout, stderr });
    });
  });
}

function buildShellArgs(values: string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "'\\''")}'`).join(' ');
}

async function commitAndPushIfChanged(
  files: string[],
  message: string,
): Promise<{ performed: boolean; notice: string }> {
  const fileArgs = buildShellArgs(files);
  const { stdout: statusOutput } = await runShellCommand(`git status --porcelain -- ${fileArgs}`);
  if (!statusOutput.trim()) {
    return { performed: false, notice: 'ℹ️ Git 변경사항 없음' };
  }

  await runShellCommand(`git add ${fileArgs}`);
  await runShellCommand(`git commit -m ${buildShellArgs([message])}`);
  const { stdout: pushStdout, stderr: pushStderr } = await runShellCommand('git push');

  let notice = '✅ Git 커밋/푸시 완료';
  if (pushStdout.trim() || pushStderr.trim()) {
    const output = `${pushStdout}${pushStderr}`.trim();
    notice = `${notice}\n${truncateMessage(output)}`;
  }
  return { performed: true, notice };
}

// --- Seminar Quiz Cheatsheet Functions ---
async function loadSeminarQuizCheatsheet(): Promise<SeminarQuizCheatsheet> {
  try {
    const raw = await fs.readFile(SEMINAR_QUIZ_CHEATSHEET_PATH, 'utf8');
    return JSON.parse(raw) as SeminarQuizCheatsheet;
  } catch (error) {
    logger.warn('세미나 퀴즈 족보 로드 실패, 빈 객체 반환', error);
    return {};
  }
}

async function saveSeminarQuizCheatsheet(data: SeminarQuizCheatsheet): Promise<void> {
  try {
    await fs.writeFile(SEMINAR_QUIZ_CHEATSHEET_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch (error) {
    logger.error('세미나 퀴즈 족보 저장 실패', error);
    throw new Error('세미나 퀴즈 족보 파일을 저장할 수 없습니다.');
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
  adminBot.catch((err, ctx) => {
    logger.error(`Admin Bot Error for ${ctx.updateType}`, err);
    ctx.reply('오류가 발생했습니다. 로그를 확인해주세요.').catch(() => {});
  });
  adminBot.start((ctx) => ctx.reply('Welcome, Admin!'));
}

if (noticeBot) {
  setBot('notice', noticeBot);
  noticeBot.catch((err, ctx) => {
    logger.error(`Notice Bot Error for ${ctx.updateType}`, err);
  });
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
      // Run in background to avoid timeout
      runner
        .runTask(task)
        .then(async (result) => {
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
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          ctx.reply(`daily_routine failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`Failed to start daily_routine: ${message}`);
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
      runner
        .runTask(task)
        .then(async (result) => {
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
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          ctx.reply(`today_quiz failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`Failed to start today_quiz: ${message}`);
    }
  });

  adminBot.command('refresh_seminar_point_exclusion', async (ctx) => {
    logger.info('User requested to refresh seminar point exclusion flags', { from: ctx.from?.username });
    const task = taskRegistry.getByName('refresh_seminar_point_exclusion');
    if (!task) {
      logger.error('refresh_seminar_point_exclusion task not found, cannot run');
      return ctx.reply('refresh_seminar_point_exclusion task not found!');
    }

    try {
      await ctx.reply('세미나 포인트미지급 여부를 전체 재확인합니다... (백그라운드 실행)');
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await ctx.reply(
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options,
            );
            const screenshotPaths = (result as { screenshotPaths?: string[] }).screenshotPaths || [];
            for (const screenshotPath of screenshotPaths) {
              await ctx.replyWithPhoto({ source: screenshotPath });
              await fs.unlink(screenshotPath).catch(() => {});
            }
          } else if (typeof result === 'string') {
            await ctx.reply(result);
          } else if (result === true) {
            await ctx.reply('세미나 포인트미지급 여부 재확인이 완료되었습니다.');
          } else {
            await ctx.reply('세미나 포인트미지급 여부 재확인이 완료되었습니다.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          ctx.reply(`세미나 포인트미지급 여부 재확인 실패: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`Failed to start 세미나 포인트미지급 여부 재확인: ${message}`);
    }
  });

  adminBot.command('apply_seminar_now', async (ctx) => {
    logger.info('User requested to run apply_seminar now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('apply_seminar');
    if (!task) {
      logger.error('apply_seminar task not found, cannot run');
      return ctx.reply('apply_seminar task not found!');
    }

    try {
      await ctx.reply('Starting apply_seminar... (백그라운드 실행)');
      runner
        .runTask(task)
        .then(async (result) => {
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
            await ctx.reply('apply_seminar finished successfully.');
          } else {
            await ctx.reply('apply_seminar finished successfully.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          ctx.reply(`apply_seminar failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`Failed to start apply_seminar: ${message}`);
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
      let gitNotice = '';
      try {
        const result = await commitAndPushIfChanged([QUIZ_DATA_FILE], 'update quiz data');
        gitNotice = `\n\n${result.notice}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('퀴즈 정답 Git 커밋/푸시 실패', error);
        gitNotice = `\n\n⚠️ Git 커밋/푸시 실패: ${message}`;
      }

      await ctx.reply(
        `퀴즈 정답이 등록되었습니다.\n제품: ${productName}\n정답: ${JSON.stringify(answers)}${gitNotice}`,
      );
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
      await ctx.reply('Running today_links and broadcasting to channel... (백그라운드 실행)');
      runner
        .runTask(task)
        .then(async (result) => {
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
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          ctx.reply(`Broadcast failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`Failed to start broadcast: ${message}`);
    }
  });

  adminBot.command('naverpay_point_exchange', async (ctx) => {
    logger.info('User requested to run naverpay_point_exchange now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('네이버페이포인트교환');
    if (!task) {
      logger.error('네이버페이포인트교환 task not found, cannot run');
      return ctx.reply('네이버페이포인트교환 task not found!');
    }

    const messageText = ctx.message?.text || '';
    const args = messageText.split(' ').slice(1);
    let attempts = 10;
    if (args.length > 0) {
      const parsedAttempts = parseInt(args[0], 10);
      if (!isNaN(parsedAttempts) && parsedAttempts > 0) {
        attempts = parsedAttempts;
      }
    }

    try {
      await ctx.reply(`네이버페이포인트교환 작업을 시작합니다... (${attempts}회 시도, 백그라운드 실행)`);
      // Run in background to avoid timeout
      runner
        .runTask(task, { maxIterations: attempts })
        .then(async (result) => {
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
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          ctx.reply(`네이버페이포인트교환 실패: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`Failed to start 네이버페이포인트교환: ${message}`);
    }
  });

  adminBot.command('baemin_point_exchange', async (ctx) => {
    logger.info('User requested to run baemin_point_exchange now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('배민포인트교환');
    if (!task) {
      logger.error('배민포인트교환 task not found, cannot run');
      return ctx.reply('배민포인트교환 task not found!');
    }

    const messageText = ctx.message?.text || '';
    const args = messageText.split(' ').slice(1);
    let attempts = 1;
    if (args.length > 0) {
      const parsedAttempts = parseInt(args[0], 10);
      if (!isNaN(parsedAttempts) && parsedAttempts > 0) {
        attempts = parsedAttempts;
      }
    }

    try {
      await ctx.reply(`배민포인트교환 작업을 시작합니다... (${attempts}회 시도, 백그라운드 실행)`);
      // Run in background to avoid timeout
      runner
        .runTask(task, { maxIterations: attempts })
        .then(async (result) => {
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
            await ctx.reply('배민포인트교환 작업이 완료되었습니다.');
          } else {
            await ctx.reply('배민포인트교환 작업이 완료되었습니다.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          ctx.reply(`배민포인트교환 실패: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`Failed to start 배민포인트교환: ${message}`);
    }
  });

  adminBot.command('check_point', async (ctx) => {
    logger.info('User requested to check point now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('check_point');
    if (!task) {
      logger.error('check_point task not found, cannot run');
      return ctx.reply('check_point task not found!');
    }

    try {
      await ctx.reply('포인트를 확인하는 중입니다... (백그라운드 실행)');
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            const msg = (result as { message: string }).message;
            const imagePath = (result as { imagePath?: string }).imagePath;
            if (imagePath) {
              await ctx.replyWithPhoto({ source: imagePath }, { caption: msg });
              await fs.unlink(imagePath).catch(() => {});
            } else {
              await ctx.reply(msg);
            }
          } else if (typeof result === 'string') {
            await ctx.reply(result);
          } else {
            await ctx.reply('포인트 확인 완료 (메시지 없음)');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          ctx.reply(`포인트 확인 실패: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`Failed to start check_point: ${message}`);
    }
  });

  adminBot.command('update_app', async (ctx) => {
    logger.info('User requested to run pnpm update:app', { from: ctx.from?.username });
    try {
      await ctx.reply(
        'Starting pnpm update:app... (백그라운드 실행)\n' +
          '⚠️ 업데이트 중 서비스가 재시작되어 봇 응답이 잠시 끊길 수 있습니다.',
      );
      runShellCommand('pnpm run update:app')
        .then(async ({ stdout, stderr }) => {
          let message = 'pnpm update:app 완료';
          if (stdout.trim()) {
            message += `\n\nstdout:\n${truncateMessage(stdout.trim())}`;
          }
          if (stderr.trim()) {
            message += `\n\nstderr:\n${truncateMessage(stderr.trim())}`;
          }
          await ctx.reply(message);
        })
        .catch(async (error) => {
          const message = error instanceof Error ? error.message : String(error);
          const stdout = (error as Error & { stdout?: string }).stdout ?? '';
          const stderr = (error as Error & { stderr?: string }).stderr ?? '';
          logger.error('pnpm update:app failed', error);
          let reply = `pnpm update:app 실패: ${message}`;
          if (stdout.trim()) {
            reply += `\n\nstdout:\n${truncateMessage(stdout.trim())}`;
          }
          if (stderr.trim()) {
            reply += `\n\nstderr:\n${truncateMessage(stderr.trim())}`;
          }
          await ctx.reply(reply);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`Failed to start pnpm update:app: ${message}`);
    }
  });

  adminBot.command('log', async (ctx) => {
    const messageText = ctx.message?.text || '';
    const args = messageText.split(' ').slice(1);

    let lineCount = 20; // 기본값
    if (args.length > 0) {
      const parsedCount = parseInt(args[0], 10);
      if (!isNaN(parsedCount) && parsedCount > 0) {
        lineCount = parsedCount;
      }
    }

    logger.info(`User requested to fetch recent ${lineCount} logs`, { from: ctx.from?.username });

    try {
      await ctx.reply(`최근 ${lineCount}개 로그를 불러옵니다... (최대 5초)`);

      const cmd = `journalctl --no-pager -u doctorville-auto.service -n ${lineCount}`;
      const { stdout, stderr, exitCode } = await runShellCommandWithAllowedExitCodes(`timeout 5s ${cmd}`, [124, 143]);

      let message = `로그 결과 (${lineCount}줄)`;
      if (exitCode) {
        message += ' (시간 제한으로 일부 로그만 표시됩니다)';
      }

      if (stdout.trim()) {
        // 불필요한 정보(예: 호스트명과 프로세스명) 제거
        // 원본 예시: Mar 04 00:51:55 CT105 env[48145]: [info] ...
        // 결과 예시: Mar 04 00:51:55 [info] ...
        const cleanedStdout = stdout
          .split('\n')
          .map((line) => line.replace(/([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+[^:]+:\s*/, '$1 '))
          .join('\n')
          .trim();

        message += `\n\nstdout:\n${cleanedStdout}`;
      }
      if (stderr.trim()) {
        message += `\n\nstderr:\n${stderr.trim()}`;
      }
      if (!stdout.trim() && !stderr.trim()) {
        message += '\n\n출력된 로그가 없습니다.';
      }
      await ctx.reply(truncateMessage(message));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error('log fetch failed', e);
      await ctx.reply(`로그 가져오기 실패: ${message}`);
    }
  });

  // --- Seminar Quiz Cheatsheet Commands ---
  adminBot.command('add_seminar_quiz', async (ctx) => {
    logger.info('User requested to add seminar quiz answer', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const argsText = messageText.replace(/^\/add_seminar_quiz\s*/, '');

    // Format: /add_seminar_quiz <키워드> | <정답>
    const parts = argsText.split('|').map((p) => p.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return ctx.reply(
        '사용법: /add_seminar_quiz <문제 키워드> | <정답 키워드>\n예) /add_seminar_quiz 펙수클루의 적응증이 아닌 | 과민성 대장증후군',
      );
    }

    const [keyword, answer] = parts;

    try {
      const data = await loadSeminarQuizCheatsheet();
      data[keyword] = answer;
      await saveSeminarQuizCheatsheet(data);
      let gitNotice = '';
      try {
        const result = await commitAndPushIfChanged([SEMINAR_QUIZ_CHEATSHEET_FILE], 'update seminar quiz cheatsheet');
        gitNotice = `\n\n${result.notice}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('세미나 퀴즈 족보 Git 커밋/푸시 실패', error);
        gitNotice = `\n\n⚠️ Git 커밋/푸시 실패: ${message}`;
      }

      await ctx.reply(`✅ 세미나 퀴즈 족보 등록 완료\n\n키워드: ${keyword}\n정답: ${answer}${gitNotice}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('세미나 퀴즈 족보 등록 실패', error);
      await ctx.reply(`❌ 족보 등록 실패: ${message}`);
    }
  });

  adminBot.command('list_seminar_quiz', async (ctx) => {
    logger.info('User requested to list seminar quiz cheatsheet', { from: ctx.from?.username });

    const messageText = ctx.message?.text || '';
    const searchKeyword = messageText.replace(/^\/list_seminar_quiz\s*/, '').trim();

    try {
      const data = await loadSeminarQuizCheatsheet();
      let entries = Object.entries(data);

      if (searchKeyword) {
        entries = entries.filter(([k, a]) => k.includes(searchKeyword) || String(a).includes(searchKeyword));
      }

      if (entries.length === 0) {
        if (searchKeyword) {
          return ctx.reply(`📋 "${searchKeyword}" 검색 결과가 없습니다.`);
        } else {
          return ctx.reply('📋 등록된 세미나 퀴즈 족보가 없습니다.');
        }
      }

      let message = searchKeyword
        ? `📋 "${searchKeyword}" 검색 결과 (${entries.length}개)\n\n`
        : `📋 세미나 퀴즈 족보 (${entries.length}개)\n\n`;

      for (const [keyword, answer] of entries) {
        message += `• ${keyword} → ${answer}\n`;
      }

      await ctx.reply(truncateMessage(message));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ 족보 조회 실패: ${message}`);
    }
  });

  adminBot.command('delete_seminar_quiz', async (ctx) => {
    logger.info('User requested to delete seminar quiz answer', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const keyword = messageText.replace(/^\/delete_seminar_quiz\s*/, '').trim();

    if (!keyword) {
      return ctx.reply('사용법: /delete_seminar_quiz <문제 키워드>\n예) /delete_seminar_quiz 펙수클루의 적응증이 아닌');
    }

    try {
      const data = await loadSeminarQuizCheatsheet();
      if (!(keyword in data)) {
        return ctx.reply(`❌ 해당 키워드가 족보에 없습니다: ${keyword}`);
      }

      const deletedAnswer = data[keyword];
      delete data[keyword];
      await saveSeminarQuizCheatsheet(data);
      let gitNotice = '';
      try {
        const result = await commitAndPushIfChanged([SEMINAR_QUIZ_CHEATSHEET_FILE], 'update seminar quiz cheatsheet');
        gitNotice = `\n\n${result.notice}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('세미나 퀴즈 족보 삭제 Git 커밋/푸시 실패', error);
        gitNotice = `\n\n⚠️ Git 커밋/푸시 실패: ${message}`;
      }

      await ctx.reply(`🗑️ 세미나 퀴즈 족보 삭제 완료\n\n키워드: ${keyword}\n정답: ${deletedAnswer}${gitNotice}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('세미나 퀴즈 족보 삭제 실패', error);
      await ctx.reply(`❌ 족보 삭제 실패: ${message}`);
    }
  });

  adminBot.command('add_seminar_answer_batch', async (ctx) => {
    logger.info('User requested batch seminar quiz registration', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const content = messageText.replace(/^\/add_seminar_answer_batch\s*/, '').trim();

    if (!content) {
      return ctx.reply('사용법: /add_seminar_answer_batch <퀴즈 알림 내용 + 마지막 줄에 정답번호>');
    }

    const lines = content.split('\n').map((l) => l.trim());
    const lastLine = lines[lines.length - 1];

    if (!/^\d+$/.test(lastLine)) {
      return ctx.reply('❌ 마지막 줄에 숫자 형식의 정답(예: 3313)이 포함되어야 합니다.');
    }

    const answers = lastLine.split('').map(Number);
    const questions: { keyword: string; options: string[] }[] = [];
    let currentQuestion: { keyword: string; options: string[] } | null = null;

    for (const line of lines) {
      if (line.match(/^Q\d+:/)) {
        // New question block
        const keywordMatch = line.match(/^Q\d+:\s*(?:\[퀴즈\]\s*)?(.*)$/);
        if (keywordMatch) {
          const rawKeyword = keywordMatch[1].trim();
          const normalizedKeyword = rawKeyword
            .replace(/^["'“”]/, '')
            .replace(/["'“”]$/, '')
            .replace(/\.\.\.$/, '')
            .trim();

          if (normalizedKeyword) {
            currentQuestion = { keyword: normalizedKeyword, options: [] };
            questions.push(currentQuestion);
          }
        }
      } else if (currentQuestion && line.match(/^\d+\./)) {
        // Option line
        const optionText = line.replace(/^\d+\.\s*/, '').trim();
        currentQuestion.options.push(optionText);
      }
    }

    if (questions.length === 0) {
      return ctx.reply('❌ 퀴즈 내용을 파싱하지 못했습니다. 형식을 확인해주세요.');
    }

    if (questions.length !== answers.length) {
      return ctx.reply(`❌ 퀴즈 개수(${questions.length})와 정답 개수(${answers.length})가 일치하지 않습니다.`);
    }

    try {
      const data = await loadSeminarQuizCheatsheet();
      const registered: string[] = [];

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const answerIndex = answers[i];
        const selectedOption = q.options[answerIndex - 1];

        if (selectedOption) {
          data[q.keyword] = selectedOption;
          registered.push(`• ${q.keyword} → ${selectedOption}`);
        }
      }

      await saveSeminarQuizCheatsheet(data);

      let gitNotice = '';
      try {
        const result = await commitAndPushIfChanged(
          [SEMINAR_QUIZ_CHEATSHEET_FILE],
          'update seminar quiz cheatsheet (batch)',
        );
        gitNotice = `\n\n${result.notice}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('세미나 퀴즈 족보 Git 커밋/푸시 실패', error);
        gitNotice = `\n\n⚠️ Git 커밋/푸시 실패: ${message}`;
      }

      await ctx.reply(`✅ 세미나 퀴즈 ${registered.length}개 일괄 등록 완료\n\n${registered.join('\n')}${gitNotice}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('세미나 퀴즈 족보 일괄 등록 실패', error);
      await ctx.reply(`❌ 일괄 등록 실패: ${message}`);
    }
  });

  adminBot.command('help', (ctx) => {
    const message = `사용 가능한 명령어:

- /schedules: 스케줄된 작업 목록을 확인합니다.
- /run_routine_now: 즉시 daily_routine 작업을 실행합니다.
- /run_quiz_now: 즉시 오늘의 퀴즈 작업(today_quiz)을 실행합니다.
- /apply_seminar_now: 즉시 세미나 신청 작업(apply_seminar)을 실행합니다.
- /refresh_seminar_point_exclusion: 모든 세미나의 포인트미지급 여부를 다시 확인해 캐시를 갱신합니다.
- /naverpay_point_exchange [횟수]: 네이버페이포인트교환 작업을 실행합니다. (기본값: 10)
- /baemin_point_exchange [횟수]: 배민포인트교환 작업을 실행합니다. (기본값: 1)
- /add_quiz_answer: 오늘의 퀴즈 정답을 등록합니다. 예) /add_quiz_answer 시너지아정 [1,2,3]
- /broadcast_today_links: 즉시 오늘의 링크를 채널에 공지합니다.
- /update_app: pnpm update:app 명령어를 실행합니다. (서버 권한 필요, 재시작으로 응답 중단 가능)
- /log [수량]: 최근 로그를 가져옵니다. (기본값: 20)
- /inspect <url> <selector> [waitUntil]: 지정한 URL에서 셀렉터에 해당하는 요소를 검사하고 스크린샷을 전송합니다.
- /5days_seminar_check: 향후 5일간의 세미나 일정을 확인합니다.
- /today_links: 오늘의 세미나와 퀴즈 링크, 출석 링크를 한 번에 가져옵니다.
- /monitor_lunch_seminar_now: 즉시 점심 세미나 모니터링을 시작합니다.
- /monitor_dinner_seminar_now: 즉시 저녁 세미나 모니터링을 시작합니다.

📚 세미나 퀴즈 족보:
- /add_seminar_quiz <키워드> | <정답>: 족보 등록
- /list_seminar_quiz: 등록된 족보 목록
- /delete_seminar_quiz <키워드>: 족보 삭제
- /add_seminar_answer_batch: 알림 내용을 복사하여 일괄 등록 (마지막 줄에 정답번호 포함)

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
      await ctx.reply('Starting monitor_lunch_seminars... (백그라운드 실행)');
      runner
        .runTask(task)
        .then(async (result) => {
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
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          ctx.reply(`monitor_lunch_seminars failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`Failed to start monitor_lunch_seminars: ${message}`);
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
      await ctx.reply('Starting monitor_dinner_seminars... (백그라운드 실행)');
      runner
        .runTask(task)
        .then(async (result) => {
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
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          ctx.reply(`monitor_dinner_seminars failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`Failed to start monitor_dinner_seminars: ${message}`);
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
    await ctx.reply('5일간의 세미나를 확인합니다... (백그라운드 실행)');
    runner
      .runTask(task)
      .then(async (result) => {
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
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        ctx.reply(`세미나 확인 중 오류 발생: ${message}`);
      });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.reply(`Failed to start 세미나 확인: ${message}`);
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
    await ctx.reply('오늘의 링크를 수집합니다... (백그라운드 실행)');
    runner
      .runTask(task)
      .then(async (result) => {
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
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        ctx.reply(`링크 수집 중 오류 발생: ${message}`);
      });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.reply(`Failed to start 링크 수집: ${message}`);
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

const adminCommands = [
  { command: 'schedules', description: '스케줄된 작업 목록 확인' },
  { command: 'run_routine_now', description: '즉시 daily_routine 실행' },
  { command: 'run_quiz_now', description: '즉시 오늘의 퀴즈(today_quiz) 실행' },
  { command: 'apply_seminar_now', description: '즉시 세미나 신청(apply_seminar) 실행' },
  { command: 'refresh_seminar_point_exclusion', description: '세미나 포인트미지급 캐시 재확인' },
  { command: 'naverpay_point_exchange', description: '네이버페이포인트교환 실행' },
  { command: 'baemin_point_exchange', description: '배민포인트교환 실행' },
  { command: 'check_point', description: '현재 포인트 확인' },
  { command: 'add_quiz_answer', description: '오늘의 퀴즈 정답 등록' },
  { command: 'broadcast_today_links', description: '오늘의 링크 채널 공지' },
  { command: 'update_app', description: '앱 업데이트 (pnpm update:app)' },
  { command: 'log', description: '최근 로그 확인' },
  { command: 'inspect', description: '페이지 요소 검사' },
  { command: '5days_seminar_check', description: '향후 5일간 세미나 일정 확인' },
  { command: 'today_links', description: '오늘의 세미나/퀴즈/출석 링크 모음' },
  { command: 'monitor_lunch_seminar_now', description: '즉시 점심 세미나 모니터링 시작' },
  { command: 'monitor_dinner_seminar_now', description: '즉시 저녁 세미나 모니터링 시작' },
  { command: 'add_seminar_quiz', description: '세미나 퀴즈 족보 등록' },
  { command: 'list_seminar_quiz', description: '등록된 족보 목록' },
  { command: 'delete_seminar_quiz', description: '족보 삭제' },
  { command: 'add_seminar_answer_batch', description: '족보 일괄 등록' },
  { command: 'help', description: '도움말' },
];

const noticeCommands = [
  { command: '5days_seminar_check', description: '향후 5일간 세미나 일정 확인' },
  { command: 'today_links', description: '오늘의 세미나/퀴즈/출석 링크 모음' },
  { command: 'help', description: '도움말' },
];

function launch(): void {
  if (adminBot) {
    adminBot.launch();
    logger.info('Admin bot started');
    adminBot.telegram
      .setMyCommands(adminCommands)
      .catch((err) => logger.error('Failed to set admin bot commands', err));
  }
  if (noticeBot) {
    noticeBot.launch();
    logger.info('Notice bot started');
    noticeBot.telegram
      .setMyCommands(noticeCommands)
      .catch((err) => logger.error('Failed to set notice bot commands', err));
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
