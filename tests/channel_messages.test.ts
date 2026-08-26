import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { Telegraf } from 'telegraf';
import * as storage from '../src/services/storage';
import { setBot } from '../src/services/bot_instance';
import {
  recordChannelMessage,
  getChannelMessagesByDate,
  getChannelMessageById,
  getRecentChannelMessages,
  updateChannelMessageStatus,
  editChannelMessage,
  deleteChannelMessage,
  deleteChannelMessagesByDate,
  getSeoulDateString,
} from '../src/services/channel_message_repository';
import { sendNotificationToChannel } from '../src/modules/utils';
import { describe, it } from 'vitest';

// 테스트 DB 설정
const testDbPath = path.join(__dirname, '..', 'data', 'test_channel_messages.db');
process.env.SQLITE_DB_PATH = testDbPath;
process.env.NOTICE_CHANNEL_ID = '-1001234567890';
storage.setDatabasePath(testDbPath);

describe('공지방 텔레그램 메시지 ID 일자별 추적 및 수정/삭제 테스트', () => {
  it('메시지 추적 및 수정/삭제 종합 검증', async () => {
    console.log('=== [Test] 공지방 텔레그램 메시지 ID 일자별 추적 및 수정/삭제 테스트 시작 ===\n');

    // 테스트 전 DB 초기화
    storage.clear();

    const mockChannelId = '-1001234567890';
    const today = getSeoulDateString();
    const yesterday = getSeoulDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));

    // --- 1. recordChannelMessage 및 getChannelMessagesByDate 단위 테스트 ---
    console.log('1. recordChannelMessage 및 getChannelMessagesByDate 검증');
    const record1 = recordChannelMessage({
      channelId: mockChannelId,
      messageId: 1001,
      date: today,
      chunkIndex: 0,
      totalChunks: 2,
      text: '오늘의 첫 번째 공지 청크',
      mediaType: 'text',
    });

    const record2 = recordChannelMessage({
      channelId: mockChannelId,
      messageId: 1002,
      date: today,
      chunkIndex: 1,
      totalChunks: 2,
      text: '오늘의 두 번째 공지 청크',
      mediaType: 'text',
    });

    const recordOld = recordChannelMessage({
      channelId: mockChannelId,
      messageId: 900,
      date: yesterday,
      chunkIndex: 0,
      totalChunks: 1,
      text: '어제의 공지',
      mediaType: 'text',
    });

    assert.strictEqual(record1.messageId, 1001);
    assert.strictEqual(record1.chunkIndex, 0);
    assert.strictEqual(record2.messageId, 1002);
    assert.strictEqual(record2.chunkIndex, 1);

    const todayMessages = getChannelMessagesByDate(today);
    assert.strictEqual(todayMessages.length, 2, '오늘 메시지는 2건이어야 함');
    assert.strictEqual(todayMessages[0].messageId, 1001);
    assert.strictEqual(todayMessages[1].messageId, 1002);

    const yesterdayMessages = getChannelMessagesByDate(yesterday);
    assert.strictEqual(yesterdayMessages.length, 1, '어제 메시지는 1건이어야 함');
    assert.strictEqual(yesterdayMessages[0].messageId, 900);
    console.log('  ✓ recordChannelMessage 및 날짜별 조회 정상 동작');

    // --- 2. getChannelMessageById 및 getRecentChannelMessages 검증 ---
    console.log('2. getChannelMessageById 및 getRecentChannelMessages 검증');
    const fetched = getChannelMessageById(1001);
    assert.ok(fetched !== null, '1001번 메시지가 조회되어야 함');
    assert.strictEqual(fetched?.text, '오늘의 첫 번째 공지 청크');

    const notFound = getChannelMessageById(999999);
    assert.strictEqual(notFound, null, '존재하지 않는 메시지는 null 반환');

    const recents = getRecentChannelMessages(10);
    assert.strictEqual(recents.length, 3, '총 3건의 메시지가 최근 목록에 포함되어야 함');
    console.log('  ✓ 단건 조회 및 최근 메시지 조회 정상 동작');

    // --- 3. updateChannelMessageStatus 검증 ---
    console.log('3. updateChannelMessageStatus 검증');
    const updated = updateChannelMessageStatus(1001, 'edited', '수정된 첫 번째 공지 청크');
    assert.strictEqual(updated, true);

    const afterUpdate = getChannelMessageById(1001);
    assert.strictEqual(afterUpdate?.status, 'edited');
    assert.strictEqual(afterUpdate?.text, '수정된 첫 번째 공지 청크');
    console.log('  ✓ 메시지 상태 및 내용 업데이트 정상 동작');

    // --- 4. Mock Bot 환경에서 editChannelMessage 검증 ---
    console.log('4. editChannelMessage (텍스트 & 포토) 연동 검증');
    let editMessageTextCalls: Array<{ channelId: string; messageId: number; text: string }> = [];
    let editMessageCaptionCalls: Array<{ channelId: string; messageId: number; caption: string }> = [];
    let deleteMessageCalls: Array<{ channelId: string; messageId: number }> = [];

    const mockNoticeBot = {
      command: () => {},
      telegram: {
        editMessageText: async (channelId: string, messageId: number, _inlineId: unknown, text: string) => {
          editMessageTextCalls.push({ channelId, messageId, text });
          return true;
        },
        editMessageCaption: async (channelId: string, messageId: number, _inlineId: unknown, caption: string) => {
          editMessageCaptionCalls.push({ channelId, messageId, caption });
          return true;
        },
        deleteMessage: async (channelId: string, messageId: number) => {
          deleteMessageCalls.push({ channelId, messageId });
          return true;
        },
      },
    } as unknown as Telegraf;

    setBot('notice', mockNoticeBot);

    // 4-1. 텍스트 메시지 수정
    const textEditResult = await editChannelMessage(1002, '수정된 두 번째 공지');
    assert.strictEqual(textEditResult.success, true);
    assert.strictEqual(editMessageTextCalls.length, 1);
    assert.strictEqual(editMessageTextCalls[0].messageId, 1002);
    assert.strictEqual(editMessageTextCalls[0].text, '수정된 두 번째 공지');

    const editedRecord = getChannelMessageById(1002);
    assert.strictEqual(editedRecord?.status, 'edited');
    assert.strictEqual(editedRecord?.text, '수정된 두 번째 공지');

    // 4-2. 포토 메시지 수정
    recordChannelMessage({
      channelId: mockChannelId,
      messageId: 2001,
      date: today,
      chunkIndex: 0,
      totalChunks: 1,
      text: '원본 캡션',
      mediaType: 'photo',
    });

    const photoEditResult = await editChannelMessage(2001, '수정된 사진 캡션');
    assert.strictEqual(photoEditResult.success, true);
    assert.strictEqual(editMessageCaptionCalls.length, 1);
    assert.strictEqual(editMessageCaptionCalls[0].messageId, 2001);
    assert.strictEqual(editMessageCaptionCalls[0].caption, '수정된 사진 캡션');
    console.log('  ✓ editChannelMessage 텍스트 및 캡션 수정 연동 성공');

    // --- 5. deleteChannelMessage 및 deleteChannelMessagesByDate 검증 ---
    console.log('5. deleteChannelMessage 및 deleteChannelMessagesByDate 검증');
    const deleteResult = await deleteChannelMessage(1001);
    assert.strictEqual(deleteResult.success, true);
    assert.strictEqual(deleteMessageCalls.length, 1);
    assert.strictEqual(deleteMessageCalls[0].messageId, 1001);

    const deletedRecord = getChannelMessageById(1001);
    assert.strictEqual(deletedRecord?.status, 'deleted');

    // 일괄 삭제 테스트 (남은 오늘자 메시지 1002, 2001 삭제)
    const batchDeleteResult = await deleteChannelMessagesByDate(today);
    assert.strictEqual(batchDeleteResult.success, true);
    assert.strictEqual(batchDeleteResult.total, 2, '삭제 대상 2건');
    assert.strictEqual(batchDeleteResult.deletedCount, 2, '삭제 성공 2건');

    const todayAfterBatch = getChannelMessagesByDate(today).filter((m) => m.status !== 'deleted');
    assert.strictEqual(todayAfterBatch.length, 0, '오늘 활성 메시지가 남아있지 않아야 함');
    console.log('  ✓ deleteChannelMessage 및 deleteChannelMessagesByDate 정상 동작');

    // --- 6. sendNotificationToChannel 호출 시 자동 DB 기록 연동 검증 ---
    console.log('6. sendNotificationToChannel 자동 DB 추적 연동 검증');
    let currentMsgIdCounter = 5000;
    const sentMessages: Array<{ text?: string; photo?: unknown }> = [];

    const fullMockNoticeBot = {
      command: () => {},
      telegram: {
        sendMessage: async (_channelId: string, text: string) => {
          const id = ++currentMsgIdCounter;
          sentMessages.push({ text });
          return { message_id: id };
        },
        sendPhoto: async (_channelId: string, photo: unknown, _options?: unknown) => {
          const id = ++currentMsgIdCounter;
          sentMessages.push({ photo });
          return { message_id: id };
        },
      },
    } as unknown as Telegraf;

    setBot('notice', fullMockNoticeBot);

    // 6-1. 단일 텍스트 메시지 전송
    const sendRes1 = await sendNotificationToChannel('단일 테스트 메시지');
    assert.ok(sendRes1 !== null);
    const tracked1 = getChannelMessageById(sendRes1!);
    assert.ok(tracked1 !== null, 'sendNotificationToChannel로 전송된 message_id가 DB에 저장되어야 함');
    assert.strictEqual(tracked1?.text, '단일 테스트 메시지');
    assert.strictEqual(tracked1?.totalChunks, 1);

    // 6-2. 다중 청크 분할 텍스트 메시지 전송
    const longText = '가'.repeat(3000) + '\n' + '나'.repeat(3000);
    const sendRes2 = await sendNotificationToChannel(longText);
    assert.ok(sendRes2 !== null);

    const todayAll = getChannelMessagesByDate(today);
    const chunkedMessages = todayAll.filter((m) => m.messageId > 5001);
    assert.ok(chunkedMessages.length >= 2, '긴 메시지는 2개 이상의 청크로 분할되어 저장되어야 함');
    assert.ok(chunkedMessages.every((m) => m.totalChunks === chunkedMessages.length));
    console.log('  ✓ sendNotificationToChannel 자동 DB 추적 연동 성공');

    // 정리
    try {
      storage.closeDatabase();
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    } catch (_e) {
      // ignore
    }

    console.log('\n🎉 모든 공지방 메시지 ID 추적 및 수정/삭제 테스트 100% 통과!\n');
  });
});
