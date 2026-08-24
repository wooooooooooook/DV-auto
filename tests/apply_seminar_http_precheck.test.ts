import assert from 'node:assert';
import { chromium } from 'playwright';
import { run as runApplySeminar, SEMINAR_LIST_KEY } from '../src/tasks/apply_seminar';
import * as httpClientModule from '../src/modules/http_client';
import * as utilsModule from '../src/modules/utils';
import * as checkSeminarPointModule from '../src/tasks/check_seminar_point';
import * as storage from '../src/services/storage';

async function testApplySeminarHttpPrecheck() {
  console.log('===========================================================');
  console.log('  apply_seminar HTTP pre-check 및 조건부 Playwright 실행 테스트');
  console.log('===========================================================\n');

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
  const sentTelegramMessages: string[] = [];

  (utilsModule as unknown as { sendTelegram: unknown }).sendTelegram = async (msg: string) => {
    sentTelegramMessages.push(msg);
    return true;
  };

  (utilsModule as unknown as { ensureLoggedIn: unknown }).ensureLoggedIn = async () => {
    return true;
  };

  (utilsModule as unknown as { safeGoto: unknown }).safeGoto = async () => {
    safeGotoCallCount++;
    return true;
  };

  chromium.launch = async (...args) => {
    browserLaunchCount++;
    return originalLaunch.bind(chromium)(...args);
  };

  const createMockPage = (options: { applyCount?: number; completionCount?: number } = {}) => {
    const { applyCount = 0, completionCount = 1 } = options;
    return {
      context: () => ({}),
      locator: (selector: string) => {
        if (selector === 'a.list_detail') return { count: async () => 1 };
        if (selector === '.ico_finish') return { count: async () => 0 };
        if (selector === 'a:has(.ico_apply)') {
          return {
            evaluateAll: async () => {
              const items = [];
              for (let i = 0; i < applyCount; i++) {
                items.push({
                  href: `https://www.doctorville.co.kr/seminar/seminarDetail?seminarId=${100 + i}`,
                  text: '신청하기',
                });
              }
              return items;
            },
          };
        }
        if (selector === 'a:has(.ico_completion)') return { count: async () => completionCount };
        return {
          count: async () => 0,
          evaluateAll: async () => [],
          isVisible: async () => false,
          click: async () => {},
        };
      },
      click: async () => {},
      waitForSelector: async () => {},
      waitForTimeout: async () => {},
      screenshot: async () => {},
    };
  };

  const HTML_NO_APPLY = `
    <div class="list_cont">
      <div class="seminar_day"><span class="date">8/25</span></div>
      <a class="list_detail" href="/seminar/seminarDetail?seminarId=100">
        <div class="list_tit"><span class="tit">기존 세미나 100</span></div>
        <span class="txt_num time">19:00</span>
        <div class="person"><span class="txt_num">10</span><span class="total"><span class="txt_num">/100</span></span></div>
        <span class="ico_completion">신청완료</span>
      </a>
    </div>
  `;

  const HTML_WITH_APPLY = `
    <div class="list_cont">
      <div class="seminar_day"><span class="date">8/25</span></div>
      <a class="list_detail" href="/seminar/seminarDetail?seminarId=100">
        <div class="list_tit"><span class="tit">신청 가능 세미나 100</span></div>
        <span class="txt_num time">19:00</span>
        <div class="person"><span class="txt_num">10</span><span class="total"><span class="txt_num">/100</span></span></div>
        <span class="ico_apply">신청하기</span>
      </a>
    </div>
  `;

  const HTML_NEW_WITHOUT_APPLY = `
    <div class="list_cont">
      <div class="seminar_day"><span class="date">8/25</span></div>
      <a class="list_detail" href="/seminar/seminarDetail?seminarId=100">
        <div class="list_tit"><span class="tit">기존 세미나 100</span></div>
        <span class="txt_num time">19:00</span>
        <div class="person"><span class="txt_num">10</span><span class="total"><span class="txt_num">/100</span></span></div>
        <span class="ico_completion">신청완료</span>
      </a>
      <a class="list_detail" href="/seminar/seminarDetail?seminarId=200">
        <div class="list_tit"><span class="tit">신규 세미나 200</span></div>
        <span class="txt_num time">20:00</span>
        <div class="person"><span class="txt_num">5</span><span class="total"><span class="txt_num">/50</span></span></div>
        <span class="ico_completion">신청완료</span>
      </a>
    </div>
  `;

  try {
    // --- Case A: HTTP HTML에 .ico_apply 없음 -> safeGoto/Playwright 미호출 ---
    console.log('--- Case A: HTTP HTML에 .ico_apply 없음 ---');
    safeGotoCallCount = 0;
    browserLaunchCount = 0;
    (httpClientModule as unknown as { httpGet: unknown }).httpGet = async () => ({
      status: 200,
      body: HTML_NO_APPLY,
      resultType: 'SUCCESS',
    });

    const resultA = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultA.success, true);
    assert.strictEqual(safeGotoCallCount, 0, 'safeGoto should NOT be called when no .ico_apply');
    assert.strictEqual(browserLaunchCount, 0, 'Chromium should NOT be launched when no .ico_apply');
    console.log('  ✓ [Pass] safeGoto 및 브라우저 실행 없이 정상 완료\n');

    // --- Case B: HTTP HTML에 .ico_apply 1개 이상 -> Playwright 신청 단계 진입 ---
    console.log('--- Case B: HTTP HTML에 .ico_apply 1개 이상 ---');
    safeGotoCallCount = 0;
    (httpClientModule as unknown as { httpGet: unknown }).httpGet = async () => ({
      status: 200,
      body: HTML_WITH_APPLY,
      resultType: 'SUCCESS',
    });

    const mockPageB = createMockPage({ applyCount: 1, completionCount: 1 });
    const resultB = await runApplySeminar({ page: mockPageB as never }, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultB.success, true);
    assert.ok(safeGotoCallCount >= 1, 'safeGoto should be called when .ico_apply exists');
    console.log('  ✓ [Pass] Playwright 진입 후 세미나 신청 로직 정상 수행\n');

    // --- Case C: 새 세미나는 없지만 기존 세미나에 .ico_apply 있음 -> Playwright 신청 실행 ---
    console.log('--- Case C: 새 세미나는 없지만 기존 세미나에 .ico_apply 있음 ---');
    storage.set(SEMINAR_LIST_KEY, [
      {
        seminarId: '100',
        name: '신청 가능 세미나 100',
        url: 'https://www.doctorville.co.kr/seminar/seminarDetail?seminarId=100',
        date: '2026-08-25',
        time: '19:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
      },
    ]);
    safeGotoCallCount = 0;
    (httpClientModule as unknown as { httpGet: unknown }).httpGet = async () => ({
      status: 200,
      body: HTML_WITH_APPLY,
      resultType: 'SUCCESS',
    });

    const mockPageC = createMockPage({ applyCount: 1, completionCount: 1 });
    const resultC = await runApplySeminar({ page: mockPageC as never }, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultC.success, true);
    assert.ok(safeGotoCallCount >= 1, 'safeGoto should be called even if no new seminar when .ico_apply exists');
    console.log('  ✓ [Pass] 신규 세미나가 없더라도 .ico_apply가 있으면 Playwright 신청 실행\n');

    // --- Case D: 새 세미나는 있지만 .ico_apply 없음 -> Playwright 신청 미실행 ---
    console.log('--- Case D: 새 세미나는 있지만 .ico_apply 없음 ---');
    storage.set(SEMINAR_LIST_KEY, [
      {
        seminarId: '100',
        name: '기존 세미나 100',
        url: 'https://www.doctorville.co.kr/seminar/seminarDetail?seminarId=100',
        date: '2026-08-25',
        time: '19:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
      },
    ]);
    safeGotoCallCount = 0;
    browserLaunchCount = 0;
    (httpClientModule as unknown as { httpGet: unknown }).httpGet = async () => ({
      status: 200,
      body: HTML_NEW_WITHOUT_APPLY,
      resultType: 'SUCCESS',
    });

    const resultD = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultD.success, true);
    assert.strictEqual(safeGotoCallCount, 0, 'safeGoto should NOT be called when new seminar has no .ico_apply');
    assert.strictEqual(browserLaunchCount, 0, 'Chromium should NOT be launched');
    const storedD = storage.get<unknown[]>(SEMINAR_LIST_KEY) || [];
    assert.strictEqual(storedD.length, 2, 'New seminar should be saved via HTTP processing');
    console.log('  ✓ [Pass] 새 세미나가 있어도 .ico_apply가 없으면 Playwright 미실행 및 HTTP 수집 완료\n');

    // --- Case E: HTTP 요청 실패 / AUTH_EXPIRED -> Playwright fallback 없이 에러 처리 ---
    console.log('--- Case E: HTTP 요청 AUTH_EXPIRED 발생 시 Playwright fallback 없음 ---');
    safeGotoCallCount = 0;
    browserLaunchCount = 0;
    (httpClientModule as unknown as { httpGet: unknown }).httpGet = async () => ({
      status: 200,
      body: '<script>alert("로그인이 되어 있지 않습니다.");</script>',
      resultType: 'AUTH_EXPIRED',
    });

    const resultE = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultE.success, false);
    assert.ok(resultE.message.includes('로그인이 필요합니다'));
    assert.strictEqual(safeGotoCallCount, 0, 'safeGoto should NOT be called on AUTH_EXPIRED');
    assert.strictEqual(browserLaunchCount, 0, 'Chromium should NOT be launched on AUTH_EXPIRED');
    console.log('  ✓ [Pass] AUTH_EXPIRED 발생 시 Playwright fallback 없이 정상 세션 만료 반환\n');

    // --- Case F: HTTP에서는 .ico_apply가 있었지만 Playwright 진입 후 사라짐 ---
    console.log('--- Case F: HTTP에서는 .ico_apply가 있었지만 Playwright 진입 후 사라짐 ---');
    safeGotoCallCount = 0;
    (httpClientModule as unknown as { httpGet: unknown }).httpGet = async () => ({
      status: 200,
      body: HTML_WITH_APPLY,
      resultType: 'SUCCESS',
    });

    const mockPageF = createMockPage({ applyCount: 0, completionCount: 1 });
    const resultF = await runApplySeminar({ page: mockPageF as never }, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultF.success, true);
    assert.ok(
      resultF.message.includes('신청 완료'),
      'Task should succeed even if apply target disappeared in Playwright',
    );
    console.log('  ✓ [Pass] Playwright 진입 후 신청 대상이 없어져도 오류가 아닌 정상 완료 처리\n');

    console.log('🎉 모든 apply_seminar HTTP pre-check 테스트 성공적 통과!\n');
  } finally {
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
