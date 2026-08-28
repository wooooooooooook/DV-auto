import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as httpClient from '../src/modules/http_client';
import * as seminarApiModule from '../src/modules/seminar_api';
import { attendSeminarApi } from '../src/modules/seminar_api';

describe('seminar_api - attendSeminarApi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('세미나 입장 API 및 UAS 정상 호출 시 success: true 및 hasEntryHistory 반환', async () => {
    vi.spyOn(httpClient, 'httpGet').mockImplementation(async (url: string) => {
      if (url.includes('/attend')) {
        return {
          status: 200,
          statusText: 'OK',
          body: JSON.stringify({
            accessAllowed: true,
            seminarInfo: { seminarId: 5585, seminarNm: '테스트 세미나' },
          }),
          resultType: 'SUCCESS',
          headers: {},
          url,
          redirected: false,
        };
      }
      if (url.includes('/uas/session')) {
        return {
          status: 200,
          statusText: 'OK',
          body: JSON.stringify({ sessionKey: 'test-session-key', response_msg: '성공' }),
          resultType: 'SUCCESS',
          headers: {},
          url,
          redirected: false,
        };
      }
      if (url.includes('/uas/activity')) {
        return {
          status: 200,
          statusText: 'OK',
          body: JSON.stringify({ activityKey: 'test-activity-key' }),
          resultType: 'SUCCESS',
          headers: {},
          url,
          redirected: false,
        };
      }
      if (url.includes('/mw/seminars/5585')) {
        return {
          status: 200,
          statusText: 'OK',
          body: JSON.stringify({
            seminarDetail: {
              seminarId: 5585,
              seminarMember: { joinDt: '2026-08-28 14:00:00', applyTy: 1 },
            },
          }),
          resultType: 'SUCCESS',
          headers: {},
          url,
          redirected: false,
        };
      }
      return {
        status: 200,
        statusText: 'OK',
        body: JSON.stringify({}),
        resultType: 'SUCCESS',
        headers: {},
        url,
        redirected: false,
      };
    });

    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockResolvedValue({
      success: true,
      seminarId: '5585',
      survey: null,
      isPointExcluded: false,
      hasEntryHistory: true,
      rawResponse: {
        seminarDetail: {
          seminarId: 5585,
          seminarMember: { joinDt: '2026-08-28 14:00:00', applyTy: 1 },
        },
      },
    });

    const res = await attendSeminarApi('5585');
    expect(res.success).toBe(true);
    expect(res.hasEntryHistory).toBe(true);
    expect(res.isAuthExpired).toBe(false);
  });

  it('입장 권한이 없는 경우(accessAllowed: false) 실패 반환', async () => {
    vi.spyOn(httpClient, 'httpGet').mockResolvedValue({
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({
        differResponseData: {
          accessAllowed: false,
        },
      }),
      resultType: 'SUCCESS',
      headers: {},
      url: 'https://m-api.doctorville.co.kr/api/mw/seminars/5585/attend',
      redirected: false,
    });

    const res = await attendSeminarApi('5585');
    expect(res.success).toBe(false);
    expect(res.hasEntryHistory).toBe(false);
    expect(res.errorMessage).toContain('입장 권한이 없습니다');
  });

  it('세션 만료(AUTH_EXPIRED) 시 isAuthExpired: true 반환', async () => {
    vi.spyOn(httpClient, 'httpGet').mockResolvedValue({
      status: 200,
      statusText: 'OK',
      body: '<html>로그인 페이지</html>',
      resultType: 'AUTH_EXPIRED',
      headers: {},
      url: 'https://m-api.doctorville.co.kr/api/mw/seminars/5585/attend',
      redirected: false,
    });

    const res = await attendSeminarApi('5585');
    expect(res.success).toBe(false);
    expect(res.isAuthExpired).toBe(true);
    expect(res.errorMessage).toContain('세션이 만료되었습니다');
  });
});
