import assert from 'node:assert';
import * as storage from '../src/services/storage';
import {
  SEMINAR_CHANGE_SUBSCRIBERS_KEY,
  getSeminarChangeSubscribers,
  addSeminarChangeSubscriber,
  removeSeminarChangeSubscriber,
  sendSeminarChangesToSubscribers,
} from '../src/services/seminar_subscribers';
import { setBot } from '../src/services/bot_instance';
import type { Telegraf } from 'telegraf';
import { describe, it } from 'vitest';

describe('세미나 정보 변경 알림 구독 및 발송 테스트', () => {
  it('구독자 등록, 조회 및 일괄 알림 발송 검증', async () => {
    console.log('=== [Test] 세미나 정보 변경 알림 구독 및 발송 테스트 시작 ===\n');

    const originalSubscribers = storage.get(SEMINAR_CHANGE_SUBSCRIBERS_KEY);

    try {
      // 1. 구독자 등록 및 조회 단위 테스트
      storage.set(SEMINAR_CHANGE_SUBSCRIBERS_KEY, []);
      assert.deepStrictEqual(getSeminarChangeSubscribers(), []);

      // 1-1. 신규 구독자 추가
      const added1 = addSeminarChangeSubscriber(12345);
      assert.strictEqual(added1, true, '첫 구독은 true를 반환해야 함');
      assert.deepStrictEqual(getSeminarChangeSubscribers(), [12345]);

      // 1-2. 중복 구독자 추가 시도
      const addedDuplicate = addSeminarChangeSubscriber(12345);
      assert.strictEqual(addedDuplicate, false, '중복 구독 시 false를 반환해야 함');
      assert.deepStrictEqual(getSeminarChangeSubscribers(), [12345]);

      // 1-3. 추가 구독자 등록
      const added2 = addSeminarChangeSubscriber(67890);
      assert.strictEqual(added2, true);
      assert.deepStrictEqual(getSeminarChangeSubscribers(), [12345, 67890]);
      console.log('  ✓ [Pass] 구독자 등록, 중복 방지 및 조회 검증 완료');

      // 1-4. 구독자 해제
      const removed1 = removeSeminarChangeSubscriber(12345);
      assert.strictEqual(removed1, true, '존재하는 구독자 해제 시 true 반환');
      assert.deepStrictEqual(getSeminarChangeSubscribers(), [67890]);

      // 1-5. 미등록 구독자 해제 시도
      const removedNonExistent = removeSeminarChangeSubscriber(99999);
      assert.strictEqual(removedNonExistent, false, '존재하지 않는 구독자 해제 시 false 반환');
      assert.deepStrictEqual(getSeminarChangeSubscribers(), [67890]);
      console.log('  ✓ [Pass] 구독자 해제 및 예외 케이스 검증 완료');

      // 2. 공지봇 커맨드 핸들러 동작 검증
      storage.set(SEMINAR_CHANGE_SUBSCRIBERS_KEY, []);

      const registeredCommands: Record<string, (ctx: unknown) => Promise<unknown>> = {};
      const mockBot = {
        command: (cmd: string | string[], handler: (ctx: unknown) => Promise<unknown>) => {
          if (Array.isArray(cmd)) {
            for (const c of cmd) {
              registeredCommands[c] = handler;
            }
          } else {
            registeredCommands[cmd] = handler;
          }
        },
      } as unknown as Telegraf;

      setBot('notice', mockBot);

      assert(
        typeof registeredCommands['subscribe_seminar_changes'] === 'function',
        'subscribe_seminar_changes 커맨드 등록 확인',
      );
      assert(
        typeof registeredCommands['unsubscribe_seminar_changes'] === 'function',
        'unsubscribe_seminar_changes 커맨드 등록 확인',
      );

      // 2-1. 커맨드를 통한 구독 테스트
      let replyMsg = '';
      const mockCtxSubscribe = {
        chat: { id: 111222 },
        reply: async (msg: string) => {
          replyMsg = msg;
        },
      };

      await registeredCommands['subscribe_seminar_changes'](mockCtxSubscribe);
      assert(replyMsg.includes('구독이 완료되었습니다'), '구독 완료 안내 메시지 확인');
      assert.deepStrictEqual(getSeminarChangeSubscribers(), [111222]);

      // 2-2. 커맨드를 통한 중복 구독 테스트
      replyMsg = '';
      await registeredCommands['subscribe_seminar_changes'](mockCtxSubscribe);
      assert(replyMsg.includes('이미'), '중복 구독 안내 메시지 확인');
      assert.deepStrictEqual(getSeminarChangeSubscribers(), [111222]);

      // 2-3. 커맨드를 통한 구독 해제 테스트
      replyMsg = '';
      await registeredCommands['unsubscribe_seminar_changes'](mockCtxSubscribe);
      assert(replyMsg.includes('구독이 해제되었습니다'), '구독 해제 안내 메시지 확인');
      assert.deepStrictEqual(getSeminarChangeSubscribers(), []);

      // 2-4. 커맨드를 통한 미구독 상태 해제 시도
      replyMsg = '';
      await registeredCommands['unsubscribe_seminar_changes'](mockCtxSubscribe);
      assert(replyMsg.includes('구독하고 있지 않습니다'), '미구독 상태 안내 메시지 확인');
      console.log(
        '  ✓ [Pass] 공지봇 커맨드 핸들러(/subscribe_seminar_changes, /unsubscribe_seminar_changes) 동작 검증 완료',
      );

      // 3. 메시지 발송(sendSeminarChangesToSubscribers) 및 차단된 사용자 자동 정리 검증
      storage.set(SEMINAR_CHANGE_SUBSCRIBERS_KEY, [100, 200, 300]);
      const sentMessages: Array<{ chatId: number; text: string }> = [];

      const mockBotForSend = {
        telegram: {
          sendMessage: async (chatId: number, text: string) => {
            if (chatId === 200) {
              throw new Error('403 Forbidden: bot was blocked by the user');
            }
            sentMessages.push({ chatId, text });
            return { message_id: 1 };
          },
        },
        command: () => {},
      } as unknown as Telegraf;

      setBot('notice', mockBotForSend);

      const sendResult = await sendSeminarChangesToSubscribers('🔔 [테스트] 세미나 정보 변경 알림');
      assert.strictEqual(sendResult.successCount, 2, '성공 2건');
      assert.strictEqual(sendResult.failCount, 1, '실패 1건');
      assert.deepStrictEqual(
        sentMessages.map((m) => m.chatId),
        [100, 300],
        '100, 300번 구독자에게 메시지 발송됨',
      );

      // 차단된 200번 사용자는 구독자 목록에서 자동 정리되어야 함
      assert.deepStrictEqual(
        getSeminarChangeSubscribers(),
        [100, 300],
        '차단된 200번 구독자는 목록에서 자동 해제되어야 함',
      );
      console.log('  ✓ [Pass] 구독자 일괄 알림 발송 및 차단 사용자(403) 자동 정리 검증 완료');

      console.log('\n🎉 모든 세미나 정보 변경 알림 구독 및 발송 테스트 100% 통과!');
    } finally {
      if (originalSubscribers !== undefined) {
        storage.set(SEMINAR_CHANGE_SUBSCRIBERS_KEY, originalSubscribers);
      }
    }
  });
});
