import type { Telegraf, Context } from 'telegraf';

type BotName = 'admin' | 'notice';

const bots: Partial<Record<BotName, Telegraf | null>> = {
  admin: null,
  notice: null,
};

function setBot(name: BotName, instance: Telegraf | null): void {
  if (Object.prototype.hasOwnProperty.call(bots, name)) {
    bots[name] = instance;

    // Register these commands before any legacy Telegram handler in telegram.ts.
    if (instance) {
      instance.command('check_advanced_seminars', async (ctx: Context) => {
        try {
          const { runCached } = await import('../tasks/check_advanced_seminars');
          const result = runCached();
          await ctx.reply(result.message);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await ctx.reply(`심화 세미나 조회 실패: ${message}`);
        }
      });

      if (name === 'notice') {
        instance.command(['today_links', '오늘의링크', '링크'], async (ctx: Context) => {
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
        });
      }

      instance.command(
        ['subscribe_seminar_changes', 'subscribe_seminar', 'subscribe', '세미나변경알림구독', '구독'],
        async (ctx: Context) => {
          try {
            const chatId = ctx.chat?.id;
            if (!chatId) {
              await ctx.reply('⚠️ 유효하지 않은 채팅방 ID입니다.');
              return;
            }
            const { addSeminarChangeSubscriber } = await import('./seminar_subscribers');
            const isAdded = addSeminarChangeSubscriber(chatId);
            if (isAdded) {
              await ctx.reply(
                '🔔 세미나 정보 변경 알림 구독이 완료되었습니다.\n세미나 일시/상태 변경 및 심화 세미나 포인트 지급 감지 시 알림이 전송됩니다.',
              );
            } else {
              await ctx.reply('ℹ️ 이미 세미나 정보 변경 알림을 구독 중입니다.');
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await ctx.reply(`구독 처리 실패: ${message}`);
          }
        },
      );

      instance.command(
        ['unsubscribe_seminar_changes', 'unsubscribe_seminar', 'unsubscribe', '구독해제', '세미나변경알림구독해제'],
        async (ctx: Context) => {
          try {
            const chatId = ctx.chat?.id;
            if (!chatId) {
              await ctx.reply('⚠️ 유효하지 않은 채팅방 ID입니다.');
              return;
            }
            const { removeSeminarChangeSubscriber } = await import('./seminar_subscribers');
            const isRemoved = removeSeminarChangeSubscriber(chatId);
            if (isRemoved) {
              await ctx.reply('🔕 세미나 정보 변경 알림 구독이 해제되었습니다.');
            } else {
              await ctx.reply('ℹ️ 세미나 정보 변경 알림을 구독하고 있지 않습니다.');
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await ctx.reply(`구독 해제 실패: ${message}`);
          }
        },
      );
    }
  }
}

function getBot(name: BotName): Telegraf | null {
  return (bots[name] as Telegraf | null | undefined) ?? null;
}

export { setBot, getBot, BotName };
