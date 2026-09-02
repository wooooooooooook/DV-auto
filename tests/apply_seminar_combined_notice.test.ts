import assert from 'node:assert';
import { describe, it, vi, beforeEach } from 'vitest';
import {
  truncateSeminarName,
  buildNewSeminarsNoticeMessage,
  publishNewSeminarsNotice,
  extractHighlightedSeminarIds,
  syncNewSeminarsNotice,
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

    // 2. 101번 세미나 포맷 (일반, 구분자 없음, 1. 순번)
    assert.ok(text.includes('1. [2026-08-27 13:00] 기존에 감지되었던 일반 세미나 (15/100)'));
    assert.ok(text.includes('https://m.doctorville.co.kr/cme/seminar/101'));

    // 3. 102번 세미나 포맷 (20자 트렁케이션 + 태그 + 구분자 강조 + 2. 순번)
    assert.ok(
      text.includes(
        '━ ✨ 방금 추가됨 ━━━━━\n2. [2026-08-28 19:00] [포인트미지급] [심화설문] 이번에새롭게추가된매우긴제목의심화설문세... (5/50)',
      ),
    );
    assert.ok(text.includes('https://m.doctorville.co.kr/cme/seminar/102\n━━━━━━━━━━━━━━━━'));

    // 4. 이전 댓글 섹션 검증
    assert.ok(text.includes('💬 [이전 댓글]'));
    assert.ok(text.includes('• 홍길동: 102번 세미나 기다렸는데 드디어 떴네요!'));
    assert.ok(text.includes('• 이영희: 감사합니다'));

    // 5. 옵션 검증 (링크 미리보기 비활성화)
    assert.deepStrictEqual(options.link_preview_options, { is_disabled: true });
  });

  it("buildNewSeminarsNoticeMessage: [비공개], [심혈관질환], '방금 추가됨' 블록이 올바르게 포함되어야 함", () => {
    const item: SeminarListItem = {
      seminarId: '5652',
      name: '개원의를 위한 고혈압 처방 팁',
      url: 'https://m.doctorville.co.kr/cme/seminar/5652',
      date: '2026-09-08',
      time: '13:00~14:00',
      currentCount: '995',
      totalCount: '4000',
      nightTime: false,
      isClosed: true,
      hiddenYn: 'Y',
      diseaseCategoryNm: '심혈관질환',
      isPointExcluded: false,
      isAdvancedSurvey: false,
    };

    const channelNotice = buildNewSeminarsNoticeMessage([item], ['5652']);
    console.log('  ✓ [비공개] 태그 포함 확인');
    assert.ok(channelNotice.text.includes('[비공개]'));
    console.log('  ✓ [심혈관질환] 태그 포함 확인');
    assert.ok(channelNotice.text.includes('[심혈관질환]'));
    console.log('  ✓ [비공개] + [심혈관질환] 순서 확인');
    assert.ok(
      channelNotice.text.includes('[2026-09-08 13:00~14:00] [비공개] [심혈관질환] 개원의를 위한 고혈압 처방 팁'),
    );
  });

  it('buildNewSeminarsNoticeMessage: 질환분류명은 비공개 세미나에만 표시, 공개 세미나는 미표시', () => {
    const privateSeminar: SeminarListItem = {
      seminarId: '5652',
      name: '비공개 심혈관 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/5652',
      date: '2026-09-08',
      time: '13:00~14:00',
      totalCount: '4000',
      currentCount: '100',
      nightTime: false,
      isClosed: true,
      diseaseCategoryNm: '심혈관질환',
      isPointExcluded: false,
      isAdvancedSurvey: false,
    };
    const publicSeminar: SeminarListItem = {
      seminarId: '5653',
      name: '공개 내분비 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/5653',
      date: '2026-09-10',
      time: '13:00~14:00',
      totalCount: '2000',
      currentCount: '50',
      nightTime: false,
      isClosed: false,
      diseaseCategoryNm: '내분비질환',
      isPointExcluded: false,
      isAdvancedSurvey: false,
    };

    const { text } = buildNewSeminarsNoticeMessage([privateSeminar, publicSeminar]);

    // 비공개 세미나: [비공개] + [심혈관질환] 모두 표시
    assert.ok(text.includes('[비공개]'), '비공개 세미나는 [비공개] 태그가 있어야 함');
    assert.ok(text.includes('[심혈관질환]'), '비공개 세미나의 질환분류명이 표시되어야 함');
    // 공개 세미나: [비공개] 없음, [내분비질환] 없음
    assert.ok(!text.includes('[내분비질환]'), '공개 세미나의 질환분류명은 표시되지 않아야 함');
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
    assert.ok(text.includes('1. [13:00] 정원 10명 일반 세미나'));
    assert.ok(text.includes('2. [13:00] 정원 100명 대규모 세미나'));
    assert.ok(text.includes('3. [13:00] 정원 미정 세미나'));
  });

  it('buildNewSeminarsNoticeMessage & seminarRepo: 발견된 순서(detectedAt 오름차순) 정렬 및 순번 검증', () => {
    // 세미나 시작일자는 09-20, 09-02, 09-10 이지만, 발견 시간은 10:00, 11:00, 12:00 순서인 경우
    const seminars: SeminarListItem[] = [
      {
        seminarId: '5643',
        name: '가장 늦은 세미나 날짜지만 먼저 발견된 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/5643',
        date: '2026-09-20',
        time: '13:00~14:00',
        totalCount: '7000',
        currentCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
        detectedAt: '2026-08-26T10:00:00.000Z',
      },
      {
        seminarId: '5647',
        name: '가장 빠른 세미나 날짜지만 두번째로 발견된 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/5647',
        date: '2026-09-02',
        time: '13:00~14:00',
        totalCount: '7000',
        currentCount: '200',
        nightTime: false,
        isAdvancedSurvey: false,
        detectedAt: '2026-08-26T11:00:00.000Z',
      },
      {
        seminarId: '5650',
        name: '중간 세미나 날짜지만 방금 가장 최근에 발견된 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/5650',
        date: '2026-09-10',
        time: '13:00~14:00',
        totalCount: '7000',
        currentCount: '10',
        nightTime: false,
        isAdvancedSurvey: false,
        detectedAt: '2026-08-26T12:00:00.000Z',
      },
    ];

    const { text } = buildNewSeminarsNoticeMessage(seminars, ['5650']);

    // 1. 헤더
    assert.ok(text.startsWith('🆕 오늘 추가된 세미나 모음 (누적 3건)\n\n'));

    // 2. 발견 순서대로 1., 2., 3. 순번이 매겨졌는지 검증 (최근 발견 5650이 3번으로 맨 아래)
    const idx1 = text.indexOf('1. [2026-09-20 13:00~14:00] 가장 늦은 세미나 날짜지만 먼저');
    const idx2 = text.indexOf('2. [2026-09-02 13:00~14:00] 가장 빠른 세미나 날짜지만 두번째');
    const idx3 = text.indexOf('3. [2026-09-10 13:00~14:00] 중간 세미나 날짜지만 방금 가장');

    assert.ok(idx1 !== -1, '1번 항목이 포함되어야 함');
    assert.ok(idx2 !== -1, '2번 항목이 포함되어야 함');
    assert.ok(idx3 !== -1, '3번 항목이 포함되어야 함');
    assert.ok(idx1 < idx2, '1번(먼저 발견)이 2번보다 앞에 위치해야 함');
    assert.ok(idx2 < idx3, '2번이 3번(최근 발견)보다 앞에 위치해야 함');

    // 3. 방금 추가된 3번 세미나는 강조선으로 감싸져 있어야 함
    assert.ok(text.includes('━ ✨ 방금 추가됨 ━━━━━\n3. [2026-09-10 13:00~14:00] 중간 세미나 날짜지만 방금 가장'));
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
      sentHistory[1].text.includes('━ ✨ 방금 추가됨 ━━━━━\n3. [2026-08-29 13:00] [심화설문] 103번 신규 세미나 (5/50)'),
    );
    // 이전 메시지 ID 1001이 삭제되었는지 검증
    assert.strictEqual(deletedIds.length, 1);
    assert.strictEqual(deletedIds[0], 1001);
  });

  it('extractHighlightedSeminarIds: 공지 메시지 본문에서 강조된 세미나 ID 추출 검증', () => {
    // 1. null 또는 빈 문자열
    assert.deepStrictEqual(extractHighlightedSeminarIds(null), []);
    assert.deepStrictEqual(extractHighlightedSeminarIds(''), []);
    assert.deepStrictEqual(extractHighlightedSeminarIds('일반 메시지입니다.'), []);

    // 2. 단일 강조 항목
    const singleMsg = `🆕 오늘 추가된 세미나 모음 (누적 2건)

1. [2026-08-27 13:00] 일반 세미나 (15/100)
https://m.doctorville.co.kr/cme/seminar/101

━ ✨ 방금 추가됨 ━━━━━
2. [2026-08-28 19:00] 신규 세미나 (5/50)
https://m.doctorville.co.kr/cme/seminar/102
━━━━━━━━━━━━━━━━`;
    assert.deepStrictEqual(extractHighlightedSeminarIds(singleMsg), ['102']);

    // 3. 복수 강조 항목
    const multiMsg = `🆕 오늘 추가된 세미나 모음 (누적 2건)

━ ✨ 방금 추가됨 ━━━━━
1. [2026-08-27 13:00] 첫번째 신규 세미나 (15/100)
https://m.doctorville.co.kr/cme/seminar/201
━━━━━━━━━━━━━━━━

━ ✨ 방금 추가됨 ━━━━━
2. [2026-08-28 19:00] 두번째 신규 세미나 (5/50)
https://m.doctorville.co.kr/cme/seminar/202
━━━━━━━━━━━━━━━━`;
    assert.deepStrictEqual(extractHighlightedSeminarIds(multiMsg), ['201', '202']);
  });

  it('syncNewSeminarsNotice: 신규 세미나 없이 정원/인원 수치 변경 시 기존 강조 표시 유지하며 editChannelMessage 호출 검증', async () => {
    seminarRepo.clearSeminars();
    const targetDate = '2026-08-27';
    const channelId = '-100999888777';

    // 1. 초기 세미나 2개 등록 (101은 일반, 102는 신규 강조)
    const initialSeminars: SeminarListItem[] = [
      {
        seminarId: '101',
        name: '101번 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        date: targetDate,
        time: '13:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
        detectedDate: targetDate,
        detectedAt: '2026-08-27T01:00:00.000Z',
      },
      {
        seminarId: '102',
        name: '102번 세미나 (신규 강조)',
        url: 'https://m.doctorville.co.kr/cme/seminar/102',
        date: targetDate,
        time: '19:00',
        currentCount: '5',
        totalCount: '50',
        nightTime: true,
        isAdvancedSurvey: false,
        detectedDate: targetDate,
        detectedAt: '2026-08-27T02:00:00.000Z',
      },
    ];
    seminarRepo.upsertSeminars(initialSeminars);

    // 2. 초기 공지 메시지 모의 생성 및 DB 저장
    const initialNoticeText = buildNewSeminarsNoticeMessage(initialSeminars, ['102']).text;
    channelRepoModule.recordChannelMessage({
      channelId,
      messageId: 5001,
      text: initialNoticeText,
      date: targetDate,
      mediaType: 'text',
      status: 'sent',
    });

    // 3. 세미나 인원 변경 (101번: 10/100 -> 35/100, 102번: 5/50 -> 40/50)
    const updatedSeminars: SeminarListItem[] = [
      {
        ...initialSeminars[0],
        currentCount: '35',
      },
      {
        ...initialSeminars[1],
        currentCount: '40',
      },
    ];
    seminarRepo.upsertSeminars(updatedSeminars);

    // editChannelMessage spy 생성
    let editedMessageId: number | null = null;
    let editedNewText = '';
    vi.spyOn(channelRepoModule, 'editChannelMessage').mockImplementation(async (msgId, newText) => {
      editedMessageId = msgId;
      editedNewText = newText;
      return { success: true, message: 'OK' };
    });

    // 4. newlyAdded = [] 상태로 syncNewSeminarsNotice 호출
    const resultMsgId = await syncNewSeminarsNotice(targetDate, [], channelId);

    // 5. 검증:
    // - 메시지 ID가 유지됨
    assert.strictEqual(resultMsgId, 5001);
    // - editChannelMessage가 5001번에 대해 호출됨
    assert.strictEqual(editedMessageId, 5001);
    // - 101번과 102번의 정원/인원 정보가 최신으로 갱신됨
    assert.ok(editedNewText.includes('1. [2026-08-27 13:00] 101번 세미나 (35/100)'));
    // - 102번 세미나의 "━ ✨ 방금 추가됨 ━━━━━" 강조 표시가 그대로 유지됨
    assert.ok(
      editedNewText.includes(
        '━ ✨ 방금 추가됨 ━━━━━\n2. [2026-08-27 19:00] 102번 세미나 (신규 강조) (40/50)\nhttps://m.doctorville.co.kr/cme/seminar/102\n━━━━━━━━━━━━━━━━',
      ),
    );

    // 6. 한 번 더 호출했을 때(변경사항 없음)는 editChannelMessage가 호출되지 않아야 함
    editedMessageId = null;
    editedNewText = '';
    // DB의 메시지 텍스트를 업데이트된 텍스트로 수정해둔 상태 시뮬레이션
    channelRepoModule.updateChannelMessageStatus(5001, 'edited', initialNoticeText, channelId); // reset test
    channelRepoModule.updateChannelMessageStatus(
      5001,
      'edited',
      buildNewSeminarsNoticeMessage(updatedSeminars, ['102']).text,
      channelId,
    );

    await syncNewSeminarsNotice(targetDate, [], channelId);
    assert.strictEqual(editedMessageId, null, '내용 변경이 없을 시 editChannelMessage를 호출하지 않아야 함');
  });
});
