import { sendNotificationToChannel } from '../modules/utils';
import * as logger from './logger';
import * as channelRepo from './channel_message_repository';

export interface PublishAndReplaceOptions {
  channelId?: string;
  prevMessageId: number | null;
  buildMessageFn: (comments: Array<{ userName: string; text: string }>) => {
    text: string;
    options?: Record<string, unknown>;
  };
  customComments?: Array<{ userName: string; text: string }>;
  logPrefix?: string;
  skipIfSameContent?: boolean;
}

/**
 * 공지 채널 메시지를 안전하게 발송하고 이전 메시지를 교체합니다.
 * 1. 기존 메시지 ID의 연결된 댓글 조회/확정 (실패 시 기존 메시지 유지)
 * 2. 새 메시지 본문 빌드 (이전 댓글 첨부)
 * 3. 새 메시지 발송 (실패 시 기존 메시지 유지)
 * 4. 댓글의 attached_to_message_id 갱신 (댓글 보존)
 * 5. 기존 메시지 삭제
 */
export async function publishAndReplaceChannelNotice(
  options: PublishAndReplaceOptions,
): Promise<{ newMessageId: number | null; success: boolean }> {
  const {
    channelId,
    prevMessageId,
    buildMessageFn,
    customComments,
    logPrefix = 'Notice',
    skipIfSameContent = false,
  } = options;
  const targetChannelId = channelId || process.env.NOTICE_CHANNEL_ID;

  // 1. 댓글 데이터 조회 및 준비
  let commentsToAttach: Array<{ userName: string; text: string }> = [];
  let commentsRetrievedSuccessfully = false;

  try {
    if (customComments !== undefined) {
      commentsToAttach = customComments;
      commentsRetrievedSuccessfully = true;
    } else if (prevMessageId) {
      // 기존 메시지 ID에 연결된 댓글만 조회
      const records = channelRepo.getChannelCommentsByParentMessageId(prevMessageId, targetChannelId);
      commentsToAttach = records.map((r) => ({ userName: r.userName, text: r.text }));
      commentsRetrievedSuccessfully = true;
    } else {
      // 이전 메시지가 없는 경우 댓글 없음
      commentsToAttach = [];
      commentsRetrievedSuccessfully = true;
    }
  } catch (err) {
    logger.error(`[${logPrefix}] 댓글 조회/준비 실패:`, err);
    commentsRetrievedSuccessfully = false;
  }

  // Case 1 & Case 3 안전 가드: 댓글 조회 실패 시 안전하게 중단하고 기존 메시지 유지
  if (!commentsRetrievedSuccessfully) {
    logger.error(
      `[${logPrefix}] 댓글 데이터 확보 실패로 인해 메시지 교체를 중단합니다. 기존 메시지(ID: ${prevMessageId}) 유지.`,
    );
    return { newMessageId: prevMessageId, success: false };
  }

  // 2. 메시지 빌드
  let messageContent: { text: string; options?: Record<string, unknown> };
  try {
    messageContent = buildMessageFn(commentsToAttach);
  } catch (err) {
    logger.error(`[${logPrefix}] 메시지 본문 생성 실패:`, err);
    return { newMessageId: prevMessageId, success: false };
  }

  // 동일 내용 스킵 옵션 (autoResume 등)
  if (skipIfSameContent && prevMessageId) {
    const existingMsg = channelRepo.getChannelMessageById(prevMessageId, targetChannelId);
    if (existingMsg && existingMsg.text === messageContent.text) {
      logger.info(`[${logPrefix}] 기존 메시지와 내용이 일치하여 재발송을 건너뜁니다. (ID: ${prevMessageId})`);
      return { newMessageId: prevMessageId, success: true };
    }
  }

  // 3. 새 메시지 발송
  let newMessageId: number | null = null;
  try {
    newMessageId = await sendNotificationToChannel(messageContent.text, null, messageContent.options);
  } catch (err) {
    logger.error(`[${logPrefix}] 새 메시지 발송 중 오류:`, err);
    newMessageId = null;
  }

  // Case 2 안전 가드: 새 메시지 발송 실패 시 기존 메시지 삭제하지 않고 종료
  if (!newMessageId) {
    logger.error(`[${logPrefix}] 새 메시지 발송 실패. 기존 메시지(ID: ${prevMessageId}) 유지.`);
    return { newMessageId: prevMessageId, success: false };
  }

  // 4. 댓글의 attached_to_message_id 갱신 (댓글-새 메시지 연결 보존)
  if (prevMessageId && newMessageId && prevMessageId !== newMessageId) {
    try {
      channelRepo.linkCommentsToNewMessage(prevMessageId, newMessageId, targetChannelId);
    } catch (err) {
      logger.warn(`[${logPrefix}] 댓글 연결 갱신 실패 (무시됨):`, err);
    }

    // 5. 기존 메시지 삭제 (새 메시지 발송 및 댓글 데이터 확보 성공 후에만 수행)
    try {
      await channelRepo.deleteChannelMessage(prevMessageId, targetChannelId);
    } catch (err) {
      logger.warn(`[${logPrefix}] 이전 메시지(ID: ${prevMessageId}) 삭제 실패:`, err);
    }
  }

  return { newMessageId, success: true };
}
