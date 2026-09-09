import { Telegraf, type Context } from 'telegraf';
import fsSync from 'fs';
import fs from 'fs/promises';
import * as logger from '../../logger';
import * as runner from '../../../core/runner';
import * as taskRegistry from '../../../core/taskRegistry';
import { replyWithSplit, TELEGRAM_SAFE_CAPTION_LENGTH } from '../../../modules/utils';

export interface PresetExchangeOptions {
  name: string;
  guid: string;
  catecode?: string;
  defaultAttempts?: number;
}

export const createPointExchangeHandler = (options: PresetExchangeOptions) => {
  return async (ctx: Context) => {
    logger.info(`User requested to run point exchange for ${options.name}`, { from: ctx.from?.username });
    const task = taskRegistry.getByName('point_exchange');
    if (!task) {
      logger.error('point_exchange task not found, cannot run');
      return replyWithSplit(ctx, 'point_exchange task not found!');
    }

    const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const args = messageText.split(' ').slice(1);
    let attempts = options.defaultAttempts ?? 1;
    if (args.length > 0) {
      const parsedAttempts = parseInt(args[0], 10);
      if (!isNaN(parsedAttempts) && parsedAttempts > 0) {
        attempts = parsedAttempts;
      }
    }

    try {
      await replyWithSplit(
        ctx,
        `${options.name} 포인트교환 작업을 시작합니다... (${attempts}회 시도, 백그라운드 실행)`,
      );
      runner
        .runTask(task, {
          args: {
            name: options.name,
            guid: options.guid,
            catecode: options.catecode || '14592',
          },
          maxIterations: attempts,
        })
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
            await replyWithSplit(ctx, `${options.name} 포인트교환 작업이 완료되었습니다.`);
          } else {
            await replyWithSplit(ctx, `${options.name} 포인트교환 작업이 완료되었습니다.`);
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `${options.name} 포인트교환 실패: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start ${options.name} point exchange: ${message}`);
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

  // 범용 포인트 교환 명령어 (URL 또는 guid 입력)
  adminBot.command('point_exchange', async (ctx) => {
    logger.info('User requested generic point_exchange', { from: ctx.from?.username });
    const task = taskRegistry.getByName('point_exchange');
    if (!task) {
      logger.error('point_exchange task not found, cannot run');
      return replyWithSplit(ctx, 'point_exchange task not found!');
    }

    const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const parts = messageText.trim().split(/\s+/).slice(1);
    if (parts.length === 0) {
      return replyWithSplit(
        ctx,
        '사용법: /point_exchange <상품 URL 또는 guid> [시도횟수(기본 1)]\n예: /point_exchange https://mcircle.bizmarketb2b.com/Goods/Content.aspx?guid=14131415&catecode=14592 5\n예: /point_exchange 14131415 10',
      );
    }

    const target = parts[0];
    let attempts = 1;
    if (parts.length > 1) {
      const parsed = parseInt(parts[1], 10);
      if (!isNaN(parsed) && parsed > 0) {
        attempts = parsed;
      }
    }

    try {
      await replyWithSplit(ctx, `포인트교환 작업을 시작합니다... (${target}, ${attempts}회 시도, 백그라운드 실행)`);
      runner
        .runTask(task, { args: { url: target }, maxIterations: attempts })
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
            await replyWithSplit(ctx, '포인트교환 작업이 완료되었습니다.');
          } else {
            await replyWithSplit(ctx, '포인트교환 작업이 완료되었습니다.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `포인트교환 실패: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start point_exchange: ${message}`);
    }
  });

  // 단축 명령어 프리셋
  adminBot.command(
    'naverpay_point_exchange',
    createPointExchangeHandler({ name: '네이버페이', guid: '14131415', defaultAttempts: 10 }),
  );
  adminBot.command(
    'baemin_point_exchange',
    createPointExchangeHandler({ name: '배민', guid: '14152303', defaultAttempts: 1 }),
  );
  adminBot.command(
    'kakaopay_point_exchange',
    createPointExchangeHandler({ name: '카카오페이 1만원', guid: '14627547', defaultAttempts: 1 }),
  );
  adminBot.command(
    'kakaopay5k_point_exchange',
    createPointExchangeHandler({ name: '카카오페이 5천원', guid: '14627539', defaultAttempts: 1 }),
  );
  adminBot.command(
    'kakaopay3k_point_exchange',
    createPointExchangeHandler({ name: '카카오페이 3천원', guid: '14627533', defaultAttempts: 1 }),
  );
}
