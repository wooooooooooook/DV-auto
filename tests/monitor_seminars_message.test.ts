import assert from 'node:assert';
import { describe, it, expect } from 'vitest';
import {
  buildSeminarMonitorStatusMessage,
  getSeminarStatusDisplay,
  type SeminarInfo,
} from '../src/tasks/monitor_seminars';

describe('buildSeminarMonitorStatusMessage 세미나 모니터 현황 메시지 포맷팅 테스트', () => {
  it('** 볼드 제거, 시작종료시각 제목 앞 표시, 20글자 트렁케이션, 심화설문 접미사 검증', () => {
    const seminars: Record<string, SeminarInfo> = {
      'https://m.doctorville.co.kr/cme/seminar/5580': {
        seminarId: '5580',
        url: 'https://m.doctorville.co.kr/cme/seminar/5580',
        name: '[재] ENVLO WEB SYMPOSIUM',
        status: '입장가능',
        processState: 1, // PROCESS_ENTER
        time: '18:00~19:00',
        isAdvancedSurvey: true,
      },
      'https://m.doctorville.co.kr/cme/seminar/5579': {
        seminarId: '5579',
        url: 'https://m.doctorville.co.kr/cme/seminar/5579',
        name: '[재] Redefining P-CAB: From Gastritis to GERD',
        status: '입장가능',
        processState: 6, // PROCESS_STARTED
        time: '18:30~19:30',
        isAdvancedSurvey: true,
      },
      'https://m.doctorville.co.kr/cme/seminar/5600': {
        seminarId: '5600',
        url: 'https://m.doctorville.co.kr/cme/seminar/5600',
        name: 'DIVE (Digital Innovation, Value & Experience) Web symposium',
        status: '대기',
        processState: 2, // PROCESS_APPLY
        time: '19:00~20:00',
        isAdvancedSurvey: false,
      },
    };

    const message = buildSeminarMonitorStatusMessage('저녁', seminars);

    // 1. 헤더 검증
    assert(message.startsWith('🔔 저녁세미나\n\n'), '헤더가 🔔 저녁세미나로 시작해야 함');

    // 2. ** 볼드 마크다운이 포함되지 않았는지 검증
    assert(!message.includes('**'), '메시지에 ** 볼드 마크다운이 포함되지 않아야 함');

    // 3. 5580 세미나 검증: 🟢 입장가능 | 18:00~19:00 [재] ENVLO WEB SYMPOS [심화설문]
    assert(
      message.includes('🟢 입장가능 | 18:00~19:00 [재] ENVLO WEB SYMPOS [심화설문]'),
      '5580 세미나의 시작종료시각, 20자 트렁케이션, 심화설문 태그가 올바르게 포맷되어야 함',
    );
    assert(message.includes('https://m.doctorville.co.kr/cme/seminar/5580'), '5580 URL이 포함되어야 함');

    // 4. 5579 세미나 검증: 🟢 입장가능 | 18:30~19:30 [재] Redefining P-CAB [심화설문]
    assert(
      message.includes('🟢 입장가능 | 18:30~19:30 [재] Redefining P-CAB [심화설문]'),
      '5579 세미나의 시작종료시각, 20자 트렁케이션, 심화설문 태그가 올바르게 포맷되어야 함',
    );
    assert(message.includes('https://m.doctorville.co.kr/cme/seminar/5579'), '5579 URL이 포함되어야 함');

    // 5. 5600 세미나 검증: ⏳ 대기 | 19:00~20:00 DIVE (Digital Innova
    assert(
      message.includes('⏳ 대기 | 19:00~20:00 DIVE (Digital Innova\nhttps://m.doctorville.co.kr/cme/seminar/5600'),
      '5600 세미나의 대기 상태, 시작종료시각, 20자 트렁케이션이 올바르게 포맷되어야 함',
    );
  });

  it('20글자 이하 제목은 트렁케이션 없이 그대로 유지', () => {
    const seminars: SeminarInfo[] = [
      {
        seminarId: '1234',
        url: 'https://m.doctorville.co.kr/cme/seminar/1234',
        name: '짧은 세미나 제목',
        status: '입장가능',
        processState: 1,
        time: '12:00~13:00',
        isAdvancedSurvey: false,
      },
    ];

    const message = buildSeminarMonitorStatusMessage('점심', seminars);
    assert(message.includes('🟢 입장가능 | 12:00~13:00 짧은 세미나 제목'));
  });

  it('시간(time) 정보가 없을 경우 시간 생략 후 제목 바로 출력', () => {
    const seminars: SeminarInfo[] = [
      {
        seminarId: '1234',
        url: 'https://m.doctorville.co.kr/cme/seminar/1234',
        name: '시간 미정 세미나',
        status: '대기',
        processState: 4,
      },
    ];

    const message = buildSeminarMonitorStatusMessage('저녁', seminars);
    assert(message.includes('⏳ 대기 | 시간 미정 세미나'));
  });

  it('getSeminarStatusDisplay 상태별 이모지 및 텍스트 매핑 검증', () => {
    // 1. 종료 상태
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '종료' }), { emoji: '🔴', text: '종료' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '', seminarCompleted: 1 }), { emoji: '🔴', text: '종료' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '', processState: 7 }), { emoji: '🔴', text: '종료' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '', processState: 8 }), { emoji: '🔴', text: '종료' });

    // 2. 입장 가능 상태
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '입장하기' }), { emoji: '🟢', text: '입장가능' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '진행중' }), { emoji: '🟢', text: '입장가능' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '', processState: 1 }), { emoji: '🟢', text: '입장가능' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '', processState: 6 }), { emoji: '🟢', text: '입장가능' });

    // 3. 대기 상태
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '대기중' }), { emoji: '⏳', text: '대기' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '신청하기' }), { emoji: '⏳', text: '대기' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '신청완료' }), { emoji: '⏳', text: '대기' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '', processState: 2 }), { emoji: '⏳', text: '대기' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '', processState: 3 }), { emoji: '⏳', text: '대기' });
  });

  it('세미나가 없는 경우 기본 메시지 반환', () => {
    const message = buildSeminarMonitorStatusMessage('저녁', []);
    assert.strictEqual(message, '🔔 저녁세미나\n\n예정된 세미나가 없습니다.');
  });

  it('buildSeminarLiveStartMessage 및 buildSeminarLiveEndMessage 개별 알림 포맷 검증', async () => {
    const { buildSeminarLiveStartMessage, buildSeminarLiveEndMessage } = await import('../src/tasks/monitor_seminars');

    // 1. 시작 알림
    const startMsg = buildSeminarLiveStartMessage({
      seminarId: '5580',
      url: 'https://m.doctorville.co.kr/cme/seminar/5580',
      name: 'ENVLO WEB SYMPOSIUM',
      status: '입장가능',
      time: '18:00~19:00',
      isAdvancedSurvey: true,
    });
    assert(startMsg.text.includes('🟢 <b>[세미나 시작]</b>'));
    assert(startMsg.text.includes('[18:00~19:00]'));
    assert(startMsg.text.includes('<b>ENVLO WEB SYMPOSIUM</b> [심화설문]'));
    assert(startMsg.text.includes('https://m.doctorville.co.kr/cme/seminar/5580'));

    // 2. 종료 알림 (퀴즈 결과 포함)
    const endMsgWithQuiz = buildSeminarLiveEndMessage({
      seminarId: '5580',
      url: 'https://m.doctorville.co.kr/cme/seminar/5580',
      name: 'ENVLO WEB SYMPOSIUM',
      status: '종료',
      time: '18:00~19:00',
      isAdvancedSurvey: true,
      quizResultMessage: '📋 퀴즈 정답\n1. O\n2. X',
    });
    assert(endMsgWithQuiz.text.includes('🔴 <b>[세미나 종료]</b>'));
    assert(endMsgWithQuiz.text.includes('📋 퀴즈 정답\n1. O\n2. X'));

    // 3. 종료 알림 (설문 없는 세미나)
    const endMsgNoSurvey = buildSeminarLiveEndMessage({
      seminarId: '5590',
      url: 'https://m.doctorville.co.kr/cme/seminar/5590',
      name: '설문 없는 세미나',
      status: '종료',
      hasSurvey: false,
    });
    assert(endMsgNoSurvey.text.includes('🔴 <b>[세미나 종료]</b>'));
    assert(endMsgNoSurvey.text.includes('(설문이 없는 세미나)'));
  });

  it('종료된 세미나의 설문 잔여 시간(약 N분 남음) 포맷팅 및 설문 없는 세미나 검증', async () => {
    const { buildSeminarMonitorStatusMessage, getSurveyRemainingMinutes } =
      await import('../src/tasks/monitor_seminars');

    const baseTime = new Date('2026-08-27T13:00:00+09:00').getTime(); // 종료 시점 (13:00)

    const seminar1 = {
      seminarId: '5580',
      url: 'https://m.doctorville.co.kr/cme/seminar/5580',
      name: '당뇨 세미나',
      status: '종료' as const,
      time: '12:00~13:00',
      endDt: '2026-08-27 13:00:00',
      endedAt: baseTime,
      quizResultMessage: '정답 : 1번 O',
      hasSurvey: true,
    };

    const seminar2 = {
      seminarId: '5590',
      url: 'https://m.doctorville.co.kr/cme/seminar/5590',
      name: '설문 없는 세미나',
      status: '종료' as const,
      time: '12:00~13:00',
      endDt: '2026-08-27 13:00:00',
      endedAt: baseTime,
      hasSurvey: false,
    };

    // 1. 종료 직후 (13:00) -> 마감까지 60분 남음
    const msgAt1300 = buildSeminarMonitorStatusMessage('점심', [seminar1, seminar2], baseTime);
    assert(msgAt1300.includes('(설문 마감 약 60분 남음)'));
    assert(msgAt1300.includes('(설문이 없는 세미나)'));

    // 2. 10분 후 (13:10) -> 마감까지 50분 남음
    const msgAt1310 = buildSeminarMonitorStatusMessage('점심', [seminar1, seminar2], baseTime + 10 * 60 * 1000);
    assert(msgAt1310.includes('(설문 마감 약 50분 남음)'));

    // 3. 40분 후 (13:40) -> 마감까지 20분 남음
    const msgAt1340 = buildSeminarMonitorStatusMessage('점심', [seminar1, seminar2], baseTime + 40 * 60 * 1000);
    assert(msgAt1340.includes('(설문 마감 약 20분 남음)'));

    // 4. 50분 후 (13:50) -> 마감까지 10분 남음
    const msgAt1350 = buildSeminarMonitorStatusMessage('점심', [seminar1, seminar2], baseTime + 50 * 60 * 1000);
    assert(msgAt1350.includes('(설문 마감 약 10분 남음)'));

    // 6. endedAt이 없는 경우 -> 설문 남은 시간 문구 표시 안 함
    const seminarNoEndedAt = {
      seminarId: '5599',
      url: 'https://m.doctorville.co.kr/cme/seminar/5599',
      name: '종료 세미나 (endedAt 없음)',
      status: '종료' as const,
      time: '12:00~13:00',
      quizResultMessage: '정답 : 2번',
      hasSurvey: true,
    };
    const msgNoEndedAt = buildSeminarMonitorStatusMessage('점심', [seminarNoEndedAt], baseTime);
    assert(msgNoEndedAt.includes('정답 : 2번'));
    assert(!msgNoEndedAt.includes('설문 마감'));
    assert(!msgNoEndedAt.includes('남음'));

    // getSurveyRemainingMinutes 유틸리티 검증
    expect(getSurveyRemainingMinutes(seminar1, baseTime + 12 * 60 * 1000)).toBe(50); // 48분 남음 -> 50분
    expect(getSurveyRemainingMinutes(seminar1, baseTime + 38 * 60 * 1000)).toBe(20); // 22분 남음 -> 20분
    expect(getSurveyRemainingMinutes(seminar1, baseTime + 52 * 60 * 1000)).toBe(10); // 8분 남음 -> 10분
    expect(getSurveyRemainingMinutes(seminar1, baseTime + 60 * 60 * 1000)).toBe(0); // 0분 -> 0분
    expect(getSurveyRemainingMinutes(seminarNoEndedAt)).toBe(null);
  });

  it('buildSurveyClosingMessage 설문 마감 20분전 / 10분전 알림 포맷 검증', async () => {
    const { buildSurveyClosingMessage } = await import('../src/tasks/monitor_seminars');

    const seminar = {
      seminarId: '7788',
      url: 'https://m.doctorville.co.kr/cme/seminar/7788',
      name: '고혈압 최신지견',
      status: '종료' as const,
      time: '12:00~13:00',
      isAdvancedSurvey: true,
      quizResultMessage: '정답 : 2번 X',
    };

    // 20분 전 메시지
    const msg20 = buildSurveyClosingMessage(seminar, 20);
    assert(msg20.text.includes('⏳ <b>[설문 마감 20분 전]</b>'));
    assert(msg20.text.includes('[12:00~13:00]'));
    assert(msg20.text.includes('<b>고혈압 최신지견</b> [심화설문]'));
    assert(msg20.text.includes('정답 : 2번 X'));
    assert(msg20.text.includes('약 20분 남았습니다.'));
    assert(msg20.text.includes('설문 진행 여부와 관계없이 발송'));

    // 10분 전 메시지
    const msg10 = buildSurveyClosingMessage(seminar, 10);
    assert(msg10.text.includes('⏳ <b>[설문 마감 10분 전]</b>'));
    assert(msg10.text.includes('약 10분 남았습니다.'));
    assert(msg10.text.includes('설문 진행 여부와 관계없이 발송'));
  });

  it('공지채널 세미나현황에서는 퀴즈정답 요약만 노출되고 상세 문항/답은 제거되며, 개별알림에서는 상세 유지 검증', async () => {
    const {
      buildSeminarMonitorStatusMessage,
      buildSeminarLiveEndMessage,
      buildSurveyClosingMessage,
      extractQuizSummaryOnly,
    } = await import('../src/tasks/monitor_seminars');

    const multiLineQuizMessage = `[퀴즈] 정답 123\n\n[퀴즈]\n✅ Q1: 1차 치료제는 무엇인가요?\n   → 메트포르민 (1번)\n✅ Q2: 병용 요법의 장점은?\n   → 혈당 강하 (2번)\n✅ Q3: 투약 간격은?\n   → 1일 1회 (3번)`;

    const baseTime = new Date('2026-08-27T13:00:00+09:00').getTime();
    const seminar = {
      seminarId: '9988',
      url: 'https://m.doctorville.co.kr/cme/seminar/9988',
      name: '당뇨 심화 세미나',
      status: '종료' as const,
      time: '12:00~13:00',
      endDt: '2026-08-27 13:00:00',
      endedAt: baseTime,
      quizResultMessage: multiLineQuizMessage,
      hasSurvey: true,
    };

    // 1. extractQuizSummaryOnly 단위 검증
    expect(extractQuizSummaryOnly(multiLineQuizMessage)).toBe('[퀴즈] 정답 123');
    expect(extractQuizSummaryOnly('정답 : 1번 O\n상세설명')).toBe('정답 : 1번 O');
    expect(extractQuizSummaryOnly(null)).toBe(null);

    // 2. 공지 채널 세미나 현황 메시지 검증: 요약만 포함, 상세 문항/답 제거
    const channelStatusMsg = buildSeminarMonitorStatusMessage('점심', [seminar], baseTime);
    assert(channelStatusMsg.includes('[퀴즈] 정답 123'), '요약은 포함되어야 함');
    assert(
      !channelStatusMsg.includes('✅ Q1: 1차 치료제는 무엇인가요?'),
      '공지 채널에는 상세 퀴즈 문항이 제거되어야 함',
    );
    assert(!channelStatusMsg.includes('메트포르민 (1번)'), '공지 채널에는 상세 퀴즈 답이 제거되어야 함');
    assert(channelStatusMsg.includes('(설문 마감 약 60분 남음)'), '설문 잔여시간 표시 확인');

    // 3. 개별 알림 (세미나 종료 및 설문 마감) 메시지 검증: 상세 내용 유지
    const endNotice = buildSeminarLiveEndMessage(seminar);
    assert(endNotice.text.includes('[퀴즈] 정답 123'));
    assert(endNotice.text.includes('✅ Q1: 1차 치료제는 무엇인가요?'), '개별 알림에는 상세 퀴즈 문항이 유지되어야 함');
    assert(endNotice.text.includes('메트포르민 (1번)'), '개별 알림에는 상세 퀴즈 답이 유지되어야 함');

    const closingNotice = buildSurveyClosingMessage(seminar, 20);
    assert(closingNotice.text.includes('[퀴즈] 정답 123'));
    assert(
      closingNotice.text.includes('✅ Q1: 1차 치료제는 무엇인가요?'),
      '개별 알림(마감)에는 상세 퀴즈 문항이 유지되어야 함',
    );
  });

  it('세미나 목록이 시작시간 순(이른 시간 우선)으로 정렬되어 메시지가 생성되는지 검증', async () => {
    const { buildSeminarMonitorStatusMessage, sortSeminarsByStartTime } = await import('../src/tasks/monitor_seminars');

    const unsortedSeminars: SeminarInfo[] = [
      {
        seminarId: '300',
        url: 'https://m.doctorville.co.kr/cme/seminar/300',
        name: '세 번째 세미나',
        status: '대기',
        time: '19:30~20:30',
        startDt: '2026-09-04 19:30:00',
      },
      {
        seminarId: '100',
        url: 'https://m.doctorville.co.kr/cme/seminar/100',
        name: '첫 번째 세미나',
        status: '입장가능',
        time: '18:00~19:00',
        startDt: '2026-09-04 18:00:00',
      },
      {
        seminarId: '200',
        url: 'https://m.doctorville.co.kr/cme/seminar/200',
        name: '두 번째 세미나',
        status: '입장가능',
        time: '18:30~19:30',
        startDt: '2026-09-04 18:30:00',
      },
    ];

    // 1. sortSeminarsByStartTime 정렬 결과 검증
    const sorted = sortSeminarsByStartTime(unsortedSeminars);
    expect(sorted.map((s) => s.seminarId)).toEqual(['100', '200', '300']);

    // 2. 메시지 본문에서 순서대로 출력되는지 검증
    const message = buildSeminarMonitorStatusMessage('저녁', unsortedSeminars);
    const idx100 = message.indexOf('18:00~19:00 첫 번째 세미나');
    const idx200 = message.indexOf('18:30~19:30 두 번째 세미나');
    const idx300 = message.indexOf('19:30~20:30 세 번째 세미나');

    expect(idx100).toBeGreaterThan(-1);
    expect(idx200).toBeGreaterThan(idx100);
    expect(idx300).toBeGreaterThan(idx200);
  });

  it('startDt 없이 time 문자열만 있는 경우 및 시작시간이 같을 때 seminarId 순 정렬 검증', async () => {
    const { sortSeminarsByStartTime } = await import('../src/tasks/monitor_seminars');

    const sameTimeSeminars: SeminarInfo[] = [
      {
        seminarId: '5580',
        url: 'https://m.doctorville.co.kr/cme/seminar/5580',
        name: '세미나 B',
        status: '대기',
        time: '12:30~13:30',
      },
      {
        seminarId: '5510',
        url: 'https://m.doctorville.co.kr/cme/seminar/5510',
        name: '세미나 A',
        status: '대기',
        time: '12:30~13:30',
      },
      {
        seminarId: '5500',
        url: 'https://m.doctorville.co.kr/cme/seminar/5500',
        name: '이른 세미나',
        status: '입장가능',
        time: '12:00~13:00',
      },
    ];

    const sorted = sortSeminarsByStartTime(sameTimeSeminars);
    expect(sorted.map((s) => s.seminarId)).toEqual(['5500', '5510', '5580']);
  });
});
