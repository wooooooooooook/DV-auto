import assert from 'node:assert';
import { chromium } from 'playwright';
import { run as runApplySeminar, SEMINAR_LIST_KEY } from '../src/tasks/apply_seminar';
import * as httpClientModule from '../src/modules/http_client';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as utilsModule from '../src/modules/utils';
import * as checkSeminarPointModule from '../src/tasks/check_seminar_point';
import * as storage from '../src/services/storage';
import { ProcessState } from '../src/modules/seminar_api';

function createFutureSeminarApiItem(
  seminarId: number,
  processState: number,
  applyCnt: number = 100,
  maxPeopleCnt: number = 5000,
): seminarApiModule.FutureSeminarApiItem {
  return {
    seminarId,
    seminarNm: `세미나 ${seminarId}`,
    startDt: '2026-08-25 13:00:00',
    endDt: '2026-08-25 14:00:00',
    maxPeopleCnt,
    applyCnt,
    processState,
    cancelProcessState: 0,
    seminarCompleted: 0,
  };
}

async function testApplySeminarHttpPrecheck() {
  console.log('===========================================================');
  console.log('  apply_seminar HTTP pre-check 및 조건부 Playwright 실행 테스트');
  console.log('===========================================================\n');

  const originalFetchMainFuture = seminarApiModule.fetchMainFutureSeminars;
  const originalFetchDetail = seminarApiModule.fetchSeminarDetail;
  const originalHttpGet = httpClientModule.httpGet;
  const originalEnsureLoggedIn = utilsModule.ensureLoggedIn;
  const originalSafeGoto = utilsModule.safeGoto;
  const originalSendTelegram = utilsModule.sendTelegram;
  const originalSearchSeminarPoints = checkSeminarPointModule.searchSeminarPoints;
  const originalLaunch = chromium.launch;

  (checkSeminarPointModule as unknown as { searchSeminarPoints: unknown }).searchSeminarPoints = async () => ({
    success: true,
    points: new Map(),
  });

  let safeGotoCallCount = 0;
  let browserLaunchCount = 0;
  const safeGotoUrls: string[] = [];
  const sentTelegramMessages: string[] = [];

  (utilsModule as unknown as { sendTelegram: unknown }).sendTelegram = async (msg: string) => {
    sentTelegramMessages.push(msg);
    return true;
  };

  (utilsModule as unknown as { ensureLoggedIn: unknown }).ensureLoggedIn = async () => {
    return true;
  };

  (utilsModule as unknown as { safeGoto: unknown }).safeGoto = async (_page: unknown, url: string) => {
    safeGotoCallCount++;
    safeGotoUrls.push(url);
    return true;
  };

  chromium.launch = async (...args) => {
    browserLaunchCount++;
    return originalLaunch.bind(chromium)(...args);
  };

  const createMockPage = () => ({
    context: () => ({}),
    locator: (_selector: string) => ({
      count: async () => 0,
      evaluateAll: async () => [],
      isVisible: async () => false,
      click: async () => {},
    }),
    click: async () => {},
    waitForSelector: async () => {},
    waitForTimeout: async () => {},
    screenshot: async () => {},
  });

  try {
    // --- Case A: API에서 모든 세미나가 신청 완료 → Playwright 미실행 ---
    console.log('--- Case A: API에서 모든 세미나가 신청 완료 (PROCESS_CANCEL) ---');
    safeGotoCallCount = 0;
    safeGotoUrls.length = 0;
    browserLaunchCount = 0;
    storage.set(SEMINAR_LIST_KEY, []);

    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
      success: true,
      items: [createFutureSeminarApiItem(100, ProcessState.PROCESS_CANCEL, 10, 100)],
      rawResponse: { futureSeminarList: { items: [] } },
    });

    const resultA = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultA.success, true);
    assert.strictEqual(safeGotoCallCount, 0, 'safeGoto should NOT be called when all applied');
    assert.strictEqual(browserLaunchCount, 0, 'Chromium should NOT be launched when all applied');
    console.log('  ✓ [Pass] safeGoto 및 브라우저 실행 없이 정상 완료\n');

    // --- Case B: API에서 PROCESS_APPLY 세미나 1개 → Playwright 신청 단계 진입 ---
    console.log('--- Case B: API에서 PROCESS_APPLY 세미나 1개 있음 ---');
    safeGotoCallCount = 0;
    safeGotoUrls.length = 0;
    storage.set(SEMINAR_LIST_KEY, []);

    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
      success: true,
      items: [createFutureSeminarApiItem(100, ProcessState.PROCESS_APPLY, 10, 100)],
      rawResponse: { futureSeminarList: { items: [] } },
    });

    (seminarApiModule as unknown as { fetchSeminarDetail: unknown }).fetchSeminarDetail = async (id: string) => ({
      success: true,
      seminarId: String(id),
      isPointExcluded: false,
      hasEntryHistory: false,
      rawResponse: {
        seminarDetail: { seminarId: Number(id), processState: ProcessState.PROCESS_CANCEL },
      },
    });

    const mockPageB = createMockPage();
    const resultB = await runApplySeminar({ page: mockPageB as never }, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultB.success, true);
    assert.ok(safeGotoCallCount >= 1, 'safeGoto should be called for PROCESS_APPLY seminar');
    // 상세 URL로 직접 진입 확인
    assert.ok(
      safeGotoUrls.some((u) => u.includes('/cme/seminar/100')),
      `상세 URL 포함: ${JSON.stringify(safeGotoUrls)}`,
    );
    // 목록 페이지 미호출 확인
    assert.ok(
      !safeGotoUrls.some((u) => u.includes('seminar/main')),
      `목록 페이지 미호출: ${JSON.stringify(safeGotoUrls)}`,
    );
    console.log('  ✓ [Pass] Playwright 진입 후 상세페이지 직접 신청 로직 정상 수행\n');

    // --- Case C: 기존 세미나 있지만 PROCESS_APPLY 세미나 추가됨 → Playwright 신청 실행 ---
    console.log('--- Case C: 기존 세미나 있지만 PROCESS_APPLY 세미나 추가 ---');
    storage.set(SEMINAR_LIST_KEY, [
      {
        seminarId: '100',
        name: '기존 세미나 100',
        url: 'https://m.doctorville.co.kr/cme/seminar/100',
        date: '2026-08-25',
        time: '13:00~14:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
      },
    ]);
    safeGotoCallCount = 0;
    safeGotoUrls.length = 0;

    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
      success: true,
      items: [
        createFutureSeminarApiItem(100, ProcessState.PROCESS_CANCEL, 10, 100),
        createFutureSeminarApiItem(200, ProcessState.PROCESS_APPLY, 5, 50),
      ],
      rawResponse: { futureSeminarList: { items: [] } },
    });

    const mockPageC = createMockPage();
    const resultC = await runApplySeminar({ page: mockPageC as never }, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultC.success, true);
    assert.ok(safeGotoCallCount >= 1, 'safeGoto should be called for new PROCESS_APPLY seminar');
    assert.ok(
      safeGotoUrls.some((u) => u.includes('/cme/seminar/200')),
      `200 상세 URL 포함: ${JSON.stringify(safeGotoUrls)}`,
    );
    console.log('  ✓ [Pass] PROCESS_APPLY 세미나 존재 시 Playwright 신청 실행\n');

    // --- Case D: 새 세미나는 있지만 모두 PROCESS_CANCEL → Playwright 미실행 ---
    console.log('--- Case D: 새 세미나 있지만 PROCESS_CANCEL → Playwright 미실행 ---');
    storage.set(SEMINAR_LIST_KEY, [
      {
        seminarId: '100',
        name: '기존 세미나 100',
        url: 'https://m.doctorville.co.kr/cme/seminar/100',
        date: '2026-08-25',
        time: '13:00~14:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
      },
    ]);
    safeGotoCallCount = 0;
    safeGotoUrls.length = 0;
    browserLaunchCount = 0;

    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
      success: true,
      items: [
        createFutureSeminarApiItem(100, ProcessState.PROCESS_CANCEL, 10, 100),
        createFutureSeminarApiItem(200, ProcessState.PROCESS_CANCEL, 5, 50),
      ],
      rawResponse: { futureSeminarList: { items: [] } },
    });

    const resultD = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultD.success, true);
    assert.strictEqual(safeGotoCallCount, 0, 'safeGoto should NOT be called when new seminar is already applied');
    assert.strictEqual(browserLaunchCount, 0, 'Chromium should NOT be launched');
    const storedD = storage.get<unknown[]>(SEMINAR_LIST_KEY) || [];
    assert.strictEqual(storedD.length, 2, 'New seminar should be saved via HTTP processing');
    console.log('  ✓ [Pass] 새 세미나가 있어도 PROCESS_APPLY가 없으면 Playwright 미실행 및 HTTP 수집 완료\n');

    // --- Case E: API 실패 + HTML fallback 경로의 AUTH_EXPIRED → Playwright 없이 에러 처리 ---
    console.log('--- Case E: API 실패 + HTML AUTH_EXPIRED 발생 시 Playwright fallback 없음 ---');
    safeGotoCallCount = 0;
    safeGotoUrls.length = 0;
    browserLaunchCount = 0;

    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
      success: false,
      isAuthExpired: false,
      errorMessage: 'API 실패',
    });

    (httpClientModule as unknown as { httpGet: unknown }).httpGet = async () => ({
      status: 200,
      body: '<script>alert("로그인이 되어 있지 않습니다.");</script>',
      resultType: 'AUTH_EXPIRED',
    });

    const resultE = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultE.success, false);
    assert.ok((resultE.message || '').includes('로그인이 필요합니다'));
    assert.strictEqual(safeGotoCallCount, 0, 'safeGoto should NOT be called on AUTH_EXPIRED');
    assert.strictEqual(browserLaunchCount, 0, 'Chromium should NOT be launched on AUTH_EXPIRED');
    console.log('  ✓ [Pass] AUTH_EXPIRED 발생 시 Playwright fallback 없이 정상 세션 만료 반환\n');

    // --- Case F: PROCESS_APPLY 있지만 신청 후 실패 (processState가 바뀌지 않음) ---
    console.log('--- Case F: PROCESS_APPLY → 신청 시도했지만 실패 (processState 변경 안 됨) ---');
    safeGotoCallCount = 0;
    safeGotoUrls.length = 0;
    storage.set(SEMINAR_LIST_KEY, []);

    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
      success: true,
      items: [createFutureSeminarApiItem(100, ProcessState.PROCESS_APPLY, 10, 100)],
      rawResponse: { futureSeminarList: { items: [] } },
    });

    // 신청 후에도 여전히 PROCESS_APPLY → 실패로 판정
    (seminarApiModule as unknown as { fetchSeminarDetail: unknown }).fetchSeminarDetail = async (id: string) => ({
      success: true,
      seminarId: String(id),
      isPointExcluded: false,
      hasEntryHistory: false,
      rawResponse: {
        seminarDetail: { seminarId: Number(id), processState: ProcessState.PROCESS_APPLY },
      },
    });

    const mockPageF = createMockPage();
    const resultF = await runApplySeminar({ page: mockPageF as never }, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultF.success, true);
    assert.ok(
      (resultF.message || '').includes('마감 등의 사유로 신청 실패'),
      `Task should report failure: "${resultF.message}"`,
    );
    console.log('  ✓ [Pass] 신청 후 processState 변경 안 되면 실패로 정확히 보고\n');

    console.log('🎉 모든 apply_seminar HTTP pre-check 테스트 성공적 통과!\n');
  } finally {
    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars =
      originalFetchMainFuture;
    (seminarApiModule as unknown as { fetchSeminarDetail: unknown }).fetchSeminarDetail = originalFetchDetail;
    (checkSeminarPointModule as unknown as { searchSeminarPoints: unknown }).searchSeminarPoints =
      originalSearchSeminarPoints;
    (httpClientModule as unknown as { httpGet: unknown }).httpGet = originalHttpGet;
    (utilsModule as unknown as { ensureLoggedIn: unknown }).ensureLoggedIn = originalEnsureLoggedIn;
    (utilsModule as unknown as { safeGoto: unknown }).safeGoto = originalSafeGoto;
    (utilsModule as unknown as { sendTelegram: unknown }).sendTelegram = originalSendTelegram;
    chromium.launch = originalLaunch;
  }
}

testApplySeminarHttpPrecheck().catch((err) => {
  console.error('❌ apply_seminar HTTP pre-check test failed:', err);
  process.exit(1);
});
