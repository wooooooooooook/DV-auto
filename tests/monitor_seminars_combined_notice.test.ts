import assert from 'node:assert';
import { describe, it, vi, beforeEach } from 'vitest';
import {
  buildSeminarStatusMessage,
  publishSeminarStatusNotice,
  hasSeminarStatusTransition,
  parsePrevNoticeSeminars,
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
    assert.ok(text.includes('🟢 입장가능 | 1번 점심 세미나 [심화설문]'));
    assert.ok(text.includes('https://m.doctorville.co.kr/cme/seminar/101'));
    assert.ok(text.includes('⏳ 대기 | 2번 점심 세미나'));
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

    assert.ok(text.includes('🔴 종료 | 1번 점심 세미나'));
    assert.ok(text.includes('퀴즈 정답 123'));
    assert.ok(!text.includes('✅ Q1: 정답1 (1번)'), '공지 채널 현황에는 상세 퀴즈 문항이 제외되어야 함');
    assert.ok(text.includes('🟢 입장가능 | 2번 점심 세미나'));
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

    assert.ok(text.includes('🔴 종료 | 1번 점심 세미나'));
    assert.ok(text.includes('🔴 종료 | 2번 점심 세미나'));
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

  it('세미나 상태 변경(종료 등) 발생 시 삭제 후 재전송(publishSeminarStatusNotice) 검증', async () => {
    const deletedMessageIds: number[] = [];
    const sentMessages: string[] = [];

    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockImplementation(async (text: string) => {
      sentMessages.push(text);
      return 999;
    });

    vi.spyOn(channelRepoModule, 'deleteChannelMessage').mockImplementation(async (msgId: number) => {
      deletedMessageIds.push(msgId);
      return { success: true, message: 'deleted' };
    });

    // 종료 상태로 변경된 세미나 목록
    const seminars: MonitoredSeminarItem[] = [
      {
        seminarId: '101',
        name: '종료된 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        status: '종료',
      },
    ];

    const prevMsgId = 888;
    const newMsgId = await publishSeminarStatusNotice('점심', seminars, prevMsgId, false, false);

    assert.strictEqual(newMsgId, 999);
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(deletedMessageIds.length, 1);
    assert.strictEqual(
      deletedMessageIds[0],
      888,
      '세미나 종료 시 기존 메시지 ID 888이 삭제되고 새 메시지가 발송되어야 함',
    );
  });

  describe('hasSeminarStatusTransition 상태 전이 판별 테스트', () => {
    it('동일한 종료 상태에서 댓글/설문시간만 달라진 경우 상태 전이 없음(false)을 반환해야 함', () => {
      const prevText = `🔔 저녁세미나

🔴 종료 | 18:30~20:00 BEYOND Web Symposium
https://m.doctorville.co.kr/cme/seminar/5612
(설문 마감 약 40분 남음)

🔴 종료 | 18:30~20:00 [EZcare WEEK] 개원가의 눈
https://m.doctorville.co.kr/cme/seminar/5638
(설문 마감 약 60분 남음)

💬 [이전 댓글]
• 영욱: 테스트 댓글입니다.`;

      const currentSeminars: MonitoredSeminarItem[] = [
        {
          seminarId: '5612',
          name: 'BEYOND Web Symposium',
          url: 'https://m.doctorville.co.kr/cme/seminar/5612',
          status: '종료',
        },
        {
          seminarId: '5638',
          name: '[EZcare WEEK] 개원가의 눈',
          url: 'https://m.doctorville.co.kr/cme/seminar/5638',
          status: '종료',
        },
      ];

      const result = hasSeminarStatusTransition(prevText, currentSeminars);
      assert.strictEqual(result, false, '세미나 상태가 둘 다 여전히 종료이므로 상태 전이가 없어야 함');
    });

    it('대기에서 입장가능으로 변경된 경우 상태 전이 있음(true)을 반환해야 함', () => {
      const prevText = `🔔 저녁세미나

⏳ 대기 | 18:30~20:00 BEYOND Web Symposium
https://m.doctorville.co.kr/cme/seminar/5612`;

      const currentSeminars: MonitoredSeminarItem[] = [
        {
          seminarId: '5612',
          name: 'BEYOND Web Symposium',
          url: 'https://m.doctorville.co.kr/cme/seminar/5612',
          status: '입장가능',
        },
      ];

      const result = hasSeminarStatusTransition(prevText, currentSeminars);
      assert.strictEqual(result, true, '대기 -> 입장가능 변경 감지');
    });

    it('입장가능에서 종료로 변경된 경우 상태 전이 있음(true)을 반환해야 함', () => {
      const prevText = `🔔 저녁세미나

🟢 입장가능 | 18:30~20:00 BEYOND Web Symposium
https://m.doctorville.co.kr/cme/seminar/5612`;

      const currentSeminars: MonitoredSeminarItem[] = [
        {
          seminarId: '5612',
          name: 'BEYOND Web Symposium',
          url: 'https://m.doctorville.co.kr/cme/seminar/5612',
          status: '종료',
        },
      ];

      const result = hasSeminarStatusTransition(prevText, currentSeminars);
      assert.strictEqual(result, true, '입장가능 -> 종료 변경 감지');
    });

    it('이전에 없던 신규 세미나가 추가된 경우 상태 전이 있음(true)을 반환해야 함', () => {
      const prevText = `🔔 저녁세미나

🔴 종료 | 18:30~20:00 BEYOND Web Symposium
https://m.doctorville.co.kr/cme/seminar/5612`;

      const currentSeminars: MonitoredSeminarItem[] = [
        {
          seminarId: '5612',
          name: 'BEYOND Web Symposium',
          url: 'https://m.doctorville.co.kr/cme/seminar/5612',
          status: '종료',
        },
        {
          seminarId: '9999',
          name: '새로운 세미나',
          url: 'https://m.doctorville.co.kr/cme/seminar/9999',
          status: '종료',
        },
      ];

      const result = hasSeminarStatusTransition(prevText, currentSeminars);
      assert.strictEqual(result, true, '신규 세미나 추가 감지');
    });

    it('기존 메시지에 있던 세미나가 삭제/취소되어 현재 목록에서 사라진 경우 상태 전이 있음(true)을 반환해야 함', () => {
      const prevText = `🔔 저녁세미나

🔴 종료 | 18:30~20:00 BEYOND Web Symposium
https://m.doctorville.co.kr/cme/seminar/5612

🔴 종료 | 18:30~20:00 [EZcare WEEK] 개원가의 눈
https://m.doctorville.co.kr/cme/seminar/5638`;

      // 5638번 세미나가 취소/삭제되어 현재 목록에서 빠진 상태
      const currentSeminars: MonitoredSeminarItem[] = [
        {
          seminarId: '5612',
          name: 'BEYOND Web Symposium',
          url: 'https://m.doctorville.co.kr/cme/seminar/5612',
          status: '종료',
        },
      ];

      const result = hasSeminarStatusTransition(prevText, currentSeminars);
      assert.strictEqual(
        result,
        true,
        '세미나가 삭제되어 목록에서 줄어들었으므로 상태 전이(공지 갱신 필요)로 판정해야 함',
      );
    });

    it('동일한 prefix 제목을 가진 세미나 2개가 있을 때 seminarId로 각각 정확히 독립 매칭되는지 검증', () => {
      const prevText = `🔔 저녁세미나

🔴 종료 | 18:30~20:00 [EZcare WEEK] 개원가의 눈 1일차
https://m.doctorville.co.kr/cme/seminar/5601

🟢 입장가능 | 18:30~20:00 [EZcare WEEK] 개원가의 눈 2일차
https://m.doctorville.co.kr/cme/seminar/5602`;

      // 1. 둘 다 이전 상태와 동일한 경우 -> 상태 전이 없음 (false)
      const currentSame: MonitoredSeminarItem[] = [
        {
          seminarId: '5601',
          name: '[EZcare WEEK] 개원가의 눈 1일차',
          url: 'https://m.doctorville.co.kr/cme/seminar/5601',
          status: '종료',
        },
        {
          seminarId: '5602',
          name: '[EZcare WEEK] 개원가의 눈 2일차',
          url: 'https://m.doctorville.co.kr/cme/seminar/5602',
          status: '입장가능',
        },
      ];
      assert.strictEqual(
        hasSeminarStatusTransition(prevText, currentSame),
        false,
        '제목 앞부분이 같아도 seminarId 기준으로 각각 매칭되어 상태가 동일하면 false',
      );

      // 2. 5602번 세미나만 종료로 바뀐 경우 -> 상태 전이 감지 (true)
      const currentChanged: MonitoredSeminarItem[] = [
        {
          seminarId: '5601',
          name: '[EZcare WEEK] 개원가의 눈 1일차',
          url: 'https://m.doctorville.co.kr/cme/seminar/5601',
          status: '종료',
        },
        {
          seminarId: '5602',
          name: '[EZcare WEEK] 개원가의 눈 2일차',
          url: 'https://m.doctorville.co.kr/cme/seminar/5602',
          status: '종료', // 입장가능 -> 종료
        },
      ];
      assert.strictEqual(
        hasSeminarStatusTransition(prevText, currentChanged),
        true,
        '5602번 세미나의 상태 전이를 정확히 감지해야 함',
      );
    });

    it('parsePrevNoticeSeminars: 정규식 기반 라인 시작 prefix 상태 파싱 및 seminarId 추출 검증', () => {
      const text = `🔔 점심세미나

🔴 종료 | 12:30~13:30 당뇨 세미나
https://m.doctorville.co.kr/cme/seminar/1001

🟢 입장가능 | 13:00~14:00 고혈압 세미나
https://m.doctorville.co.kr/cme/seminar/1002

⏳ 대기 | 14:00~15:00 비만 세미나
https://m.doctorville.co.kr/cme/seminar/1003`;

      const parsed = parsePrevNoticeSeminars(text);
      assert.strictEqual(parsed.length, 3);

      assert.strictEqual(parsed[0].status, '종료');
      assert.strictEqual(parsed[0].seminarId, '1001');

      assert.strictEqual(parsed[1].status, '입장가능');
      assert.strictEqual(parsed[1].seminarId, '1002');

      assert.strictEqual(parsed[2].status, '대기');
      assert.strictEqual(parsed[2].seminarId, '1003');
    });

    it('이전 텍스트가 빈 문자열이거나 없는 경우 상태 전이 있음(true)을 반환해야 함', () => {
      const currentSeminars: MonitoredSeminarItem[] = [
        {
          seminarId: '5612',
          name: 'BEYOND Web Symposium',
          url: 'https://m.doctorville.co.kr/cme/seminar/5612',
          status: '종료',
        },
      ];

      assert.strictEqual(hasSeminarStatusTransition('', currentSeminars), true);
    });
  });
});
