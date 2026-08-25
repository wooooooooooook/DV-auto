import { getBot } from './bot_instance';
import * as storage from './storage';
import { splitTelegramMessage, TELEGRAM_SAFE_MESSAGE_LENGTH } from '../modules/telegram_splitter';
import { sleep } from '../modules/utils';

export const SEMINAR_CHANGE_SUBSCRIBERS_KEY = 'seminar_change_subscribers';

/**
 * 세미나 정보 변경 알림 구독자 목록(chatId 배열)을 조회합니다.
 */
export function getSeminarChangeSubscribers(): number[] {
  const subscribers = storage.get<number[]>(SEMINAR_CHANGE_SUBSCRIBERS_KEY, []);
  if (!Array.isArray(subscribers)) {
    return [];
  }
  return subscribers;
}

/**
 * 세미나 정보 변경 알림 구독자를 추가합니다.
 * @returns 새로 등록된 경우 true, 이미 등록되어 있던 경우 false
 */
export function addSeminarChangeSubscriber(chatId: number): boolean {
  const subscribers = getSeminarChangeSubscribers();
  if (subscribers.includes(chatId)) {
    return false;
  }
  const updated = [...subscribers, chatId];
  storage.set(SEMINAR_CHANGE_SUBSCRIBERS_KEY, updated);
  return true;
}

/**
 * 세미나 정보 변경 알림 구독자를 해제합니다.
 * @returns 해제된 경우 true, 기존에 등록되어 있지 않았던 경우 false
 */
export function removeSeminarChangeSubscriber(chatId: number): boolean {
  const subscribers = getSeminarChangeSubscribers();
  if (!subscribers.includes(chatId)) {
    return false;
  }
  const updated = subscribers.filter((id) => id !== chatId);
  storage.set(SEMINAR_CHANGE_SUBSCRIBERS_KEY, updated);
  return true;
}

/**
 * 공지봇(noticeBot)을 통해 세미나 정보 변경 알림 구독자들에게 메시지를 발송합니다.
 * 차단되었거나 유효하지 않은 채팅방은 자동으로 구독자 목록에서 정리됩니다.
 */
export async function sendSeminarChangesToSubscribers(
  message: string,
): Promise<{ successCount: number; failCount: number }> {
  const subscribers = getSeminarChangeSubscribers();
  if (subscribers.length === 0) {
    return { successCount: 0, failCount: 0 };
  }

  const bot = getBot('notice');
  if (!bot) {
    console.warn('[seminar_subscribers] 공지봇(noticeBot)이 초기화되지 않아 구독자 알림을 발송할 수 없습니다.');
    return { successCount: 0, failCount: subscribers.length };
  }

  let successCount = 0;
  let failCount = 0;
  const invalidChatIds: number[] = [];

  for (const chatId of subscribers) {
    try {
      const chunks = splitTelegramMessage(message, { maxLength: TELEGRAM_SAFE_MESSAGE_LENGTH });
      for (let i = 0; i < chunks.length; i++) {
        await bot.telegram.sendMessage(chatId, chunks[i]);
        if (i < chunks.length - 1) {
          await sleep(100);
        }
      }
      successCount++;
    } catch (error) {
      failCount++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[seminar_subscribers] chatId(${chatId}) 메시지 발송 실패:`, errorMessage);

      // 봇 차단, 대화방 없음, 계정 비활성화 등 복구 불가능한 에러인 경우 정리 대상으로 등록
      const lower = errorMessage.toLowerCase();
      if (
        lower.includes('forbidden') ||
        lower.includes('blocked') ||
        lower.includes('chat not found') ||
        lower.includes('deactivated')
      ) {
        invalidChatIds.push(chatId);
      }
    }
  }

  if (invalidChatIds.length > 0) {
    for (const invalidId of invalidChatIds) {
      removeSeminarChangeSubscriber(invalidId);
    }
    console.log(
      `[seminar_subscribers] 유효하지 않은 구독자 ${invalidChatIds.length}명 자동 구독 해제 완료:`,
      invalidChatIds,
    );
  }

  return { successCount, failCount };
}
