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
import * as monitorSeminarsModule from '../src/tasks/monitor_seminars';

async function runTests() {
  console.log('===========================================================');
  console.log('  monitor_seminars API 기반 모니터링 기능 단위/통합 테스트');
  console.log('===========================================================\n');

  // ── Test 1: getTodaysSeminarsFromApi 시간대 및 상태 필터링 ─────────
  console.log('--- [Test 1] getTodaysSeminarsFromApi 시간대 및 상태 필터링 검증 ---');

  const originalFetchMainFuture = seminarApiModule.fetchMainFutureSeminars;
  const mockApiItems: seminarApiModule.FutureSeminarApiItem[] = [
    {
      seminarId: 5565,
      seminarNm: '눈에서 시작하는 심혈관 위험 평가',
      startDt: '2026-08-24 13:00:00',
      endDt: '2026-08-24 14:00:00',
      useSurvey: 'Y',
      useDepthSurvey: 'Y',
      survey: { surveyId: 101, point: 1000 },
      processState: 2, // PROCESS_APPLY -> '신청하기'
    },
    {
      seminarId: 5566,
      seminarNm: '점심 라이브 입장 가능 세미나',
      startDt: '2026-08-24 12:30:00',
      endDt: '2026-08-24 13:30:00',
      useSurvey: 'Y',
      useDepthSurvey: 'N',
      survey: { surveyId: 102, point: 500 },
      processState: 1, // PROCESS_ENTER -> '입장하기'
    },
    {
      seminarId: 5538,
      seminarNm: '저녁 포인트 미지급 세미나',
      startDt: '2026-08-24 18:00:00',
      endDt: '2026-08-24 19:00:00',
      useSurvey: 'Y',
      useDepthSurvey: 'N',
      survey: null, // 포인트 미지급
      processState: 1, // '입장하기'
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

  (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
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
  assert.strictEqual(sem5565.status, '신청하기');
  assert.strictEqual(sem5565.isAdvancedSurvey, true);
  assert.strictEqual(sem5565.isSurveyPointExcluded, false);

  const sem5566 = Object.values(lunchRes.seminars).find((s) => s.seminarId === '5566');
  assert.ok(sem5566);
  assert.strictEqual(sem5566.status, '입장하기');
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

  // 저장소(SEMINAR_LIST_KEY)에 isPointExcluded: true로 기저장된 경우 우선 참조 검증
  const storageModule = await import('../src/services/storage');
  const { SEMINAR_LIST_KEY } = await import('../src/tasks/apply_seminar');
  storageModule.set(SEMINAR_LIST_KEY, [
    { seminarId: '5538', name: '저녁 포인트 미지급 세미나', url: '', isPointExcluded: true, isAdvancedSurvey: false },
  ]);
  const dinnerResWithStorage = await getTodaysSeminarsFromApi(17, 22, '2026-08-24');
  const sem5538Stored = Object.values(dinnerResWithStorage.seminars)[0];
  assert.strictEqual(
    sem5538Stored.isSurveyPointExcluded,
    true,
    '저장소에 저장된 isPointExcluded=true 값을 우선 반영해야 함',
  );
  storageModule.deleteKey(SEMINAR_LIST_KEY);

  console.log('  ✓ getTodaysSeminarsFromApi: 날짜/시간대 필터링 및 저장소 기반 isPointExcluded 판정 검증 완료\n');

  // ── Test 2: checkSeminarEndStatusFromApi 종료 및 설문 상태 판정 ─────
  console.log('--- [Test 2] checkSeminarEndStatusFromApi 종료 및 설문 상태 판정 검증 ---');

  const originalFetchSeminarDetail = seminarApiModule.fetchSeminarDetail;
  (seminarApiModule as unknown as { fetchSeminarDetail: unknown }).fetchSeminarDetail = async (id: number | string) => {
    const sid = String(id);
    if (sid === '1001') {
      // 설문 진행 중 (surveyState: 1)
      return {
        success: true,
        seminarId: sid,
        survey: { point: 1000 },
        surveyState: 1,
        isPointExcluded: false,
        rawResponse: {
          surveyState: 1,
          seminarDetail: { seminarId: 1001, processState: 6 },
        },
      };
    } else if (sid === '1002') {
      // 방송 종료 (processState: 7)
      return {
        success: true,
        seminarId: sid,
        survey: { point: 500 },
        surveyState: 5, // 미오픈
        isPointExcluded: false,
        rawResponse: {
          surveyState: 5,
          seminarDetail: { seminarId: 1002, processState: 7 },
        },
      };
    } else if (sid === '1003') {
      // 진행 중 (processState: 6, surveyState: 5)
      return {
        success: true,
        seminarId: sid,
        survey: { point: 1000 },
        surveyState: 5,
        isPointExcluded: false,
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
  };

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

  // ── Test 3: monitorSeminars API 감시 & Playwright 온디맨드 실행 통합 검증 ──
  console.log('--- [Test 3] monitorSeminars API 감시 및 Playwright 온디맨드 실행 시뮬레이션 ---');

  const channelMessages: string[] = [];
  const telegramMessages: string[] = [];
  const autoEnterCalls: string[] = [];

  const origSendChannel = utilsModule.sendNotificationToChannel;
  const origSendTelegram = utilsModule.sendTelegram;
  const origEnsureLoggedIn = utilsModule.ensureLoggedIn;
  const origSafeGoto = utilsModule.safeGoto;

  (utilsModule as unknown as { sendNotificationToChannel: unknown }).sendNotificationToChannel = async (
    msg: string,
  ) => {
    channelMessages.push(msg);
    return true;
  };
  (utilsModule as unknown as { sendTelegram: unknown }).sendTelegram = async (msg: string) => {
    telegramMessages.push(msg);
    return true;
  };
  (utilsModule as unknown as { ensureLoggedIn: unknown }).ensureLoggedIn = async () => {};
  (utilsModule as unknown as { safeGoto: unknown }).safeGoto = async () => {};

  // Mock Page & BrowserContext
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

  // Step별 API 상태 시뮬레이션
  let step = 0;
  (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => {
    step++;
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours();

    if (step === 1) {
      // Step 1: 세미나 대기 상태 (processState: 2)
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
            processState: 2, // 신청하기/대기
          },
        ],
        rawResponse: {},
      };
    } else if (step === 2) {
      // Step 2: 세미나 시작 -> 입장 가능 상태로 전이 (processState: 1)
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
      // Step 3: 세미나 진행 중
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
  };

  (seminarApiModule as unknown as { fetchSeminarDetail: unknown }).fetchSeminarDetail = async (id: number | string) => {
    const sid = String(id);
    if (sid === '9901') {
      if (step < 3) {
        return {
          success: true,
          seminarId: sid,
          survey: { point: 1000 },
          surveyState: 5, // 미오픈
          isPointExcluded: false,
          rawResponse: { surveyState: 5, seminarDetail: { processState: 1 } },
        };
      } else {
        // step 3 이상: 세미나 종료 및 설문 오픈 (surveyState: 1)
        return {
          success: true,
          seminarId: sid,
          survey: { point: 1000 },
          surveyState: 1, // 설문 오픈
          isPointExcluded: false,
          rawResponse: { surveyState: 1, seminarDetail: { processState: 7 } },
        };
      }
    }
    return { success: false, seminarId: sid, isAuthExpired: false, errorMessage: 'not found' };
  };

  const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours();
  // 10ms 단위 초고속 모킹 테스트 실행 (mockContext 주입)
  const monitorSuccess = await monitorSeminars('테스트점심', currentHour, currentHour + 2, {
    pollIntervalMs: 10,
    context: mockContext,
  });

  assert.strictEqual(monitorSuccess, true);

  // 1. 자동 입장 확인 (newPage 호출됨)
  assert(autoEnterCalls.length > 0, 'Playwright 브라우저 페이지 생성이 호출되어야 함');
  // 2. 시작 알림 채널 전송 확인
  assert(
    channelMessages.some(
      (m) => m.includes('🟢세미나시작') && m.includes('API 테스트 세미나') && m.includes('[심화설문]'),
    ),
    '채널에 🟢세미나시작 [심화설문] 공지가 전송되어야 함',
  );
  // 3. 종료 알림 채널 전송 확인
  assert(
    channelMessages.some((m) => m.includes('🔴세미나종료') && m.includes('API 테스트 세미나')),
    '채널에 🔴세미나종료 공지가 전송되어야 함',
  );
  // 4. 완료 알림 전송 확인
  assert(
    channelMessages.some((m) => m.includes('테스트점심세미나 모니터링이 종료되었습니다')),
    '최종 모니터링 종료 공지가 전송되어야 함',
  );

  // ── Test 4: isAutoResume 시 입장이력(hasEntryHistory)에 따른 자동입장 생략 검증 ──
  console.log('--- [Test 4] isAutoResume 시 입장이력(hasEntryHistory)에 따른 자동입장 생략 검증 ---');

  const resumePageCalls: string[] = [];
  const resumeChannelMessages: string[] = [];
  const resumeTelegramMessages: string[] = [];

  (utilsModule as unknown as { sendNotificationToChannel: unknown }).sendNotificationToChannel = async (
    msg: string,
  ) => {
    resumeChannelMessages.push(msg);
    return true;
  };
  (utilsModule as unknown as { sendTelegram: unknown }).sendTelegram = async (msg: string) => {
    resumeTelegramMessages.push(msg);
    return true;
  };

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
  (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => {
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
  };

  (seminarApiModule as unknown as { fetchSeminarDetail: unknown }).fetchSeminarDetail = async (id: number | string) => {
    const sid = String(id);
    if (sid === '9902') {
      if (resumeStep < 2) {
        return {
          success: true,
          seminarId: sid,
          survey: { point: 1000 },
          surveyState: 5,
          isPointExcluded: false,
          hasEntryHistory: true, // 입장이력 존재!
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
        // 종료
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
  };

  // isAutoResume: true 로 실행
  const resumeSuccess = await monitorSeminars('테스트재개', currentHour, currentHour + 2, {
    pollIntervalMs: 10,
    context: resumeMockContext,
    isAutoResume: true,
  });

  assert.strictEqual(resumeSuccess, true);
  // 종료 설문 처리(handleSeminarEndAndQuiz) 외에 초기 입장(performAutoEnter) 단계에서 newPage가 불리지 않았는지 확인:
  // Step 1에서 입장 호출이 생략되므로 종료 시점(Step 2) 설문 처리용으로만 1회 newPage가 호출됨.
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

  (utilsModule as unknown as { sendNotificationToChannel: unknown }).sendNotificationToChannel = async (
    msg: string,
  ) => {
    emptyChannelMessages.push(msg);
    return true;
  };
  (utilsModule as unknown as { sendTelegram: unknown }).sendTelegram = async (msg: string) => {
    emptyTelegramMessages.push(msg);
    return true;
  };

  (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
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

  // ── Test 7: 신청 실패(PROCESS_APPLY) 세미나 시작/종료 공지 발송 및 종료 공지 선발송 순서 검증 ──
  console.log('--- [Test 7] 신청 실패 세미나 공지 발송 및 종료 공지 선발송 검증 ---');

  const test7Events: string[] = [];
  const test7ChannelMessages: string[] = [];
  let test7AutoEnterCalled = false;

  (utilsModule as unknown as { sendNotificationToChannel: unknown }).sendNotificationToChannel = async (
    msg: string,
  ) => {
    test7Events.push(`CHANNEL:${msg.split('\n')[0]}`);
    test7ChannelMessages.push(msg);
    return true;
  };

  const test7MockPage = {
    locator: (selector: string) => ({
      first: () => ({
        isVisible: async () => {
          if (selector.includes('입장하기')) {
            test7AutoEnterCalled = true;
            return false;
          }
          return selector.includes('설문참여');
        },
        click: async () => {
          test7Events.push('PLAYWRIGHT:CLICK_SURVEY');
        },
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
    url: () => 'https://m.doctorville.co.kr/cme/seminar/attend?seminarId=9903',
    close: async () => {},
  } as unknown as Page;

  const test7MockContext = {
    newPage: async () => {
      test7Events.push('PLAYWRIGHT:NEW_PAGE');
      return test7MockPage;
    },
    waitForEvent: async () => null,
    close: async () => {},
  } as unknown as BrowserContext;

  let test7Step = 0;
  (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => {
    test7Step++;
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const currentH = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours();

    return {
      success: true,
      items: [
        {
          seminarId: 9903,
          seminarNm: '신청 실패 테스트 세미나',
          startDt: `${todayStr} ${String(currentH).padStart(2, '0')}:00:00`,
          endDt: `${todayStr} ${String(currentH + 1).padStart(2, '0')}:00:00`,
          useSurvey: 'Y',
          useDepthSurvey: 'N',
          survey: { point: 1000 },
          processState: 2, // 신청 실패/미신청 상태 (PROCESS_APPLY)
        },
      ],
      rawResponse: {},
    };
  };

  (seminarApiModule as unknown as { fetchSeminarDetail: unknown }).fetchSeminarDetail = async (id: number | string) => {
    const sid = String(id);
    if (sid === '9903') {
      if (test7Step < 2) {
        return {
          success: true,
          seminarId: sid,
          survey: { point: 1000 },
          surveyState: 5,
          isPointExcluded: false,
          rawResponse: { surveyState: 5, seminarDetail: { processState: 2 } },
        };
      } else {
        // 종료
        return {
          success: true,
          seminarId: sid,
          survey: { point: 1000 },
          surveyState: 1,
          isPointExcluded: false,
          rawResponse: { surveyState: 1, seminarDetail: { processState: 7 } },
        };
      }
    }
    return { success: false, seminarId: sid, isAuthExpired: false, errorMessage: 'not found' };
  };

  const test7Success = await monitorSeminars('테스트신청실패', currentHour, currentHour + 2, {
    pollIntervalMs: 10,
    context: test7MockContext,
  });

  assert.strictEqual(test7Success, true);
  // 시작 공지 전송 확인
  assert(
    test7ChannelMessages.some((m) => m.includes('🟢세미나시작') && m.includes('신청 실패 테스트 세미나')),
    '신청 실패 세미나도 🟢세미나시작 공지가 전송되어야 함',
  );
  // 종료 공지 전송 확인
  assert(
    test7ChannelMessages.some((m) => m.includes('🔴세미나종료') && m.includes('신청 실패 테스트 세미나')),
    '신청 실패 세미나도 🔴세미나종료 공지가 전송되어야 함',
  );
  // 신청 실패 세미나는 status !== '입장하기' 이므로 자동입장(checkAndPerformAutoEnter) 시도가 생략되어야 함
  assert.strictEqual(test7AutoEnterCalled, false, '신청 실패 세미나는 자동입장 시도를 하지 않아야 함');

  // 종료 공지가 설문/퀴즈 처리(PLAYWRIGHT:NEW_PAGE)보다 먼저 발송되었는지 순서 검증
  const channelEndIndex = test7Events.findIndex((e) => e.includes('CHANNEL:🔴세미나종료'));
  const playwrightSurveyIndex = test7Events.findIndex((e) => e === 'PLAYWRIGHT:NEW_PAGE');
  assert(channelEndIndex >= 0, '🔴세미나종료 이벤트가 존재해야 함');
  assert(playwrightSurveyIndex >= 0, '설문 처리 브라우저 생성이 존재해야 함');
  assert(
    channelEndIndex < playwrightSurveyIndex,
    `🔴세미나종료 공지(${channelEndIndex})가 설문 처리 브라우저 실행(${playwrightSurveyIndex})보다 먼저여야 함`,
  );

  console.log('  ✓ 신청 실패 세미나 공지 발송 및 종료 공지 선발송 순서 검증 완료!\n');

  // ── Test 8: 감시 중 API 목록에서 사라진 세미나 정리 검증 ──────────────
  console.log('--- [Test 8] 감시 중 API 목록에서 사라진 세미나 정리 검증 ---');

  const test8ChannelMessages: string[] = [];
  (utilsModule as unknown as { sendNotificationToChannel: unknown }).sendNotificationToChannel = async (
    msg: string,
  ) => {
    test8ChannelMessages.push(msg);
    return true;
  };

  let test8Step = 0;
  (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => {
    test8Step++;
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const currentH = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours();

    if (test8Step === 1) {
      // Step 1: 세미나 9904가 목록에 존재 (미래 시간)
      return {
        success: true,
        items: [
          {
            seminarId: 9904,
            seminarNm: '사라진 세미나 테스트',
            startDt: `${todayStr} ${String(currentH).padStart(2, '0')}:00:00`,
            endDt: `${todayStr} ${String(currentH + 1).padStart(2, '0')}:00:00`,
            useSurvey: 'Y',
            useDepthSurvey: 'N',
            survey: { point: 1000 },
            processState: 2,
          },
        ],
        rawResponse: {},
      };
    } else {
      // Step 2: 세미나 9904가 목록에서 완전히 사라짐
      return {
        success: true,
        items: [],
        rawResponse: {},
      };
    }
  };

  (seminarApiModule as unknown as { fetchSeminarDetail: unknown }).fetchSeminarDetail = async (id: number | string) => {
    const sid = String(id);
    if (sid === '9904') {
      // 상세 조회 시 세미나가 종료(processState: 7)된 상태로 확인됨
      return {
        success: true,
        seminarId: sid,
        survey: { point: 1000 },
        surveyState: 1,
        isPointExcluded: false,
        rawResponse: { surveyState: 1, seminarDetail: { processState: 7 } },
      };
    }
    return { success: false, seminarId: sid, isAuthExpired: false, errorMessage: 'not found' };
  };

  const test8Success = await monitorSeminars('테스트사라진세미나', currentHour, currentHour + 2, {
    pollIntervalMs: 10,
    context: test7MockContext,
  });

  assert.strictEqual(test8Success, true);
  assert(
    test8ChannelMessages.some((m) => m.includes('🔴세미나종료') && m.includes('사라진 세미나 테스트')),
    '목록에서 사라진 세미나도 종료 감지되어 🔴세미나종료 공지가 전송되고 리스트에서 정상 정리되어야 함',
  );

  console.log('  ✓ 감시 중 API 목록에서 사라진 세미나 정리 검증 완료!\n');

  // Clean up mocks
  (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars =
    originalFetchMainFuture;
  (seminarApiModule as unknown as { fetchSeminarDetail: unknown }).fetchSeminarDetail = originalFetchSeminarDetail;
  (utilsModule as unknown as { sendNotificationToChannel: unknown }).sendNotificationToChannel = origSendChannel;
  (utilsModule as unknown as { sendTelegram: unknown }).sendTelegram = origSendTelegram;
  (utilsModule as unknown as { ensureLoggedIn: unknown }).ensureLoggedIn = origEnsureLoggedIn;
  (utilsModule as unknown as { safeGoto: unknown }).safeGoto = origSafeGoto;

  console.log('🎉 모든 monitor_seminars API 기반 단위/통합 테스트 통과!');
}

runTests().catch((err) => {
  console.error('테스트 실패:', err);
  process.exit(1);
});
