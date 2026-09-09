import { Telegraf } from 'telegraf';
import https from 'https';
import { setBot } from './bot_instance';
import * as logger from './logger';
import { adminCommands, noticeCommands } from './telegram/command_definitions';
import { syncBotCommands } from './telegram/command_sync';
import { setupNoticeBotMiddleware, setupNoticeBotCommands } from './telegram/notice_handlers';
import { setupAdminBot } from './telegram/admin_handlers';

const ADMIN_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const NOTICE_BOT_TOKEN = process.env.NOTICE_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!ADMIN_BOT_TOKEN) {
  logger.warn('TELEGRAM_BOT_TOKEN is not set. The admin bot will not be initialized.');
}
if (!NOTICE_BOT_TOKEN) {
  logger.warn('NOTICE_BOT_TOKEN is not set. The notice bot will not be initialized.');
}
if (!ADMIN_CHAT_ID) {
  logger.warn('TELEGRAM_CHAT_ID is not set. Admin bot access will be restricted for all users.');
}

// Force IPv4 for Telegram API requests to work around network issues
const ipv4Agent = new https.Agent({ family: 4 });

const adminBot = ADMIN_BOT_TOKEN ? new Telegraf(ADMIN_BOT_TOKEN, { telegram: { agent: ipv4Agent } }) : null;
const noticeBot = NOTICE_BOT_TOKEN ? new Telegraf(NOTICE_BOT_TOKEN, { telegram: { agent: ipv4Agent } }) : null;

function attachGlobalLinkPreviewDisabled(bot: Telegraf): void {
  const origCallApi = bot.telegram.callApi.bind(bot.telegram);
  bot.telegram.callApi = async function (method, data, options) {
    if (data && typeof data === 'object' && !('link_preview_options' in data)) {
      (data as Record<string, unknown>).link_preview_options = { is_disabled: true };
    }
    return origCallApi(method, data, options);
  };
}

if (adminBot) {
  attachGlobalLinkPreviewDisabled(adminBot);
  setBot('admin', adminBot);
  setupAdminBot(adminBot);
}

if (noticeBot) {
  attachGlobalLinkPreviewDisabled(noticeBot);
  setBot('notice', noticeBot);
  noticeBot.catch((err, ctx) => {
    logger.error(`Notice Bot Error for ${ctx.updateType}`, err);
  });
  setupNoticeBotMiddleware(noticeBot);
  setupNoticeBotCommands(noticeBot);
}

function launch(): void {
  if (adminBot) {
    adminBot.launch();
    logger.info('Admin bot started');
    syncBotCommands(adminBot, adminCommands, 'Admin bot').catch((err) =>
      logger.error('Failed to sync admin bot commands', err),
    );
  }
  if (noticeBot) {
    noticeBot.launch();
    logger.info('Notice bot started');
    syncBotCommands(noticeBot, noticeCommands, 'Notice bot').catch((err) =>
      logger.error('Failed to sync notice bot commands', err),
    );
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
