import { Telegraf, type Context } from 'telegraf';
import * as logger from '../logger';
import { checkNoticeCooldown } from '../bot_instance';
import { replyWithSplit } from '../../modules/utils';
import {
  recordDiscussionThread,
  recordChannelComment,
  getChannelCommentByMessageId,
  getChannelMessageById,
  getChannelMessageIdByThreadId,
} from '../channel_message_repository';
import { createSeminarDetailHandler } from './seminar_detail_handler';

/**
 * Telegraf Context로부터 토론 댓글의 원본 공지 채널 포스트 ID(parentMessageId) 및 채널 ID를 추출합니다.
 */
export function extractParentMessageId(ctx: Context): {
  parentMessageId: number | null;
  channelId?: string;
} {
  const msg = ctx.message;
  if (!msg) return { parentMessageId: null };

  const targetNoticeChannelId = process.env.NOTICE_CHANNEL_ID;

  // 1. reply_to_message 검사
  const replyTo = 'reply_to_message' in msg ? msg.reply_to_message : undefined;
  if (replyTo) {
    const replyToAny = replyTo as unknown as {
      forward_from_message_id?: number;
      forward_from_chat?: { id?: number | string };
      forward_origin?: { type?: string; message_id?: number; chat?: { id?: number | string } };
      sender_chat?: { type?: string; id?: number | string };
    };
    // 1-1. replyTo가 자동 포워드된 채널 원본 포스트인 경우 (구 Bot API forward_from_message_id)
    if (typeof replyToAny.forward_from_message_id === 'number') {
      const fwdChatId = replyToAny.forward_from_chat?.id ? String(replyToAny.forward_from_chat.id) : undefined;
      return {
        parentMessageId: replyToAny.forward_from_message_id,
        channelId: fwdChatId || targetNoticeChannelId,
      };
    }

    // 1-2. Bot API 7.0+ forward_origin 확인
    const origin = replyToAny.forward_origin;
    if (origin && origin.type === 'channel' && typeof origin.message_id === 'number') {
      const origChatId = origin.chat?.id ? String(origin.chat.id) : undefined;
      return {
        parentMessageId: origin.message_id,
        channelId: origChatId || targetNoticeChannelId,
      };
    }

    // 1-3. replyTo가 채널 자체에서 보낸 메시지인 경우 (sender_chat이 channel)
    if (replyToAny.sender_chat && replyToAny.sender_chat.type === 'channel') {
      if (typeof replyToAny.forward_from_message_id === 'number') {
        return {
          parentMessageId: replyToAny.forward_from_message_id,
          channelId: String(replyToAny.sender_chat.id),
        };
      }
    }

    // 1-4. replyTo가 다른 사람의 댓글인 경우 -> 해당 부모 댓글의 parent_message_id 상속
    const existingComment = getChannelCommentByMessageId(replyTo.message_id);
    if (existingComment && existingComment.parentMessageId) {
      return {
        parentMessageId: existingComment.parentMessageId,
        channelId: existingComment.channelId || targetNoticeChannelId,
      };
    }

    // 1-5. replyTo가 DB에 등록된 채널 공지 메시지 자체인 경우
    const channelMsg = getChannelMessageById(replyTo.message_id);
    if (channelMsg) {
      return {
        parentMessageId: channelMsg.messageId,
        channelId: channelMsg.channelId || targetNoticeChannelId,
      };
    }
  }

  // 2. message_thread_id 검사 (토론방 스레드 ID로 매핑 테이블 조회)
  const threadId = 'message_thread_id' in msg ? msg.message_thread_id : undefined;
  if (threadId) {
    const mappedChannelMsgId = getChannelMessageIdByThreadId(threadId);
    if (mappedChannelMsgId) {
      return {
        parentMessageId: mappedChannelMsgId,
        channelId: targetNoticeChannelId,
      };
    }
  }

  return { parentMessageId: null };
}

export const noticeTodayLinks = async (ctx: Context) => {
  logger.info('User requested cached today_links on notice bot', { from: ctx.from?.username });
  try {
    const { getTodayLinksCache } = await import('../../tasks/today_links');
    const cache = getTodayLinksCache();
    if (cache && cache.message) {
      await replyWithSplit(ctx, cache.message, cache.options as Parameters<Context['reply']>[1]);
    } else {
      await replyWithSplit(
        ctx,
        'ℹ️ 오늘의 링크 정보가 아직 생성되지 않았습니다. 매일 오전 9시 채널 공지 이후 조회하실 수 있습니다.',
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await replyWithSplit(ctx, `오늘의 링크 조회 실패: ${message}`);
  }
};

export function setupNoticeBotMiddleware(noticeBot: Telegraf): void {
  noticeBot.use(async (ctx, next) => {
    // 1. 토론 그룹으로 자동 포워딩된 채널 포스트 스레드 매핑 저장
    if (ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') && ctx.message) {
      const msg = ctx.message as unknown as {
        message_id: number;
        is_automatic_forward?: boolean;
        forward_from_message_id?: number;
        forward_origin?: { type?: string; message_id?: number; chat?: { id?: number | string } };
        forward_from_chat?: { id?: number | string };
      };
      const isAutoForward = msg.is_automatic_forward === true;
      const forwardMsgId =
        msg.forward_from_message_id ||
        (msg.forward_origin?.type === 'channel' ? msg.forward_origin.message_id : undefined);
      const forwardChatId =
        msg.forward_from_chat?.id ||
        (msg.forward_origin?.type === 'channel' ? msg.forward_origin.chat?.id : undefined) ||
        process.env.NOTICE_CHANNEL_ID;

      if (isAutoForward && forwardMsgId) {
        try {
          recordDiscussionThread(msg.message_id, String(forwardChatId), forwardMsgId);
        } catch (err) {
          logger.error('토론 스레드 매핑 저장 실패:', err);
        }
      }
    }

    // 2. 토론 그룹(Group/Supergroup)에서 수신된 일반 댓글 감지 및 parent_message_id 매핑 저장
    if (
      ctx.chat &&
      (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup') &&
      ctx.message &&
      'text' in ctx.message
    ) {
      const text = ctx.message.text.trim();
      const isCommand = text.startsWith('/');
      if (!isCommand && !ctx.from?.is_bot) {
        const userName = ctx.from?.first_name || ctx.from?.username || '익명';
        const userId = ctx.from?.id ? String(ctx.from.id) : undefined;
        const messageId = ctx.message.message_id;

        const { parentMessageId, channelId: extractedChannelId } = extractParentMessageId(ctx);

        if (parentMessageId) {
          const channelId = extractedChannelId || process.env.NOTICE_CHANNEL_ID || String(ctx.chat.id);
          try {
            recordChannelComment({
              channelId,
              messageId,
              parentMessageId,
              userId,
              userName,
              text,
            });
          } catch (err) {
            logger.error('댓글 저장 중 오류 발생:', err);
          }
        }
      }
    }

    const userId = ctx.from?.id;
    if (userId && !checkNoticeCooldown(userId)) {
      await replyWithSplit(ctx, '⏳ 요청이 너무 빠릅니다. 2초 후 다시 시도해주세요.').catch(() => {});
      return;
    }
    return next();
  });

  noticeBot.start((ctx) => replyWithSplit(ctx, 'Welcome!'));
}

export function setupNoticeBotCommands(noticeBot: Telegraf): void {
  noticeBot.command('today_links', noticeTodayLinks);
  noticeBot.command('seminar_detail', createSeminarDetailHandler({ alwaysRefresh: false, showRawMessages: false }));

  noticeBot.command('help', (ctx) => {
    const message = `사용 가능한 명령어:

- /settings (/구독설정): 맞춤 알림 구독 항목 및 시간 설정
- /today_links: 오늘의 세미나/퀴즈/출석 링크 모음
- /intermd_quiz: 인터엠디 오늘의 퀴즈 정답 확인
- /seminar_detail <세미나번호>: 세미나 상세 정보 조회 (예: /seminar_detail 5566)
- /check_advanced_seminars: 최근 2주 심화 세미나 포인트 지급 현황 (방장 계정 기준)
- /help: 도움말`;
    replyWithSplit(ctx, message);
  });
}
