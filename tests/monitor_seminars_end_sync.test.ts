import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as storage from '../src/services/storage';
import * as seminarRepo from '../src/services/seminar_repository';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as utilsModule from '../src/modules/utils';
import * as syncService from '../src/services/seminar_sync_service';
import * as channelMessageRepo from '../src/services/channel_message_repository';
import * as seminarQuizModule from '../src/tasks/seminar_quiz';
import { monitorSeminars } from '../src/tasks/monitor_seminars';
import type { BrowserContext, Page } from 'playwright';

describe('monitor_seminars_end_sync (세미나 모두 종료 메시지 시점 detail API 동기화)', () => {
  const mockPage = {
    close: async () => {},
  } as unknown as Page;
  const mockContext = {
    newPage: async () => mockPage,
    close: async () => {},
  } as unknown as BrowserContext;

  beforeEach(() => {
    storage.setDatabasePath(':memory:');
    storage.clear();
    vi.spyOn(utilsModule, 'ensureLoggedIn').mockResolvedValue(undefined as never);
    vi.spyOn(utilsModule, 'safeGoto').mockResolvedValue(undefined as never);
    vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true);
    vi.spyOn(seminarQuizModule, 'processSeminarQuiz').mockResolvedValue({
      success: true,
      hasQuizResult: false,
      message: '퀴즈 완료',
    });
    vi.spyOn(seminarApiModule, 'attendSeminarApi').mockResolvedValue({
      success: true,
      hasEntryHistory: true,
    });
  });

  afterEach(() => {
    storage.closeDatabase();
    vi.restoreAllMocks();
  });

  it('모든 세미나 및 설문이 초기 확인 시 이미 종료되어 완료 메시지 발송 시 syncSeminarsDetailToDb가 호출된다', async () => {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

    // DB에 종료 예정 세미나 1개 저장
    seminarRepo.setAllSeminars([
      {
        seminarId: '9001',
        name: '종료 예정 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/9001',
        date: todayStr,
        time: '12:00~13:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
        isPointExcluded: false,
        processState: seminarApiModule.ProcessState.PROCESS_ENTER,
      },
    ]);

    // mainFuture API: 빈 목록
    vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
      success: true,
      items: [],
    });

    // detail API: 종료 완료(isEnded: true, surveyState: 2=완료)
    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockResolvedValue({
      success: true,
      surveyState: 2, // SURVEY_COMPLETED
      isPointExcluded: false,
      hasEntryHistory: true,
      rawResponse: {
        seminarDetail: {
          processState: seminarApiModule.ProcessState.PROCESS_COMPLETED,
          seminarCompleted: 1,
        },
      },
    });

    const syncSpy = vi.spyOn(syncService, 'syncSeminarsDetailToDb').mockResolvedValue([]);
    vi.spyOn(channelMessageRepo, 'publishAndReplaceChannelNotice').mockResolvedValue(12345);

    await monitorSeminars('점심', 0, 24, {
      context: mockContext,
      pollIntervalMs: 10,
      waitForSurveyClose: false,
    });

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ seminarId: '9001' })]),
      3,
      250,
    );
  });

  it('모니터링 루프 진행 중 세미나가 종료되어 isAllCompleted가 될 때도 syncSeminarsDetailToDb가 호출된다', async () => {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

    seminarRepo.setAllSeminars([
      {
        seminarId: '9002',
        name: '진행 중 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/9002',
        date: todayStr,
        time: '12:00~13:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
        isPointExcluded: false,
        processState: seminarApiModule.ProcessState.PROCESS_ENTER,
      },
    ]);

    vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
      success: true,
      items: [
        {
          seminarId: 9002,
          seminarNm: '진행 중 세미나',
          startDt: `${todayStr} 12:00:00`,
          processState: seminarApiModule.ProcessState.PROCESS_ENTER,
        },
      ],
    });

    let callCount = 0;
    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockImplementation(async () => {
      callCount++;
      if (callCount <= 1) {
        // 1회차(초기): 아직 진행 중
        return {
          success: true,
          surveyState: 5, // 미오픈
          isPointExcluded: false,
          hasEntryHistory: true,
          rawResponse: {
            seminarDetail: {
              processState: seminarApiModule.ProcessState.PROCESS_ENTER,
              seminarCompleted: 0,
            },
          },
        };
      }
      // 2회차 이후(루프): 종료됨
      return {
        success: true,
        surveyState: 2, // 완료
        isPointExcluded: false,
        hasEntryHistory: true,
        rawResponse: {
          seminarDetail: {
            processState: seminarApiModule.ProcessState.PROCESS_COMPLETED,
            seminarCompleted: 1,
          },
        },
      };
    });

    const syncSpy = vi.spyOn(syncService, 'syncSeminarsDetailToDb').mockResolvedValue([]);
    vi.spyOn(channelMessageRepo, 'publishAndReplaceChannelNotice').mockResolvedValue(12345);

    await monitorSeminars('점심', 0, 24, {
      context: mockContext,
      pollIntervalMs: 10,
      waitForSurveyClose: false,
    });

    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ seminarId: '9002' })]),
      3,
      250,
    );
  });
});
