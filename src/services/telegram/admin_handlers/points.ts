import { Telegraf, type Context } from 'telegraf';
import fsSync from 'fs';
import fs from 'fs/promises';
import * as logger from '../../logger';
import * as runner from '../../../core/runner';
import * as taskRegistry from '../../../core/taskRegistry';
import { replyWithSplit, TELEGRAM_SAFE_CAPTION_LENGTH } from '../../../modules/utils';

export const createPointExchangeHandler = (taskName: string, defaultAttempts = 1) => {
  return async (ctx: Context) => {
    logger.info(`User requested to run ${taskName} now`, { from: ctx.from?.username });
    const task = taskRegistry.getByName(taskName);
    if (!task) {
      logger.error(`${taskName} task not found, cannot run`);
      return replyWithSplit(ctx, `${taskName} task not found!`);
    }

    const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const args = messageText.split(' ').slice(1);
    let attempts = defaultAttempts;
    if (args.length > 0) {
      const parsedAttempts = parseInt(args[0], 10);
      if (!isNaN(parsedAttempts) && parsedAttempts > 0) {
        attempts = parsedAttempts;
      }
    }

    try {
      await replyWithSplit(ctx, `${taskName} 작업을 시작합니다... (${attempts}회 시도, 백그라운드 실행)`);
      runner
        .runTask(task, { maxIterations: attempts })
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
            await replyWithSplit(ctx, `${taskName} 작업이 완료되었습니다.`);
          } else {
            await replyWithSplit(ctx, `${taskName} 작업이 완료되었습니다.`);
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `${taskName} 실패: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start ${taskName}: ${message}`);
    }
  };
};

export function setupPointsCommands(adminBot: Telegraf): void {
  adminBot.command('check_point', async (ctx) => {
    logger.info('User requested to check point now', { from: ctx.from?.username });
    const task = taskRegistry.getByName('check_point');
    if (!task) {
      logger.error('check_point task not found, cannot run');
      return replyWithSplit(ctx, 'check_point task not found!');
    }

    try {
      runner
        .runTask(task)
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            const msg = (result as { message: string }).message;
            const imagePath = (result as { imagePath?: string }).imagePath;
            if (imagePath && fsSync.existsSync(imagePath)) {
              if (msg.length <= TELEGRAM_SAFE_CAPTION_LENGTH) {
                await ctx.replyWithPhoto({ source: imagePath }, { caption: msg });
              } else {
                await ctx.replyWithPhoto({ source: imagePath });
                await replyWithSplit(ctx, msg);
              }
              await fs.unlink(imagePath).catch(() => {});
            } else {
              await replyWithSplit(ctx, msg);
            }
          } else if (typeof result === 'string') {
            await replyWithSplit(ctx, result);
          } else {
            await replyWithSplit(ctx, '포인트 확인 완료 (메시지 없음)');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `포인트 확인 실패: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start check_point: ${message}`);
    }
  });

  // 세미나 번호로 포인트 지급 여부 조회 (단일/복수 지원)
  adminBot.command('check_seminar_point', async (ctx) => {
    logger.info('User requested to check seminar point', { from: ctx.from?.username });
    const task = taskRegistry.getByName('check_seminar_point');
    if (!task) {
      logger.error('check_seminar_point task not found, cannot run');
      return replyWithSplit(ctx, 'check_seminar_point task not found!');
    }

    try {
      // 메시지에서 4~5자리 숫자만 세미나 번호로 추출 (날짜의 월/일 제외)
      const text = ctx.message?.text || '';
      const seminarIds = (text.match(/\b\d{4,5}\b/g) || []) as string[];
      if (seminarIds.length === 0) {
        return replyWithSplit(
          ctx,
          '사용법: /check_seminar_point <세미나번호> [세미나번호...]\n예: /check_seminar_point 5517\n   또는 여러 줄 입력:\n8/12 5525\n8/13 5526\n8/14 5542 5543 5544 5565',
        );
      }

      const result = await runner.runTask(task, { args: { seminarIds: seminarIds.join(',') } });

      if (result && typeof result === 'object') {
        const r = result as { message?: string };
        if (r.message) await replyWithSplit(ctx, r.message);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start check_seminar_point: ${message}`);
    }
  });

  adminBot.command('naverpay_point_exchange', createPointExchangeHandler('네이버페이포인트교환', 10));
  adminBot.command('baemin_point_exchange', createPointExchangeHandler('배민포인트교환', 1));
  adminBot.command('kakaopay_point_exchange', createPointExchangeHandler('카카오페이포인트교환', 1));
  adminBot.command('kakaopay5k_point_exchange', createPointExchangeHandler('카카오페이5k포인트교환', 1));
  adminBot.command('kakaopay3k_point_exchange', createPointExchangeHandler('카카오페이3k포인트교환', 1));
}
