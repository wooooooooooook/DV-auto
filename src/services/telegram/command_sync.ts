import { Telegraf } from 'telegraf';
import fsSync from 'fs';
import path from 'path';
import * as logger from '../logger';
import { isTelegram429Error, getTelegramRetryAfter } from '../../modules/utils';

export const BOT_COMMANDS_CACHE_PATH = path.join(process.cwd(), 'data', 'bot_commands_cache.json');

export function loadBotCommandsCache(): Record<string, string> {
  try {
    if (fsSync.existsSync(BOT_COMMANDS_CACHE_PATH)) {
      return JSON.parse(fsSync.readFileSync(BOT_COMMANDS_CACHE_PATH, 'utf-8'));
    }
  } catch (err) {
    logger.warn('Failed to load bot commands cache:', err);
  }
  return {};
}

export function saveBotCommandsCache(botLabel: string, serializedCommands: string): void {
  try {
    const dir = path.dirname(BOT_COMMANDS_CACHE_PATH);
    if (!fsSync.existsSync(dir)) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
    const cache = loadBotCommandsCache();
    cache[botLabel] = serializedCommands;
    fsSync.writeFileSync(BOT_COMMANDS_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
  } catch (err) {
    logger.warn('Failed to save bot commands cache:', err);
  }
}

export async function syncBotCommands(
  bot: Telegraf,
  commands: Array<{ command: string; description: string }>,
  botLabel: string,
): Promise<void> {
  const serialized = JSON.stringify(commands);
  const cache = loadBotCommandsCache();

  if (cache[botLabel] === serialized) {
    logger.info(`[${botLabel}] Commands are unchanged; skipping sync to avoid Telegram rate limits.`);
    return;
  }

  const scopes: Array<Parameters<Telegraf['telegram']['setMyCommands']>[1]> = [
    { scope: { type: 'default' } },
    { scope: { type: 'all_private_chats' } },
    { scope: { type: 'all_group_chats' } },
    { scope: { type: 'all_chat_administrators' } },
  ];

  let allSuccess = true;

  for (let i = 0; i < scopes.length; i++) {
    const extra = scopes[i];
    try {
      await bot.telegram.setMyCommands(commands, extra);
      if (i < scopes.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (err) {
      allSuccess = false;
      if (isTelegram429Error(err)) {
        const retryAfter = getTelegramRetryAfter(err);
        const retryInfo = retryAfter ? ` (retry after ${retryAfter}s)` : '';
        logger.warn(
          `Failed to set ${botLabel} commands due to rate limit (429)${retryInfo}. Aborting remaining scopes.`,
        );
        break;
      }
      logger.warn(`Failed to set ${botLabel} commands for scope ${extra?.scope?.type}:`, err);
    }
  }

  if (allSuccess) {
    saveBotCommandsCache(botLabel, serialized);
  }
}
