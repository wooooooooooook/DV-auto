import type { Telegraf } from 'telegraf';

type BotName = 'admin' | 'notice';

const bots: Partial<Record<BotName, Telegraf | null>> = {
  admin: null,
  notice: null,
};

function setBot(name: BotName, instance: Telegraf | null): void {
  if (Object.prototype.hasOwnProperty.call(bots, name)) {
    bots[name] = instance;
  }
}

function getBot(name: BotName): Telegraf | null {
  return (bots[name] as Telegraf | null | undefined) ?? null;
}

export { setBot, getBot, BotName };
