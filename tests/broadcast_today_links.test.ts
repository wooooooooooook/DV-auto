import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { Telegraf } from 'telegraf';
import * as storage from '../src/services/storage';
import { setBot } from '../src/services/bot_instance';
import {
  recordChannelMessage,
  getTodayLinksChannelMessage,
  editChannelMessage,
  getSeoulDateString,
} from '../src/services/channel_message_repository';
import {
  sendOrUpdateTodayLinksNotification,
  type BroadcastTodayLinksResult,
} from '../src/services/broadcast_today_links';
import { describe, it } from 'vitest';

const testDbPath = path.join(__dirname, '..', 'data', 'test_broadcast_today_links.db');
process.env.SQLITE_DB_PATH = testDbPath;
process.env.NOTICE_CHANNEL_ID = '-1001234567890';
storage.setDatabasePath(testDbPath);

describe('broadcast_today_links 공지 메시지 수정 기능 테스트', () => {
  it('공지 메시지 수정 및 갱신 기능 검증', async () => {
    console.log('=== [Test] broadcast_today_links 공지 메시지 수정 기능 테스트 시작 ===\n');

    storage.clear();

    const mockChannelId = '-1001234567890';
    const today = getSeoulDateString();
    const yesterday = getSeoulDateString(new Date(Date.now() - 24 * 60 * 60 * 1000));

    let editCalls: Array<{ channelId: string; messageId: number; text: string }> = [];
    let sendCalls: Array<{ channelId: string; text: string }> = [];
    let nextMessageId = 10000;
    let throwEditError: Error | null = null;

    const mockNoticeBot = {
      command: () => {},
      telegram: {
        editMessageText: async (channelId: string, messageId: number, _inlineId: unknown, text: string) => {
          if (throwEditError) {
            throw throwEditError;
          }
          editCalls.push({ channelId, messageId, text });
          return true;
        },
        sendMessage: async (channelId: string, text: string) => {
          const id = ++nextMessageId;
          sendCalls.push({ channelId, text });
          return { message_id: id };
        },
      },
    } as unknown as Telegraf;

    setBot('notice', mockNoticeBot);

    // 1. getTodayLinksChannelMessage 식별 검증
    console.log('1. getTodayLinksChannelMessage 식별 검증');
    assert.strictEqual(getTodayLinksChannelMessage(today), null, '초기에는 today_links 메시지가 없어야 함');

    // 일반 공지(포인트 전환) 등록
    recordChannelMessage({
      channelId: mockChannelId,
      messageId: 5001,
      date: today,
      text: '네이버페이포인트 전환이 가능해졌습니다\nhttps://www.doctorville.co.kr/...',
      mediaType: 'text',
    });
    assert.strictEqual(getTodayLinksChannelMessage(today), null, '일반 공지는 today_links로 식별되지 않아야 함');

    // today_links 공지 등록
    const todayLinksText =
      '✨ <b>출석체크:</b> https://m.doctorville.co.kr/mypage/attendance\n\n✏️ <b>오늘의 퀴즈:</b> 오늘은 퀴즈가 없습니다. ☕';
    recordChannelMessage({
      channelId: mockChannelId,
      messageId: 5002,
      date: today,
      text: todayLinksText,
      mediaType: 'text',
    });

    const identified = getTodayLinksChannelMessage(today);
    assert.ok(identified !== null, 'today_links 메시지가 식별되어야 함');
    assert.strictEqual(identified?.messageId, 5002);
    console.log('  ✓ getTodayLinksChannelMessage 정상 동작');

    // 2. editChannelMessage의 'message is not modified' 예외 처리 검증
    console.log('2. editChannelMessage message is not modified 처리 검증');
    throwEditError = new Error('400: Bad Request: message is not modified: specified new message content is the same');
    const sameEditRes = await editChannelMessage(5002, todayLinksText);
    assert.strictEqual(sameEditRes.success, true, 'message is not modified는 성공으로 처리되어야 함');
    throwEditError = null;
    console.log('  ✓ message is not modified 에러 시 정상 성공 처리 검증 완료');

    // 3. sendOrUpdateTodayLinksNotification 검증
    console.log('3. sendOrUpdateTodayLinksNotification 신규 발송 및 수정 검증');
    storage.clear();
    sendCalls = [];
    editCalls = [];

    // 3-1. 오늘 처음 broadcast_today_links 실행 시 -> 새로 전송 ('sent')
    const initialText = '✨ 출석체크: https://m.doctorville.co.kr/mypage/attendance\n✏️ 오늘의 퀴즈: 퀴즈1\n1. 세미나A';
    const result1: BroadcastTodayLinksResult = await sendOrUpdateTodayLinksNotification(initialText, {
      parse_mode: 'HTML',
    });

    assert.strictEqual(result1.success, true);
    assert.strictEqual(result1.action, 'sent');
    assert.strictEqual(sendCalls.length, 1);
    assert.strictEqual(editCalls.length, 0);
    const firstMsgId = result1.messageId;
    assert.ok(firstMsgId !== null);

    const savedRecord = getTodayLinksChannelMessage(today);
    assert.strictEqual(savedRecord?.messageId, firstMsgId);
    assert.strictEqual(savedRecord?.status, 'sent');
    console.log('  ✓ 첫 실행 시 신규 발송(sent) 및 DB 기록 성공');

    // 3-2. 같은 날 다시 broadcast_today_links 실행 시 -> 새로 보내지 않고 기존 메시지 수정 ('edited')
    const updatedText =
      '✨ 출석체크: https://m.doctorville.co.kr/mypage/attendance\n✏️ 오늘의 퀴즈: 퀴즈1 (정답: 123)\n1. 세미나A\n2. 세미나B 추가됨';
    const result2: BroadcastTodayLinksResult = await sendOrUpdateTodayLinksNotification(updatedText, {
      parse_mode: 'HTML',
    });

    assert.strictEqual(result2.success, true);
    assert.strictEqual(result2.action, 'edited');
    assert.strictEqual(result2.messageId, firstMsgId, '기존 메시지 ID와 동일해야 함');
    assert.strictEqual(sendCalls.length, 1, '새 메시지가 발송되지 않아야 함');
    assert.strictEqual(editCalls.length, 1, '메시지 수정 API가 1회 호출되어야 함');
    assert.strictEqual(editCalls[0].messageId, firstMsgId);
    assert.strictEqual(editCalls[0].text, updatedText);

    const updatedRecord = getTodayLinksChannelMessage(today);
    assert.strictEqual(updatedRecord?.status, 'edited');
    assert.strictEqual(updatedRecord?.text, updatedText);
    console.log('  ✓ 재실행 시 신규 발송 없이 기존 메시지 수정(edited) 성공');

    // 3-3. 기존 메시지 수정 실패 시 (예: 채널에서 메시지 삭제됨) -> 신규 발송 fallback 검증
    console.log('4. 기존 메시지 수정 실패 시 Fallback 신규 발송 검증');
    throwEditError = new Error('400: Bad Request: message to edit not found');
    const fallbackText = '✨ 출석체크: https://m.doctorville.co.kr/mypage/attendance\n✏️ 오늘의 퀴즈: 새 퀴즈';
    const resultFallback = await sendOrUpdateTodayLinksNotification(fallbackText);

    assert.strictEqual(resultFallback.success, true);
    assert.strictEqual(resultFallback.action, 'sent', '수정 실패 시 신규 발송으로 fallback');
    assert.strictEqual(sendCalls.length, 2, '새 메시지가 전송되어 총 전송 수 2회');
    assert.notStrictEqual(resultFallback.messageId, firstMsgId, '새로운 messageId가 발급되어야 함');
    throwEditError = null;
    console.log('  ✓ 수정 실패 시 Fallback 신규 발송 성공');

    // 3-4. 다른 날짜(yesterday)에 대해서는 별개로 동작하는지 검증
    console.log('5. 다른 날짜(과거 일자)와의 격리 검증');
    const yesterdayResult = await sendOrUpdateTodayLinksNotification(
      '✨ 출석체크: https://m.doctorville.co.kr/mypage/attendance\n어제 링크',
      {},
      yesterday,
    );
    assert.strictEqual(yesterdayResult.action, 'sent', '어제 날짜에 대한 공지가 없으므로 새로 전송');

    // 정리
    try {
      storage.closeDatabase();
      if (fs.existsSync(testDbPath)) {
        fs.unlinkSync(testDbPath);
      }
    } catch (_e) {
      // ignore
    }

    console.log('\n🎉 모든 broadcast_today_links 공지 메시지 수정 기능 테스트 100% 통과!\n');
  });
});
