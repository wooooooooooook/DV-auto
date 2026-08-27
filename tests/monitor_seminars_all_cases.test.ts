import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as storage from '../src/services/storage';
import * as channelRepo from '../src/services/channel_message_repository';
import { isSeminarNoticeCompleted, shouldResumeSeminarMonitor } from '../src/services/channel_message_repository';
import { monitorSeminars } from '../src/tasks/monitor_seminars';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as utilsModule from '../src/modules/utils';
import * as seminarQuizModule from '../src/tasks/seminar_quiz';
import type { BrowserContext, Page } from 'playwright';

describe('monitor_seminars_all_cases (앱 재시작 및 공지방 상태 기반 autoResume 모든 경우의 수 검증)', () => {
  beforeEach(() => {
    storage.setDatabasePath(':memory:');
    storage.clear();
  });

  afterEach(() => {
    storage.closeDatabase();
    vi.restoreAllMocks();
  });

  it('공지방 상태에 따른 isSeminarNoticeCompleted 및 shouldResumeSeminarMonitor 검증', () => {
    const today = '2026-08-28';

    // 1. 공지 메시지가 전혀 없는 경우
    expect(isSeminarNoticeCompleted('점심', today)).toBe(false);
    expect(shouldResumeSeminarMonitor('점심', today)).toBe(false);

    // 2. 공지 메시지가 진행 중인 상태인 경우 (종료 문구 없음)
    channelRepo.recordChannelMessage({
      channelId: 'test_chan',
      messageId: 1001,
      date: today,
      text: '🔔 점심세미나\n\n🟢 입장가능 | 12:30 심장 세미나\nhttps://m.doctorville.co.kr/cme/seminar/1',
      status: 'sent',
    });

    expect(isSeminarNoticeCompleted('점심', today)).toBe(false);
    expect(shouldResumeSeminarMonitor('점심', today)).toBe(true);

    // 3. 공지 메시지가 '모두 종료' 문구를 포함하는 경우
    channelRepo.recordChannelMessage({
      channelId: 'test_chan',
      messageId: 1002,
      date: today,
      text: '🔔 점심세미나\n\n🔴 종료 | 12:30 심장 세미나\n\n━━━━━━━━━━━━━━━━━━\n🏁 점심세미나가 모두 종료되었습니다.',
      status: 'sent',
    });

    expect(isSeminarNoticeCompleted('점심', today)).toBe(true);
    expect(shouldResumeSeminarMonitor('점심', today)).toBe(false);
  });

  it('Case 3/5: 다운타임 중 세미나가 종료되었을 때, 재개 시 온디맨드 퀴즈 처리 및 공지 갱신 검증', async () => {
    const fetchMainFutureSpy = vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars');
    const fetchSeminarDetailSpy = vi.spyOn(seminarApiModule, 'fetchSeminarDetail');
    const sendNotificationToChannelSpy = vi.spyOn(utilsModule, 'sendNotificationToChannel');
    const sendTelegramSpy = vi.spyOn(utilsModule, 'sendTelegram');
    const ensureLoggedInSpy = vi.spyOn(utilsModule, 'ensureLoggedIn');
    const safeGotoSpy = vi.spyOn(utilsModule, 'safeGoto');
    const processSeminarQuizSpy = vi.spyOn(seminarQuizModule, 'processSeminarQuiz');

    const channelMessages: string[] = [];
    sendNotificationToChannelSpy.mockImplementation(async (msg) => {
      channelMessages.push(msg);
      return 8888;
    });
    sendTelegramSpy.mockResolvedValue(true);
    ensureLoggedInSpy.mockResolvedValue(undefined as never);
    safeGotoSpy.mockResolvedValue(undefined as never);
    processSeminarQuizSpy.mockResolvedValue({
      success: true,
      hasQuizResult: true,
      message: '정답 : 2번 O',
    });

    // 기존 공지 메시지 등록 (진행 중 상태)
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    channelRepo.recordChannelMessage({
      channelId: 'notice_chan',
      messageId: 701,
      date: todayStr,
      text: '🔔 점심세미나\n\n🟢 입장가능 | 12:30 당뇨 세미나\nhttps://m.doctorville.co.kr/cme/seminar/901',
      status: 'sent',
    });

    // API 응답: 세미나가 이미 방송 종료(processState 7) 및 설문 진행중(surveyState 1) 상태
    fetchMainFutureSpy.mockResolvedValue({
      success: true,
      items: [
        {
          seminarId: 901,
          seminarNm: '당뇨 세미나',
          startDt: `${todayStr} 12:30:00`,
          endDt: `${todayStr} 13:30:00`,
          useSurvey: 'Y',
          useDepthSurvey: 'N',
          processState: 7, // PROCESS_END
        },
      ],
      rawResponse: {},
    });

    fetchSeminarDetailSpy.mockResolvedValue({
      success: true,
      seminarId: '901',
      surveyState: 1, // 설문 진행 중
      isPointExcluded: false,
      hasEntryHistory: true,
      rawResponse: { surveyState: 1, seminarDetail: { processState: 7 } },
    });

    const mockPage = {
      locator: (selector: string) => ({
        first: () => ({
          isVisible: async () => selector.includes('설문참여'),
          click: async () => {},
          isEnabled: async () => true,
        }),
      }),
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
      screenshot: async () => {},
      url: () => 'https://m.doctorville.co.kr/cme/seminar/901',
      close: async () => {},
    } as unknown as Page;

    const mockContext = {
      newPage: async () => mockPage,
      waitForEvent: async () => null,
      close: async () => {},
    } as unknown as BrowserContext;

    // autoResume으로 실행 (점심 시간대 11시 ~ 15시)
    const result = await monitorSeminars('점심', 11, 15, {
      isAutoResume: true,
      context: mockContext,
      pollIntervalMs: 10,
      waitForSurveyClose: false, // 테스트에서는 세미나 종료 감지 즉시 완료
    });

    expect(result).toBe(true);
    expect(processSeminarQuizSpy).toHaveBeenCalled();
    expect(channelMessages.some((m) => m.includes('정답 : 2번 O'))).toBe(true);
  });

  it('Case 6: 다운타임 중 모든 세미나 및 설문이 마감된 상태에서 재개 시 즉시 모두종료 공지 전송 후 정상 종료 검증', async () => {
    const fetchMainFutureSpy = vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars');
    const fetchSeminarDetailSpy = vi.spyOn(seminarApiModule, 'fetchSeminarDetail');
    const sendNotificationToChannelSpy = vi.spyOn(utilsModule, 'sendNotificationToChannel');
    const sendTelegramSpy = vi.spyOn(utilsModule, 'sendTelegram');

    const channelMessages: string[] = [];
    sendNotificationToChannelSpy.mockImplementation(async (msg) => {
      channelMessages.push(msg);
      return 9999;
    });
    sendTelegramSpy.mockResolvedValue(true);

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    channelRepo.recordChannelMessage({
      channelId: 'notice_chan',
      messageId: 801,
      date: todayStr,
      text: '🔔 점심세미나\n\n🟢 입장가능 | 12:30 고혈압 세미나',
      status: 'sent',
    });

    fetchMainFutureSpy.mockResolvedValue({
      success: true,
      items: [
        {
          seminarId: 902,
          seminarNm: '고혈압 세미나',
          startDt: `${todayStr} 12:30:00`,
          endDt: `${todayStr} 13:30:00`,
          useSurvey: 'N',
          processState: 8, // PROCESS_COMPLETED
          seminarCompleted: 1,
        },
      ],
      rawResponse: {},
    });

    fetchSeminarDetailSpy.mockResolvedValue({
      success: true,
      seminarId: '902',
      surveyState: 2, // 설문 완료/마감
      isPointExcluded: false,
      hasEntryHistory: true,
      rawResponse: { surveyState: 2, seminarDetail: { processState: 8, seminarCompleted: 1 } },
    });

    const mockPage = {
      close: async () => {},
    } as unknown as Page;

    const mockContext = {
      newPage: async () => mockPage,
      close: async () => {},
    } as unknown as BrowserContext;

    const editChannelMessageSpy = vi.spyOn(channelRepo, 'editChannelMessage');
    editChannelMessageSpy.mockResolvedValue({ success: true, message: 'edited' });

    const result = await monitorSeminars('점심', 11, 15, {
      isAutoResume: true,
      context: mockContext,
      pollIntervalMs: 10,
      waitForSurveyClose: true,
    });

    expect(result).toBe(true);
    // 1. 새 메시지 발송 대신 editChannelMessage를 통해 기존 메시지가 인플레이스 update 되었는지 검증 (새 푸시 알림 없음)
    expect(editChannelMessageSpy).toHaveBeenCalledWith(
      801,
      expect.stringContaining('🏁 점심세미나가 모두 종료되었습니다.'),
    );
    // 2. 관리자 텔레그램봇으로 autoResume 재개 사실이 전송되었는지 검증
    expect(sendTelegramSpy).toHaveBeenCalledWith(expect.stringContaining('세미나 감시가 재개(autoResume)되었으며'));
  });
});
