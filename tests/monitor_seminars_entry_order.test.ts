import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import { monitorSeminars } from '../src/tasks/monitor_seminars';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as utilsModule from '../src/modules/utils';
import * as storage from '../src/services/storage';

describe('monitor_seminars 공지채널 메시지 선발송 및 Playwright 입장 순서 검증', () => {
  beforeEach(() => {
    storage.setDatabasePath(':memory:');
    storage.clear();
  });

  afterEach(() => {
    storage.closeDatabase();
    vi.restoreAllMocks();
  });

  it('초기 세미나 목록에서 입장가능 세미나 감지 시 Playwright 입장 전에 공지채널 메시지를 먼저 발송해야 한다', async () => {
    const fetchMainFutureSpy = vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars');
    const fetchSeminarDetailSpy = vi.spyOn(seminarApiModule, 'fetchSeminarDetail');
    const sendNotificationToChannelSpy = vi.spyOn(utilsModule, 'sendNotificationToChannel');
    const sendTelegramSpy = vi.spyOn(utilsModule, 'sendTelegram');
    const ensureLoggedInSpy = vi.spyOn(utilsModule, 'ensureLoggedIn');
    const safeGotoSpy = vi.spyOn(utilsModule, 'safeGoto');

    const eventOrder: string[] = [];
    let messageIdSeq = 500;

    sendNotificationToChannelSpy.mockImplementation(async () => {
      eventOrder.push('send_channel_notice');
      return ++messageIdSeq;
    });

    sendTelegramSpy.mockResolvedValue(true);
    ensureLoggedInSpy.mockResolvedValue(undefined as never);
    safeGotoSpy.mockResolvedValue(undefined as never);

    const mockPage = {
      locator: (selector: string) => ({
        first: () => ({
          isVisible: async () => selector.includes('입장하기') || selector.includes('방송보기'),
          click: async () => {},
          isEnabled: async () => true,
          count: async () => 1,
          waitFor: async () => {},
        }),
        count: async () => 1,
        waitFor: async () => {},
      }),
      getByRole: () => ({
        first: () => ({
          isVisible: async () => true,
          click: async () => {},
          waitFor: async () => {},
        }),
      }),
      evaluate: async () => [],
      on: () => {},
      waitForEvent: async () => null,
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
      screenshot: async () => {},
      frames: () => [{ url: () => 'https://video.ibm.com/socialstream/123' }],
      url: () => 'https://m.doctorville.co.kr/cme/seminar/attend?seminarId=8801',
      close: async () => {},
    } as unknown as Page;

    const mockContext = {
      newPage: async () => {
        eventOrder.push('playwright_newPage');
        return mockPage;
      },
      waitForEvent: async () => null,
      close: async () => {},
    } as unknown as BrowserContext;

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours();

    let step = 0;
    fetchMainFutureSpy.mockImplementation(async () => {
      step++;
      if (step === 1) {
        return {
          success: true,
          items: [
            {
              seminarId: 8801,
              seminarNm: '점심 라이브 시작 세미나',
              startDt: `${todayStr} ${String(currentHour).padStart(2, '0')}:00:00`,
              endDt: `${todayStr} ${String(currentHour + 1).padStart(2, '0')}:00:00`,
              useSurvey: 'Y',
              useDepthSurvey: 'N',
              survey: { point: 1000 },
              processState: 1, // 입장가능
            },
          ],
          rawResponse: {},
        };
      }
      return {
        success: true,
        items: [
          {
            seminarId: 8801,
            seminarNm: '점심 라이브 시작 세미나',
            startDt: `${todayStr} ${String(currentHour).padStart(2, '0')}:00:00`,
            endDt: `${todayStr} ${String(currentHour + 1).padStart(2, '0')}:00:00`,
            useSurvey: 'Y',
            useDepthSurvey: 'N',
            survey: { point: 1000 },
            processState: 7, // 방송 종료
            seminarCompleted: 1,
          },
        ],
        rawResponse: {},
      };
    });

    fetchSeminarDetailSpy.mockImplementation(async (id: number | string) => {
      if (step === 1) {
        return {
          success: true,
          seminarId: String(id),
          survey: { point: 1000 },
          surveyState: 5,
          isPointExcluded: false,
          hasEntryHistory: false, // 1차 API 입장 이력 없음 -> Playwright 폴백 유도
          rawResponse: { surveyState: 5, seminarDetail: { processState: 1 } },
        };
      }
      return {
        success: true,
        seminarId: String(id),
        survey: { point: 1000 },
        surveyState: 3, // 마감
        isPointExcluded: false,
        hasEntryHistory: true,
        rawResponse: { surveyState: 3, seminarDetail: { processState: 7 } },
      };
    });

    // 1차 API 실패 유도 (attendSeminarApi) -> Playwright newPage로 폴백되도록 설정
    const seminarApi = await import('../src/modules/seminar_api');
    vi.spyOn(seminarApi, 'attendSeminarApi').mockResolvedValue({
      success: false,
      hasEntryHistory: false,
      errorMessage: 'API fallback test',
    });

    const result = await monitorSeminars('점심', currentHour, currentHour + 2, {
      context: mockContext,
      pollIntervalMs: 10,
      waitForSurveyClose: false,
    });

    expect(result).toBe(true);

    // 공지채널 메시지 발송이 Playwright 입장(newPage)보다 먼저 호출되었는지 확인
    const firstNoticeIndex = eventOrder.indexOf('send_channel_notice');
    const firstPlaywrightIndex = eventOrder.indexOf('playwright_newPage');

    expect(firstNoticeIndex).toBeGreaterThanOrEqual(0);
    expect(firstPlaywrightIndex).toBeGreaterThanOrEqual(0);
    expect(firstNoticeIndex).toBeLessThan(firstPlaywrightIndex);
  });

  it('폴링 중 대기 상태에서 입장가능으로 전이될 때도 공지채널 메시지를 먼저 발송한 후 Playwright 입장을 실행해야 한다', async () => {
    const fetchMainFutureSpy = vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars');
    const fetchSeminarDetailSpy = vi.spyOn(seminarApiModule, 'fetchSeminarDetail');
    const sendNotificationToChannelSpy = vi.spyOn(utilsModule, 'sendNotificationToChannel');
    const sendTelegramSpy = vi.spyOn(utilsModule, 'sendTelegram');
    const ensureLoggedInSpy = vi.spyOn(utilsModule, 'ensureLoggedIn');
    const safeGotoSpy = vi.spyOn(utilsModule, 'safeGoto');

    const eventOrder: string[] = [];
    let messageIdSeq = 700;

    sendNotificationToChannelSpy.mockImplementation(async () => {
      eventOrder.push('send_channel_notice');
      return ++messageIdSeq;
    });

    sendTelegramSpy.mockResolvedValue(true);
    ensureLoggedInSpy.mockResolvedValue(undefined as never);
    safeGotoSpy.mockResolvedValue(undefined as never);

    const mockPage = {
      locator: (selector: string) => ({
        first: () => ({
          isVisible: async () => selector.includes('입장하기'),
          click: async () => {},
          isEnabled: async () => true,
          count: async () => 1,
          waitFor: async () => {},
        }),
        count: async () => 1,
        waitFor: async () => {},
      }),
      getByRole: () => ({
        first: () => ({
          isVisible: async () => true,
          click: async () => {},
          waitFor: async () => {},
        }),
      }),
      evaluate: async () => [],
      on: () => {},
      waitForEvent: async () => null,
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
      screenshot: async () => {},
      frames: () => [{ url: () => 'https://video.ibm.com/socialstream/123' }],
      url: () => 'https://m.doctorville.co.kr/cme/seminar/attend?seminarId=8802',
      close: async () => {},
    } as unknown as Page;

    const mockContext = {
      newPage: async () => {
        eventOrder.push('playwright_newPage');
        return mockPage;
      },
      waitForEvent: async () => null,
      close: async () => {},
    } as unknown as BrowserContext;

    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours();

    let step = 0;
    fetchMainFutureSpy.mockImplementation(async () => {
      step++;
      if (step === 1) {
        return {
          success: true,
          items: [
            {
              seminarId: 8802,
              seminarNm: '전이 테스트 세미나',
              startDt: `${todayStr} ${String(currentHour).padStart(2, '0')}:00:00`,
              endDt: `${todayStr} ${String(currentHour + 1).padStart(2, '0')}:00:00`,
              useSurvey: 'Y',
              useDepthSurvey: 'N',
              survey: { point: 1000 },
              processState: 2, // 대기 상태 (초기 공지 발송 안 됨)
            },
          ],
          rawResponse: {},
        };
      } else if (step === 2) {
        return {
          success: true,
          items: [
            {
              seminarId: 8802,
              seminarNm: '전이 테스트 세미나',
              startDt: `${todayStr} ${String(currentHour).padStart(2, '0')}:00:00`,
              endDt: `${todayStr} ${String(currentHour + 1).padStart(2, '0')}:00:00`,
              useSurvey: 'Y',
              useDepthSurvey: 'N',
              survey: { point: 1000 },
              processState: 1, // 입장가능으로 전이
            },
          ],
          rawResponse: {},
        };
      }
      return {
        success: true,
        items: [
          {
            seminarId: 8802,
            seminarNm: '전이 테스트 세미나',
            startDt: `${todayStr} ${String(currentHour).padStart(2, '0')}:00:00`,
            endDt: `${todayStr} ${String(currentHour + 1).padStart(2, '0')}:00:00`,
            useSurvey: 'Y',
            useDepthSurvey: 'N',
            survey: { point: 1000 },
            processState: 7, // 방송 종료
            seminarCompleted: 1,
          },
        ],
        rawResponse: {},
      };
    });

    fetchSeminarDetailSpy.mockImplementation(async (id: number | string) => {
      if (step === 1) {
        return {
          success: true,
          seminarId: String(id),
          survey: { point: 1000 },
          surveyState: 5,
          isPointExcluded: false,
          hasEntryHistory: false,
          rawResponse: { surveyState: 5, seminarDetail: { processState: 2 } },
        };
      } else if (step === 2) {
        return {
          success: true,
          seminarId: String(id),
          survey: { point: 1000 },
          surveyState: 5,
          isPointExcluded: false,
          hasEntryHistory: false,
          rawResponse: { surveyState: 5, seminarDetail: { processState: 1 } },
        };
      }
      return {
        success: true,
        seminarId: String(id),
        survey: { point: 1000 },
        surveyState: 3,
        isPointExcluded: false,
        hasEntryHistory: true,
        rawResponse: { surveyState: 3, seminarDetail: { processState: 7 } },
      };
    });

    const seminarApi = await import('../src/modules/seminar_api');
    vi.spyOn(seminarApi, 'attendSeminarApi').mockResolvedValue({
      success: false,
      hasEntryHistory: false,
      errorMessage: 'API fallback test',
    });

    const result = await monitorSeminars('점심', currentHour, currentHour + 2, {
      context: mockContext,
      pollIntervalMs: 10,
      waitForSurveyClose: false,
    });

    expect(result).toBe(true);

    const firstNoticeIndex = eventOrder.indexOf('send_channel_notice');
    const firstPlaywrightIndex = eventOrder.indexOf('playwright_newPage');

    expect(firstNoticeIndex).toBeGreaterThanOrEqual(0);
    expect(firstPlaywrightIndex).toBeGreaterThanOrEqual(0);
    expect(firstNoticeIndex).toBeLessThan(firstPlaywrightIndex);
  });
});
