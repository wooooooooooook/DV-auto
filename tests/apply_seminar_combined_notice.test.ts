import assert from 'node:assert';
import { describe, it, vi, beforeEach } from 'vitest';
import {
  truncateSeminarName,
  buildNewSeminarsNoticeMessage,
  publishNewSeminarsNotice,
  type SeminarListItem,
} from '../src/tasks/apply_seminar';
import * as utilsModule from '../src/modules/utils';
import * as channelRepoModule from '../src/services/channel_message_repository';
import * as seminarRepo from '../src/services/seminar_repository';
import { getDatabase } from '../src/services/storage';

describe('신규 세미나 모음 통합 공지 (삭제/재발송) 단위 테스트', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('truncateSeminarName: 세미나명 20글자 truncation 검증', () => {
    const shortName = '짧은 세미나명';
    assert.strictEqual(truncateSeminarName(shortName), shortName);

    const exactly20 = '12345678901234567890';
    assert.strictEqual(truncateSeminarName(exactly20), exactly20);

    const longName = '이것은스무글자를훨씬초과하는매우매우긴세미나제목입니다';
    assert.strictEqual(truncateSeminarName(longName), '이것은스무글자를훨씬초과하는매우매우긴세...');
  });

  it('buildNewSeminarsNoticeMessage: 헤더, 세미나 포맷, 트렁케이션, 구분자 강조 및 댓글 검증', () => {
    const seminars: SeminarListItem[] = [
      {
        seminarId: '101',
        name: '기존에 감지되었던 일반 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        date: '2026-08-27',
        time: '13:00',
        currentCount: '15',
        totalCount: '100',
        nightTime: false,
        isPointExcluded: false,
        isAdvancedSurvey: false,
      },
      {
        seminarId: '102',
        name: '이번에새롭게추가된매우긴제목의심화설문세미나입니다',
        url: 'https://m.doctorville.co.kr/cme/seminar/102',
        date: '2026-08-28',
        time: '19:00',
        currentCount: '5',
        totalCount: '50',
        nightTime: true,
        isPointExcluded: true,
        isAdvancedSurvey: true,
      },
    ];

    const comments = [
      { userName: '홍길동', text: '102번 세미나 기다렸는데 드디어 떴네요!' },
      { userName: '이영희', text: '감사합니다' },
    ];

    // 102번 세미나만 이번 회차에 새로 추가됨 (highlight 대상)
    const { text, options } = buildNewSeminarsNoticeMessage(seminars, ['102'], comments);

    // 1. 헤더 검증
    assert.ok(text.startsWith('🆕 오늘 추가된 세미나 모음 (누적 2건)\n\n'), '헤더가 정확해야 함');

    // 2. 101번 세미나 포맷 (일반, 구분자 없음)
    assert.ok(text.includes('[2026-08-27 13:00] 기존에 감지되었던 일반 세미나 (15/100)'));
    assert.ok(text.includes('https://m.doctorville.co.kr/cme/seminar/101'));

    // 3. 102번 세미나 포맷 (20자 트렁케이션 + 태그 + 구분자 강조)
    assert.ok(
      text.includes(
        '━ ✨ 방금 추가됨 ━━━━━\n[2026-08-28 19:00] [포인트미지급] [심화설문] 이번에새롭게추가된매우긴제목의심화설문세... (5/50)',
      ),
    );
    assert.ok(text.includes('https://m.doctorville.co.kr/cme/seminar/102\n━━━━━━━━━━━━━━━━━━━━━'));

    // 4. 이전 댓글 섹션 검증
    assert.ok(text.includes('💬 [이전 댓글]'));
    assert.ok(text.includes('• 홍길동: 102번 세미나 기다렸는데 드디어 떴네요!'));
    assert.ok(text.includes('• 이영희: 감사합니다'));

    // 5. 옵션 검증 (링크 미리보기 비활성화)
    assert.deepStrictEqual(options.link_preview_options, { is_disabled: true });
  });

  it('buildNewSeminarsNoticeMessage: 정원 10명 미만 세미나 제외 검증', () => {
    const list: SeminarListItem[] = [
      {
        seminarId: '901',
        name: '정원 5명 소규모 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/901',
        time: '13:00',
        nightTime: false,
        isAdvancedSurvey: false,
        totalCount: '5',
        currentCount: '1',
      },
      {
        seminarId: '902',
        name: '정원 10명 일반 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/902',
        time: '13:00',
        nightTime: false,
        isAdvancedSurvey: false,
        totalCount: '10',
        currentCount: '2',
      },
      {
        seminarId: '903',
        name: '정원 100명 대규모 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/903',
        time: '13:00',
        nightTime: false,
        isAdvancedSurvey: false,
        totalCount: '100',
        currentCount: '10',
      },
      {
        seminarId: '904',
        name: '정원 9명 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/904',
        time: '13:00',
        nightTime: false,
        isAdvancedSurvey: false,
        totalCount: '9',
        currentCount: '0',
      },
      {
        seminarId: '905',
        name: '정원 미정 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/905',
        time: '13:00',
        nightTime: false,
        isAdvancedSurvey: false,
        totalCount: '',
        currentCount: '0',
      },
    ];

    const { text } = buildNewSeminarsNoticeMessage(list);

    // 1. 헤더 카운트: 5명, 9명 제외되어 총 3건 (10명, 100명, 미정)
    assert.ok(text.startsWith('🆕 오늘 추가된 세미나 모음 (누적 3건)\n\n'));

    // 2. 5명, 9명 세미나는 미포함
    assert.ok(!text.includes('정원 5명 소규모 세미나'));
    assert.ok(!text.includes('정원 9명 세미나'));

    // 3. 10명, 100명, 미정 세미나는 포함
    assert.ok(text.includes('정원 10명 일반 세미나'));
    assert.ok(text.includes('정원 100명 대규모 세미나'));
    assert.ok(text.includes('정원 미정 세미나'));
  });

  it('publishNewSeminarsNotice: 새 메시지 발송 및 이전 메시지 삭제 동작 검증', async () => {
    const deletedMessageIds: number[] = [];
    const sentMessages: string[] = [];

    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockImplementation(async (text: string) => {
      sentMessages.push(text);
      return 888; // new message ID
    });

    vi.spyOn(channelRepoModule, 'deleteChannelMessage').mockImplementation(async (msgId: number) => {
      deletedMessageIds.push(msgId);
      return { success: true, message: 'deleted' };
    });

    const seminars: SeminarListItem[] = [
      {
        seminarId: '101',
        name: '1번 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        date: '2026-08-27',
        time: '13:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
      },
    ];

    const prevMessageId = 444;
    const newMsgId = await publishNewSeminarsNotice(seminars, prevMessageId, ['101'], [], '2026-08-26');

    assert.strictEqual(newMsgId, 888);
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(deletedMessageIds.length, 1);
    assert.strictEqual(deletedMessageIds[0], 444, '이전 메시지 ID 444가 삭제되어야 함');
  });

  it('channel_messages: getNewSeminarsChannelMessage 조회 검증', () => {
    const db = getDatabase();
    db.prepare('DELETE FROM channel_messages').run();

    channelRepoModule.recordChannelMessage({
      channelId: 'test_chan',
      messageId: 501,
      date: '2026-08-26',
      text: '🆕 오늘 추가된 세미나 모음 (2건)\n\n[2026-08-27] 세미나1...',
    });

    const found = channelRepoModule.getNewSeminarsChannelMessage('2026-08-26', 'test_chan');
    assert.ok(found !== null);
    assert.strictEqual(found.messageId, 501);
  });

  it('seminar_repository: getSeminarsByDetectedDate 조회 검증', () => {
    seminarRepo.clearSeminars();

    const sem1: SeminarListItem = {
      seminarId: '201',
      name: '오늘 감지 세미나 1',
      url: 'https://m.doctorville.co.kr/cme/seminar/201',
      date: '2026-08-28',
      time: '13:00',
      currentCount: '0',
      totalCount: '100',
      nightTime: false,
      isAdvancedSurvey: false,
      detectedDate: '2026-08-26',
    };
    const sem2: SeminarListItem = {
      seminarId: '202',
      name: '오늘 감지 세미나 2',
      url: 'https://m.doctorville.co.kr/cme/seminar/202',
      date: '2026-08-29',
      time: '19:00',
      currentCount: '0',
      totalCount: '100',
      nightTime: true,
      isAdvancedSurvey: true,
      detectedDate: '2026-08-26',
    };
    const semOld: SeminarListItem = {
      seminarId: '199',
      name: '어제 감지 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/199',
      date: '2026-08-27',
      time: '13:00',
      currentCount: '0',
      totalCount: '100',
      nightTime: false,
      isAdvancedSurvey: false,
      detectedDate: '2026-08-25',
    };

    seminarRepo.upsertSeminars([sem1, sem2, semOld]);

    const todayList = seminarRepo.getSeminarsByDetectedDate('2026-08-26');
    assert.strictEqual(todayList.length, 2);
    assert.strictEqual(todayList[0].seminarId, '201');
    assert.strictEqual(todayList[1].seminarId, '202');
  });

  it('다회차 실행 시뮬레이션: 1차(2건) 발송 후 2차(1건 추가) 시 총 3건 통합 발송 및 이전 메시지 삭제 검증', async () => {
    seminarRepo.clearSeminars();
    const deletedIds: number[] = [];
    const sentHistory: Array<{ text: string; id: number }> = [];
    let nextMsgId = 1000;

    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockImplementation(async (text: string) => {
      const id = ++nextMsgId;
      sentHistory.push({ text, id });
      return id;
    });

    vi.spyOn(channelRepoModule, 'deleteChannelMessage').mockImplementation(async (msgId: number) => {
      deletedIds.push(msgId);
      return { success: true, message: 'deleted' };
    });

    const targetDate = '2026-08-26';

    // [1차 실행] 세미나 101, 102 감지
    const batch1: SeminarListItem[] = [
      {
        seminarId: '101',
        name: '101번 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        date: '2026-08-27',
        time: '13:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
        detectedDate: targetDate,
      },
      {
        seminarId: '102',
        name: '102번 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/102',
        date: '2026-08-28',
        time: '19:00',
        currentCount: '20',
        totalCount: '100',
        nightTime: true,
        isAdvancedSurvey: false,
        detectedDate: targetDate,
      },
    ];
    seminarRepo.upsertSeminars(batch1);

    const firstMsgId = await publishNewSeminarsNotice(
      seminarRepo.getSeminarsByDetectedDate(targetDate),
      null,
      ['101', '102'],
      [],
      targetDate,
    );
    assert.strictEqual(firstMsgId, 1001);
    assert.strictEqual(sentHistory.length, 1);
    assert.ok(sentHistory[0].text.includes('🆕 오늘 추가된 세미나 모음 (누적 2건)'));
    assert.strictEqual(deletedIds.length, 0);

    // [2차 실행] 세미나 103 추가 감지
    const batch2Item: SeminarListItem = {
      seminarId: '103',
      name: '103번 신규 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/103',
      date: '2026-08-29',
      time: '13:00',
      currentCount: '5',
      totalCount: '50',
      nightTime: false,
      isAdvancedSurvey: true,
      detectedDate: targetDate,
    };
    seminarRepo.upsertSeminars([batch2Item]);

    const secondMsgId = await publishNewSeminarsNotice(
      seminarRepo.getSeminarsByDetectedDate(targetDate),
      firstMsgId,
      ['103'], // 이번엔 103번만 신규 추가
      [],
      targetDate,
    );

    assert.strictEqual(secondMsgId, 1002);
    assert.strictEqual(sentHistory.length, 2);
    assert.ok(sentHistory[1].text.includes('🆕 오늘 추가된 세미나 모음 (누적 3건)'));
    // 103번에만 구분자가 적용되었는지 검증
    assert.ok(
      sentHistory[1].text.includes('━ ✨ 방금 추가됨 ━━━━━\n[2026-08-29 13:00] [심화설문] 103번 신규 세미나 (5/50)'),
    );
    // 이전 메시지 ID 1001이 삭제되었는지 검증
    assert.strictEqual(deletedIds.length, 1);
    assert.strictEqual(deletedIds[0], 1001);
  });
});
