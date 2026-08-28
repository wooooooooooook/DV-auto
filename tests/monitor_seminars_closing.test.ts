import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as storage from '../src/services/storage';
import { setBot } from '../src/services/bot_instance';
import { updateSubscription } from '../src/services/subscription_service';
import {
  getSeminarSurveyEndTime,
  getSurveyRemainingMinutes,
  sendSurveyClosingNotice,
  type MonitoredSeminarItem,
} from '../src/tasks/monitor_seminars';

describe('monitor_seminars_closing (설문 가능 시간 및 마감 알림)', () => {
  beforeEach(() => {
    storage.setDatabasePath(':memory:');
    storage.clear();
  });

  afterEach(() => {
    storage.closeDatabase();
  });

  it('endedAt 기반 설문 마감 시각(종료 감지 후 60분) 계산 검증', () => {
    // 1. endedAt 기준
    const endedAt = Date.now();
    const itemWithEndedAt = {
      endedAt,
    };
    expect(getSeminarSurveyEndTime(itemWithEndedAt)).toBe(endedAt + 60 * 60 * 1000);

    // 3. surveyEndDt(서버 설문 마감 시각)가 있는 경우
    const surveyEndDt = '2026-08-28 14:41:57.0';
    const parsedSurveyEnd = new Date('2026-08-28T14:41:57+09:00').getTime();
    expect(getSeminarSurveyEndTime({ surveyEndDt })).toBe(parsedSurveyEnd);

    // 4. surveyMinutesLeft(서버 잔여 시간)가 있는 경우
    const now = Date.now();
    expect(getSeminarSurveyEndTime({ surveyMinutesLeft: 38 }, now)).toBe(now + 38 * 60 * 1000);

    // 5. 정보가 전혀 없는 경우 null 반환
    expect(getSeminarSurveyEndTime({})).toBe(null);
  });

  it('10분 단위 잔여 시간 계산(getSurveyRemainingMinutes) 검증 (서버 surveyEndDt / surveyMinutesLeft 우선)', () => {
    const now = new Date('2026-08-28T14:03:00+09:00').getTime();

    // 1. 서버 surveyEndDt 기준 ("2026-08-28 14:41:57.0" -> 14:03 기준 약 38분 남음 -> 40분)
    expect(getSurveyRemainingMinutes({ surveyEndDt: '2026-08-28 14:41:57.0' }, now)).toBe(40);

    // 2. 서버 surveyMinutesLeft 기준 (38분 -> 40분, 18분 -> 20분, 8분 -> 10분)
    expect(getSurveyRemainingMinutes({ surveyMinutesLeft: 38 }, now)).toBe(40);
    expect(getSurveyRemainingMinutes({ surveyMinutesLeft: 18 }, now)).toBe(20);
    expect(getSurveyRemainingMinutes({ surveyMinutesLeft: 8 }, now)).toBe(10);
    expect(getSurveyRemainingMinutes({ surveyMinutesLeft: 0 }, now)).toBe(0);

    // 3. endedAt 기준
    const endMs = new Date('2026-08-27T13:00:00+09:00').getTime(); // 종료 감지 시각
    const seminar = {
      endedAt: endMs, // 마감 시각 = 14:00 (endMs + 60분)
    };

    // 13:00 (60분 전) -> 60분
    expect(getSurveyRemainingMinutes(seminar, endMs)).toBe(60);

    // 13:08 (52분 전) -> 50분
    expect(getSurveyRemainingMinutes(seminar, endMs + 8 * 60 * 1000)).toBe(50);

    // 13:36 (24분 전) -> 20분
    expect(getSurveyRemainingMinutes(seminar, endMs + 36 * 60 * 1000)).toBe(20);

    // 13:48 (12분 전) -> 10분
    expect(getSurveyRemainingMinutes(seminar, endMs + 48 * 60 * 1000)).toBe(10);

    // 13:58 (2분 전) -> 0분 (반올림 시 0분)
    expect(getSurveyRemainingMinutes(seminar, endMs + 58 * 60 * 1000)).toBe(0);

    // 14:05 (마감 이후) -> 0분
    expect(getSurveyRemainingMinutes(seminar, endMs + 65 * 60 * 1000)).toBe(0);

    // endedAt을 알 수 없는 경우 -> null 반환
    expect(getSurveyRemainingMinutes({})).toBe(null);
    expect(getSurveyRemainingMinutes({ endedAt: undefined })).toBe(null);
  });

  it('sendSurveyClosingNotice가 20분전 / 10분전 구독자에게 알림을 발송해야 한다', async () => {
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

    // 101번은 20분전만 구독, 102번은 10분전만 구독, 103번은 둘 다 구독
    updateSubscription(101, { surveyClosing20: true, surveyClosing10: false });
    updateSubscription(102, { surveyClosing20: false, surveyClosing10: true });
    updateSubscription(103, { surveyClosing20: true, surveyClosing10: true });

    const seminarItem: MonitoredSeminarItem = {
      seminarId: '8888',
      url: 'https://m.doctorville.co.kr/cme/seminar/8888',
      name: '설문 알림 세미나',
      status: '종료',
      time: '12:00~13:00',
      quizResultMessage: '정답 : 3번 O',
      hasSurvey: true,
    };

    // 20분 전 알림 발송 -> 101, 103번에게 전달
    const res20 = await sendSurveyClosingNotice(seminarItem, 20);
    expect(res20.successCount).toBe(2);
    expect(sentMessages.map((m) => m.chatId)).toEqual([101, 103]);
    expect(sentMessages[0].text).toContain('[설문 마감 20분 전]');
    expect(sentMessages[0].text).toContain('정답 : 3번 O');

    sentMessages.length = 0;

    // 10분 전 알림 발송 -> 102, 103번에게 전달
    const res10 = await sendSurveyClosingNotice(seminarItem, 10);
    expect(res10.successCount).toBe(2);
    expect(sentMessages.map((m) => m.chatId)).toEqual([102, 103]);
    expect(sentMessages[0].text).toContain('[설문 마감 10분 전]');
  });
});
