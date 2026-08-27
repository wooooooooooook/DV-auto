import assert from 'assert';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import * as httpClientModule from '../src/modules/http_client';
import * as utilsModule from '../src/modules/utils';
import * as checkSeminarPointModule from '../src/tasks/check_seminar_point';
import { applySeminarExtraTask } from '../src/tasks/apply_seminar';
import * as seminarRepo from '../src/services/seminar_repository';
import { describe, it, vi } from 'vitest';

const COOKIE_FILE = path.join(process.cwd(), 'cookies.json');

describe('HTTP Session Expiry & Error Classification Tests', () => {
  it('세션 만료 및 오류 구분 종합 테스트', async () => {
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
      const res5 = await httpClientModule.sendDoctorVilleRequest('http://127.0.0.1:59999/nonexistent', {
        timeout: 100,
      });
      assert.strictEqual(res5.status, 0);
      assert.strictEqual(res5.resultType, 'HTTP_ERROR');
      assert.ok(res5.statusText.length > 0);
      console.log('  ✓ timeout/network error → resultType: HTTP_ERROR, status: 0');

      // 6. 실제 작업 중 세션 만료(중간 만료) 시나리오 검증
      // Prepare initial storage data
      const initialStorageData: seminarRepo.SeminarListItem[] = [
        {
          name: '기존 세미나 1',
          url: 'https://www.doctorville.co.kr/cme/seminar/100',
          seminarId: '100',
          isPointExcluded: false,
          isAdvancedSurvey: false,
          nightTime: false,
          time: '13:00~14:00',
          currentCount: '10',
          totalCount: '100',
          date: '2026-08-25',
        },
      ];
      seminarRepo.setAllSeminars(initialStorageData);

      // Track state
      let ensureLoggedInCalledCount = 0;
      let browserCreated = false;
      let httpGetCallCount = 0;

      vi.spyOn(utilsModule, 'ensureLoggedIn').mockImplementation(async () => {
        ensureLoggedInCalledCount++;
        return true as never;
      });

      const originalLaunch = chromium.launch.bind(chromium);
      vi.spyOn(chromium, 'launch').mockImplementation(async (...args: Parameters<typeof originalLaunch>) => {
        browserCreated = true;
        return originalLaunch(...args);
      });

      // First HTTP call (seminar list) -> 200 OK + valid list JSON containing a newly added seminar
      // Second HTTP call (detail page check for newly added seminar) -> 200 OK + AUTH_EXPIRED ("로그인이 되어 있지 않습니다")
      const mockListJson = JSON.stringify({
        code: 200,
        futureSeminarList: {
          items: [
            {
              seminarId: 101,
              seminarNm: '신규 세미나 101',
              startDt: '2026-08-25 13:00:00',
              endDt: '2026-08-25 14:00:00',
              applyCnt: 10,
              maxPeopleCnt: 100,
              processState: 2,
              cancelProcessState: 0,
              seminarCompleted: 0,
            },
            {
              seminarId: 102,
              seminarNm: '신규 세미나 102',
              startDt: '2026-08-25 14:00:00',
              endDt: '2026-08-25 15:00:00',
              applyCnt: 10,
              maxPeopleCnt: 100,
              processState: 2,
              cancelProcessState: 0,
              seminarCompleted: 0,
            },
          ],
        },
      });
      const mockExpiredHtml = '<script>alert("로그인이 되어 있지 않습니다.\\n로그인 해주시기 바랍니다.");</script>';

      vi.spyOn(checkSeminarPointModule, 'searchSeminarPoints').mockResolvedValue({
        success: true,
        points: new Map(),
      });
      vi.spyOn(httpClientModule, 'httpGet').mockImplementation(
        async (url: string, _headers?: Record<string, string>) => {
          httpGetCallCount++;
          if (url.includes('seminars/mainFuture') || url.includes('seminar/main')) {
            // 세미나 목록 조회 -> 정상
            return {
              status: 200,
              statusText: '200',
              headers: {},
              body: mockListJson,
              url,
              redirected: false,
              resultType: 'SUCCESS' as const,
            };
          } else {
            // 신규 세미나 상세 페이지/포인트미지급 여부 조회 중 세션 만료 발생!
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
        },
      );

      const taskResult = await applySeminarExtraTask.run({}, { notifyNewSeminarsToTelegram: false });

      // Assertions for Mid-Task Session Expiry:
      // 1) Task result is failure
      assert.strictEqual(taskResult.success, false);
      assert.ok(taskResult.message, 'taskResult.message가 존재해야 함');
      assert.ok(
        taskResult.message!.includes('만료') ||
          taskResult.message!.includes('AUTH_EXPIRED') ||
          taskResult.message!.includes('로그인이 필요합니다'),
        `Unexpected task message: ${taskResult.message}`,
      );

      // 2) ensureLoggedIn was NOT called for HTTP-only task
      assert.strictEqual(
        ensureLoggedInCalledCount,
        0,
        'runHttpOnly 작업은 Playwright ensureLoggedIn()을 호출하지 않고 순수 HTTP로만 동작해야 함',
      );

      // 3) Playwright browser was NOT launched
      assert.strictEqual(browserCreated, false, 'AUTH_EXPIRED 발생 시 Playwright 브라우저를 켜지 않아야 함');

      // 4) Subsequent HTTP requests were aborted immediately
      assert.ok(httpGetCallCount >= 2, 'AUTH_EXPIRED 감지 즉시 이후 세미나 조회를 중단해야 함');

      // 5) Existing storage was preserved and not corrupted
      const storedAfter = seminarRepo.getAllSeminars();
      assert.strictEqual(
        storedAfter?.length,
        1,
        '중간 세션 만료 발생 시 기존 storage 데이터가 잘못된 값으로 덮어씌워지지 않아야 함',
      );
      assert.strictEqual(storedAfter?.[0].seminarId, '100');
      assert.strictEqual(storedAfter?.[0].name, '기존 세미나 1');
      assert.strictEqual(storedAfter?.[0].date, '2026-08-25');

      console.log(
        '  ✓ 작업 중간 AUTH_EXPIRED 발생 시 ensureLoggedIn 재호출 없음, Playwright 미실행, 추가 조회 즉시 중단, storage 보존 성공적 검증 완료',
      );

      // 7. 신규 세미나 정상 추가 및 상세 조회/포인트 제외 판정 성공 시 seminar_list 정상 업데이트 검증
      seminarRepo.setAllSeminars(initialStorageData);

      const mockDetailSuccessJson = JSON.stringify({
        code: 200,
        seminarDetail: {
          intro: '포인트 지급 세미나',
          useDepthSurvey: false,
          processState: 2,
        },
      });

      vi.spyOn(checkSeminarPointModule, 'searchSeminarPoints').mockResolvedValue({
        success: true,
        points: new Map(),
      });

      vi.spyOn(httpClientModule, 'httpGet').mockImplementation(
        async (url: string, _headers?: Record<string, string>) => {
          if (url.includes('seminars/mainFuture') || url.includes('seminar/main')) {
            return {
              status: 200,
              statusText: '200',
              headers: {},
              body: mockListJson,
              url,
              redirected: false,
              resultType: 'SUCCESS' as const,
            };
          } else {
            return {
              status: 200,
              statusText: '200',
              headers: {},
              body: mockDetailSuccessJson,
              url,
              redirected: false,
              resultType: 'SUCCESS' as const,
            };
          }
        },
      );

      vi.spyOn(utilsModule, 'ensureLoggedIn').mockResolvedValue(true as never);
      const successTaskResult = await applySeminarExtraTask.run({}, { notifyNewSeminarsToTelegram: false });
      assert.strictEqual(successTaskResult.success, true);

      const storedAfterSuccess = seminarRepo.getAllSeminars();
      assert.ok(Array.isArray(storedAfterSuccess));
      assert.strictEqual(storedAfterSuccess.length, 3, '기존 1건 + 신규 2건 = 총 3건이 storage에 저장되어야 함');
      const newSeminar101 = storedAfterSuccess.find((item) => (item.url as string).includes('/101'));
      assert.ok(newSeminar101, '신규 세미나 101이 storage에 포함되어야 함');
      assert.strictEqual(
        newSeminar101.isPointExcluded,
        false,
        '포인트 지급 세미나이므로 isPointExcluded가 false로 설정되어야 함',
      );

      console.log(
        '  ✓ 신규 세미나 정상 추가 및 상세 조회/포인트 제외 판정 성공 시 seminar_list 정상 업데이트 검증 완료',
      );

      console.log('🎉 모든 HTTP 세션 만료 및 오류 구분 테스트 통과!');
    } finally {
      vi.restoreAllMocks();
      server.close();
      if (originalCookies !== null) {
        fs.writeFileSync(COOKIE_FILE, originalCookies, 'utf8');
      } else if (fs.existsSync(COOKIE_FILE)) {
        fs.unlinkSync(COOKIE_FILE);
      }
    }
  });
});
