import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import * as httpClientModule from '../src/modules/http_client';
import * as utilsModule from '../src/modules/utils';
import { applySeminarExtraTask } from '../src/tasks/apply_seminar';
import { run as runRefreshPointExclusion } from '../src/tasks/refresh_seminar_point_exclusion';
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

    // 5. timeout/network error -> HTTP_ERROR
    try {
      await httpClientModule.sendDoctorVilleRequest('http://127.0.0.1:59999/nonexistent', { timeout: 100 });
      assert.fail('Should have thrown network error');
    } catch (err) {
      assert.ok(err instanceof Error);
      console.log('  ✓ timeout/network error → 에러 발생(HTTP_ERROR 영역)');
    }

    // Prepare mock storage for storage preservation test
    const initialStorageData = [
      {
        name: '기존 세미나 1',
        url: `${baseUrl}/seminar/1`,
        seminarId: '1',
        isPointExcluded: false,
        date: '2026-08-25',
      },
    ];
    storage.set('apply_seminar:seminar_list', initialStorageData);

    // Mock httpGet to redirect external calls to mock server
    const originalHttpGet = httpClientModule.httpGet;
    (httpClientModule as unknown as { httpGet: unknown }).httpGet = async (
      url: string,
      headers?: Record<string, string>,
    ) => {
      return httpClientModule.sendDoctorVilleRequest(`${baseUrl}/path?url=${encodeURIComponent(url)}`, { headers });
    };

    // Mock ensureLoggedIn so that task start check succeeds without Playwright
    const originalEnsureLoggedIn = utilsModule.ensureLoggedIn;
    (utilsModule as unknown as { ensureLoggedIn: unknown }).ensureLoggedIn = async () => {};

    // 6 & 7. 작업 중 AUTH_EXPIRED -> 재로그인하지 않고 즉시 중단 및 storage 미변경 확인
    let browserCreated = false;
    const originalLaunch = chromium.launch.bind(chromium);
    chromium.launch = async (...args: Parameters<typeof originalLaunch>) => {
      browserCreated = true;
      return originalLaunch(...args);
    };

    mockStatusCode = 200;
    mockResponseBody = 'alert("로그인이 되어 있지 않습니다.\\n로그인 해주시기 바랍니다.");';

    const taskResult = await applySeminarExtraTask.run({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(taskResult.success, false);
    assert.ok(
      taskResult.message.includes('만료') ||
        taskResult.message.includes('AUTH_EXPIRED') ||
        taskResult.message.includes('로그인이 필요합니다'),
      `Unexpected message: ${taskResult.message}`,
    );
    assert.strictEqual(browserCreated, false, 'AUTH_EXPIRED 발생 시 Playwright 재로그인을 시도하지 않아야 함');

    const storedAfter = storage.get('apply_seminar:seminar_list');
    assert.deepStrictEqual(storedAfter, initialStorageData, 'AUTH_EXPIRED 발생 시 기존 storage 데이터가 유지되어야 함');
    console.log('  ✓ 작업 중 AUTH_EXPIRED 발생 시 재로그인 없이 즉시 중단 및 storage 데이터 보존 확인');

    // 8. refresh_seminar_point_exclusion 도 작업 중 AUTH_EXPIRED 발생 시 중단 및 storage 보존
    const refreshResult = await runRefreshPointExclusion();
    assert.strictEqual(refreshResult.success, false);
    assert.strictEqual(browserCreated, false, 'refresh task에서 AUTH_EXPIRED 시 Playwright 미실행');
    assert.deepStrictEqual(storage.get('apply_seminar:seminar_list'), initialStorageData);
    console.log('  ✓ refresh_seminar_point_exclusion 작업 중 AUTH_EXPIRED 즉시 중단 확인');

    // Restore functions
    chromium.launch = originalLaunch;
    (httpClientModule as unknown as { httpGet: unknown }).httpGet = originalHttpGet;
    (utilsModule as unknown as { ensureLoggedIn: unknown }).ensureLoggedIn = originalEnsureLoggedIn;

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
