import assert from 'node:assert';
import { describe, it, vi, beforeEach } from 'vitest';
import {
  buildSeminarStatusMessage,
  publishSeminarStatusNotice,
  type MonitoredSeminarItem,
} from '../src/tasks/monitor_seminars';
import * as utilsModule from '../src/modules/utils';
import * as channelRepoModule from '../src/services/channel_message_repository';

describe('세미나 모니터링 통합 메시지 (삭제/재발송) 단위 테스트', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('buildSeminarStatusMessage: 대기 및 입장가능 상태 메시지 포맷과 인라인 키보드 검증', () => {
    const seminars: MonitoredSeminarItem[] = [
      {
        seminarId: '101',
        name: '1번 점심 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        status: '입장가능',
        isAdvancedSurvey: true,
      },
      {
        seminarId: '102',
        name: '2번 점심 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/102',
        status: '대기',
      },
    ];

    const { text, options } = buildSeminarStatusMessage('점심', seminars, false);

    // 1. 헤더 검증
    assert.ok(text.startsWith('🔔 점심세미나\n\n'));

    // 2. 세미나별 상태 이모티콘 및 태그 검증
    assert.ok(text.includes('🟢 입장가능 | **1번 점심 세미나** [심화설문]'));
    assert.ok(text.includes('https://m.doctorville.co.kr/cme/seminar/101'));
    assert.ok(text.includes('⏳ 대기 | **2번 점심 세미나**'));
    assert.ok(text.includes('https://m.doctorville.co.kr/cme/seminar/102'));

    // 3. 옵션 검증 (인라인 키보드 미부착, 링크 미리보기 비활성화)
    assert.strictEqual(options.reply_markup, undefined);
    assert.deepStrictEqual(options.link_preview_options, { is_disabled: true });

    // 4. 아직 미완료이므로 종료 문구 없음
    assert.ok(!text.includes('점심세미나가 모두 종료되었습니다'));
  });

  it('buildSeminarStatusMessage: 세미나 종료 및 퀴즈 정답 포함 포맷 검증', () => {
    const seminars: MonitoredSeminarItem[] = [
      {
        seminarId: '101',
        name: '1번 점심 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        status: '종료',
        quizResultMessage: '퀴즈 정답 123\n✅ Q1: 정답1 (1번)\n✅ Q2: 정답2 (2번)',
      },
      {
        seminarId: '102',
        name: '2번 점심 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/102',
        status: '입장가능',
      },
    ];

    const { text } = buildSeminarStatusMessage('점심', seminars, false);

    assert.ok(text.includes('🔴 종료 | **1번 점심 세미나**'));
    assert.ok(text.includes('퀴즈 정답 123'));
    assert.ok(text.includes('✅ Q1: 정답1 (1번)'));
    assert.ok(text.includes('🟢 입장가능 | **2번 점심 세미나**'));
  });

  it('buildSeminarStatusMessage: 모든 세미나 종료 시 하단 종료 안내 문구 결합 검증', () => {
    const seminars: MonitoredSeminarItem[] = [
      {
        seminarId: '101',
        name: '1번 점심 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        status: '종료',
        quizResultMessage: '퀴즈 정답 12',
      },
      {
        seminarId: '102',
        name: '2번 점심 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/102',
        status: '종료',
        hasSurvey: false,
      },
    ];

    const { text } = buildSeminarStatusMessage('점심', seminars, true);

    assert.ok(text.includes('🔴 종료 | **1번 점심 세미나**'));
    assert.ok(text.includes('🔴 종료 | **2번 점심 세미나**'));
    assert.ok(text.includes('(설문이 없는 세미나)'));
    assert.ok(text.includes('━━━━━━━━━━━━━━━━━━'));
    assert.ok(text.includes('🏁 점심세미나가 모두 종료되었습니다.'));
  });

  it('publishSeminarStatusNotice: 새 메시지 발송 및 이전 메시지 삭제 동작 검증', async () => {
    const deletedMessageIds: number[] = [];
    const sentMessages: string[] = [];

    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockImplementation(async (text: string) => {
      sentMessages.push(text);
      return 777; // new message ID
    });

    vi.spyOn(channelRepoModule, 'deleteChannelMessage').mockImplementation(async (msgId: number) => {
      deletedMessageIds.push(msgId);
      return { success: true, message: 'deleted' };
    });

    const seminars: MonitoredSeminarItem[] = [
      {
        seminarId: '101',
        name: '1번 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        status: '입장가능',
      },
    ];

    const newMsgId = await publishSeminarStatusNotice('점심', seminars, 555, false, false);

    assert.strictEqual(newMsgId, 777);
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(deletedMessageIds.length, 1);
    assert.strictEqual(deletedMessageIds[0], 555, '이전 메시지 ID 555가 삭제되어야 함');
  });

  it('publishSeminarStatusNotice: autoResume 시 기존 메시지와 동일하면 재발송 생략 검증', async () => {
    const seminars: MonitoredSeminarItem[] = [
      {
        seminarId: '101',
        name: '1번 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        status: '입장가능',
      },
    ];

    vi.spyOn(channelRepoModule, 'getChannelCommentsByParentMessageId').mockReturnValue([]);
    const { text } = buildSeminarStatusMessage('점심', seminars, false, []);

    vi.spyOn(channelRepoModule, 'getChannelMessageById').mockReturnValue({
      id: 1,
      channelId: 'channel_1',
      messageId: 555,
      date: '2026-08-26',
      chunkIndex: 0,
      totalChunks: 1,
      text, // 동일한 텍스트
      mediaType: 'text',
      status: 'sent',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const sendSpy = vi.spyOn(utilsModule, 'sendNotificationToChannel');
    const deleteSpy = vi.spyOn(channelRepoModule, 'deleteChannelMessage');

    const resultMsgId = await publishSeminarStatusNotice('점심', seminars, 555, false, true, []);

    assert.strictEqual(resultMsgId, 555);
    assert.strictEqual(sendSpy.mock.calls.length, 0, '내용이 일치하므로 새 메시지를 보내지 않아야 함');
    assert.strictEqual(deleteSpy.mock.calls.length, 0, '내용이 일치하므로 기존 메시지를 삭제하지 않아야 함');
  });

  it('buildSeminarStatusMessage: 이전 댓글 섹션 첨부 검증', () => {
    const seminars: MonitoredSeminarItem[] = [
      {
        seminarId: '101',
        name: '1번 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        status: '입장가능',
      },
    ];

    const comments = [
      { userName: '홍길동', text: '1번 문제 정답 3번인 것 같아요' },
      { userName: '김철수', text: '1-2-4 맞습니다!' },
    ];

    const { text } = buildSeminarStatusMessage('점심', seminars, false, comments);

    assert.ok(text.includes('💬 [이전 댓글]'));
    assert.ok(text.includes('• 홍길동: 1번 문제 정답 3번인 것 같아요'));
    assert.ok(text.includes('• 김철수: 1-2-4 맞습니다!'));
  });

  it('channel_comments: recordChannelComment 및 cleanOldChannelComments 1일 TTL 검증', async () => {
    const { getDatabase } = await import('../src/services/storage');
    const db = getDatabase();
    db.prepare('DELETE FROM channel_comments').run();

    channelRepoModule.recordChannelComment({
      channelId: 'test_chan',
      messageId: 1001,
      parentMessageId: 100,
      date: '2026-08-25', // 어제
      userName: '어제유저',
      text: '어제 댓글',
    });

    channelRepoModule.recordChannelComment({
      channelId: 'test_chan',
      messageId: 1002,
      parentMessageId: 100,
      date: '2026-08-26', // 오늘
      userName: '오늘유저',
      text: '오늘 댓글',
    });

    const todayComments = channelRepoModule.getChannelCommentsByDate('2026-08-26');
    assert.strictEqual(todayComments.length, 1);
    assert.strictEqual(todayComments[0].userName, '오늘유저');
    assert.strictEqual(todayComments[0].text, '오늘 댓글');
  });
});
