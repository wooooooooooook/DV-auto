import assert from 'node:assert';
import * as httpClientModule from '../src/modules/http_client';
import {
  getRequiredTermsOptionIds,
  submitSeminarTermsAgree,
  applySeminarApi,
  applySeminarWithTerms,
  ProcessState,
  type TermsInfo,
} from '../src/modules/seminar_api';
import { describe, it, vi } from 'vitest';

describe('세미나 신청 및 약관 동의 API 단위 테스트', () => {
  it('약관 필터링, 신청 API 및 약관 동의 종합 검증', async () => {
    console.log('===========================================================');
    console.log('  세미나 신청 및 약관 동의 API 단위 테스트');
    console.log('===========================================================\n');

    // -------------------------------------------------------------
    // Test 1: getRequiredTermsOptionIds 필터링 검증
    // -------------------------------------------------------------
    console.log('--- [Test 1] getRequiredTermsOptionIds 약관 필터링 검증 ---');

    // 1-1. null/undefined 또는 빈 termsInfo
    assert.deepStrictEqual(getRequiredTermsOptionIds(null), []);
    assert.deepStrictEqual(getRequiredTermsOptionIds(undefined), []);
    assert.deepStrictEqual(getRequiredTermsOptionIds({}), []);

    // 1-2. (선택) 포함 약관과 미포함 약관 혼합
    const mixedTermsInfo: TermsInfo = {
      dataReceiver: '테스트제약사',
      termsOptionsModels: [
        { termsOptionsId: 101, title: '개인정보 수집 및 이용 동의 [필수]' },
        { termsOptionsId: 102, title: '개인정보 제3자 제공 동의' },
        { termsOptionsId: 103, title: '마케팅 정보 수신 동의 (선택)' },
        { termsOptionsId: 104, title: '이벤트 혜택 안내 [선택]' },
        { termsOptionsId: 105, title: '학술 정보 안내 (선택)' },
      ],
    };

    const requiredIds = getRequiredTermsOptionIds(mixedTermsInfo);
    assert.deepStrictEqual(requiredIds, [101, 102], '101, 102번 필수/일반 약관만 추출되어야 함');
    console.log('  ✓ [Pass] (선택) 미포함 약관 정상 필터링 확인: [101, 102]\n');

    // -------------------------------------------------------------
    // Test 2: submitSeminarTermsAgree 및 applySeminarApi HTTP Mocking 검증
    // -------------------------------------------------------------
    console.log('--- [Test 2] submitSeminarTermsAgree 및 applySeminarApi 호출 검증 ---');

    const requestsMade: Array<{ url: string; method: string; body: unknown }> = [];

    try {
      vi.spyOn(httpClientModule, 'sendDoctorVilleRequest').mockImplementation(
        async (url: string, options?: httpClientModule.HttpRequestOptions) => {
          let parsedBody: unknown = undefined;
          if (options && typeof options.body === 'string') {
            try {
              parsedBody = JSON.parse(options.body);
            } catch {
              parsedBody = options.body;
            }
          }
          requestsMade.push({ url, method: options?.method || 'GET', body: parsedBody });

          return {
            status: 200,
            statusText: '200',
            headers: {},
            body: JSON.stringify({ timestamp: '2026-08-25 00:00:00', data: true, error: null }),
            url,
            redirected: false,
            resultType: 'SUCCESS' as const,
          };
        },
      );

      // 2-1. submitSeminarTermsAgree
      requestsMade.length = 0;
      const termsRes = await submitSeminarTermsAgree(5597, [101, 102]);
      assert.strictEqual(termsRes.success, true);
      assert.strictEqual(requestsMade.length, 1);
      assert.strictEqual(requestsMade[0].method, 'POST');
      assert.ok(requestsMade[0].url.includes('/seminar/terms-info'));
      assert.deepStrictEqual(requestsMade[0].body, {
        seminarId: 5597,
        agreedTermsOptionsIdList: [101, 102],
      });
      console.log('  ✓ [Pass] submitSeminarTermsAgree 호출 및 페이로드 정상 검증 완료\n');

      // 2-2. applySeminarApi
      requestsMade.length = 0;
      const applyRes = await applySeminarApi(5597);
      assert.strictEqual(applyRes.success, true);
      assert.strictEqual(requestsMade.length, 1);
      assert.strictEqual(requestsMade[0].method, 'POST');
      assert.ok(requestsMade[0].url.includes('/seminars/apply'));
      assert.deepStrictEqual(requestsMade[0].body, { seminarId: 5597 });
      console.log('  ✓ [Pass] applySeminarApi 호출 및 페이로드 정상 검증 완료\n');

      // -------------------------------------------------------------
      // Test 3: applySeminarWithTerms 통합 흐름 및 재조회 검증
      // -------------------------------------------------------------
      console.log('--- [Test 3] applySeminarWithTerms 약관 동의 후 신청 및 재조회 검증 ---');

      // 3-1. 필수 약관이 있고, 신청 후 PROCESS_CANCEL로 확정되는 경우: 성공
      let detailQueryCount = 0;
      const httpGetSpy = vi.spyOn(httpClientModule, 'httpGet').mockImplementation(async (url: string) => {
        detailQueryCount++;
        return {
          status: 200,
          statusText: '200',
          headers: {},
          body: JSON.stringify({
            seminarDetail: {
              seminarId: 5597,
              processState: detailQueryCount === 1 ? ProcessState.PROCESS_APPLY : ProcessState.PROCESS_CANCEL,
            },
            termsInfo: mixedTermsInfo,
          }),
          url,
          redirected: false,
          resultType: 'SUCCESS' as const,
        };
      });

      requestsMade.length = 0;
      detailQueryCount = 0;
      const withTermsRes = await applySeminarWithTerms(5597);
      assert.strictEqual(withTermsRes.success, true);
      assert.strictEqual(withTermsRes.alreadyApplied, false);
      assert.strictEqual(withTermsRes.processState, ProcessState.PROCESS_CANCEL);
      assert.ok(
        requestsMade.some((r) => r.url.includes('terms-info')),
        '약관 동의 요청 호출 확인',
      );
      assert.ok(
        requestsMade.some((r) => r.url.includes('seminars/apply')),
        '세미나 신청 요청 호출 확인',
      );
      console.log('  ✓ [Pass] 필수 약관 동의 → API 신청 → 상세 재조회(PROCESS_CANCEL)로 최종 성공 확정 확인\n');

      // 3-2. applySeminarApi가 성공하더라도 재조회 결과가 여전히 PROCESS_APPLY(미신청)이면 실패 처리
      httpGetSpy.mockImplementation(async (url: string) => ({
        status: 200,
        statusText: '200',
        headers: {},
        body: JSON.stringify({
          seminarDetail: {
            seminarId: 5597,
            processState: ProcessState.PROCESS_APPLY, // 신청 후에도 미신청 상태 유지
          },
          termsInfo: mixedTermsInfo,
        }),
        url,
        redirected: false,
        resultType: 'SUCCESS' as const,
      }));

      requestsMade.length = 0;
      const failedRecheckRes = await applySeminarWithTerms(5597);
      assert.strictEqual(failedRecheckRes.success, false, '재조회 결과 미신청 상태이면 success: false여야 함');
      assert.ok(
        (failedRecheckRes.errorMessage || '').includes('미신청 상태 유지됨'),
        `에러 메시지 확인: ${failedRecheckRes.errorMessage}`,
      );
      console.log('  ✓ [Pass] API 성공 응답이라도 재조회 상태가 PROCESS_APPLY이면 실패로 판정 확인\n');

      // 3-3. 이미 신청 완료된 세미나인 경우: alreadyApplied: true 반환 및 API 재신청 생략
      httpGetSpy.mockImplementation(async (url: string) => ({
        status: 200,
        statusText: '200',
        headers: {},
        body: JSON.stringify({
          seminarDetail: {
            seminarId: 5597,
            processState: ProcessState.PROCESS_CANCEL, // 이미 완료 상태
          },
          termsInfo: mixedTermsInfo,
        }),
        url,
        redirected: false,
        resultType: 'SUCCESS' as const,
      }));

      requestsMade.length = 0;
      const alreadyAppliedRes = await applySeminarWithTerms(5597);
      assert.strictEqual(alreadyAppliedRes.success, true);
      assert.strictEqual(alreadyAppliedRes.alreadyApplied, true, 'alreadyApplied가 true여야 함');
      assert.strictEqual(
        requestsMade.some((r) => r.url.includes('seminars/apply')),
        false,
        '이미 완료 상태이므로 apply API 재호출 없음',
      );
      console.log('  ✓ [Pass] 이미 신청 완료 상태인 경우 alreadyApplied: true 및 중복 신청 방지 확인\n');

      // 3-4. 세션 만료 시 처리
      httpGetSpy.mockImplementation(async (url: string) => ({
        status: 200,
        statusText: '200',
        headers: {},
        body: '<script>alert("로그인이 되어 있지 않습니다.");</script>',
        url,
        redirected: false,
        resultType: 'AUTH_EXPIRED' as const,
      }));

      const authExpiredRes = await applySeminarWithTerms(5597, null);
      assert.strictEqual(authExpiredRes.success, false);
      assert.strictEqual(authExpiredRes.isAuthExpired, true);
      console.log('  ✓ [Pass] 세션 만료 응답 시 isAuthExpired: true 정상 반환\n');

      console.log('🎉 세미나 신청 및 약관 동의 API 단위 테스트 모두 성공!\n');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
