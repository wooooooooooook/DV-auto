import { Telegraf } from 'telegraf';
import * as logger from '../../logger';
import { replyWithSplit } from '../../../modules/utils';
import { isAuthorizedAdmin } from '../auth';
import { createSeminarDetailHandler } from '../seminar_detail_handler';
import { setupExecutionCommands } from './execution';
import { setupQuizCommands } from './quiz';
import { setupPointsCommands } from './points';
import { setupSystemCommands } from './system';

export function setupAdminBotMiddleware(adminBot: Telegraf): void {
  adminBot.catch((err, ctx) => {
    logger.error(`Admin Bot Error for ${ctx.updateType}`, err);
    replyWithSplit(ctx, '오류가 발생했습니다. 로그를 확인해주세요.').catch(() => {});
  });

  // 관리자 권한 검증 미들웨어
  adminBot.use(async (ctx, next) => {
    if (!isAuthorizedAdmin(ctx)) {
      const fromInfo = ctx.from ? `${ctx.from.id} (@${ctx.from.username || 'unknown'})` : 'unknown';
      const chatInfo = ctx.chat ? `${ctx.chat.id} (${ctx.chat.type})` : 'unknown';
      logger.warn(`Unauthorized access attempt to adminBot from: ${fromInfo} in chat: ${chatInfo}`);
      await replyWithSplit(ctx, '⛔ 접근 권한이 없습니다.').catch(() => {});
      return;
    }
    return next();
  });

  adminBot.start((ctx) => replyWithSplit(ctx, 'Welcome, Admin!'));
}

export function setupAdminBotCommands(adminBot: Telegraf): void {
  setupExecutionCommands(adminBot);
  setupQuizCommands(adminBot);
  setupPointsCommands(adminBot);

  // 세미나 상세 정보 조회
  adminBot.command('seminar_detail', createSeminarDetailHandler({ alwaysRefresh: true, showRawMessages: true }));

  setupSystemCommands(adminBot);
}

export function setupAdminBot(adminBot: Telegraf): void {
  setupAdminBotMiddleware(adminBot);
  setupAdminBotCommands(adminBot);
}
