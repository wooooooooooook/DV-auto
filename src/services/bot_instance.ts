import type { Telegraf, Context } from 'telegraf';

type BotName = 'admin' | 'notice';

const bots: Partial<Record<BotName, Telegraf | null>> = {
  admin: null,
  notice: null,
};

const NOTICE_USER_COOLDOWN_MS = 2000;
const noticeUserLastRequestMap = new Map<number, number>();

function checkNoticeCooldown(userId: number, cooldownMs = NOTICE_USER_COOLDOWN_MS): boolean {
  const now = Date.now();
  const lastTime = noticeUserLastRequestMap.get(userId) || 0;
  if (now - lastTime < cooldownMs) {
    return false;
  }
  noticeUserLastRequestMap.set(userId, now);
  if (noticeUserLastRequestMap.size > 5000) {
    for (const [uid, time] of noticeUserLastRequestMap.entries()) {
      if (now - time > 60000) {
        noticeUserLastRequestMap.delete(uid);
      }
    }
  }
  return true;
}

function clearNoticeCooldowns(): void {
  noticeUserLastRequestMap.clear();
}

function setBot(name: BotName, instance: Telegraf | null): void {
  if (Object.prototype.hasOwnProperty.call(bots, name)) {
    bots[name] = instance;

    // Register these commands before any legacy Telegram handler in telegram.ts.
    if (instance) {
      instance.command('check_advanced_seminars', async (ctx: Context) => {
        try {
          if (name === 'notice' && ctx.from?.id && !checkNoticeCooldown(ctx.from.id)) {
            await ctx.reply('⏳ 요청이 너무 빠릅니다. 2초 후 다시 시도해주세요.');
            return;
          }
          const { runCached } = await import('../tasks/check_advanced_seminars');
          const result = runCached();
          await ctx.reply(result.message);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await ctx.reply(`심화 세미나 조회 실패: ${message}`);
        }
      });

      if (name === 'notice') {
        instance.command('today_links', async (ctx: Context) => {
          try {
            if (ctx.from?.id && !checkNoticeCooldown(ctx.from.id)) {
              await ctx.reply('⏳ 요청이 너무 빠릅니다. 2초 후 다시 시도해주세요.');
              return;
            }
            const { getTodayLinksCache } = await import('../tasks/today_links');
            const { replyWithSplit } = await import('../modules/utils');
            const cache = getTodayLinksCache();
            if (cache && cache.message) {
              await replyWithSplit(ctx, cache.message, cache.options as Parameters<Context['reply']>[1]);
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

        instance.command('intermd_quiz', async (ctx: Context) => {
          try {
            if (ctx.from?.id && !checkNoticeCooldown(ctx.from.id)) {
              await ctx.reply('⏳ 요청이 너무 빠릅니다. 2초 후 다시 시도해주세요.');
              return;
            }
            const { getInterMDQuizCache } = await import('../tasks/intermd_quiz');
            const { replyWithSplit } = await import('../modules/utils');
            const cache = getInterMDQuizCache();
            if (cache && cache.formattedMessage) {
              await replyWithSplit(ctx, cache.formattedMessage);
            } else {
              await ctx.reply(
                'ℹ️ 오늘의 인터엠디 퀴즈 정보가 아직 등록되지 않았거나 오늘 출제된 퀴즈가 없습니다. 매일 오전 8시 1분 퀴즈 진행 후 확인하실 수 있습니다.',
              );
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await ctx.reply(`인터엠디 퀴즈 조회 실패: ${message}`);
          }
        });

        instance.command('subscribe_intermd_quiz', async (ctx: Context) => {
          try {
            if (ctx.from?.id && !checkNoticeCooldown(ctx.from.id)) {
              await ctx.reply('⏳ 요청이 너무 빠릅니다. 2초 후 다시 시도해주세요.');
              return;
            }
            const chatId = ctx.chat?.id;
            if (!chatId) {
              await ctx.reply('⚠️ 유효하지 않은 채팅방 ID입니다.');
              return;
            }
            const { addInterMDQuizSubscriber } = await import('./intermd_quiz_subscribers');
            const isAdded = addInterMDQuizSubscriber(chatId);
            if (isAdded) {
              await ctx.reply(
                '🔔 인터엠디 오늘의 퀴즈 알림 구독이 완료되었습니다.\n매일 오전 8시 1분 퀴즈 정답 및 상세 정보가 발송됩니다. (퀴즈가 없는 날은 발송되지 않습니다)',
              );
            } else {
              await ctx.reply('ℹ️ 이미 인터엠디 퀴즈 알림을 구독 중입니다.');
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await ctx.reply(`구독 처리 실패: ${message}`);
          }
        });

        instance.command('unsubscribe_intermd_quiz', async (ctx: Context) => {
          try {
            if (ctx.from?.id && !checkNoticeCooldown(ctx.from.id)) {
              await ctx.reply('⏳ 요청이 너무 빠릅니다. 2초 후 다시 시도해주세요.');
              return;
            }
            const chatId = ctx.chat?.id;
            if (!chatId) {
              await ctx.reply('⚠️ 유효하지 않은 채팅방 ID입니다.');
              return;
            }
            const { removeInterMDQuizSubscriber } = await import('./intermd_quiz_subscribers');
            const isRemoved = removeInterMDQuizSubscriber(chatId);
            if (isRemoved) {
              await ctx.reply('🔕 인터엠디 퀴즈 알림 구독이 해제되었습니다.');
            } else {
              await ctx.reply('ℹ️ 인터엠디 퀴즈 알림을 구독하고 있지 않습니다.');
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            await ctx.reply(`구독 해제 실패: ${message}`);
          }
        });
        instance.command(
          ['start', 'subscribe_settings', '구독설정', '구독', 'settings', 'subscribe'],
          async (ctx: Context) => {
            try {
              if (ctx.from?.id && !checkNoticeCooldown(ctx.from.id)) {
                await ctx.reply('⏳ 요청이 너무 빠릅니다. 2초 후 다시 시도해주세요.');
                return;
              }
              const chatId = ctx.chat?.id;
              if (!chatId) {
                await ctx.reply('⚠️ 유효하지 않은 채팅방 ID입니다.');
                return;
              }
              const { buildMainMenu } = await import('./subscription_service');
              const { text, replyMarkup } = buildMainMenu(chatId);
              await ctx.reply(text, {
                parse_mode: 'HTML',
                reply_markup: replyMarkup,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              await ctx.reply(`구독 설정 조회 실패: ${message}`);
            }
          },
        );

        // 콜백 쿼리 (인라인 키보드 인터랙션)
        if (typeof instance.action === 'function') {
          instance.action(/^sub:(.+)$/, async (ctx: Context & { match?: RegExpExecArray }) => {
            try {
              const chatId = ctx.chat?.id;
              if (!chatId) {
                await ctx.answerCbQuery('⚠️ 유효하지 않은 채팅방 ID입니다.').catch(() => {});
                return;
              }

              const actionData = ctx.match?.[1] || '';
              const subService = await import('./subscription_service');

              if (actionData.startsWith('toggle:')) {
                const topic = actionData.replace('toggle:', '') as Parameters<typeof subService.toggleTopic>[1];
                subService.toggleTopic(chatId, topic);
                await ctx.answerCbQuery('설정이 변경되었습니다.').catch(() => {});
                const { text, replyMarkup } = subService.buildMainMenu(chatId);
                await ctx
                  .editMessageText(text, {
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup,
                  })
                  .catch(() => {});
                return;
              }

              if (actionData === 'menu:today_links_time') {
                await ctx.answerCbQuery().catch(() => {});
                const { text, replyMarkup } = subService.buildTodayLinksTimeMenu(chatId);
                await ctx
                  .editMessageText(text, {
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup,
                  })
                  .catch(() => {});
                return;
              }

              if (actionData.startsWith('set_time:')) {
                const time = actionData.replace('set_time:', '');
                subService.setTodayLinksTime(chatId, time);
                await ctx.answerCbQuery(`오늘의 링크 시간이 ${time}으로 설정되었습니다.`).catch(() => {});
                const { text, replyMarkup } = subService.buildMainMenu(chatId);
                await ctx
                  .editMessageText(text, {
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup,
                  })
                  .catch(() => {});
                return;
              }

              if (actionData === 'menu:new_seminar') {
                await ctx.answerCbQuery().catch(() => {});
                const { text, replyMarkup } = subService.buildNewSeminarMenu(chatId);
                await ctx
                  .editMessageText(text, {
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup,
                  })
                  .catch(() => {});
                return;
              }

              if (actionData.startsWith('set_new_seminar:')) {
                const filter = actionData.replace('set_new_seminar:', '') as Parameters<
                  typeof subService.setNewSeminarFilter
                >[1];
                subService.setNewSeminarFilter(chatId, filter);
                const label = subService.getNewSeminarFilterLabel(filter);
                await ctx.answerCbQuery(`신규 세미나 알림이 [${label}] (으)로 설정되었습니다.`).catch(() => {});
                const { text, replyMarkup } = subService.buildMainMenu(chatId);
                await ctx
                  .editMessageText(text, {
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup,
                  })
                  .catch(() => {});
                return;
              }

              if (actionData === 'all_on') {
                subService.setAllTopics(chatId, true);
                await ctx.answerCbQuery('모든 알림이 켜졌습니다.').catch(() => {});
                const { text, replyMarkup } = subService.buildMainMenu(chatId);
                await ctx
                  .editMessageText(text, {
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup,
                  })
                  .catch(() => {});
                return;
              }

              if (actionData === 'all_off') {
                subService.setAllTopics(chatId, false);
                await ctx.answerCbQuery('모든 알림이 꺼졌습니다.').catch(() => {});
                const { text, replyMarkup } = subService.buildMainMenu(chatId);
                await ctx
                  .editMessageText(text, {
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup,
                  })
                  .catch(() => {});
                return;
              }

              if (actionData === 'menu:main') {
                await ctx.answerCbQuery().catch(() => {});
                const { text, replyMarkup } = subService.buildMainMenu(chatId);
                await ctx
                  .editMessageText(text, {
                    parse_mode: 'HTML',
                    reply_markup: replyMarkup,
                  })
                  .catch(() => {});
                return;
              }

              if (actionData === 'close') {
                await ctx.answerCbQuery('구독 설정이 완료되었습니다.').catch(() => {});
                await ctx.deleteMessage().catch(async () => {
                  await ctx
                    .editMessageText('✅ <b>구독 설정이 완료되었습니다.</b>', { parse_mode: 'HTML' })
                    .catch(() => {});
                });
                return;
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              await ctx.answerCbQuery(`오류 발생: ${message}`).catch(() => {});
            }
          });
        }
      }

      instance.command('subscribe_seminar_changes', async (ctx: Context) => {
        try {
          if (name === 'notice' && ctx.from?.id && !checkNoticeCooldown(ctx.from.id)) {
            await ctx.reply('⏳ 요청이 너무 빠릅니다. 2초 후 다시 시도해주세요.');
            return;
          }
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
      });

      instance.command('unsubscribe_seminar_changes', async (ctx: Context) => {
        try {
          if (name === 'notice' && ctx.from?.id && !checkNoticeCooldown(ctx.from.id)) {
            await ctx.reply('⏳ 요청이 너무 빠릅니다. 2초 후 다시 시도해주세요.');
            return;
          }
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
      });
    }
  }
}

function getBot(name: BotName): Telegraf | null {
  return (bots[name] as Telegraf | null | undefined) ?? null;
}

export { setBot, getBot, BotName, checkNoticeCooldown, clearNoticeCooldowns };
