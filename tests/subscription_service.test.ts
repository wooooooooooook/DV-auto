import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as storage from '../src/services/storage';
import type { SeminarListItem } from '../src/tasks/apply_seminar';
import {
  getSubscription,
  updateSubscription,
  toggleTopic,
  setTodayLinksTime,
  setNewSeminarFilter,
  setAllTopics,
  matchesNewSeminarFilter,
  getTodayLinksSubscribersForTime,
  markTodayLinksSent,
  getSubscribersForTopic,
  buildMainMenu,
  buildTodayLinksTimeMenu,
  buildNewSeminarMenu,
} from '../src/services/subscription_service';
import {
  addInterMDQuizSubscriber,
  removeInterMDQuizSubscriber,
  getInterMDQuizSubscribers,
} from '../src/services/intermd_quiz_subscribers';
import {
  addSeminarChangeSubscriber,
  removeSeminarChangeSubscriber,
  getSeminarChangeSubscribers,
} from '../src/services/seminar_subscribers';

describe('subscription_service', () => {
  beforeEach(() => {
    storage.setDatabasePath(':memory:');
    storage.clear();
  });

  afterEach(() => {
    storage.closeDatabase();
  });

  it('기본 구독 정보 조회 및 업데이트가 올바르게 동작해야 한다', () => {
    const defaultSub = getSubscription(12345);
    expect(defaultSub.chatId).toBe(12345);
    expect(defaultSub.todayLinks).toBe(false);
    expect(defaultSub.todayLinksTime).toBe('09:00');
    expect(defaultSub.newSeminar).toBe('off');
    expect(defaultSub.newSeminarIncludePointExcluded).toBe(false);
    expect(defaultSub.intermdQuiz).toBe(false);
    expect(defaultSub.seminarChanges).toBe(false);
    expect(defaultSub.seminarLive).toBe(false);
    expect(defaultSub.surveyClosing20).toBe(false);
    expect(defaultSub.surveyClosing10).toBe(false);
    expect(defaultSub.pointConversion).toBe(false);

    const updated = updateSubscription(12345, {
      todayLinks: true,
      todayLinksTime: '08:00',
      newSeminar: 'limit_5000',
      newSeminarIncludePointExcluded: true,
      surveyClosing20: true,
      surveyClosing10: true,
      pointConversion: true,
    });

    expect(updated.todayLinks).toBe(true);
    expect(updated.todayLinksTime).toBe('08:00');
    expect(updated.newSeminar).toBe('limit_5000');
    expect(updated.newSeminarIncludePointExcluded).toBe(true);
    expect(updated.surveyClosing20).toBe(true);
    expect(updated.surveyClosing10).toBe(true);
    expect(updated.pointConversion).toBe(true);

    const fetched = getSubscription(12345);
    expect(fetched.todayLinks).toBe(true);
    expect(fetched.todayLinksTime).toBe('08:00');
    expect(fetched.newSeminar).toBe('limit_5000');
    expect(fetched.newSeminarIncludePointExcluded).toBe(true);
    expect(fetched.surveyClosing20).toBe(true);
    expect(fetched.surveyClosing10).toBe(true);
    expect(fetched.pointConversion).toBe(true);
  });

  it('토픽별 ON/OFF 토글이 올바르게 동작해야 한다', () => {
    expect(getSubscription(100).intermdQuiz).toBe(false);

    toggleTopic(100, 'intermd_quiz');
    expect(getSubscription(100).intermdQuiz).toBe(true);

    toggleTopic(100, 'intermd_quiz');
    expect(getSubscription(100).intermdQuiz).toBe(false);

    toggleTopic(100, 'new_seminar_point_excluded');
    expect(getSubscription(100).newSeminarIncludePointExcluded).toBe(true);

    toggleTopic(100, 'new_seminar_point_excluded');
    expect(getSubscription(100).newSeminarIncludePointExcluded).toBe(false);

    toggleTopic(100, 'today_links');
    expect(getSubscription(100).todayLinks).toBe(true);

    toggleTopic(100, 'seminar_changes');
    expect(getSubscription(100).seminarChanges).toBe(true);

    toggleTopic(100, 'seminar_live');
    expect(getSubscription(100).seminarLive).toBe(true);

    toggleTopic(100, 'survey_closing_20');
    expect(getSubscription(100).surveyClosing20).toBe(true);

    toggleTopic(100, 'survey_closing_10');
    expect(getSubscription(100).surveyClosing10).toBe(true);

    toggleTopic(100, 'point_conversion');
    expect(getSubscription(100).pointConversion).toBe(true);
  });

  it('오늘의 링크 시간 설정 시 자동으로 todayLinks가 ON되어야 한다', () => {
    expect(getSubscription(200).todayLinks).toBe(false);

    setTodayLinksTime(200, '00:02');
    const sub = getSubscription(200);
    expect(sub.todayLinks).toBe(true);
    expect(sub.todayLinksTime).toBe('00:02');

    setTodayLinksTime(200, '07:00');
    expect(getSubscription(200).todayLinksTime).toBe('07:00');
  });

  it('신규 세미나 조건 필터링이 올바르게 동작해야 한다', () => {
    setNewSeminarFilter(300, 'limit_5000');
    expect(getSubscription(300).newSeminar).toBe('limit_5000');

    // limit_5000 테스트
    expect(matchesNewSeminarFilter('limit_5000', { totalCount: '5000', currentCount: '100' })).toBe(true);
    expect(matchesNewSeminarFilter('limit_5000', { totalCount: '3000', currentCount: '100' })).toBe(true);
    expect(matchesNewSeminarFilter('limit_5000', { totalCount: '10000', currentCount: '100' })).toBe(false);

    // limit_3000 테스트
    expect(matchesNewSeminarFilter('limit_3000', { totalCount: '3000', currentCount: '100' })).toBe(true);
    expect(matchesNewSeminarFilter('limit_3000', { totalCount: '3500', currentCount: '100' })).toBe(false);

    // urgent_1000 테스트 (total - current <= 1000)
    expect(matchesNewSeminarFilter('urgent_1000', { totalCount: '5000', currentCount: '4200' })).toBe(true); // 800명 남음
    expect(matchesNewSeminarFilter('urgent_1000', { totalCount: '5000', currentCount: '3000' })).toBe(false); // 2000명 남음

    // all 테스트
    expect(matchesNewSeminarFilter('all', { totalCount: '20000', currentCount: '0' })).toBe(true);

    // off 테스트
    expect(matchesNewSeminarFilter('off', { totalCount: '500', currentCount: '0' })).toBe(false);

    // 포인트 미지급(isPointExcluded) 필터링 테스트
    // 1) includePointExcluded=false (기본) -> isPointExcluded === true는 제외
    expect(
      matchesNewSeminarFilter('all', { totalCount: '5000', currentCount: '0', isPointExcluded: true }, false),
    ).toBe(false);
    expect(
      matchesNewSeminarFilter('limit_5000', { totalCount: '5000', currentCount: '0', isPointExcluded: true }, false),
    ).toBe(false);

    // 2) includePointExcluded=true -> isPointExcluded === true여도 조건에 맞으면 포함
    expect(matchesNewSeminarFilter('all', { totalCount: '5000', currentCount: '0', isPointExcluded: true }, true)).toBe(
      true,
    );
    expect(
      matchesNewSeminarFilter('limit_5000', { totalCount: '5000', currentCount: '0', isPointExcluded: true }, true),
    ).toBe(true);
    expect(
      matchesNewSeminarFilter('limit_3000', { totalCount: '5000', currentCount: '0', isPointExcluded: true }, true),
    ).toBe(false); // 정원 초과로 제외
  });

  it('전체 켜기 및 전체 끄기가 올바르게 동작해야 한다', () => {
    setAllTopics(400, true);
    let sub = getSubscription(400);
    expect(sub.todayLinks).toBe(true);
    expect(sub.newSeminar).toBe('all');
    expect(sub.intermdQuiz).toBe(true);
    expect(sub.seminarChanges).toBe(true);
    expect(sub.seminarLive).toBe(true);
    expect(sub.surveyClosing20).toBe(true);
    expect(sub.surveyClosing10).toBe(true);
    expect(sub.pointConversion).toBe(true);

    setAllTopics(400, false);
    sub = getSubscription(400);
    expect(sub.todayLinks).toBe(false);
    expect(sub.newSeminar).toBe('off');
    expect(sub.intermdQuiz).toBe(false);
    expect(sub.seminarChanges).toBe(false);
    expect(sub.seminarLive).toBe(false);
    expect(sub.surveyClosing20).toBe(false);
    expect(sub.surveyClosing10).toBe(false);
    expect(sub.pointConversion).toBe(false);
  });

  it('시간별 오늘의 링크 구독자 조회 및 당일 발송 완료 처리가 동작해야 한다', () => {
    updateSubscription(501, { todayLinks: true, todayLinksTime: '08:00' });
    updateSubscription(502, { todayLinks: true, todayLinksTime: '08:00' });
    updateSubscription(503, { todayLinks: true, todayLinksTime: '09:00' });
    updateSubscription(504, { todayLinks: false, todayLinksTime: '08:00' });

    const subscribers8am = getTodayLinksSubscribersForTime('08:00', '2026-08-27');
    expect(subscribers8am).toEqual([501, 502]);

    markTodayLinksSent([501], '2026-08-27');

    const remaining8am = getTodayLinksSubscribersForTime('08:00', '2026-08-27');
    expect(remaining8am).toEqual([502]);

    // 다음 날에는 다시 501이 조회 대상에 포함되어야 함
    const nextDay8am = getTodayLinksSubscribersForTime('08:00', '2026-08-28');
    expect(nextDay8am).toEqual([501, 502]);
  });

  it('토픽별 구독자 조회가 올바르게 동작해야 한다', () => {
    updateSubscription(601, { pointConversion: true, seminarLive: true, surveyClosing20: true });
    updateSubscription(602, { pointConversion: true, seminarLive: false, surveyClosing10: true });
    updateSubscription(603, { newSeminar: 'limit_3000', surveyClosing20: true, surveyClosing10: true });

    expect(getSubscribersForTopic('point_conversion')).toEqual([601, 602]);
    expect(getSubscribersForTopic('seminar_live')).toEqual([601]);
    expect(getSubscribersForTopic('new_seminar')).toEqual([603]);
    expect(getSubscribersForTopic('survey_closing_20')).toEqual([601, 603]);
    expect(getSubscribersForTopic('survey_closing_10')).toEqual([602, 603]);
  });

  it('UI 마크업 생성 헬퍼가 버튼과 텍스트를 정상 반환해야 한다', () => {
    updateSubscription(700, {
      todayLinks: true,
      todayLinksTime: '00:02',
      newSeminar: 'urgent_1000',
      newSeminarIncludePointExcluded: false,
    });

    const mainUI = buildMainMenu(700);
    expect(mainUI.text).toContain('공지봇 맞춤 알림 구독 설정');
    expect(mainUI.text).toContain('음소거');
    expect(mainUI.text).toContain('채널 나가기');
    expect(mainUI.text).toContain('설문 진행 여부와 관계없이 알림이 전송됩니다');
    expect(mainUI.text).toContain('00:02');
    expect(mainUI.text).toContain('마감 임박');
    expect(mainUI.text).toContain('포인트 미지급 제외');
    expect(mainUI.replyMarkup.inline_keyboard.length).toBeGreaterThan(5);

    const timeUI = buildTodayLinksTimeMenu(700);
    expect(timeUI.text).toContain('수신 시간 설정');
    expect(timeUI.replyMarkup.inline_keyboard.length).toBeGreaterThan(3);

    const newSemUI = buildNewSeminarMenu(700);
    expect(newSemUI.text).toContain('신규 세미나 등록 알림 설정');
    expect(newSemUI.text).toContain('포인트 미지급 세미나 수신: <b>🔴 제외 (알림 안 받음)</b>');
    expect(newSemUI.replyMarkup.inline_keyboard.length).toBe(7);
    expect(
      newSemUI.replyMarkup.inline_keyboard.some((row) =>
        row.some(
          (btn) =>
            btn.text.includes('포인트 미지급 세미나도 수신') &&
            btn.callback_data === 'sub:toggle:new_seminar_point_excluded',
        ),
      ),
    ).toBe(true);

    // 포인트 미지급 포함으로 변경 후 검증
    updateSubscription(700, { newSeminarIncludePointExcluded: true });
    const newSemUI2 = buildNewSeminarMenu(700);
    expect(newSemUI2.text).toContain('포인트 미지급 세미나 수신: <b>🟢 포함 (알림 받음)</b>');
    expect(newSemUI2.replyMarkup.inline_keyboard.some((row) => row.some((btn) => btn.text.includes('ON 🟢')))).toBe(
      true,
    );
  });

  it('레거시 intermd_quiz 및 seminar_subscribers 래퍼 함수가 호환되어야 한다', () => {
    expect(getInterMDQuizSubscribers()).toEqual([]);
    expect(addInterMDQuizSubscriber(801)).toBe(true);
    expect(addInterMDQuizSubscriber(801)).toBe(false);
    expect(getInterMDQuizSubscribers()).toEqual([801]);
    expect(removeInterMDQuizSubscriber(801)).toBe(true);
    expect(getInterMDQuizSubscribers()).toEqual([]);

    expect(getSeminarChangeSubscribers()).toEqual([]);
    expect(addSeminarChangeSubscriber(802)).toBe(true);
    expect(addSeminarChangeSubscriber(802)).toBe(false);
    expect(getSeminarChangeSubscribers()).toEqual([802]);
    expect(removeSeminarChangeSubscriber(802)).toBe(true);
    expect(getSeminarChangeSubscribers()).toEqual([]);
  });

  it('마감 임박 세미나 발송 및 markSeminarUrgentNotified가 정상 동작해야 한다', async () => {
    const { setBot } = await import('../src/services/bot_instance');
    const { sendUrgentSeminarsToSubscribers } = await import('../src/services/subscription_service');
    const seminarRepo = await import('../src/services/seminar_repository');

    const sentMessages: Array<{ chatId: number; text: string }> = [];
    const mockBot = {
      command: () => {},
      action: () => {},
      telegram: {
        sendMessage: async (chatId: number, text: string) => {
          sentMessages.push({ chatId, text });
          return { message_id: 999 };
        },
      },
    };
    setBot('notice', mockBot as unknown as Parameters<typeof setBot>[1]);

    updateSubscription(901, { newSeminar: 'urgent_1000' });
    updateSubscription(902, { newSeminar: 'limit_5000' });

    const urgentSeminar: SeminarListItem = {
      seminarId: '9988',
      name: '마감임박 세미나 테스트',
      url: 'https://m.doctorville.co.kr/cme/seminar/9988',
      date: '2026-08-27',
      totalCount: '5000',
      currentCount: '4300', // 잔여 700명
      time: '19:00',
      nightTime: false,
      isAdvancedSurvey: false,
    };

    seminarRepo.upsertSeminar(urgentSeminar);

    const res = await sendUrgentSeminarsToSubscribers([urgentSeminar]);
    expect(res.successCount).toBe(1);
    expect(sentMessages.length).toBe(1);
    expect(sentMessages[0].chatId).toBe(901);
    expect(sentMessages[0].text).toContain('마감 임박');
    expect(sentMessages[0].text).toContain('잔여 700명');

    seminarRepo.markSeminarUrgentNotified('9988');
    const stored = seminarRepo.getSeminarById('9988');
    expect(stored?.urgentNotified).toBe(true);
  });

  it('신규 세미나 등록 시 통합빌드가 아닌 개별 메시지로 각 세미나마다 전송되어야 한다', async () => {
    const { setBot } = await import('../src/services/bot_instance');
    const { sendNewSeminarToSubscribers, buildSingleNewSeminarMessage } =
      await import('../src/services/subscription_service');

    // 1. 단일 메시지 빌더 검증
    const singleMsg = buildSingleNewSeminarMessage({
      seminarId: '1111',
      name: '새로운 당뇨 세미나',
      date: '2026-08-27',
      time: '12:30~13:30',
      totalCount: '5000',
      currentCount: '0',
      nightTime: false,
      isAdvancedSurvey: true,
      isPointExcluded: false,
      url: 'https://m.doctorville.co.kr/cme/seminar/1111',
    });
    expect(singleMsg.text).toContain('🆕 <b>[신규 세미나 등록]</b>');
    expect(singleMsg.text).toContain('[2026-08-27 12:30~13:30]');
    expect(singleMsg.text).toContain('[심화설문]');
    expect(singleMsg.text).toContain('<b>새로운 당뇨 세미나</b> (0/5000)');
    expect(singleMsg.text).toContain('https://m.doctorville.co.kr/cme/seminar/1111');

    // 2. 2건의 신규 세미나 발송 시 개별로 2건 메시지가 전송되는지 검증
    const sentMessages: Array<{ chatId: number; text: string }> = [];
    const mockBot = {
      command: () => {},
      action: () => {},
      telegram: {
        sendMessage: async (chatId: number, text: string) => {
          sentMessages.push({ chatId, text });
          return { message_id: 999 };
        },
      },
    };
    setBot('notice', mockBot as unknown as Parameters<typeof setBot>[1]);

    updateSubscription(999, { newSeminar: 'all' });

    const newSeminars = [
      {
        seminarId: '1001',
        name: '세미나 A',
        url: 'https://m.doctorville.co.kr/cme/seminar/1001',
        totalCount: '5000',
        currentCount: '0',
      },
      {
        seminarId: '1002',
        name: '세미나 B',
        url: 'https://m.doctorville.co.kr/cme/seminar/1002',
        totalCount: '3000',
        currentCount: '0',
      },
    ];

    const result = await sendNewSeminarToSubscribers(
      newSeminars as unknown as Parameters<typeof sendNewSeminarToSubscribers>[0],
    );
    expect(result.successCount).toBe(1);

    // 통합 모음 메시지가 아니라 세미나 개수만큼 2건이 개별 전송되어야 함
    expect(sentMessages.length).toBe(2);
    expect(sentMessages[0].chatId).toBe(999);
    expect(sentMessages[0].text).toContain('세미나 A');
    expect(sentMessages[0].text).not.toContain('오늘 추가된 세미나 모음');
    expect(sentMessages[1].chatId).toBe(999);
    expect(sentMessages[1].text).toContain('세미나 B');
  });

  it('포인트 미지급 세미나 발송 시 newSeminarIncludePointExcluded 설정에 따라 필터링되어야 한다', async () => {
    const { setBot } = await import('../src/services/bot_instance');
    const { sendNewSeminarToSubscribers } = await import('../src/services/subscription_service');

    const sentMessages: Array<{ chatId: number; text: string }> = [];
    const mockBot = {
      command: () => {},
      action: () => {},
      telegram: {
        sendMessage: async (chatId: number, text: string) => {
          sentMessages.push({ chatId, text });
          return { message_id: 999 };
        },
      },
    };
    setBot('notice', mockBot as unknown as Parameters<typeof setBot>[1]);

    // 1001번 유저: 포인트 미지급 포함 (true)
    updateSubscription(1001, { newSeminar: 'all', newSeminarIncludePointExcluded: true });
    // 1002번 유저: 포인트 미지급 제외 (false)
    updateSubscription(1002, { newSeminar: 'all', newSeminarIncludePointExcluded: false });

    const newSeminars: SeminarListItem[] = [
      {
        seminarId: '2001',
        name: '일반 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/2001',
        totalCount: '5000',
        currentCount: '0',
        isPointExcluded: false,
      },
      {
        seminarId: '2002',
        name: '포인트 미지급 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/2002',
        totalCount: '5000',
        currentCount: '0',
        isPointExcluded: true,
      },
    ];

    await sendNewSeminarToSubscribers(newSeminars);

    const user1001Messages = sentMessages.filter((m) => m.chatId === 1001);
    const user1002Messages = sentMessages.filter((m) => m.chatId === 1002);

    // 1001번 유저는 2개 모두 수신 (일반 + 포인트 미지급)
    expect(user1001Messages.length).toBe(2);
    expect(user1001Messages[0].text).toContain('일반 세미나');
    expect(user1001Messages[1].text).toContain('포인트 미지급 세미나');
    expect(user1001Messages[1].text).toContain('[포인트미지급]');

    // 1002번 유저는 일반 세미나 1개만 수신
    expect(user1002Messages.length).toBe(1);
    expect(user1002Messages[0].text).toContain('일반 세미나');
  });
});
