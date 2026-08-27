import {
  getSubscribersForTopic,
  updateSubscription,
  getSubscription,
  sendToTopicSubscribers,
} from './subscription_service';

export const INTERMD_QUIZ_SUBSCRIBERS_KEY = 'intermd_quiz_subscribers';

/**
 * 인터엠디 오늘의 퀴즈 알림 구독자 목록(chatId 배열)을 조회합니다.
 */
export function getInterMDQuizSubscribers(): number[] {
  return getSubscribersForTopic('intermd_quiz');
}

/**
 * 인터엠디 오늘의 퀴즈 알림 구독자를 추가합니다.
 * @returns 새로 등록된 경우 true, 이미 등록되어 있던 경우 false
 */
export function addInterMDQuizSubscriber(chatId: number): boolean {
  const current = getSubscription(chatId);
  if (current.intermdQuiz) {
    return false;
  }
  updateSubscription(chatId, { intermdQuiz: true });
  return true;
}

/**
 * 인터엠디 오늘의 퀴즈 알림 구독자를 해제합니다.
 * @returns 해제된 경우 true, 기존에 등록되어 있지 않았던 경우 false
 */
export function removeInterMDQuizSubscriber(chatId: number): boolean {
  const current = getSubscription(chatId);
  if (!current.intermdQuiz) {
    return false;
  }
  updateSubscription(chatId, { intermdQuiz: false });
  return true;
}

/**
 * 공지봇(noticeBot)을 통해 인터엠디 오늘의 퀴즈 알림 구독자들에게 메시지를 발송합니다.
 * 차단되었거나 유효하지 않은 채팅방은 자동으로 구독자 목록에서 정리됩니다.
 */
export async function sendInterMDQuizToSubscribers(
  message: string,
): Promise<{ successCount: number; failCount: number }> {
  return sendToTopicSubscribers('intermd_quiz', message);
}
