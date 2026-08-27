import assert from 'node:assert';
import { describe, it, vi, beforeEach } from 'vitest';
import * as utilsModule from '../src/modules/utils';
import * as channelRepoModule from '../src/services/channel_message_repository';
import { publishSeminarStatusNotice, type MonitoredSeminarItem } from '../src/tasks/monitor_seminars';
import { publishNewSeminarsNotice, type SeminarListItem } from '../src/tasks/apply_seminar';
import { extractParentMessageId } from '../src/services/telegram';
import { getDatabase } from '../src/services/storage';

describe('Telegram 댓글 보존 및 공지 메시지 교체 (Comment Retention & Safe Replacement) 단위 테스트', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    const db = getDatabase();
    db.prepare('DELETE FROM channel_messages').run();
    db.prepare('DELETE FROM channel_comments').run();
    db.prepare('DELETE FROM channel_discussion_threads').run();
  });

  // Test 1 — 댓글 없는 메시지
  it('Test 1 — 댓글 없는 메시지: 새 메시지 정상 발송 및 이전 메시지 삭제', async () => {
    const deletedIds: number[] = [];
    let sentText = '';

    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockImplementation(async (text: string) => {
      sentText = text;
      return 101; // new message ID
    });

    vi.spyOn(channelRepoModule, 'deleteChannelMessage').mockImplementation(async (id: number) => {
      deletedIds.push(id);
      return { success: true, message: 'deleted' };
    });

    const seminars: MonitoredSeminarItem[] = [
      {
        seminarId: '1',
        name: '세미나 1',
        url: 'https://m.doctorville.co.kr/cme/seminar/1',
        status: '입장가능',
      },
    ];

    const result = await publishSeminarStatusNotice('점심', seminars, 100);

    assert.strictEqual(result, 101);
    assert.ok(!sentText.includes('💬 [이전 댓글]'), '댓글이 없으므로 이전 댓글 섹션이 없어야 함');
    assert.deepStrictEqual(deletedIds, [100], '이전 메시지 ID 100이 삭제되어야 함');
  });

  // Test 2 — 댓글 1개
  it('Test 2 — 댓글 1개: 이전 메시지의 댓글이 새 메시지에 [이전 댓글] 형태로 첨부되고 이전 메시지 삭제', async () => {
    const deletedIds: number[] = [];
    let sentText = '';

    // 기존 메시지 100번에 달린 댓글 1개 기록
    channelRepoModule.recordChannelComment({
      channelId: 'test_channel',
      messageId: 5001,
      parentMessageId: 100,
      userName: '유저1',
      text: '세미나 문제 정답은 3번입니다.',
    });

    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockImplementation(async (text: string) => {
      sentText = text;
      return 101;
    });

    vi.spyOn(channelRepoModule, 'deleteChannelMessage').mockImplementation(async (id: number) => {
      deletedIds.push(id);
      return { success: true, message: 'deleted' };
    });

    const seminars: MonitoredSeminarItem[] = [
      {
        seminarId: '1',
        name: '세미나 1',
        url: 'https://m.doctorville.co.kr/cme/seminar/1',
        status: '입장가능',
      },
    ];

    const result = await publishSeminarStatusNotice('점심', seminars, 100);

    assert.strictEqual(result, 101);
    assert.ok(sentText.includes('💬 [이전 댓글]'), '이전 댓글 섹션이 포함되어야 함');
    assert.ok(sentText.includes('• 유저1: 세미나 문제 정답은 3번입니다.'));
    assert.deepStrictEqual(deletedIds, [100]);
  });

  // Test 3 — 댓글 여러 개 (최대 5개 제한)
  it('Test 3 — 댓글 여러 개: 7개의 댓글이 있을 때 최근 5개만 본문에 첨부', async () => {
    for (let i = 1; i <= 7; i++) {
      channelRepoModule.recordChannelComment({
        channelId: 'test_channel',
        messageId: 5000 + i,
        parentMessageId: 100,
        userName: `유저${i}`,
        text: `댓글내용_${i}`,
        createdAt: 1000 + i * 10,
      });
    }

    let sentText = '';
    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockImplementation(async (text: string) => {
      sentText = text;
      return 101;
    });
    vi.spyOn(channelRepoModule, 'deleteChannelMessage').mockResolvedValue({ success: true, message: 'deleted' });

    const seminars: SeminarListItem[] = [
      {
        seminarId: '10',
        name: '신규 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/10',
        time: '19:00',
        currentCount: '10',
        totalCount: '50',
        nightTime: false,
        isAdvancedSurvey: false,
      },
    ];

    const result = await publishNewSeminarsNotice(seminars, 100, ['10']);

    assert.strictEqual(result, 101);
    assert.ok(sentText.includes('💬 [이전 댓글]'));
    // 1번, 2번은 제외되고 3, 4, 5, 6, 7번(최근 5개)만 포함되어야 함
    assert.ok(!sentText.includes('• 유저1: 댓글내용_1'));
    assert.ok(!sentText.includes('• 유저2: 댓글내용_2'));
    assert.ok(sentText.includes('• 유저3: 댓글내용_3'));
    assert.ok(sentText.includes('• 유저4: 댓글내용_4'));
    assert.ok(sentText.includes('• 유저5: 댓글내용_5'));
    assert.ok(sentText.includes('• 유저6: 댓글내용_6'));
    assert.ok(sentText.includes('• 유저7: 댓글내용_7'));
  });

  // Test 4 — 다른 공지의 댓글 존재 시 격리 검증
  it('Test 4 — 다른 공지의 댓글 존재: 공지 100의 댓글 A만 첨부되고 공지 200의 댓글 B는 섞이지 않음', async () => {
    // 공지 100에 댓글 A 등록
    channelRepoModule.recordChannelComment({
      channelId: 'test_channel',
      messageId: 5001,
      parentMessageId: 100,
      userName: '유저A',
      text: '세미나A에 대한 댓글',
    });

    // 공지 200에 댓글 B 등록
    channelRepoModule.recordChannelComment({
      channelId: 'test_channel',
      messageId: 5002,
      parentMessageId: 200,
      userName: '유저B',
      text: '세미나B에 대한 댓글',
    });

    let sentText = '';
    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockImplementation(async (text: string) => {
      sentText = text;
      return 101;
    });
    vi.spyOn(channelRepoModule, 'deleteChannelMessage').mockResolvedValue({ success: true, message: 'deleted' });

    const seminars: MonitoredSeminarItem[] = [
      {
        seminarId: '1',
        name: '세미나 1',
        url: 'https://m.doctorville.co.kr/cme/seminar/1',
        status: '입장가능',
      },
    ];

    // 공지 100을 갱신
    await publishSeminarStatusNotice('점심', seminars, 100);

    assert.ok(sentText.includes('• 유저A: 세미나A에 대한 댓글'));
    assert.ok(!sentText.includes('• 유저B: 세미나B에 대한 댓글'), '다른 공지의 댓글 B는 포함되지 않아야 함');
  });

  // Test 5 — 새 메시지 발송 실패 시 기존 메시지 삭제 방지
  it('Test 5 — 새 메시지 발송 실패 시 기존 메시지를 삭제하지 않고 유지', async () => {
    const deletedIds: number[] = [];

    channelRepoModule.recordChannelComment({
      channelId: 'test_channel',
      messageId: 5001,
      parentMessageId: 100,
      userName: '유저1',
      text: '댓글내용',
    });

    // 새 메시지 발송 실패 모의 (null 반환)
    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockResolvedValue(null);

    const deleteSpy = vi.spyOn(channelRepoModule, 'deleteChannelMessage').mockImplementation(async (id: number) => {
      deletedIds.push(id);
      return { success: true, message: 'deleted' };
    });

    const seminars: MonitoredSeminarItem[] = [
      {
        seminarId: '1',
        name: '세미나 1',
        url: 'https://m.doctorville.co.kr/cme/seminar/1',
        status: '입장가능',
      },
    ];

    const result = await publishSeminarStatusNotice('점심', seminars, 100);

    assert.strictEqual(result, 100, '실패 시 기존 메시지 ID를 반환해야 함');
    assert.strictEqual(deleteSpy.mock.calls.length, 0, '기존 메시지를 삭제하지 않아야 함');
    assert.deepStrictEqual(deletedIds, []);
  });

  // Test 6 — 댓글 보존/조회 실패 시 기존 메시지 삭제 방지
  it('Test 6 — 댓글 조회/보존 실패 시 기존 메시지를 유지하고 새 메시지 발송/삭제 중단', async () => {
    const deleteSpy = vi.spyOn(channelRepoModule, 'deleteChannelMessage');
    const sendSpy = vi.spyOn(utilsModule, 'sendNotificationToChannel');

    // DB 댓글 조회 시 강제 에러 모의
    vi.spyOn(channelRepoModule, 'getChannelCommentsByParentMessageId').mockImplementation(() => {
      throw new Error('Database disk I/O error');
    });

    const seminars: MonitoredSeminarItem[] = [
      {
        seminarId: '1',
        name: '세미나 1',
        url: 'https://m.doctorville.co.kr/cme/seminar/1',
        status: '입장가능',
      },
    ];

    const result = await publishSeminarStatusNotice('점심', seminars, 100);

    assert.strictEqual(result, 100);
    assert.strictEqual(sendSpy.mock.calls.length, 0, '새 메시지를 발송하지 않아야 함');
    assert.strictEqual(deleteSpy.mock.calls.length, 0, '기존 메시지를 삭제하지 않아야 함');
  });

  // Test 7 — Telegram discussion update에서 parent_message_id 추출 검증
  describe('Test 7 — extractParentMessageId Telegram Update 구조 검증', () => {
    it('7-1: 구 Bot API forward_from_message_id로 채널 포스트에 직접 답장한 경우', () => {
      const mockCtx = {
        message: {
          message_id: 6001,
          reply_to_message: {
            message_id: 300,
            forward_from_message_id: 100, // 원본 채널 메시지 ID
            forward_from_chat: { id: -1001234567890 },
          },
          text: '직접 답장 댓글',
        },
      } as unknown as Parameters<typeof extractParentMessageId>[0];

      const extracted = extractParentMessageId(mockCtx);
      assert.strictEqual(extracted.parentMessageId, 100);
      assert.strictEqual(extracted.channelId, '-1001234567890');
    });

    it('7-2: Bot API 7.0+ forward_origin(channel)으로 채널 포스트에 직접 답장한 경우', () => {
      const mockCtx = {
        message: {
          message_id: 6002,
          reply_to_message: {
            message_id: 300,
            forward_origin: {
              type: 'channel',
              message_id: 105,
              chat: { id: -1009876543210 },
            },
          },
          text: 'Bot API 7.0 답장 댓글',
        },
      } as unknown as Parameters<typeof extractParentMessageId>[0];

      const extracted = extractParentMessageId(mockCtx);
      assert.strictEqual(extracted.parentMessageId, 105);
      assert.strictEqual(extracted.channelId, '-1009876543210');
    });

    it('7-3: 대댓글(다른 사람의 댓글에 reply)인 경우 부모 댓글의 parent_message_id 상속', () => {
      // 1. 부모 댓글 5001번이 parent_message_id 100으로 DB에 기록됨
      channelRepoModule.recordChannelComment({
        channelId: 'test_channel',
        messageId: 5001,
        parentMessageId: 100,
        userName: '부모유저',
        text: '첫번째 댓글',
      });

      // 2. 5002번 댓글이 5001번에 reply함
      const mockCtx = {
        message: {
          message_id: 5002,
          reply_to_message: {
            message_id: 5001,
            text: '첫번째 댓글',
          },
          text: '대댓글 작성',
        },
      } as unknown as Parameters<typeof extractParentMessageId>[0];

      const extracted = extractParentMessageId(mockCtx);
      assert.strictEqual(extracted.parentMessageId, 100, '부모 댓글의 parent_message_id(100)를 상속받아야 함');
    });

    it('7-4: 토론방 message_thread_id로 스레드 매핑 테이블을 조회하는 경우', () => {
      // 자동 포워딩된 토론 스레드 매핑 (threadId 300 -> channel_message_id 100)
      channelRepoModule.recordDiscussionThread(300, 'test_channel', 100);

      const mockCtx = {
        message: {
          message_id: 6003,
          message_thread_id: 300,
          text: '토픽 스레드 내 일반 댓글',
        },
      } as unknown as Parameters<typeof extractParentMessageId>[0];

      const extracted = extractParentMessageId(mockCtx);
      assert.strictEqual(extracted.parentMessageId, 100);
    });

    it('7-5: 공지와 무관한 일반 그룹 대화는 parentMessageId가 null이어야 함', () => {
      const mockCtx = {
        message: {
          message_id: 7001,
          text: '그냥 잡담',
        },
      } as unknown as Parameters<typeof extractParentMessageId>[0];

      const extracted = extractParentMessageId(mockCtx);
      assert.strictEqual(extracted.parentMessageId, null);
    });
  });

  // Test 8 — N차 재발송 시 댓글 누적 보존 검증
  it('Test 8 — N차 재발송 시 댓글 누적 보존: 100(C1) -> 101(C2) -> 102 갱신 시 [C1, C2] 모두 첨부', async () => {
    let currentChannelMsgId = 100;
    const sentHistory: string[] = [];

    vi.spyOn(channelRepoModule, 'deleteChannelMessage').mockResolvedValue({ success: true, message: 'deleted' });

    // 1. 공지 100번에 댓글 C1 등록
    channelRepoModule.recordChannelComment({
      channelId: 'test_channel',
      messageId: 5001,
      parentMessageId: 100,
      userName: '유저1',
      text: '댓글1',
    });

    // 2. 100번 -> 101번으로 갱신
    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockImplementation(async (text: string) => {
      sentHistory.push(text);
      return 101;
    });

    const seminars: MonitoredSeminarItem[] = [
      {
        seminarId: '1',
        name: '세미나 1',
        url: 'https://m.doctorville.co.kr/cme/seminar/1',
        status: '입장가능',
      },
    ];

    currentChannelMsgId = (await publishSeminarStatusNotice('점심', seminars, currentChannelMsgId))!;
    assert.strictEqual(currentChannelMsgId, 101);
    assert.ok(sentHistory[0].includes('• 유저1: 댓글1'));

    // 3. 새 공지 101번에 새로운 댓글 C2 등록
    channelRepoModule.recordChannelComment({
      channelId: 'test_channel',
      messageId: 5002,
      parentMessageId: 101,
      userName: '유저2',
      text: '댓글2',
    });

    // 4. 101번 -> 102번으로 2차 갱신
    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockImplementation(async (text: string) => {
      sentHistory.push(text);
      return 102;
    });

    currentChannelMsgId = (await publishSeminarStatusNotice('점심', seminars, currentChannelMsgId))!;
    assert.strictEqual(currentChannelMsgId, 102);

    // 2차 갱신 메시지에 댓글1과 댓글2가 모두 포함되어 있는지 확인
    const lastSent = sentHistory[1];
    assert.ok(lastSent.includes('💬 [이전 댓글]'));
    assert.ok(lastSent.includes('• 유저1: 댓글1'));
    assert.ok(lastSent.includes('• 유저2: 댓글2'));
  });
});
