import assert from 'node:assert';
import type { BrowserContext, Page } from 'playwright';
import {
  getTodaysSeminarsFromApi,
  checkSeminarEndStatusFromApi,
  monitorSeminars,
  isSeminarStartedByTime,
} from '../src/tasks/monitor_seminars';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as utilsModule from '../src/modules/utils';
import * as seminarQuizModule from '../src/tasks/seminar_quiz';
import { describe, it, vi } from 'vitest';

describe('monitor_seminars API 기반 모니터링 기능 단위/통합 테스트', () => {
  it('시간대 및 상태 필터링, 종료 상태 확인 종합 테스트', async () => {
    console.log('===========================================================');
    console.log('  monitor_seminars API 기반 모니터링 기능 단위/통합 테스트');
    console.log('===========================================================\n');

    const fetchMainFutureSpy = vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars');
    const fetchSeminarDetailSpy = vi.spyOn(seminarApiModule, 'fetchSeminarDetail');
    const sendNotificationToChannelSpy = vi.spyOn(utilsModule, 'sendNotificationToChannel');
    const sendTelegramSpy = vi.spyOn(utilsModule, 'sendTelegram');
    const ensureLoggedInSpy = vi.spyOn(utilsModule, 'ensureLoggedIn');
    const safeGotoSpy = vi.spyOn(utilsModule, 'safeGoto');
    const processSeminarQuizSpy = vi.spyOn(seminarQuizModule, 'processSeminarQuiz');

    // ── Test 1: getTodaysSeminarsFromApi 시간대 및 상태 필터링 ─────────
    console.log('--- [Test 1] getTodaysSeminarsFromApi 시간대 및 상태 필터링 검증 ---');
    const mockApiItems: seminarApiModule.FutureSeminarApiItem[] = [
      {
        seminarId: 5565,
        seminarNm: '눈에서 시작하는 심혈관 위험 평가',
        startDt: '2026-08-24 13:00:00',
        endDt: '2026-08-24 14:00:00',
        useSurvey: 'Y',
        useDepthSurvey: 'Y',
        survey: { surveyId: 101, point: 1000 },
        processState: 2, // PROCESS_APPLY
      },
      {
        seminarId: 5566,
        seminarNm: '점심 라이브 입장 가능 세미나',
        startDt: '2026-08-24 12:30:00',
        endDt: '2026-08-24 13:30:00',
        useSurvey: 'Y',
        useDepthSurvey: 'N',
        survey: { surveyId: 102, point: 500 },
        processState: 1, // PROCESS_ENTER -> '입장가능'
      },
      {
        seminarId: 5538,
        seminarNm: '저녁 포인트 미지급 세미나',
        startDt: '2026-08-24 18:00:00',
        endDt: '2026-08-24 19:00:00',
        useSurvey: 'Y',
        useDepthSurvey: 'N',
        survey: null, // 포인트 미지급
        processState: 1, // '입장가능'
      },
      {
        seminarId: 5539,
        seminarNm: '내일 세미나 (오늘 필터링 제외 대상)',
        startDt: '2026-08-25 13:00:00',
        endDt: '2026-08-25 14:00:00',
        useSurvey: 'Y',
        survey: { point: 1000 },
        processState: 2,
      },
    ];

    fetchMainFutureSpy.mockResolvedValue({
      success: true,
      items: mockApiItems,
      rawResponse: {},
    });

    // 점심 시간대 (11시 ~ 15시) 조회
    const lunchRes = await getTodaysSeminarsFromApi(11, 15, '2026-08-24');
    assert.strictEqual(lunchRes.success, true);
    const lunchKeys = Object.keys(lunchRes.seminars);
    assert.strictEqual(lunchKeys.length, 2, '2026-08-24 점심 세미나는 2건이어야 함 (5565, 5566)');

    const sem5565 = Object.values(lunchRes.seminars).find((s) => s.seminarId === '5565');
    assert.ok(sem5565);
    assert.strictEqual(sem5565.isAdvancedSurvey, true);
    assert.strictEqual(sem5565.isSurveyPointExcluded, false);

    const sem5566 = Object.values(lunchRes.seminars).find((s) => s.seminarId === '5566');
    assert.ok(sem5566);
    assert.strictEqual(sem5566.status, '입장가능');
    assert.strictEqual(sem5566.isAdvancedSurvey, false);
    assert.strictEqual(sem5566.isSurveyPointExcluded, false);

    // 저녁 시간대 (17시 ~ 22시) 조회 (저장소에 없는 경우 기본 false)
    const dinnerRes = await getTodaysSeminarsFromApi(17, 22, '2026-08-24');
    assert.strictEqual(dinnerRes.success, true);
    const dinnerKeys = Object.keys(dinnerRes.seminars);
    assert.strictEqual(dinnerKeys.length, 1, '2026-08-24 저녁 세미나는 1건이어야 함 (5538)');
    const sem5538 = Object.values(dinnerRes.seminars)[0];
    assert.strictEqual(sem5538.seminarId, '5538');
    assert.strictEqual(sem5538.isSurveyPointExcluded, false, '저장소에 없는 메인 목록 API 아이템은 기본 false');

    // 저장소(seminars 테이블)에 isPointExcluded: true로 기저장된 경우 우선 참조 검증
    const seminarRepoModule = await import('../src/services/seminar_repository');
    seminarRepoModule.setAllSeminars([
      {
        seminarId: '5538',
        name: '저녁 포인트 미지급 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/5538',
        time: '19:00',
        currentCount: '0',
        totalCount: '10',
        nightTime: true,
        isPointExcluded: true,
        isAdvancedSurvey: false,
      },
    ]);
    const dinnerResWithStorage = await getTodaysSeminarsFromApi(17, 22, '2026-08-24');
    const sem5538Stored = Object.values(dinnerResWithStorage.seminars)[0];
    assert.strictEqual(
      sem5538Stored.isSurveyPointExcluded,
      true,
      '저장소에 저장된 isPointExcluded=true 값을 우선 반영해야 함',
    );
    seminarRepoModule.clearSeminars();

    console.log('  ✓ getTodaysSeminarsFromApi: 날짜/시간대 필터링 및 저장소 기반 isPointExcluded 판정 검증 완료\n');

    // ── Test 2: checkSeminarEndStatusFromApi 종료 및 설문 상태 판정 ─────
    console.log('--- [Test 2] checkSeminarEndStatusFromApi 종료 및 설문 상태 판정 검증 ---');

    fetchSeminarDetailSpy.mockImplementation(async (id: number | string) => {
      const sid = String(id);
      if (sid === '1001') {
        return {
          success: true,
          seminarId: sid,
          survey: { point: 1000 },
          surveyState: 1,
          isPointExcluded: false,
          hasEntryHistory: false,
          rawResponse: {
            surveyState: 1,
            seminarDetail: { seminarId: 1001, processState: 6 },
          },
        };
      } else if (sid === '1002') {
        return {
          success: true,
          seminarId: sid,
          survey: { point: 500 },
          surveyState: 5,
          isPointExcluded: false,
          hasEntryHistory: false,
          rawResponse: {
            surveyState: 5,
            seminarDetail: { seminarId: 1002, processState: 7 },
          },
        };
      } else if (sid === '1003') {
        return {
          success: true,
          seminarId: sid,
          survey: { point: 1000 },
          surveyState: 5,
          isPointExcluded: false,
          hasEntryHistory: false,
          rawResponse: {
            surveyState: 5,
            seminarDetail: { seminarId: 1003, processState: 6, seminarCompleted: 0 },
          },
        };
      }
      return {
        success: false,
        seminarId: sid,
        isAuthExpired: false,
        errorMessage: 'not found',
      };
    });

    const endStatus1001 = await checkSeminarEndStatusFromApi('1001');
    assert.strictEqual(endStatus1001.isEnded, true, 'surveyState: 1 이면 isEnded=true');
    assert.strictEqual(endStatus1001.isSurveyOpen, true, 'surveyState: 1 이면 isSurveyOpen=true');
    assert.strictEqual(endStatus1001.isPointExcluded, false);

    const endStatus1002 = await checkSeminarEndStatusFromApi('1002');
    assert.strictEqual(endStatus1002.isEnded, true, 'processState: 7 이면 isEnded=true');
    assert.strictEqual(endStatus1002.isSurveyOpen, false);

    const endStatus1003 = await checkSeminarEndStatusFromApi('1003');
    assert.strictEqual(endStatus1003.isEnded, false, '진행 중인 세미나는 isEnded=false');

    console.log('  ✓ checkSeminarEndStatusFromApi: surveyState 및 processState 기반 종료 판정 검증 완료\n');

    // ── Test 3: monitorSeminars API 감시 & 통합 메시지 갱신 검증 ──
    console.log('--- [Test 3] monitorSeminars API 감시 및 통합 메시지 갱신 시뮬레이션 ---');

    const channelMessages: string[] = [];
    const telegramMessages: string[] = [];
    const autoEnterCalls: string[] = [];
    let messageCounter = 100;

    sendNotificationToChannelSpy.mockImplementation(async (msg: string) => {
      channelMessages.push(msg);
      return ++messageCounter;
    });
    sendTelegramSpy.mockImplementation(async (msg: string) => {
      telegramMessages.push(msg);
      return true;
    });
    ensureLoggedInSpy.mockResolvedValue(undefined as never);
    safeGotoSpy.mockResolvedValue(undefined as never);

    const mockPage = {
      locator: (selector: string) => ({
        first: () => ({
          isVisible: async () => selector.includes('입장하기') || selector.includes('설문참여'),
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
      url: () => 'https://m.doctorville.co.kr/cme/seminar/attend?seminarId=9901',
      close: async () => {},
    } as unknown as Page;

    const mockContext = {
      newPage: async () => {
        autoEnterCalls.push('newPage');
        return mockPage;
      },
      waitForEvent: async () => null,
      close: async () => {},
    } as unknown as BrowserContext;

    let step = 0;
    fetchMainFutureSpy.mockImplementation(async () => {
      step++;
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
      const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours();

      if (step === 1) {
        return {
          success: true,
          items: [
            {
              seminarId: 9901,
              seminarNm: 'API 테스트 세미나',
              startDt: `${todayStr} ${String(currentHour).padStart(2, '0')}:00:00`,
              endDt: `${todayStr} ${String(currentHour + 1).padStart(2, '0')}:00:00`,
              useSurvey: 'Y',
              useDepthSurvey: 'Y',
              survey: { point: 1000 },
              processState: 2, // 대기
            },
          ],
          rawResponse: {},
        };
      } else if (step === 2) {
        return {
          success: true,
          items: [
            {
              seminarId: 9901,
              seminarNm: 'API 테스트 세미나',
              startDt: `${todayStr} ${String(currentHour).padStart(2, '0')}:00:00`,
              endDt: `${todayStr} ${String(currentHour + 1).padStart(2, '0')}:00:00`,
              useSurvey: 'Y',
              useDepthSurvey: 'Y',
              survey: { point: 1000 },
              processState: 1, // 입장하기
            },
          ],
          rawResponse: {},
        };
      } else {
        return {
          success: true,
          items: [
            {
              seminarId: 9901,
              seminarNm: 'API 테스트 세미나',
              startDt: `${todayStr} ${String(currentHour).padStart(2, '0')}:00:00`,
              endDt: `${todayStr} ${String(currentHour + 1).padStart(2, '0')}:00:00`,
              useSurvey: 'Y',
              useDepthSurvey: 'Y',
              survey: { point: 1000 },
              processState: 6, // 진행 중
            },
          ],
          rawResponse: {},
        };
      }
    });

    fetchSeminarDetailSpy.mockImplementation(async (id: number | string) => {
      const sid = String(id);
      if (sid === '9901') {
        if (step < 3) {
          return {
            success: true,
            seminarId: sid,
            survey: { point: 1000 },
            surveyState: 5,
            isPointExcluded: false,
            hasEntryHistory: false,
            rawResponse: { surveyState: 5, seminarDetail: { processState: 1 } },
          };
        } else {
          return {
            success: true,
            seminarId: sid,
            survey: { point: 1000 },
            surveyState: 1,
            isPointExcluded: false,
            hasEntryHistory: false,
            rawResponse: { surveyState: 1, seminarDetail: { processState: 7 } },
          };
        }
      }
      return { success: false, seminarId: sid, isAuthExpired: false, errorMessage: 'not found' };
    });

    const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours();
    const monitorSuccess = await monitorSeminars('테스트점심', currentHour, currentHour + 2, {
      pollIntervalMs: 10,
      context: mockContext,
    });

    assert.strictEqual(monitorSuccess, true);
    assert(autoEnterCalls.length > 0, 'Playwright 브라우저 페이지 생성이 호출되어야 함');
    // 통합 메시지 포맷 검증
    assert(
      channelMessages.some((m) => m.includes('🔔 테스트점심세미나') && m.includes('API 테스트 세미나')),
      '채널에 🔔 테스트점심세미나 통합 공지가 전송되어야 함',
    );
    assert(
      channelMessages.some((m) => m.includes('🏁 테스트점심세미나가 모두 종료되었습니다.')),
      '마지막 메시지 하단에 종료 공지가 결합되어 전송되어야 함',
    );

    // ── Test 4: isAutoResume 시 입장이력(hasEntryHistory)에 따른 자동입장 생략 검증 ──
    console.log('--- [Test 4] isAutoResume 시 입장이력(hasEntryHistory)에 따른 자동입장 생략 검증 ---');

    const resumePageCalls: string[] = [];
    const resumeChannelMessages: string[] = [];

    sendNotificationToChannelSpy.mockImplementation(async (msg: string) => {
      resumeChannelMessages.push(msg);
      return ++messageCounter;
    });

    const resumeMockPage = {
      locator: (selector: string) => ({
        first: () => ({
          isVisible: async () => selector.includes('설문참여'),
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
      url: () => 'https://m.doctorville.co.kr/cme/seminar/attend?seminarId=9902',
      close: async () => {},
    } as unknown as Page;

    const resumeMockContext = {
      newPage: async () => {
        resumePageCalls.push('newPage');
        return resumeMockPage;
      },
      waitForEvent: async () => null,
      close: async () => {},
    } as unknown as BrowserContext;

    let resumeStep = 0;
    fetchMainFutureSpy.mockImplementation(async () => {
      resumeStep++;
      const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
      const currentH = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours();

      return {
        success: true,
        items: [
          {
            seminarId: 9902,
            seminarNm: '재개 테스트 세미나',
            startDt: `${todayStr} ${String(currentH).padStart(2, '0')}:00:00`,
            endDt: `${todayStr} ${String(currentH + 1).padStart(2, '0')}:00:00`,
            useSurvey: 'Y',
            useDepthSurvey: 'N',
            survey: { point: 1000 },
            processState: 1, // 이미 입장 가능 상태
          },
        ],
        rawResponse: {},
      };
    });

    fetchSeminarDetailSpy.mockImplementation(async (id: number | string) => {
      const sid = String(id);
      if (sid === '9902') {
        if (resumeStep < 2) {
          return {
            success: true,
            seminarId: sid,
            survey: { point: 1000 },
            surveyState: 5,
            isPointExcluded: false,
            hasEntryHistory: true, // 입장이력 존재
            rawResponse: {
              surveyState: 5,
              seminarDetail: {
                processState: 1,
                seminarMember: {
                  joinDt: '2026-08-24 13:00:10.0',
                  applyTy: 1,
                },
              },
            },
          };
        } else {
          return {
            success: true,
            seminarId: sid,
            survey: { point: 1000 },
            surveyState: 1,
            isPointExcluded: false,
            hasEntryHistory: true,
            rawResponse: { surveyState: 1, seminarDetail: { processState: 7 } },
          };
        }
      }
      return { success: false, seminarId: sid, isAuthExpired: false, errorMessage: 'not found' };
    });

    const resumeSuccess = await monitorSeminars('테스트재개', currentHour, currentHour + 2, {
      pollIntervalMs: 10,
      context: resumeMockContext,
      isAutoResume: true,
    });

    assert.strictEqual(resumeSuccess, true);
    assert.strictEqual(
      resumePageCalls.length,
      1,
      '초기 입장(performAutoEnter)은 생략되고 종료 설문 처리용 newPage 1회만 호출되어야 함',
    );

    console.log('  ✓ isAutoResume: true 및 입장이력 존재 시 자동입장 생략 검증 완료!\n');

    // ── Test 5: 예정된 세미나가 없는 경우 알림 없이 종료 검증 ──────────────
    console.log('--- [Test 5] 예정된 세미나가 없는 경우 텔레그램 알림 없이 종료 검증 ---');

    const emptyTelegramMessages: string[] = [];
    const emptyChannelMessages: string[] = [];

    sendNotificationToChannelSpy.mockImplementation(async (msg: string) => {
      emptyChannelMessages.push(msg);
      return ++messageCounter;
    });
    sendTelegramSpy.mockImplementation(async (msg: string) => {
      emptyTelegramMessages.push(msg);
      return true;
    });

    fetchMainFutureSpy.mockResolvedValue({
      success: true,
      items: [],
      rawResponse: {},
    });

    const emptyMonitorSuccess = await monitorSeminars('테스트빈세미나', currentHour, currentHour + 2, {
      pollIntervalMs: 10,
      context: resumeMockContext,
    });

    assert.strictEqual(emptyMonitorSuccess, true, '세미나가 없어도 정상 종료(true)를 반환해야 함');
    assert.strictEqual(emptyTelegramMessages.length, 0, '세미나가 없을 때 텔레그램 알림을 전송하지 않아야 함');
    assert.strictEqual(emptyChannelMessages.length, 0, '세미나가 없을 때 채널 알림을 전송하지 않아야 함');

    console.log('  ✓ 예정된 세미나가 없는 경우 알림 없이 종료 검증 완료!\n');

    // ── Test 6: isSeminarStartedByTime 시간 판정 단위 검증 ────────────────
    console.log('--- [Test 6] isSeminarStartedByTime 시간 판정 검증 ---');
    const pastTime = '2026-08-24 12:00:00';
    const futureTime = '2026-08-24 14:00:00';
    const testNowMs = new Date('2026-08-24T13:00:00+09:00').getTime();

    assert.strictEqual(isSeminarStartedByTime(pastTime, testNowMs), true, '과거 시간은 true');
    assert.strictEqual(isSeminarStartedByTime(futureTime, testNowMs), false, '미래 시간은 false');
    assert.strictEqual(isSeminarStartedByTime(undefined, testNowMs), false, 'undefined는 false');
    console.log('  ✓ isSeminarStartedByTime 시간 판정 단위 검증 완료!\n');
  });
});
