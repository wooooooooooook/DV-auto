import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import * as httpClientModule from '../src/modules/http_client';
import * as utilsModule from '../src/modules/utils';
import { applySeminarExtraTask } from '../src/tasks/apply_seminar';
// import { run as runRefreshPointExclusion } from '../src/tasks/refresh_seminar_point_exclusion';
import * as storage from '../src/services/storage';

const COOKIE_FILE = path.join(process.cwd(), 'cookies.json');

async function runTests() {
  console.log('--- [Test] HTTP Session Expiry & Error Classification Tests Started ---');

  // Backup original cookies.json
  let originalCookies: string | null = null;
  if (fs.existsSync(COOKIE_FILE)) {
    originalCookies = fs.readFileSync(COOKIE_FILE, 'utf8');
  }

  // Set up mock HTTP server
  let mockStatusCode = 200;
  let mockResponseBody = '<html><body>정상 페이지</body></html>';

  const server = http.createServer((_req, res) => {
    res.writeHead(mockStatusCode, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(mockResponseBody);
  });

  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    // 1. 200 + 정상 HTML -> SUCCESS
    mockStatusCode = 200;
    mockResponseBody = '<html><body><button>회원정보수정</button></body></html>';
    const res1 = await httpClientModule.sendDoctorVilleRequest(`${baseUrl}/main`);
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.resultType, 'SUCCESS');
    console.log('  ✓ 200 + 정상 HTML → SUCCESS');

    // 2. 200 + 로그인이 되어 있지 않습니다 -> AUTH_EXPIRED
    mockStatusCode = 200;
    mockResponseBody =
      '<script>alert("로그인이 되어 있지 않습니다.\\n로그인 해주시기 바랍니다.");document.location.href="/intro";</script>';
    const res2 = await httpClientModule.sendDoctorVilleRequest(`${baseUrl}/main`);
    assert.strictEqual(res2.status, 200);
    assert.strictEqual(res2.resultType, 'AUTH_EXPIRED');
    console.log('  ✓ 200 + "로그인이 되어 있지 않습니다" → AUTH_EXPIRED');

    // 3. 403 -> HTTP_ERROR
    mockStatusCode = 403;
    mockResponseBody = 'Forbidden';
    const res3 = await httpClientModule.sendDoctorVilleRequest(`${baseUrl}/main`);
    assert.strictEqual(res3.status, 403);
    assert.strictEqual(res3.resultType, 'HTTP_ERROR');
    console.log('  ✓ 403 → HTTP_ERROR');

    // 4. 500 -> HTTP_ERROR
    mockStatusCode = 500;
    mockResponseBody = 'Internal Server Error';
    const res4 = await httpClientModule.sendDoctorVilleRequest(`${baseUrl}/main`);
    assert.strictEqual(res4.status, 500);
    assert.strictEqual(res4.resultType, 'HTTP_ERROR');
    console.log('  ✓ 500 → HTTP_ERROR');

    // 5. timeout/network error -> HTTP_ERROR 반환 (throw 하지 않음)
    const res5 = await httpClientModule.sendDoctorVilleRequest('http://127.0.0.1:59999/nonexistent', { timeout: 100 });
    assert.strictEqual(res5.status, 0);
    assert.strictEqual(res5.resultType, 'HTTP_ERROR');
    assert.ok(res5.statusText.length > 0);
    console.log('  ✓ timeout/network error → resultType: HTTP_ERROR, status: 0');

    // 6. 실제 작업 중 세션 만료(중간 만료) 시나리오 검증
    // Prepare initial storage data
    const initialStorageData = [
      {
        name: '기존 세미나 1',
        url: 'https://www.doctorville.co.kr/cme/seminar/100',
        seminarId: '100',
        isPointExcluded: false,
        date: '2026-08-25',
      },
    ];
    storage.set('apply_seminar:seminar_list', initialStorageData);

    // Track state
    let ensureLoggedInCalledCount = 0;
    let browserCreated = false;
    let httpGetCallCount = 0;

    const originalEnsureLoggedIn = utilsModule.ensureLoggedIn;
    (utilsModule as unknown as { ensureLoggedIn: unknown }).ensureLoggedIn = async () => {
      ensureLoggedInCalledCount++;
    };

    const originalLaunch = chromium.launch.bind(chromium);
    chromium.launch = async (...args: Parameters<typeof originalLaunch>) => {
      browserCreated = true;
      return originalLaunch(...args);
    };

    // First HTTP call (seminar list) -> 200 OK + valid list HTML containing a newly added seminar
    // Second HTTP call (detail page check for newly added seminar) -> 200 OK + AUTH_EXPIRED ("로그인이 되어 있지 않습니다")
    const mockListHtml = `
      <div class="list_cont">
        <span class="seminar_day"><span class="date">8/25</span></span>
        <a class="list_detail" href="/cme/seminar/101">
          <span class="list_tit"><span class="tit">신규 세미나 101</span></span>
          <span class="txt_num time">13:00~14:00</span>
        </a>
        <a class="list_detail" href="/cme/seminar/102">
          <span class="list_tit"><span class="tit">신규 세미나 102</span></span>
          <span class="txt_num time">14:00~15:00</span>
        </a>
      </div>
    `;
    const mockExpiredHtml = '<script>alert("로그인이 되어 있지 않습니다.\\n로그인 해주시기 바랍니다.");</script>';

    const originalHttpGet = httpClientModule.httpGet;
    (httpClientModule as unknown as { httpGet: unknown }).httpGet = async (
      url: string,
      _headers?: Record<string, string>,
    ) => {
      httpGetCallCount++;
      if (httpGetCallCount === 1) {
        // 첫 번째 요청: 세미나 목록 조회 -> 정상
        return {
          status: 200,
          statusText: '200',
          headers: {},
          body: mockListHtml,
          url,
          redirected: false,
          resultType: 'SUCCESS' as const,
        };
      } else {
        // 두 번째 요청: 신규 세미나 상세 페이지/포인트미지급 여부 조회 중 세션 만료 발생!
        return {
          status: 200,
          statusText: '200',
          headers: {},
          body: mockExpiredHtml,
          url,
          redirected: false,
          resultType: 'AUTH_EXPIRED' as const,
        };
      }
    };

    const taskResult = await applySeminarExtraTask.run({}, { notifyNewSeminarsToTelegram: false });

    // Assertions for Mid-Task Session Expiry:
    // 1) Task result is failure
    assert.strictEqual(taskResult.success, false);
    assert.ok(
      taskResult.message.includes('만료') ||
        taskResult.message.includes('AUTH_EXPIRED') ||
        taskResult.message.includes('로그인이 필요합니다'),
      `Unexpected task message: ${taskResult.message}`,
    );

    // 2) ensureLoggedIn was called only once at task start
    assert.strictEqual(
      ensureLoggedInCalledCount,
      1,
      'ensureLoggedIn()은 작업 시작 시 1회만 호출되어야 하며, AUTH_EXPIRED 발생 시 재호출되지 않아야 함',
    );

    // 3) Playwright browser was NOT launched
    assert.strictEqual(browserCreated, false, 'AUTH_EXPIRED 발생 시 Playwright 브라우저를 켜지 않아야 함');

    // 4) Subsequent HTTP requests were aborted immediately (call count should be 2, not continuing to 102)
    assert.strictEqual(httpGetCallCount, 2, 'AUTH_EXPIRED 감지 즉시 이후 세미나 조회를 중단해야 함 (호출 횟수: 2)');

    // 5) Existing storage was preserved and not corrupted
    const storedAfter = storage.get('apply_seminar:seminar_list');
    assert.deepStrictEqual(
      storedAfter,
      initialStorageData,
      '중간 세션 만료 발생 시 기존 storage 데이터가 잘못된 값으로 덮어씌워지지 않아야 함',
    );

    console.log(
      '  ✓ 작업 중간 AUTH_EXPIRED 발생 시 ensureLoggedIn 재호출 없음, Playwright 미실행, 추가 조회 즉시 중단, storage 보존 성공적 검증 완료',
    );

    // Restore functions
    chromium.launch = originalLaunch;
    (httpClientModule as unknown as { httpGet: unknown }).httpGet = originalHttpGet;
    (utilsModule as unknown as { ensureLoggedIn: unknown }).ensureLoggedIn = originalEnsureLoggedIn;

    // 7. 신규 세미나 정상 추가 및 상세 조회/포인트 제외 판정 성공 시 seminar_list 정상 업데이트 검증
    storage.set('apply_seminar:seminar_list', initialStorageData);
    let successHttpGetCount = 0;

    const mockDetailSuccessHtml = '<html><body><div>세미나 상세 내용 (포인트 지급 세미나)</div></body></html>';

    (httpClientModule as unknown as { httpGet: unknown }).httpGet = async (
      url: string,
      _headers?: Record<string, string>,
    ) => {
      successHttpGetCount++;
      if (successHttpGetCount === 1) {
        return {
          status: 200,
          statusText: '200',
          headers: {},
          body: mockListHtml,
          url,
          redirected: false,
          resultType: 'SUCCESS' as const,
        };
      } else {
        return {
          status: 200,
          statusText: '200',
          headers: {},
          body: mockDetailSuccessHtml,
          url,
          redirected: false,
          resultType: 'SUCCESS' as const,
        };
      }
    };

    (utilsModule as unknown as { ensureLoggedIn: unknown }).ensureLoggedIn = async () => {};
    const successTaskResult = await applySeminarExtraTask.run({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(successTaskResult.success, true);

    const storedAfterSuccess = storage.get<unknown[]>('apply_seminar:seminar_list') as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(storedAfterSuccess));
    assert.strictEqual(storedAfterSuccess.length, 3, '기존 1건 + 신규 2건 = 총 3건이 storage에 저장되어야 함');
    const newSeminar101 = storedAfterSuccess.find((item) => (item.url as string).includes('/101'));
    assert.ok(newSeminar101, '신규 세미나 101이 storage에 포함되어야 함');
    assert.strictEqual(
      newSeminar101.isPointExcluded,
      false,
      '포인트 지급 세미나이므로 isPointExcluded가 false로 설정되어야 함',
    );

    console.log('  ✓ 신규 세미나 정상 추가 및 상세 조회/포인트 제외 판정 성공 시 seminar_list 정상 업데이트 검증 완료');

    console.log('🎉 모든 HTTP 세션 만료 및 오류 구분 테스트 통과!');
  } finally {
    server.close();
    if (originalCookies !== null) {
      fs.writeFileSync(COOKIE_FILE, originalCookies, 'utf8');
    } else if (fs.existsSync(COOKIE_FILE)) {
      fs.unlinkSync(COOKIE_FILE);
    }
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
