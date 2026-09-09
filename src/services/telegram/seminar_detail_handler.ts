import { type Context } from 'telegraf';
import * as logger from '../logger';
import { replyWithSplit } from '../../modules/utils';
import { extractSeminarIds } from '../../tasks/seminar_detail';

export interface SeminarDetailHandlerOptions {
  alwaysRefresh?: boolean;
  showRawMessages?: boolean;
}

export const createSeminarDetailHandler = (options: SeminarDetailHandlerOptions | boolean) => async (ctx: Context) => {
  const opts: SeminarDetailHandlerOptions =
    typeof options === 'boolean' ? { alwaysRefresh: options, showRawMessages: options } : options;
  const alwaysRefresh = opts.alwaysRefresh ?? false;
  const showRawMessages = opts.showRawMessages ?? false;

  logger.info('User requested seminar detail', { from: ctx.from?.username, alwaysRefresh, showRawMessages });
  try {
    const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const seminarIds = extractSeminarIds(messageText);
    if (seminarIds.length === 0) {
      return replyWithSplit(
        ctx,
        '사용법: /seminar_detail <세미나번호> [세미나번호...]\n예: /seminar_detail 5566\n   또는 /seminar_detail 5566 5567',
      );
    }

    const MAX_SEMINAR_IDS_PER_REQUEST = 10;
    if (seminarIds.length > MAX_SEMINAR_IDS_PER_REQUEST) {
      return replyWithSplit(ctx, '⚠️ 세미나 번호는 한 번에 최대 10개까지만 조회할 수 있습니다.');
    }

    const { run: runSeminarDetail } = await import('../../tasks/seminar_detail');
    const force = alwaysRefresh;
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
          await replyWithSplit(ctx, msg, { parse_mode: 'Markdown' });
        }
      } else if (r.success !== false && r.message) {
        await replyWithSplit(ctx, r.message, { parse_mode: 'Markdown' });
      } else if (!r.success && r.message) {
        await replyWithSplit(ctx, r.message);
      }

      if (showRawMessages) {
        for (const rawMsg of r.rawMessages ?? []) {
          await replyWithSplit(ctx, rawMsg, { parse_mode: 'Markdown' });
        }
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    replyWithSplit(ctx, `세미나 상세 조회 실패: ${message}`);
  }
};
