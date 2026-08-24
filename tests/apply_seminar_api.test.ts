import assert from 'node:assert';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as httpClientModule from '../src/modules/http_client';
import {
  getRequiredTermsOptionIds,
  submitSeminarTermsAgree,
  applySeminarApi,
  applySeminarWithTerms,
  type TermsInfo,
} from '../src/modules/seminar_api';

async function runApplySeminarApiTests() {
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

  const originalSendRequest = httpClientModule.sendDoctorVilleRequest;
  const requestsMade: Array<{ url: string; method: string; body: unknown }> = [];

  try {
    (httpClientModule as unknown as { sendDoctorVilleRequest: unknown }).sendDoctorVilleRequest = async (
      url: string,
      options: { method?: string; body?: string },
    ) => {
      let parsedBody: unknown = undefined;
      if (typeof options.body === 'string') {
        try {
          parsedBody = JSON.parse(options.body);
        } catch {
          parsedBody = options.body;
        }
      }
      requestsMade.push({ url, method: options.method || 'GET', body: parsedBody });

      if (url.includes('terms-info')) {
        return {
          status: 200,
          statusText: '200',
          headers: {},
          body: JSON.stringify({ timestamp: '2026-08-25 00:00:00', data: true, error: null }),
          url,
          redirected: false,
          resultType: 'SUCCESS',
        };
      }

      if (url.includes('seminars/apply')) {
        return {
          status: 200,
          statusText: '200',
          headers: {},
          body: JSON.stringify({ timestamp: '2026-08-25 00:00:00', data: true, error: null }),
          url,
          redirected: false,
          resultType: 'SUCCESS',
        };
      }

      return {
        status: 200,
        statusText: '200',
        headers: {},
        body: JSON.stringify({ code: 200, message: 'OK' }),
        url,
        redirected: false,
        resultType: 'SUCCESS',
      };
    };

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
    // Test 3: applySeminarWithTerms 통합 흐름 검증
    // -------------------------------------------------------------
    console.log('--- [Test 3] applySeminarWithTerms 약관 동의 후 신청 흐름 검증 ---');

    // 3-1. 필수 약관이 있는 경우: terms-info → seminars/apply 순차 호출
    requestsMade.length = 0;
    const withTermsRes = await applySeminarWithTerms(5597, mixedTermsInfo);
    assert.strictEqual(withTermsRes.success, true);
    assert.strictEqual(requestsMade.length, 2, 'terms-info 호출 후 seminars/apply 호출되어야 함');
    assert.ok(requestsMade[0].url.includes('terms-info'), '1번째 요청은 약관 동의');
    assert.deepStrictEqual(requestsMade[0].body, { seminarId: 5597, agreedTermsOptionsIdList: [101, 102] });
    assert.ok(requestsMade[1].url.includes('seminars/apply'), '2번째 요청은 세미나 신청');
    console.log('  ✓ [Pass] 필수 약관 있을 때 약관 동의 → 세미나 신청 순차 호출 확인\n');

    // 3-2. 약관이 없거나 (선택)만 있는 경우: terms-info 호출 없이 바로 seminars/apply 호출
    const optionalOnlyTermsInfo: TermsInfo = {
      termsOptionsModels: [
        { termsOptionsId: 201, title: '마케팅 정보 수신 동의 (선택)' },
        { termsOptionsId: 202, title: '이벤트 알림 (선택)' },
      ],
    };
    requestsMade.length = 0;
    const optionalRes = await applySeminarWithTerms(5597, optionalOnlyTermsInfo);
    assert.strictEqual(optionalRes.success, true);
    assert.strictEqual(requestsMade.length, 1, '약관 동의 요청 없이 세미나 신청만 1회 호출되어야 함');
    assert.ok(requestsMade[0].url.includes('seminars/apply'));
    console.log('  ✓ [Pass] (선택) 약관만 있을 때 약관 동의 생략하고 즉시 신청 확인\n');

    // 3-3. 세션 만료 시 처리
    (httpClientModule as unknown as { sendDoctorVilleRequest: unknown }).sendDoctorVilleRequest = async () => ({
      status: 200,
      statusText: '200',
      headers: {},
      body: '<script>alert("로그인이 되어 있지 않습니다.");</script>',
      url: 'https://api.doctorville.co.kr/api/seminars/apply',
      redirected: false,
      resultType: 'AUTH_EXPIRED',
    });

    const authExpiredRes = await applySeminarWithTerms(5597, null);
    assert.strictEqual(authExpiredRes.success, false);
    assert.strictEqual(authExpiredRes.isAuthExpired, true);
    console.log('  ✓ [Pass] 세션 만료 응답 시 isAuthExpired: true 정상 반환\n');

    console.log('🎉 세미나 신청 및 약관 동의 API 단위 테스트 모두 성공!\n');
  } finally {
    (httpClientModule as unknown as { sendDoctorVilleRequest: unknown }).sendDoctorVilleRequest = originalSendRequest;
  }
}

runApplySeminarApiTests().catch((err) => {
  console.error('❌ apply_seminar API test failed:', err);
  process.exit(1);
});
