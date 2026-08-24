import assert from 'node:assert';
import type { BrowserContext, Page } from 'playwright';
import { getTodaysSeminarsFromApi, checkSeminarEndStatusFromApi, monitorSeminars } from '../src/tasks/monitor_seminars';
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

  // 저녁 시간대 (17시 ~ 22시) 조회
  const dinnerRes = await getTodaysSeminarsFromApi(17, 22, '2026-08-24');
  assert.strictEqual(dinnerRes.success, true);
  const dinnerKeys = Object.keys(dinnerRes.seminars);
  assert.strictEqual(dinnerKeys.length, 1, '2026-08-24 저녁 세미나는 1건이어야 함 (5538)');
  const sem5538 = Object.values(dinnerRes.seminars)[0];
  assert.strictEqual(sem5538.seminarId, '5538');
  assert.strictEqual(sem5538.isSurveyPointExcluded, false, '메인 목록 API 아이템은 상세 조회 전까지 기본 false');

  console.log('  ✓ getTodaysSeminarsFromApi: 날짜/시간대 필터링 및 상태/플래그 판정 검증 완료\n');

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

  console.log('  ✓ monitorSeminars API 모니터링 -> Playwright 온디맨드 입장 -> 설문/퀴즈 제출 전 플로우 통과!\n');

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
