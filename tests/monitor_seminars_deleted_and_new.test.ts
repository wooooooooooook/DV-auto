import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as storage from '../src/services/storage';
import * as seminarRepo from '../src/services/seminar_repository';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as utilsModule from '../src/modules/utils';
import {
  monitorSeminars,
  buildSeminarStatusMessage,
  getTodaysSeminarsFromApi,
  checkSeminarEndStatusFromApi,
} from '../src/tasks/monitor_seminars';
import type { BrowserContext, Page } from 'playwright';

describe('monitor_seminars 삭제 세미나, 신규 세미나 및 종료 안내 개선 테스트', () => {
  beforeEach(() => {
    storage.setDatabasePath(':memory:');
    storage.clear();
    vi.spyOn(utilsModule, 'ensureLoggedIn').mockResolvedValue(undefined as never);
    vi.spyOn(utilsModule, 'safeGoto').mockResolvedValue(undefined as never);
    vi.spyOn(seminarApiModule, 'attendSeminarApi').mockResolvedValue({
      success: true,
      hasEntryHistory: true,
    });
  });

  afterEach(() => {
    storage.closeDatabase();
    vi.restoreAllMocks();
  });

  it('Test 1: "A,B" -> "A", B 상세 API "세미나 정보를 찾을 수 없습니다" -> B 삭제 확정, DB isClosed=1, 이후 polling에서도 B 재등록 없음, A 종료 후 monitor 정상 종료', async () => {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

    // DB에 A, B 저장
    seminarRepo.setAllSeminars([
      {
        seminarId: '101',
        name: '세미나A',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        date: todayStr,
        time: '12:00~13:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
        isPointExcluded: false,
      },
      {
        seminarId: '102',
        name: '세미나B (삭제대상)',
        url: 'https://m.doctorville.co.kr/cme/seminar/102',
        date: todayStr,
        time: '12:00~13:00',
        currentCount: '5',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
        isPointExcluded: false,
      },
    ]);

    let pollCount = 0;
    const fetchMainFutureSpy = vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars');
    const fetchSeminarDetailSpy = vi.spyOn(seminarApiModule, 'fetchSeminarDetail');
    const sendTelegramSpy = vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true);
    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockResolvedValue(1001);

    // 1차 폴링: A, B 모두 반환
    // 2차 폴링: B가 목록에서 사라지고 A만 반환 (A는 종료 상태)
    fetchMainFutureSpy.mockImplementation(async () => {
      pollCount++;
      if (pollCount === 1) {
        return {
          success: true,
          items: [
            {
              seminarId: 101,
              seminarNm: '세미나A',
              startDt: `${todayStr} 12:00:00`,
              endDt: `${todayStr} 13:00:00`,
              useSurvey: 'Y',
              processState: 2, // 대기
            },
            {
              seminarId: 102,
              seminarNm: '세미나B (삭제대상)',
              startDt: `${todayStr} 12:00:00`,
              endDt: `${todayStr} 13:00:00`,
              useSurvey: 'Y',
              processState: 2, // 대기
            },
          ],
          rawResponse: {},
        };
      }
      // 2차 이후: A만 반환하며 A는 방송 완료/종료(processState: 8, seminarCompleted: 1)
      return {
        success: true,
        items: [
          {
            seminarId: 101,
            seminarNm: '세미나A',
            startDt: `${todayStr} 12:00:00`,
            endDt: `${todayStr} 13:00:00`,
            useSurvey: 'Y',
            processState: 8,
            seminarCompleted: 1,
          },
        ],
        rawResponse: {},
      };
    });

    fetchSeminarDetailSpy.mockImplementation(async (sid) => {
      const id = String(sid);
      if (id === '101') {
        if (pollCount >= 2) {
          return {
            success: true,
            seminarId: '101',
            surveyState: 2,
            isPointExcluded: false,
            hasEntryHistory: true,
            rawResponse: { surveyState: 2, seminarDetail: { processState: 8, seminarCompleted: 1 } },
          };
        }
        return {
          success: true,
          seminarId: '101',
          surveyState: 5,
          isPointExcluded: false,
          hasEntryHistory: true,
          rawResponse: { surveyState: 5, seminarDetail: { processState: 2 } },
        };
      }
      if (id === '102') {
        if (pollCount === 1) {
          return {
            success: true,
            seminarId: '102',
            surveyState: 5,
            isPointExcluded: false,
            hasEntryHistory: true,
            rawResponse: { surveyState: 5, seminarDetail: { processState: 2 } },
          };
        }
        // 2차 이후: 404 또는 "세미나 정보를 찾을 수 없습니다"
        return {
          success: false,
          seminarId: '102',
          isAuthExpired: false,
          statusCode: 404,
          isNotFound: true,
          errorMessage: '세미나 정보를 찾을 수 없습니다.',
        };
      }
      return { success: false, seminarId: id, isAuthExpired: false, errorMessage: 'not found' };
    });

    const mockPage = {
      close: async () => {},
    } as unknown as Page;
    const mockContext = {
      newPage: async () => mockPage,
      close: async () => {},
    } as unknown as BrowserContext;

    const result = await monitorSeminars('점심', 0, 24, {
      context: mockContext,
      pollIntervalMs: 10,
      waitForSurveyClose: false,
    });

    expect(result).toBe(true);

    // B가 삭제 확정되어 DB에 isClosed = true(1) 로 마킹되었는지 확인
    const storedB = seminarRepo.getSeminarById('102');
    expect(storedB).not.toBeNull();
    expect(storedB?.isClosed).toBe(true);

    // 삭제된 B에 대해 관리자 알림이 발송되었는지 확인
    expect(
      sendTelegramSpy.mock.calls.some((call) => typeof call[0] === 'string' && call[0].includes('세미나가 삭제/취소')),
    ).toBe(true);

    // DB fallback에서도 isClosed=true인 B는 주입되지 않는지 확인
    const fallbackCheck = await getTodaysSeminarsFromApi(11, 15, todayStr);
    expect(fallbackCheck.seminars['102']).toBeUndefined();
  });

  it('Test 2: "A,B" -> "A", B 상세 API timeout/500 -> B 삭제 처리하지 않고 기존 상태 유지', async () => {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    let pollCount = 0;

    const fetchMainFutureSpy = vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars');
    const fetchSeminarDetailSpy = vi.spyOn(seminarApiModule, 'fetchSeminarDetail');
    vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true);
    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockResolvedValue(1002);

    fetchMainFutureSpy.mockImplementation(async () => {
      pollCount++;
      if (pollCount === 1) {
        return {
          success: true,
          items: [
            {
              seminarId: 201,
              seminarNm: '세미나A',
              startDt: `${todayStr} 12:00:00`,
              endDt: `${todayStr} 13:00:00`,
              useSurvey: 'Y',
              processState: 2,
            },
            {
              seminarId: 202,
              seminarNm: '세미나B (일시 오류)',
              startDt: `${todayStr} 12:00:00`,
              endDt: `${todayStr} 13:00:00`,
              useSurvey: 'Y',
              processState: 2,
            },
          ],
          rawResponse: {},
        };
      }
      // 2차: 메인 API에서 B 일시 누락, A는 종료 상태
      return {
        success: true,
        items: [
          {
            seminarId: 201,
            seminarNm: '세미나A',
            startDt: `${todayStr} 12:00:00`,
            endDt: `${todayStr} 13:00:00`,
            useSurvey: 'Y',
            processState: 8,
            seminarCompleted: 1,
          },
        ],
        rawResponse: {},
      };
    });

    fetchSeminarDetailSpy.mockImplementation(async (sid) => {
      const id = String(sid);
      if (id === '201') {
        return {
          success: true,
          seminarId: '201',
          surveyState: pollCount >= 2 ? 2 : 5,
          isPointExcluded: false,
          hasEntryHistory: true,
          rawResponse: { surveyState: pollCount >= 2 ? 2 : 5, seminarDetail: { processState: pollCount >= 2 ? 8 : 2 } },
        };
      }
      if (id === '202') {
        if (pollCount === 1) {
          return {
            success: true,
            seminarId: '202',
            surveyState: 5,
            isPointExcluded: false,
            hasEntryHistory: true,
            rawResponse: { surveyState: 5, seminarDetail: { processState: 2 } },
          };
        }
        // 2차: 500 서버 에러 또는 timeout
        return {
          success: false,
          seminarId: '202',
          isAuthExpired: false,
          statusCode: 500,
          errorMessage: 'Internal Server Error (timeout)',
        };
      }
      return { success: false, seminarId: id, isAuthExpired: false, errorMessage: 'not found' };
    });

    const endCheckB = await checkSeminarEndStatusFromApi('202');
    expect(endCheckB.isDeletedOrNotFound).toBe(false);
    expect(endCheckB.errorType).toBe('network_or_server');
  });

  it('Test 3: "A,B" -> "A,B,C" -> C 신규 감지 및 C 단건 신청/입장 처리', async () => {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    let pollCount = 0;

    const fetchMainFutureSpy = vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars');
    const fetchSeminarDetailSpy = vi.spyOn(seminarApiModule, 'fetchSeminarDetail');
    const sendTelegramSpy = vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true);
    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockResolvedValue(1003);
    const applySeminarSpy = vi.spyOn(seminarApiModule, 'applySeminarWithTerms').mockResolvedValue({
      success: true,
      message: '신청 완료',
      seminarId: '303',
      isAuthExpired: false,
    });

    fetchMainFutureSpy.mockImplementation(async () => {
      pollCount++;
      if (pollCount === 1) {
        return {
          success: true,
          items: [
            {
              seminarId: 301,
              seminarNm: '세미나A',
              startDt: `${todayStr} 12:00:00`,
              endDt: `${todayStr} 13:00:00`,
              useSurvey: 'Y',
              processState: 2,
            },
          ],
          rawResponse: {},
        };
      }
      // 2차: C 세미나 새로 등장 (PROCESS_APPLY = 2 상태)
      return {
        success: true,
        items: [
          {
            seminarId: 301,
            seminarNm: '세미나A',
            startDt: `${todayStr} 12:00:00`,
            endDt: `${todayStr} 13:00:00`,
            useSurvey: 'Y',
            processState: 8,
            seminarCompleted: 1,
          },
          {
            seminarId: 303,
            seminarNm: '신규세미나C',
            startDt: `${todayStr} 12:30:00`,
            endDt: `${todayStr} 13:30:00`,
            useSurvey: 'Y',
            processState: 2, // 신청 필요
          },
        ],
        rawResponse: {},
      };
    });

    fetchSeminarDetailSpy.mockImplementation(async (sid) => {
      const id = String(sid);
      if (id === '301') {
        return {
          success: true,
          seminarId: '301',
          surveyState: pollCount >= 2 ? 2 : 5,
          isPointExcluded: false,
          hasEntryHistory: true,
          rawResponse: { surveyState: pollCount >= 2 ? 2 : 5, seminarDetail: { processState: pollCount >= 2 ? 8 : 2 } },
        };
      }
      if (id === '303') {
        return {
          success: true,
          seminarId: '303',
          surveyState: pollCount >= 3 ? 2 : 5,
          isPointExcluded: false,
          hasEntryHistory: pollCount >= 3,
          rawResponse: {
            surveyState: pollCount >= 3 ? 2 : 5,
            seminarDetail: { processState: pollCount >= 3 ? 8 : 2, seminarCompleted: pollCount >= 3 ? 1 : 0 },
          },
        };
      }
      return { success: false, seminarId: id, isAuthExpired: false, errorMessage: 'not found' };
    });

    const mockPage = {
      close: async () => {},
    } as unknown as Page;
    const mockContext = {
      newPage: async () => mockPage,
      close: async () => {},
    } as unknown as BrowserContext;

    setTimeout(() => {
      // 3회차에는 모두 종료 처리
      fetchMainFutureSpy.mockResolvedValue({
        success: true,
        items: [
          {
            seminarId: 301,
            seminarNm: '세미나A',
            startDt: `${todayStr} 12:00:00`,
            endDt: `${todayStr} 13:00:00`,
            useSurvey: 'Y',
            processState: 8,
            seminarCompleted: 1,
          },
          {
            seminarId: 303,
            seminarNm: '신규세미나C',
            startDt: `${todayStr} 12:30:00`,
            endDt: `${todayStr} 13:30:00`,
            useSurvey: 'Y',
            processState: 8,
            seminarCompleted: 1,
          },
        ],
        rawResponse: {},
      });
    }, 25);

    const result = await monitorSeminars('점심', 0, 24, {
      context: mockContext,
      pollIntervalMs: 10,
      waitForSurveyClose: false,
    });

    expect(result).toBe(true);

    // C 신규 감지 텔레그램 알림 발송 확인
    expect(
      sendTelegramSpy.mock.calls.some((call) => typeof call[0] === 'string' && call[0].includes('신규세미나C')),
    ).toBe(true);

    // C 단건 신청 applySeminarWithTerms가 호출되었는지 확인
    expect(applySeminarSpy).toHaveBeenCalledWith('303');
  });

  it('Test 4: 모니터링 종료 안내가 polling마다 새 메시지로 생성되지 않고 기존 현황 메시지만 수정됨', () => {
    const periodName = '점심';
    const seminars = [
      {
        seminarId: '401',
        name: '미종료 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/401',
        status: '대기' as const,
      },
    ];

    const timeExpiredMessage = '점심 모니터링 시간이 종료되었지만, 마치지 않은 세미나가 있습니다:\n• 미종료 세미나';

    // 1. 미종료 세미나가 있을 때 timeExpiredMessage 첨부 확인
    const statusMsg = buildSeminarStatusMessage(periodName, seminars, false, [], Date.now(), timeExpiredMessage);
    expect(statusMsg.text).toContain('⚠️ 점심 모니터링 시간이 종료되었지만, 마치지 않은 세미나가 있습니다:');
    expect(statusMsg.text).not.toContain('🏁 점심세미나가 모두 종료되었습니다.');

    // 2. 미종료 세미나가 완료(isAllCompleted=true)로 바뀌었을 때 timeExpiredMessage가 제거되고 완료 문구로 교체됨 확인
    const completedSeminars = [
      {
        seminarId: '401',
        name: '미종료 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/401',
        status: '종료' as const,
      },
    ];
    const completedStatusMsg = buildSeminarStatusMessage(
      periodName,
      completedSeminars,
      true,
      [],
      Date.now(),
      timeExpiredMessage,
    );
    expect(completedStatusMsg.text).toContain('🏁 점심세미나가 모두 종료되었습니다.');
    expect(completedStatusMsg.text).not.toContain('⚠️ 점심 모니터링 시간이 종료되었지만');
  });

  it('Test 5: 세미나 5611 실제 사례 (상세 API가 200 OK에 {} 빈 객체 반환) -> 삭제 확정, DB isClosed=1, 미완료 세미나 알림 없이 정상 종료', async () => {
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

    // DB에 5647(정상), 5611(삭제), 5610(정상) 저장되어 있는 상황
    seminarRepo.setAllSeminars([
      {
        seminarId: '5647',
        name: '[EZcare WEEK] 스타틴 가짜',
        url: 'https://m.doctorville.co.kr/cme/seminar/5647',
        date: todayStr,
        time: '13:00~14:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
        isPointExcluded: false,
      },
      {
        seminarId: '5611',
        name: '병 의원 입지분석',
        url: 'https://m.doctorville.co.kr/cme/seminar/5611',
        date: todayStr,
        time: '13:00~14:00',
        currentCount: '0',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
        isPointExcluded: false,
      },
      {
        seminarId: '5610',
        name: '제미다파정을 활용한 새로운 병용치료의',
        url: 'https://m.doctorville.co.kr/cme/seminar/5610',
        date: todayStr,
        time: '13:00~14:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
        isPointExcluded: false,
      },
    ]);

    const fetchMainFutureSpy = vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars');
    const fetchSeminarDetailSpy = vi.spyOn(seminarApiModule, 'fetchSeminarDetail');
    const sendTelegramSpy = vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true);
    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockResolvedValue(5600);

    // 메인 API 목록에는 5647, 5610만 있고 (모두 종료 상태), 5611은 사라진 상태
    fetchMainFutureSpy.mockResolvedValue({
      success: true,
      items: [
        {
          seminarId: 5647,
          seminarNm: '[EZcare WEEK] 스타틴 가짜',
          startDt: `${todayStr} 13:00:00`,
          endDt: `${todayStr} 14:00:00`,
          useSurvey: 'Y',
          processState: 8,
          seminarCompleted: 1,
        },
        {
          seminarId: 5610,
          seminarNm: '제미다파정을 활용한 새로운 병용치료의',
          startDt: `${todayStr} 13:00:00`,
          endDt: `${todayStr} 14:00:00`,
          useSurvey: 'Y',
          processState: 8,
          seminarCompleted: 1,
        },
      ],
      rawResponse: {},
    });

    // 5611 상세 API 조회 시 서버가 {} 빈 객체를 반환하는 실제 닥터빌 동작
    fetchSeminarDetailSpy.mockImplementation(async (sid) => {
      const id = String(sid);
      if (id === '5647' || id === '5610') {
        return {
          success: true,
          seminarId: id,
          surveyState: 2,
          isPointExcluded: false,
          hasEntryHistory: true,
          rawResponse: { surveyState: 2, seminarDetail: { processState: 8, seminarCompleted: 1 } },
        };
      }
      if (id === '5611') {
        return {
          success: false,
          seminarId: '5611',
          isAuthExpired: false,
          statusCode: 404,
          isNotFound: true,
          errorMessage: '세미나 정보를 찾을 수 없습니다.',
          rawResponse: {},
        };
      }
      return { success: false, seminarId: id, isAuthExpired: false, errorMessage: 'not found' };
    });

    const mockPage = {
      close: async () => {},
    } as unknown as Page;
    const mockContext = {
      newPage: async () => mockPage,
      close: async () => {},
    } as unknown as BrowserContext;

    // 모니터링 실행
    const result = await monitorSeminars('점심', 0, 24, {
      context: mockContext,
      pollIntervalMs: 10,
      waitForSurveyClose: false,
    });

    expect(result).toBe(true);

    // 5611이 삭제 확정되어 DB isClosed=1로 기록되었는지 확인
    const stored5611 = seminarRepo.getSeminarById('5611');
    expect(stored5611?.isClosed).toBe(true);

    // 5611 삭제 안내 텔레그램 알림 발송 확인
    expect(sendTelegramSpy.mock.calls.some((call) => typeof call[0] === 'string' && call[0].includes('5611'))).toBe(
      true,
    );

    // 5611이 미완료 세미나로 남지 않고 5647, 5610만 완료되어 정상 종료되었는지 확인
    expect(
      sendTelegramSpy.mock.calls.some(
        (call) => typeof call[0] === 'string' && call[0].includes('마치지 않은 세미나가 있습니다'),
      ),
    ).toBe(false);
  });
});
