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

  it('endDt, time, endedAt 기반 설문 마감 시각(종료 후 60분) 계산 검증', () => {
    // 1. endDt 기준
    const itemWithEndDt = {
      endDt: '2026-08-27 13:00:00',
    };
    const expectedEndDtMs = new Date('2026-08-27T13:00:00+09:00').getTime() + 60 * 60 * 1000;
    expect(getSeminarSurveyEndTime(itemWithEndDt)).toBe(expectedEndDtMs);

    // 2. time 기준
    const itemWithTime = {
      time: '12:00~13:00',
    };
    expect(getSeminarSurveyEndTime(itemWithTime)).toBe(expectedEndDtMs);

    // 3. endedAt 기준
    const endedAt = Date.now();
    const itemWithEndedAt = {
      endedAt,
    };
    expect(getSeminarSurveyEndTime(itemWithEndedAt)).toBe(endedAt + 60 * 60 * 1000);

    // 4. 정보가 전혀 없는 경우 null 반환
    expect(getSeminarSurveyEndTime({})).toBe(null);
  });

  it('10분 단위 잔여 시간 계산(getSurveyRemainingMinutes) 검증', () => {
    const endMs = new Date('2026-08-27T13:00:00+09:00').getTime(); // 종료 시각
    const seminar = {
      endDt: '2026-08-27 13:00:00', // 마감 시각 = 14:00 (endMs + 60분)
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
