import http from 'http';
import { chromium } from 'playwright';
import * as httpClientModule from '../src/modules/http_client';
import * as utilsModule from '../src/modules/utils';
import { fetchMainFutureSeminars } from '../src/modules/seminar_api';
import { syncSeminars } from '../src/tasks/apply_seminar';
import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * 비로그인 상태에서 메인 세미나 목록 API 는 HTTP 200 과 함께 빈 객체({}) 를 반환한다 (실측 확인).
 * code/401 도 아니고 message 에 '로그인' 도 없으므로 기존 판정을 모두 빠져나가
 * 'API 응답 구조 이상' 이 되어 세션 만료 사실을 알리지 못했다.
 */
describe('세미나 목록 API 세션 만료 감지 및 자동 재로그인', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('빈 객체 응답을 세션 만료로 판정한다', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };

    try {
      const result = await fetchMainFutureSeminars(`http://127.0.0.1:${port}/api/mw/seminars/mainFuture`);

      expect(result.success).toBe(false);
      // 구조 오류(isAuthExpired: false)로 오분류되면 재로그인 폴백이 동작하지 않는다.
      expect(result.isAuthExpired).toBe(true);
      expect(result.errorMessage).toContain('세션이 만료되었습니다');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('응답에 데이터가 있는 구조 이상은 세션 만료로 오분류하지 않는다', async () => {
    // 빈 객체만 세션 만료로 봐야 한다. 실제 API 구조 변경을 오인해 브라우저 로그인을
    // 띄우지 않도록, 데이터가 있는 응답은 기존처럼 구조 오류로 남긴다.
    vi.spyOn(httpClientModule, 'httpGet').mockResolvedValue({
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ futureSeminarList: {} }),
      ok: true,
    } as unknown as httpClientModule.HttpResponse);

    const result = await fetchMainFutureSeminars();

    expect(result.success).toBe(false);
    expect(result.isAuthExpired).toBe(false);
    expect(result.errorMessage).toContain('API 응답 구조 이상');
  });

  it('세션 만료 시 재로그인 후 1회 재시도하여 목록을 정상 수신한다', async () => {
    const validJson = JSON.stringify({
      futureSeminarList: {
        items: [
          {
            seminarId: 201,
            seminarNm: '복구된 세미나',
            startDt: '2026-10-05 13:00:00',
            endDt: '2026-10-05 14:00:00',
            applyCnt: 5,
            maxPeopleCnt: 100,
            processState: 2,
            cancelProcessState: 0,
            seminarCompleted: 0,
          },
        ],
      },
    });

    const httpGetSpy = vi.spyOn(httpClientModule, 'httpGet').mockImplementation(async () => {
      // 첫 호출은 비로그인 응답(빈 객체), 재시도 호출은 정상 응답.
      const callIndex = httpGetSpy.mock.calls.length;
      return {
        status: 200,
        statusText: 'OK',
        ok: true,
        body: callIndex <= 1 ? '{}' : validJson,
      } as unknown as httpClientModule.HttpResponse;
    });

    const ensureLoggedInSpy = vi.spyOn(utilsModule, 'ensureLoggedIn').mockResolvedValue(undefined as never);

    // 실제 브라우저를 띄우지 않도록 가짜 브라우저를 반환한다.
    // (Browser 인스턴스를 spread 하면 프로토타입 메서드가 사라져 오동작한다)
    const fakeBrowser = {
      newContext: async () => ({
        newPage: async () => ({ close: async () => {} }),
        close: async () => {},
      }),
      close: async () => {},
    };
    const launchSpy = vi.spyOn(chromium, 'launch').mockResolvedValue(fakeBrowser as never);

    const sendTelegramSpy = vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(undefined as never);

    try {
      const result = await syncSeminars({ notifyNewSeminarsToChannel: false, silentIfNoNew: false });

      expect(ensureLoggedInSpy).toHaveBeenCalledTimes(1);
      expect(launchSpy).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(httpGetSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

      const bodies = JSON.stringify(result);
      expect(bodies).toContain('복구된 세미나');
      expect(sendTelegramSpy).toHaveBeenCalledWith(expect.stringContaining('자동 재로그인'));
    } finally {
      launchSpy.mockRestore();
    }
  });
});
