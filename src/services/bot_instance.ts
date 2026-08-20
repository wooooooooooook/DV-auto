import type { Telegraf, Context } from 'telegraf';

type BotName = 'admin' | 'notice';

const bots: Partial<Record<BotName, Telegraf | null>> = {
  admin: null,
  notice: null,
};

function setBot(name: BotName, instance: Telegraf | null): void {
  if (Object.prototype.hasOwnProperty.call(bots, name)) {
    bots[name] = instance;

    // Register this command before the legacy Telegram handler in telegram.ts.
    // The command only reads local history, so it must reply immediately without
    // starting the old browser/background workflow.
    if (name === 'admin' && instance) {
      instance.command('check_advanced_seminars', async (ctx: Context) => {
        try {
          const { run } = await import('../tasks/check_advanced_seminars');
          const result = run();
          await ctx.reply(result.message);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await ctx.reply(`심화 세미나 조회 실패: ${message}`);
        }
      });
    }
  }
}

function getBot(name: BotName): Telegraf | null {
  return (bots[name] as Telegraf | null | undefined) ?? null;
}

export { setBot, getBot, BotName };
