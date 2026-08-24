import { Telegraf, type Context } from 'telegraf';
import { exec, spawn } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import https from 'https';
import path from 'path';
import { setBot, checkNoticeCooldown } from './bot_instance';
import * as logger from './logger';
import * as scheduler from '../core/scheduler';
import * as runner from '../core/runner';
import * as taskRegistry from '../core/taskRegistry';
import { inspect } from '../modules/inspect';
import { sendNotificationToChannel } from '../modules/utils';
import { extractSeminarIds } from '../tasks/seminar_detail';

const ADMIN_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const NOTICE_BOT_TOKEN = process.env.NOTICE_BOT_TOKEN;
const SEMINAR_QUIZ_CHEATSHEET_FILE = 'data/seminar_quiz_cheatsheet.json';
const SEMINAR_QUIZ_CHEATSHEET_PATH = path.join(process.cwd(), SEMINAR_QUIZ_CHEATSHEET_FILE);
const QUIZ_FILE = 'data/quiz.json';
const QUIZ_PATH = path.join(process.cwd(), QUIZ_FILE);

type SeminarQuizCheatsheet = Record<string, string>;
type QuizMapping = Record<string, Array<string | number>>;
type CommandResult = { stdout: string; stderr: string };
type CommandResultWithExitCode = CommandResult & { exitCode?: number };

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

// --- Quiz Mapping (quiz.json) Functions ---
async function loadQuizMapping(): Promise<QuizMapping> {
  try {
    const raw = await fs.readFile(QUIZ_PATH, 'utf8');
    return JSON.parse(raw) as QuizMapping;
  } catch (error) {
    logger.warn('quiz.json 로드 실패, 빈 객체 반환', error);
    return {};
  }
}

async function saveQuizMapping(data: QuizMapping): Promise<void> {
  try {
    await fs.writeFile(QUIZ_PATH, `${JSON.stringify(data, null, 4)}\n`, 'utf8');
  } catch (error) {
    logger.error('quiz.json 저장 실패', error);
    throw new Error('quiz.json 파일을 저장할 수 없습니다.');
  }
}

type ParsedQuizQuestion = { keyword: string; options: string[] };

function parseQuizQuestionsFromText(content: string): ParsedQuizQuestion[] {
  const lines = content.split('\n').map((l) => l.trim());
  const questions: ParsedQuizQuestion[] = [];
  let currentQuestion: ParsedQuizQuestion | null = null;

  for (const line of lines) {
    if (line.match(/^Q\d+:/)) {
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
      const optionText = line.replace(/^\d+\.\s*/, '').trim();
      currentQuestion.options.push(optionText);
    }
  }

  return questions;
}

async function registerQuizAnswersToCheatsheet(
  questions: ParsedQuizQuestion[],
  answers: number[],
): Promise<{ registered: string[]; gitNotice: string }> {
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

  return { registered, gitNotice };
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

  noticeBot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && !checkNoticeCooldown(userId)) {
      await ctx.reply('⏳ 요청이 너무 빠릅니다. 2초 후 다시 시도해주세요.').catch(() => {});
      return;
    }
    return next();
  });

  noticeBot.start((ctx) => ctx.reply('Welcome!'));
}

// --- Shared Handlers ---
const todayLinks = async (ctx: Context) => {
  logger.info('User requested to run today_links now', { from: ctx.from?.username });
  const task = taskRegistry.getByName('today_links');
  if (!task) {
    logger.error('today_links task not found, cannot run');
    return ctx.reply('today_links task not found!');
  }

  let targetDate: string | undefined;
  if (ctx.message && 'text' in ctx.message) {
    const text = ctx.message.text.trim();
    const match = text.match(/^\/today_links(?:\s+(.+))?$/);
    if (match && match[1]) {
      targetDate = match[1].trim();
    }
  }

  try {
    runner
      .runTask(task, { args: targetDate ? { date: targetDate } : undefined })
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

const createSeminarDetailHandler = (allowForce: boolean) => async (ctx: Context) => {
  logger.info('User requested seminar detail', { from: ctx.from?.username, allowForce });
  try {
    const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const seminarIds = extractSeminarIds(messageText);
    if (seminarIds.length === 0) {
      return ctx.reply(
        allowForce
          ? '사용법: /seminar_detail <세미나번호> [force]\n예: /seminar_detail 5566 (목록 저장값 우선)\n   /seminar_detail 5566 force (실시간 API 강제 조회)\n   또는 /seminar_detail 5566 5567'
          : '사용법: /seminar_detail <세미나번호> [세미나번호...]\n예: /seminar_detail 5566\n   또는 /seminar_detail 5566 5567',
      );
    }

    const MAX_SEMINAR_IDS_PER_REQUEST = 10;
    if (seminarIds.length > MAX_SEMINAR_IDS_PER_REQUEST) {
      return ctx.reply('⚠️ 세미나 번호는 한 번에 최대 10개까지만 조회할 수 있습니다.');
    }

    const { run: runSeminarDetail, isForceRefresh } = await import('../tasks/seminar_detail');
    const force = allowForce && isForceRefresh(messageText);
    const result = await runSeminarDetail({
      args: {
        seminarIds,
        seminarId: seminarIds[0],
        preferStored: !force,
        force,
      },
    });

    if (result && typeof result === 'object') {
      const r = result as {
        message?: string;
        success?: boolean;
        rawMessages?: string[];
        messages?: string[];
      };

      if (r.messages && r.messages.length > 1) {
        for (const msg of r.messages) {
          await ctx.reply(msg, { parse_mode: 'Markdown' });
        }
      } else if (r.success !== false && r.message) {
        await ctx.reply(r.message, { parse_mode: 'Markdown' });
      } else if (!r.success && r.message) {
        await ctx.reply(r.message);
      }

      for (const rawMsg of r.rawMessages ?? []) {
        await ctx.reply(rawMsg, { parse_mode: 'Markdown' });
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.reply(`세미나 상세 조회 실패: ${message}`);
  }
};

// --- Admin Bot Commands ---
if (adminBot) {
  // ==========================================
  // 1. 루틴 / 실행 (Routine & Execution)
  // ==========================================

  adminBot.command('run_routine_now', async (ctx) => {
    logger.info('User requested to run daily_routine now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('daily_routine');
    if (!task) {
      logger.error('daily_routine task not found, cannot run');
      return ctx.reply('daily_routine task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await ctx.reply(
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options,
            );
            if (
              (result as { imagePath?: string }).imagePath &&
              fsSync.existsSync((result as { imagePath: string }).imagePath)
            ) {
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

  adminBot.command('today_links', todayLinks);

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

  adminBot.command('apply_seminar_now', async (ctx) => {
    logger.info('User requested to run apply_seminar now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('apply_seminar');
    if (!task) {
      logger.error('apply_seminar task not found, cannot run');
      return ctx.reply('apply_seminar task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await ctx.reply(
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options,
            );
            if (
              (result as { imagePath?: string }).imagePath &&
              fsSync.existsSync((result as { imagePath: string }).imagePath)
            ) {
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

  adminBot.command('run_quiz_now', async (ctx) => {
    logger.info('User requested to run today_quiz now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('today_quiz');
    if (!task) {
      logger.error('today_quiz task not found, cannot run');
      return ctx.reply('today_quiz task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await ctx.reply(
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options,
            );
            if (
              (result as { imagePath?: string }).imagePath &&
              fsSync.existsSync((result as { imagePath: string }).imagePath)
            ) {
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

  adminBot.command('monitor_lunch_seminar_now', async (ctx) => {
    logger.info('User requested to run monitor_lunch_seminars now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('monitor_lunch_seminars');
    if (!task) {
      logger.error('monitor_lunch_seminars task not found, cannot run');
      return ctx.reply('monitor_lunch_seminars task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await ctx.reply(
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options,
            );
            if (
              (result as { imagePath?: string }).imagePath &&
              fsSync.existsSync((result as { imagePath: string }).imagePath)
            ) {
              await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
              await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
            }
          } else if (typeof result === 'string') {
            await ctx.reply(result);
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
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await ctx.reply(
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options,
            );
            if (
              (result as { imagePath?: string }).imagePath &&
              fsSync.existsSync((result as { imagePath: string }).imagePath)
            ) {
              await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
              await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
            }
          } else if (typeof result === 'string') {
            await ctx.reply(result);
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

  // ==========================================
  // 2. 세미나 & 퀴즈 족보 (Seminar & Cheatsheet)
  // ==========================================

  // /run_seminar_quiz <seminarId> [advanced] — 수동 세미나 퀴즈 실행
  adminBot.command('run_seminar_quiz', async (ctx) => {
    logger.info('User requested to run seminar_quiz manually', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const parts = messageText.split(/\s+/).slice(1);
    const seminarId = parts[0]?.trim() || '';
    const isAdvancedSurvey = parts[1]?.toLowerCase() === 'advanced' || parts[1]?.toLowerCase() === '심화';

    if (!seminarId) {
      return ctx.reply(
        '사용법: /run_seminar_quiz <seminarId> [advanced]\n예) /run_seminar_quiz 12345\n     /run_seminar_quiz 12345 advanced',
      );
    }

    const task = taskRegistry.getByName('run_seminar_quiz');
    if (!task) {
      logger.error('run_seminar_quiz task not found, cannot run');
      return ctx.reply('run_seminar_quiz task not found!');
    }

    try {
      await ctx.reply(
        `Starting run_seminar_quiz (seminarId=${seminarId}${isAdvancedSurvey ? ', 심화설문' : ''})... (백그라운드 실행)`,
      );
      const args: Record<string, string> = { seminarId };
      if (isAdvancedSurvey) args.isAdvancedSurvey = 'true';
      runner
        .runTask(task, { args })
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await ctx.reply(
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options,
            );
            if (
              (result as { imagePath?: string }).imagePath &&
              fsSync.existsSync((result as { imagePath: string }).imagePath)
            ) {
              await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
              await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
            } else {
              const shotPaths = (result as { screenshotPaths?: string[] }).screenshotPaths;
              if (shotPaths) {
                for (const p of shotPaths) {
                  await ctx.replyWithPhoto({ source: p });
                  await fs.unlink(p).catch(() => {});
                }
              }
            }
          } else if (typeof result === 'string') {
            await ctx.reply(result);
          } else if (result === true) {
            await ctx.reply('run_seminar_quiz finished successfully.');
          } else {
            await ctx.reply('run_seminar_quiz finished.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          ctx.reply(`run_seminar_quiz failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`Failed to start run_seminar_quiz: ${message}`);
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

    let answers: number[] = [];
    if (/^\d+$/.test(lastLine)) {
      answers = lastLine.split('').map(Number);
    } else if (/^[\d\s,-]+$/.test(lastLine)) {
      const digits = lastLine.match(/\d/g);
      if (digits) answers = digits.map(Number);
    }

    if (answers.length === 0) {
      return ctx.reply('❌ 마지막 줄에 숫자 형식의 정답(예: 3313 또는 3 3 1 3)이 포함되어야 합니다.');
    }

    const questions = parseQuizQuestionsFromText(content);

    if (questions.length === 0) {
      return ctx.reply('❌ 퀴즈 내용을 파싱하지 못했습니다. 형식을 확인해주세요.');
    }

    if (questions.length !== answers.length) {
      return ctx.reply(`❌ 퀴즈 개수(${questions.length})와 정답 개수(${answers.length})가 일치하지 않습니다.`);
    }

    try {
      const { registered, gitNotice } = await registerQuizAnswersToCheatsheet(questions, answers);
      await ctx.reply(`✅ 세미나 퀴즈 ${registered.length}개 일괄 등록 완료\n\n${registered.join('\n')}${gitNotice}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('세미나 퀴즈 족보 일괄 등록 실패', error);
      await ctx.reply(`❌ 일괄 등록 실패: ${message}`);
    }
  });

  // 답장(Reply)을 통한 퀴즈 정답 번호 일괄 등록 핸들러
  adminBot.on('text', async (ctx, next) => {
    const messageText = ctx.message.text.trim();
    // 명령어인 경우 telegraf command 핸들러에 위임
    if (messageText.startsWith('/')) {
      return next();
    }

    const replyToMessage = ctx.message.reply_to_message;
    if (!replyToMessage) {
      return next();
    }

    const replyText =
      'text' in replyToMessage && replyToMessage.text
        ? replyToMessage.text
        : 'caption' in replyToMessage && replyToMessage.caption
          ? replyToMessage.caption
          : '';

    if (!replyText) {
      return next();
    }

    // 숫자로만 구성되어 있는지 확인 (예: "234", "1 2 3", "1, 2, 3", "1-2-3")
    let answers: number[] = [];
    if (/^\d+$/.test(messageText)) {
      answers = messageText.split('').map(Number);
    } else if (/^[\d\s,-]+$/.test(messageText)) {
      const digits = messageText.match(/\d/g);
      if (digits) {
        answers = digits.map(Number);
      }
    }

    if (answers.length === 0) {
      return next();
    }

    // 답장 대상 메시지가 퀴즈 문제인지 파싱
    const questions = parseQuizQuestionsFromText(replyText);
    if (questions.length === 0) {
      return next();
    }

    if (questions.length !== answers.length) {
      return ctx.reply(
        `❌ 퀴즈 개수(${questions.length}개)와 전송한 정답 개수(${answers.length}개)가 일치하지 않습니다.\n확인 후 다시 답장을 보내주세요.`,
      );
    }

    try {
      logger.info('Registering quiz cheatsheet via reply', {
        from: ctx.from?.username,
        questionCount: questions.length,
        answers,
      });
      const { registered, gitNotice } = await registerQuizAnswersToCheatsheet(questions, answers);
      await ctx.reply(
        `✅ 세미나/오늘의 퀴즈 ${registered.length}개 족보 등록 완료 (답장 등록)\n\n${registered.join('\n')}${gitNotice}\n\n재실행: /run_quiz_now`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('답장을 통한 퀴즈 족보 등록 실패', error);
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

  adminBot.command('list_quiz', async (ctx) => {
    logger.info('User requested to list quiz.json', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const searchKeyword = messageText.replace(/^\/list_quiz\s*/, '').trim();

    try {
      const data = await loadQuizMapping();
      let entries = Object.entries(data);

      if (searchKeyword) {
        entries = entries.filter(
          ([product, answers]) => product.includes(searchKeyword) || JSON.stringify(answers).includes(searchKeyword),
        );
      }

      if (entries.length === 0) {
        if (searchKeyword) {
          return ctx.reply(`📋 quiz.json "${searchKeyword}" 검색 결과가 없습니다.`);
        } else {
          return ctx.reply('📋 quiz.json에 등록된 항목이 없습니다.');
        }
      }

      let message = searchKeyword
        ? `📋 quiz.json "${searchKeyword}" 검색 결과 (${entries.length}개)\n\n`
        : `📋 quiz.json 목록 (${entries.length}개)\n\n`;

      for (const [product, answers] of entries) {
        message += `• ${product} → [${answers.join(', ')}]\n`;
      }

      await ctx.reply(truncateMessage(message));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.reply(`❌ quiz.json 목록 조회 실패: ${message}`);
    }
  });

  adminBot.command('delete_quiz', async (ctx) => {
    logger.info('User requested to delete quiz mapping', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const target = messageText.replace(/^\/delete_quiz\s*/, '').trim();

    if (!target) {
      return ctx.reply('사용법: /delete_quiz <제품명>\n예) /delete_quiz 글리아타민');
    }

    try {
      const data = await loadQuizMapping();

      if (!(target in data)) {
        return ctx.reply(`❌ "${target}" 제품이 quiz.json에 없습니다.`);
      }

      const deletedAnswer = data[target];
      delete data[target];
      await saveQuizMapping(data);
      let gitNotice = '';
      try {
        const result = await commitAndPushIfChanged([QUIZ_FILE], `delete ${target} from quiz.json`);
        gitNotice = `\n\n${result.notice}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('quiz.json 삭제 Git 커밋/푸시 실패', error);
        gitNotice = `\n\n⚠️ Git 커밋/푸시 실패: ${message}`;
      }

      await ctx.reply(
        `🗑️ quiz.json 항목 삭제 완료\n\n제품: ${target}\n정답: ${JSON.stringify(deletedAnswer)}${gitNotice}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('quiz.json 삭제 실패', error);
      await ctx.reply(`❌ quiz.json 삭제 실패: ${message}`);
    }
  });

  // ==========================================
  // 3. 포인트 & 교환 (Points & Exchange)
  // ==========================================

  adminBot.command('check_point', async (ctx) => {
    logger.info('User requested to check point now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('check_point');
    if (!task) {
      logger.error('check_point task not found, cannot run');
      return ctx.reply('check_point task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            const msg = (result as { message: string }).message;
            const imagePath = (result as { imagePath?: string }).imagePath;
            if (imagePath && fsSync.existsSync(imagePath)) {
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

  // 세미나 번호로 포인트 지급 여부 조회 (단일/복수 지원)
  adminBot.command('check_seminar_point', async (ctx) => {
    logger.info('User requested to check seminar point', { from: ctx.from?.username });
    const task = taskRegistry.getByName('check_seminar_point');
    if (!task) {
      logger.error('check_seminar_point task not found, cannot run');
      return ctx.reply('check_seminar_point task not found!');
    }

    try {
      // 메시지에서 4~5자리 숫자만 세미나 번호로 추출 (날짜의 월/일 제외)
      const text = ctx.message?.text || '';
      const seminarIds = (text.match(/\b\d{4,5}\b/g) || []) as string[];
      if (seminarIds.length === 0) {
        return ctx.reply(
          '사용법: /check_seminar_point <세미나번호> [세미나번호...]\n예: /check_seminar_point 5517\n   또는 여러 줄 입력:\n8/12 5525\n8/13 5526\n8/14 5542 5543 5544 5565',
        );
      }

      const result = await runner.runTask(task, { args: { seminarIds: seminarIds.join(',') } });

      if (result && typeof result === 'object') {
        const r = result as { message?: string };
        if (r.message) await ctx.reply(r.message);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      ctx.reply(`Failed to start check_seminar_point: ${message}`);
    }
  });

  // 세미나 상세 정보 조회
  adminBot.command('seminar_detail', createSeminarDetailHandler(true));

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
      runner
        .runTask(task, { maxIterations: attempts })
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await ctx.reply(
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options,
            );
            if (
              (result as { imagePath?: string }).imagePath &&
              fsSync.existsSync((result as { imagePath: string }).imagePath)
            ) {
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
      runner
        .runTask(task, { maxIterations: attempts })
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await ctx.reply(
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options,
            );
            if (
              (result as { imagePath?: string }).imagePath &&
              fsSync.existsSync((result as { imagePath: string }).imagePath)
            ) {
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

  // ==========================================
  // 4. 시스템 & 관리 (System & Management)
  // ==========================================

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

  adminBot.command('log', async (ctx) => {
    const messageText = ctx.message?.text || '';
    const args = messageText.split(' ').slice(1);

    let lineCount = 20;
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

  adminBot.command('update_app', async (ctx) => {
    logger.info('User requested to run update_app', { from: ctx.from?.username });
    try {
      await ctx.reply(
        '🔄 앱 업데이트 및 빌드를 시작합니다...\n' +
          '1. Git Pull & 의존성 설치\n' +
          '2. TypeScript 빌드\n' +
          '3. 서비스 파일 갱신',
      );

      // 1. 빌드 및 설정 동기 실행 (재시작 제외)
      const buildCommand =
        'git pull && pnpm install --frozen-lockfile && pnpm run build && cp deploy/doctorville-auto.service /etc/systemd/system/ && systemctl daemon-reload';

      runShellCommand(buildCommand)
        .then(async ({ stdout, stderr }) => {
          let message = '✅ 앱 업데이트 및 빌드 성공!';
          if (stdout.trim()) {
            message += `\n\nstdout:\n${truncateMessage(stdout.trim())}`;
          }
          if (stderr.trim()) {
            message += `\n\nstderr:\n${truncateMessage(stderr.trim())}`;
          }
          message += '\n\n🚀 서비스를 재시작합니다...';
          await ctx.reply(message);

          // 2. 서비스 재시작을 독립(detached) 프로세스로 실행하여 데드락 및 타임아웃 방지
          const restartProcess = spawn('systemctl', ['restart', 'doctorville-auto.service'], {
            detached: true,
            stdio: 'ignore',
          });
          restartProcess.unref();
        })
        .catch(async (error) => {
          const message = error instanceof Error ? error.message : String(error);
          const stdout = (error as Error & { stdout?: string }).stdout ?? '';
          const stderr = (error as Error & { stderr?: string }).stderr ?? '';
          logger.error('update_app failed', error);
          let reply = `❌ 업데이트 실패:\n${message}`;
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
      ctx.reply(`Failed to start update_app: ${message}`);
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

  adminBot.command('help', (ctx) => {
    const message = `사용 가능한 명령어:

🔄 루틴 / 실행:
- /run_routine_now: 즉시 daily_routine 작업을 실행합니다.
- /today_links [날짜]: 오늘의 세미나/퀴즈/출석 링크를 가져옵니다. (날짜 지정 가능: 예 /today_links 8/20, /today_links 내일)
- /broadcast_today_links: 즉시 오늘의 링크를 채널에 공지합니다.
- /apply_seminar_now: 즉시 세미나 신청 작업(apply_seminar)을 실행합니다.
- /run_quiz_now: 즉시 오늘의 퀴즈 작업(today_quiz)을 실행합니다.
- /monitor_lunch_seminar_now: 즉시 점심 세미나 모니터링을 시작합니다.
- /monitor_dinner_seminar_now: 즉시 저녁 세미나 모니터링을 시작합니다.

📚 세미나 & 퀴즈 족보:
- /run_seminar_quiz <seminarId> [advanced]: 특정 세미나의 설문 퀴즈를 수동 실행합니다. (advanced: 심화설문)
- /add_seminar_answer_batch: 알림 내용을 복사하여 일괄 등록 (마지막 줄에 정답번호 포함)
- /list_seminar_quiz: 등록된 족보 목록
- /delete_seminar_quiz <키워드>: 족보 삭제
- /list_quiz: quiz.json 등록 제품 목록
- /delete_quiz <제품명>: quiz.json 항목 삭제
- /seminar_detail <세미나번호> [force]: 세미나 상세 정보 조회 (force: 실시간 API 강제 조회)

💰 포인트 & 교환:
- /check_point: 현재 포인트를 확인합니다.
- /check_seminar_point: 세미나 번호로 포인트 지급 확인
- /check_advanced_seminars: 최근 2주 심화 세미나 포인트 일괄 확인 (방장 계정 기준)
- /naverpay_point_exchange [횟수]: 네이버페이포인트교환 작업을 실행합니다. (기본값: 10)
- /baemin_point_exchange [횟수]: 배민포인트교환 작업을 실행합니다. (기본값: 1)

⚙️ 시스템 & 관리:
- /schedules: 스케줄된 작업 목록을 확인합니다.
- /log [수량]: 최근 로그를 가져옵니다. (기본값: 20)
- /update_app: pnpm update:app 명령어를 실행합니다. (서버 권한 필요, 재시작으로 응답 중단 가능)
- /inspect <url> <selector> [waitUntil]: 지정한 URL에서 셀렉터에 해당하는 요소를 검사하고 스크린샷을 전송합니다.

명령어 사용 예: /inspect https://example.com "div.article" networkidle`;
    ctx.reply(message);
  });
}

const noticeTodayLinks = async (ctx: Context) => {
  logger.info('User requested cached today_links on notice bot', { from: ctx.from?.username });
  try {
    const { getTodayLinksCache } = await import('../tasks/today_links');
    const cache = getTodayLinksCache();
    if (cache && cache.message) {
      await ctx.reply(cache.message, cache.options as Parameters<Context['reply']>[1]);
    } else {
      await ctx.reply(
        'ℹ️ 오늘의 링크 정보가 아직 생성되지 않았습니다. 매일 오전 9시 채널 공지 이후 조회하실 수 있습니다.',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await ctx.reply(`오늘의 링크 조회 실패: ${message}`);
  }
};

// --- Notice Bot Commands ---
if (noticeBot) {
  noticeBot.command('today_links', noticeTodayLinks);
  noticeBot.command('seminar_detail', createSeminarDetailHandler(false));

  noticeBot.command('help', (ctx) => {
    const message = `사용 가능한 명령어:

- /today_links: 오늘의 세미나/퀴즈/출석 링크 모음
- /seminar_detail <세미나번호>: 세미나 상세 정보 조회 (예: /seminar_detail 5566)
- /check_advanced_seminars: 최근 2주 심화 세미나 포인트 지급 현황 (방장 계정 기준)
- /subscribe_seminar_changes: 세미나 정보 변경 알림 구독
- /unsubscribe_seminar_changes: 세미나 정보 변경 알림 구독 해제`;
    ctx.reply(message);
  });
}

const adminCommands = [
  // 1. 루틴 / 실행
  { command: 'run_routine_now', description: '즉시 daily_routine 실행' },
  { command: 'today_links', description: '세미나/퀴즈 링크 모음 [날짜 지정 가능]' },
  { command: 'broadcast_today_links', description: '오늘의 링크 채널 공지' },
  { command: 'apply_seminar_now', description: '즉시 세미나 신청(apply_seminar) 실행' },
  { command: 'run_quiz_now', description: '즉시 오늘의 퀴즈(today_quiz) 실행' },
  { command: 'monitor_lunch_seminar_now', description: '즉시 점심 세미나 모니터링 시작' },
  { command: 'monitor_dinner_seminar_now', description: '즉시 저녁 세미나 모니터링 시작' },
  // 2. 세미나 & 퀴즈 족보
  { command: 'run_seminar_quiz', description: '특정 세미나 퀴즈 수동 실행 (seminarId, [advanced])' },
  { command: 'add_seminar_answer_batch', description: '족보 일괄 등록' },
  { command: 'list_seminar_quiz', description: '등록된 족보 목록' },
  { command: 'delete_seminar_quiz', description: '족보 삭제' },
  { command: 'list_quiz', description: 'quiz.json 등록 제품 목록' },
  { command: 'delete_quiz', description: 'quiz.json 항목 삭제' },
  { command: 'seminar_detail', description: '세미나 번호로 상세 정보 조회 [force: 실시간 API 조회]' },
  // 3. 포인트 & 교환
  { command: 'check_point', description: '현재 포인트 확인' },
  { command: 'check_seminar_point', description: '세미나 번호로 포인트 지급 확인' },
  { command: 'check_advanced_seminars', description: '최근 2주 심화 세미나 포인트 일괄 확인 (방장 계정 기준)' },
  { command: 'naverpay_point_exchange', description: '네이버페이포인트교환 실행' },
  { command: 'baemin_point_exchange', description: '배민포인트교환 실행' },
  // 4. 시스템 & 관리
  { command: 'schedules', description: '스케줄된 작업 목록 확인' },
  { command: 'log', description: '최근 로그 확인' },
  { command: 'update_app', description: '앱 업데이트 (pnpm update:app)' },
  { command: 'inspect', description: '페이지 요소 검사' },
  { command: 'help', description: '도움말' },
];

const noticeCommands = [
  { command: 'today_links', description: '오늘의 세미나/퀴즈/출석 링크 모음' },
  { command: 'seminar_detail', description: '세미나 번호로 상세 정보 조회' },
  { command: 'check_advanced_seminars', description: '최근 2주 심화 세미나 포인트 확인 (방장 계정 기준)' },
  { command: 'subscribe_seminar_changes', description: '세미나 정보 변경 알림 구독' },
  { command: 'unsubscribe_seminar_changes', description: '세미나 정보 변경 알림 구독 해제' },
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
