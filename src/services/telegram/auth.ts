import { type Context } from 'telegraf';

export function isAuthorizedAdmin(
  ctx: Pick<Context, 'from' | 'chat'>,
  configuredChatId: string | undefined = process.env.TELEGRAM_CHAT_ID,
): boolean {
  if (!configuredChatId) {
    return false;
  }
  const allowedIds = configuredChatId
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);

  const fromId = ctx.from?.id ? String(ctx.from.id) : undefined;
  const chatId = ctx.chat?.id ? String(ctx.chat.id) : undefined;

  return (fromId !== undefined && allowedIds.includes(fromId)) || (chatId !== undefined && allowedIds.includes(chatId));
}
