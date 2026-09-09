import { Telegraf, type Context } from 'telegraf';
import fsSync from 'fs';
import fs from 'fs/promises';
import * as logger from '../../logger';
import * as runner from '../../../core/runner';
import * as taskRegistry from '../../../core/taskRegistry';
import { replyWithSplit } from '../../../modules/utils';
import { sendOrUpdateTodayLinksNotification } from '../../broadcast_today_links';

export const todayLinks = async (ctx: Context) => {
  logger.info('User requested to run today_links now', { from: ctx.from?.username });
  const task = taskRegistry.getByName('today_links');
  if (!task) {
    logger.error('today_links task not found, cannot run');
    return replyWithSplit(ctx, 'today_links task not found!');
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
          const resObj = result as { message: string; options?: Record<string, unknown> };
          await replyWithSplit(ctx, resObj.message, resObj.options as Parameters<Context['reply']>[1]);
        } else if (typeof result === 'string') {
          await replyWithSplit(ctx, result);
        } else if (result === true) {
          await replyWithSplit(ctx, '작업이 완료되었습니다.');
        } else {
          await replyWithSplit(ctx, '작업이 완료되었습니다.');
        }
      })
      .catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        replyWithSplit(ctx, `링크 수집 중 오류 발생: ${message}`);
      });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    replyWithSplit(ctx, `Failed to start 링크 수집: ${message}`);
  }
};

export function setupExecutionCommands(adminBot: Telegraf): void {
  adminBot.command('run_routine_now', async (ctx) => {
    logger.info('User requested to run daily_routine now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('daily_routine');
    if (!task) {
      logger.error('daily_routine task not found, cannot run');
      return replyWithSplit(ctx, 'daily_routine task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await replyWithSplit(
              ctx,
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options as Parameters<Context['reply']>[1],
            );
            if (
              (result as { imagePath?: string }).imagePath &&
              fsSync.existsSync((result as { imagePath: string }).imagePath)
            ) {
              await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
              await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
            }
          } else if (typeof result === 'string') {
            await replyWithSplit(ctx, result);
          } else if (result === true) {
            await replyWithSplit(ctx, 'daily_routine finished successfully.');
          } else {
            await replyWithSplit(ctx, 'daily_routine finished successfully.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `daily_routine failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start daily_routine: ${message}`);
    }
  });

  adminBot.command('today_links', todayLinks);

  adminBot.command('broadcast_today_links', async (ctx) => {
    logger.info('Admin requested to broadcast today_links', { from: ctx.from?.username });
    const task = taskRegistry.getByName('today_links');
    if (!task) {
      logger.error('today_links task not found, cannot run broadcast');
      return replyWithSplit(ctx, 'today_links task not found!');
    }

    try {
      await replyWithSplit(ctx, 'Running today_links and broadcasting to channel... (백그라운드 실행)');
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && (result as { message?: string }).message) {
            const broadcastRes = await sendOrUpdateTodayLinksNotification(
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options ?? {},
            );
            if (broadcastRes.success) {
              const replyText =
                broadcastRes.action === 'edited'
                  ? `✅ 기존 오늘의 링크 공지 메시지(ID: ${broadcastRes.messageId})를 성공적으로 수정했습니다.`
                  : `✅ 오늘의 링크를 채널에 새로 공지했습니다. (ID: ${broadcastRes.messageId})`;
              await replyWithSplit(ctx, replyText);
            } else {
              await replyWithSplit(ctx, `❌ 공지 전송/수정 실패: ${broadcastRes.message}`);
            }
          } else {
            await replyWithSplit(ctx, 'Task ran, but no message was produced to broadcast.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `Broadcast failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start broadcast: ${message}`);
    }
  });

  adminBot.command('apply_seminar_now', async (ctx) => {
    logger.info('User requested to run apply_seminars now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('apply_seminars');
    if (!task) {
      logger.error('apply_seminars task not found, cannot run');
      return replyWithSplit(ctx, 'apply_seminars task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await replyWithSplit(
              ctx,
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options as Parameters<Context['reply']>[1],
            );
            if (
              (result as { imagePath?: string }).imagePath &&
              fsSync.existsSync((result as { imagePath: string }).imagePath)
            ) {
              await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
              await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
            }
          } else if (typeof result === 'string') {
            await replyWithSplit(ctx, result);
          } else if (result === true) {
            await replyWithSplit(ctx, 'apply_seminars finished successfully.');
          } else {
            await replyWithSplit(ctx, 'apply_seminars finished successfully.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `apply_seminars failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start apply_seminars: ${message}`);
    }
  });

  adminBot.command('sync_seminars_now', async (ctx) => {
    logger.info('User requested to run sync_seminars now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('sync_seminars');
    if (!task) {
      logger.error('sync_seminars task not found, cannot run');
      return replyWithSplit(ctx, 'sync_seminars task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await replyWithSplit(
              ctx,
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options as Parameters<Context['reply']>[1],
            );
          } else if (typeof result === 'string') {
            await replyWithSplit(ctx, result);
          } else if (result === true) {
            await replyWithSplit(ctx, 'sync_seminars finished successfully.');
          } else {
            await replyWithSplit(ctx, 'sync_seminars finished successfully.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `sync_seminars failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start sync_seminars: ${message}`);
    }
  });

  adminBot.command('run_quiz_now', async (ctx) => {
    logger.info('User requested to run today_quiz now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('today_quiz');
    if (!task) {
      logger.error('today_quiz task not found, cannot run');
      return replyWithSplit(ctx, 'today_quiz task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await replyWithSplit(
              ctx,
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options as Parameters<Context['reply']>[1],
            );
            if (
              (result as { imagePath?: string }).imagePath &&
              fsSync.existsSync((result as { imagePath: string }).imagePath)
            ) {
              await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
              await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
            }
          } else if (typeof result === 'string') {
            await replyWithSplit(ctx, result);
          } else if (result === true) {
            await replyWithSplit(ctx, 'today_quiz finished successfully.');
          } else {
            await replyWithSplit(ctx, 'today_quiz finished successfully.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `today_quiz failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start today_quiz: ${message}`);
    }
  });

  adminBot.command('run_intermd_quiz_now', async (ctx) => {
    logger.info('User requested to run intermd_quiz now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('intermd_quiz');
    if (!task) {
      logger.error('intermd_quiz task not found, cannot run');
      return replyWithSplit(ctx, 'intermd_quiz task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await replyWithSplit(
              ctx,
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options as Parameters<Context['reply']>[1],
            );
          } else if (typeof result === 'string') {
            await replyWithSplit(ctx, result);
          } else if (result === true) {
            await replyWithSplit(ctx, '인터엠디 퀴즈 작업이 성공적으로 완료되었습니다.');
          } else {
            await replyWithSplit(ctx, '인터엠디 퀴즈 작업이 완료되었습니다.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `intermd_quiz failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start intermd_quiz: ${message}`);
    }
  });

  adminBot.command(['run_keymedi_attendance_now', 'keymedi_attendance_now', 'keymedi_attendance'], async (ctx) => {
    logger.info('User requested to run keymedi_attendance now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('keymedi_attendance');
    if (!task) {
      logger.error('keymedi_attendance task not found, cannot run');
      return replyWithSplit(ctx, 'keymedi_attendance task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await replyWithSplit(
              ctx,
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options as Parameters<Context['reply']>[1],
            );
          } else if (typeof result === 'string') {
            await replyWithSplit(ctx, result);
          } else if (result === true) {
            await replyWithSplit(ctx, '키메디 출석체크 작업이 성공적으로 완료되었습니다.');
          } else {
            await replyWithSplit(ctx, '키메디 출석체크 작업이 완료되었습니다.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `keymedi_attendance failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start keymedi_attendance: ${message}`);
    }
  });

  adminBot.command(['run_docple_daily_now', 'docple_daily_now', 'docple_daily', 'docple'], async (ctx) => {
    logger.info('User requested to run docple_daily now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('docple_daily');
    if (!task) {
      logger.error('docple_daily task not found, cannot run');
      return replyWithSplit(ctx, 'docple_daily task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await replyWithSplit(
              ctx,
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options as Parameters<Context['reply']>[1],
            );
          } else if (typeof result === 'string') {
            await replyWithSplit(ctx, result);
          } else if (result === true) {
            await replyWithSplit(ctx, '닥플 일일 자동화 작업이 성공적으로 완료되었습니다.');
          } else {
            await replyWithSplit(ctx, '닥플 일일 자동화 작업이 완료되었습니다.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `docple_daily failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start docple_daily: ${message}`);
    }
  });

  adminBot.command(['run_hmp_attendance_now', 'hmp_attendance_now', 'hmp_attendance'], async (ctx) => {
    logger.info('User requested to run hmp_attendance now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('hmp_attendance');
    if (!task) {
      logger.error('hmp_attendance task not found, cannot run');
      return replyWithSplit(ctx, 'hmp_attendance task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await replyWithSplit(
              ctx,
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options as Parameters<Context['reply']>[1],
            );
          } else if (typeof result === 'string') {
            await replyWithSplit(ctx, result);
          } else if (result === true) {
            await replyWithSplit(ctx, 'HMP 출석체크 작업이 성공적으로 완료되었습니다.');
          } else {
            await replyWithSplit(ctx, 'HMP 출석체크 작업이 완료되었습니다.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `hmp_attendance failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start hmp_attendance: ${message}`);
    }
  });

  adminBot.command('monitor_lunch_seminar_now', async (ctx) => {
    logger.info('User requested to run monitor_lunch_seminars now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('monitor_lunch_seminars');
    if (!task) {
      logger.error('monitor_lunch_seminars task not found, cannot run');
      return replyWithSplit(ctx, 'monitor_lunch_seminars task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await replyWithSplit(
              ctx,
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options as Parameters<Context['reply']>[1],
            );
            if (
              (result as { imagePath?: string }).imagePath &&
              fsSync.existsSync((result as { imagePath: string }).imagePath)
            ) {
              await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
              await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
            }
          } else if (typeof result === 'string') {
            await replyWithSplit(ctx, result);
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `monitor_lunch_seminars failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start monitor_lunch_seminars: ${message}`);
    }
  });

  adminBot.command('monitor_dinner_seminar_now', async (ctx) => {
    logger.info('User requested to run monitor_dinner_seminars now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('monitor_dinner_seminars');
    if (!task) {
      logger.error('monitor_dinner_seminars task not found, cannot run');
      return replyWithSplit(ctx, 'monitor_dinner_seminars task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await replyWithSplit(
              ctx,
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options as Parameters<Context['reply']>[1],
            );
            if (
              (result as { imagePath?: string }).imagePath &&
              fsSync.existsSync((result as { imagePath: string }).imagePath)
            ) {
              await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
              await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
            }
          } else if (typeof result === 'string') {
            await replyWithSplit(ctx, result);
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `monitor_dinner_seminars failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start monitor_dinner_seminars: ${message}`);
    }
  });
}
