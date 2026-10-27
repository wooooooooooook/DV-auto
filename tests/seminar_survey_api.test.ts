import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchSeminarSurveyQuizHttp } from '../src/modules/seminar_survey_api';
import * as httpClient from '../src/modules/http_client';

describe('seminar_survey_api (fetchSeminarSurveyQuizHttp)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1페이지에 퀴즈가 없고 2페이지에 퀴즈가 있는 경우 모든 페이지를 순회하여 퀴즈 정답을 올바르게 추출한다', async () => {
    const mockCheatsheet = {
      '펙수클루 적응증': '과민성 대장증후군',
      '펙수클루 특장점': '1일 3회',
    };

    const createMockResponse = (body: string, status = 200): httpClient.HttpResponse => ({
      status,
      statusText: status === 200 ? 'OK' : 'Not Found',
      body,
      headers: {},
      url: 'https://survey.villeway.com',
      redirected: false,
      resultType: status === 200 ? 'SUCCESS' : 'HTTP_ERROR',
    });

    vi.spyOn(httpClient, 'sendDoctorVilleRequest').mockImplementation(async (url: string) => {
      if (url.includes('/survey-url')) {
        return createMockResponse(
          JSON.stringify({
            surveyUrl: 'https://survey.villeway.com/s/c/testCompany/u/testSecureToken123',
          }),
        );
      }
      if (url.includes('/auth/authenticate-via-client')) {
        return createMockResponse(
          JSON.stringify({
            data: { accessToken: 'mock-access-token' },
          }),
        );
      }
      if (url.includes('/user/survey-detail')) {
        return createMockResponse(
          JSON.stringify({
            data: {
              config: { title: '2026 호흡기 증례 세미나 심화 설문조사' },
              pageCnt: 2,
              questionCnt: 5,
            },
          }),
        );
      }
      if (url.includes('/user/survey-page/1')) {
        return createMockResponse(
          JSON.stringify({
            data: {
              id: 101,
              pageNumber: 1,
              questions: [
                {
                  id: 1,
                  questionNumber: 1,
                  subject: '[퀴즈] 다음 중 펙수클루 적응증이 아닌 것은 무엇일까요?',
                  type: { key: 'QUIZ_MULTIPLE_CHOICE', nameKo: '객관식 퀴즈형' },
                  options: [
                    { id: 11, optionNumber: 1, text: '위염 치료' },
                    { id: 12, optionNumber: 2, text: '과민성 대장증후군 (IBS)' },
                  ],
                },
                {
                  id: 2,
                  questionNumber: 2,
                  subject: '[퀴즈] 펙수클루 특장점이 아닌 것은 무엇인가요?',
                  type: { key: 'QUIZ_MULTIPLE_CHOICE', nameKo: '객관식 퀴즈형' },
                  options: [
                    { id: 21, optionNumber: 1, text: '1일 3회 복용' },
                    { id: 22, optionNumber: 2, text: '식사와 무관하게 복용' },
                  ],
                },
              ],
            },
          }),
        );
      }
      if (url.includes('/user/survey-page/2')) {
        return createMockResponse(
          JSON.stringify({
            data: {
              id: 102,
              pageNumber: 2,
              questions: [
                {
                  id: 3,
                  questionNumber: 3,
                  subject: '강의에 만족하십니까?',
                  type: { key: 'MC_SELECT', nameKo: '객관식' },
                  options: [
                    { id: 31, optionNumber: 1, text: '매우 만족' },
                    { id: 32, optionNumber: 2, text: '보통' },
                  ],
                },
              ],
            },
          }),
        );
      }
      return createMockResponse('', 404);
    });

    const result = await fetchSeminarSurveyQuizHttp('5616', mockCheatsheet);

    expect(result.success).toBe(true);
    expect(result.totalPageCnt).toBe(2);
    expect(result.totalQuestionCnt).toBe(3);
    expect(result.quizQuestionCnt).toBe(2);
    expect(result.depthSurveyQuestionCnt).toBe(1); // 마지막 페이지(2페이지)의 심화설문 1문항
    expect(result.isAdvancedSurvey).toBe(true); // '심화' 포함
    expect(result.quizzes).toHaveLength(2);
    expect(result.quizzes[0].selectedIndex).toBe(2);
    expect(result.quizzes[0].selectedText).toBe('과민성 대장증후군 (IBS)');
    expect(result.quizzes[1].selectedIndex).toBe(1);
    expect(result.quizzes[1].selectedText).toBe('1일 3회 복용');
    expect(result.quizSummaryMessage).toBe('퀴즈 정답 21 + 심화1');
  });

  it('findMinimalBranchOptionIndex: 아니오/해당없음 등 분기 최소화 옵션을 올바르게 우선 선택하고, 기타는 제외한다', async () => {
    const { findMinimalBranchOptionIndex } = await import('../src/tasks/seminar_quiz');

    // Case 1: 1번 "네", 2번 "아니오" -> 2번 선택
    const options1 = [
      { index: 1, text: '네', value: '0' },
      { index: 2, text: '아니오', value: '1' },
    ];
    expect(findMinimalBranchOptionIndex(options1)).toBe(2);

    // Case 2: 1번 "예", 2번 "해당 없음" -> 2번 선택
    const options2 = [
      { index: 1, text: '예', value: '0' },
      { index: 2, text: '해당 없음', value: '1' },
    ];
    expect(findMinimalBranchOptionIndex(options2)).toBe(2);

    // Case 3: 부정 보기가 없는 경우 -> 기본 1번 선택
    const options3 = [
      { index: 1, text: '매우 만족', value: '0' },
      { index: 2, text: '보통', value: '1' },
    ];
    expect(findMinimalBranchOptionIndex(options3)).toBe(1);

    // Case 4: 1번이 "기타"이고 2번이 "만족"인 경우 -> 추가 텍스트창 방지를 위해 2번("만족") 선택
    const options4 = [
      { index: 1, text: '기타 (직접 입력)', value: '0' },
      { index: 2, text: '만족', value: '1' },
    ];
    expect(findMinimalBranchOptionIndex(options4)).toBe(2);
  });

  it('markerKind: [퀴즈] 마커가 없거나 일반 설문인 경우 지문 패턴과 무관하게 poll로 정확히 분류한다', async () => {
    const { markerKind, isQuizQuestionPattern } = await import('../src/tasks/seminar_quiz');

    // 1. [퀴즈] / [OX] / [주관식] / [QUIZ] 마커가 있는 경우 -> 'quiz'
    expect(markerKind('[퀴즈]')).toBe('quiz');
    expect(markerKind('[OX]')).toBe('quiz');
    expect(markerKind('[주관식]')).toBe('quiz');
    expect(markerKind('[QUIZ]')).toBe('quiz');

    // 2. [퀴즈] 마커가 없고 지문에 "고르시오", "아닌 것", "무엇일까요" 등이 있어도 -> 'poll' (오인식 방지)
    expect(markerKind(null)).toBe('poll');
    expect(markerKind('[설문]')).toBe('poll');
    expect(markerKind('[일반]')).toBe('poll');
    expect(markerKind(null, new Set([1, 2]), 3)).toBe('poll'); // 3번은 httpQuizQuestionNums에 없음

    // 3. HTTP API 퀴즈 번호에 포함된 경우 -> 'quiz'
    expect(markerKind(null, new Set([1, 2]), 1)).toBe('quiz');
    expect(markerKind(null, new Set([1, 2]), 2)).toBe('quiz');

    // 4. isQuizQuestionPattern 함수 동작 검증 (명시적 마커 유무)
    expect(isQuizQuestionPattern('[퀴즈] 다음 중 올바른 것은?')).toBe(true);
    expect(isQuizQuestionPattern('다음 중 가장 유익했던 강의를 고르시오')).toBe(false);
    expect(isQuizQuestionPattern('처방 시 고려하지 않는 사항은 무엇일까요?')).toBe(false);
  });

  it('다중 페이지 설문(totalPageCnt > 1)이거나 useDepthSurvey 플래그가 있는 경우 심화 설문 문항 수를 정확히 집계한다', async () => {
    const createMockResponse = (body: string, status = 200): httpClient.HttpResponse => ({
      status,
      statusText: status === 200 ? 'OK' : 'Not Found',
      body,
      headers: {},
      url: 'https://survey.villeway.com',
      redirected: false,
      resultType: status === 200 ? 'SUCCESS' : 'HTTP_ERROR',
    });

    vi.spyOn(httpClient, 'sendDoctorVilleRequest').mockImplementation(async (url: string) => {
      if (url.includes('/survey-url')) {
        return createMockResponse(
          JSON.stringify({
            surveyUrl: 'https://survey.villeway.com/s/c/testCompany/u/testSecureToken123',
          }),
        );
      }
      if (url.includes('/auth/authenticate-via-client')) {
        return createMockResponse(JSON.stringify({ data: { accessToken: 'mock-access-token' } }));
      }
      if (url.includes('/user/survey-detail')) {
        return createMockResponse(
          JSON.stringify({
            data: {
              config: { title: '일반 설문조사', useDepthSurvey: 'Y' },
              pageCnt: 2,
              questionCnt: 4,
            },
          }),
        );
      }
      if (url.includes('/user/survey-page/1')) {
        return createMockResponse(
          JSON.stringify({
            data: {
              id: 101,
              pageNumber: 1,
              questions: [
                {
                  id: 1,
                  questionNumber: 1,
                  subject: '[퀴즈] 퀴즈 문제 1',
                  type: { key: 'QUIZ_MULTIPLE_CHOICE', nameKo: '객관식 퀴즈형' },
                  options: [{ id: 11, optionNumber: 1, text: '정답1' }],
                },
              ],
            },
          }),
        );
      }
      if (url.includes('/user/survey-page/2')) {
        return createMockResponse(
          JSON.stringify({
            data: {
              id: 102,
              pageNumber: 2,
              questions: [
                {
                  id: 2,
                  questionNumber: 2,
                  subject: '심화 설문 1',
                  type: { key: 'MC_SELECT', nameKo: '객관식' },
                  options: [{ id: 21, optionNumber: 1, text: '보통' }],
                },
                {
                  id: 3,
                  questionNumber: 3,
                  subject: '심화 설문 2',
                  type: { key: 'MC_SELECT', nameKo: '객관식' },
                  options: [{ id: 31, optionNumber: 1, text: '만족' }],
                },
                {
                  id: 4,
                  questionNumber: 4,
                  subject: '심화 설문 3',
                  type: { key: 'MC_SELECT', nameKo: '객관식' },
                  options: [{ id: 41, optionNumber: 1, text: '매우 만족' }],
                },
              ],
            },
          }),
        );
      }
      return createMockResponse('', 404);
    });

    const result = await fetchSeminarSurveyQuizHttp('7777');
    expect(result.success).toBe(true);
    expect(result.isAdvancedSurvey).toBe(true);
    expect(result.quizQuestionCnt).toBe(1);
    expect(result.depthSurveyQuestionCnt).toBe(3); // 2페이지의 심화설문 3문항
    expect(result.quizSummaryMessage).toContain('심화3');
  });

  it('제목에 "만족도"가 포함되어 있어도 useDepthSurvey === "N"이고 마지막 페이지에 객관식만 있는 경우 심화설문으로 오판되지 않는다 (5716 호흡기 증례강의 케이스)', async () => {
    const mockCheatsheet = {
      '호흡기 증례 퀴즈 1': '정답4',
      '호흡기 증례 퀴즈 2': '정답1',
      '호흡기 증례 퀴즈 3': '정답2',
    };

    const createMockResponse = (body: string, status = 200): httpClient.HttpResponse => ({
      status,
      statusText: status === 200 ? 'OK' : 'Not Found',
      body,
      headers: {},
      url: 'https://survey.villeway.com',
      redirected: false,
      resultType: status === 200 ? 'SUCCESS' : 'HTTP_ERROR',
    });

    vi.spyOn(httpClient, 'sendDoctorVilleRequest').mockImplementation(async (url: string) => {
      if (url.includes('/survey-url')) {
        return createMockResponse(JSON.stringify({ surveyUrl: 'https://survey.villeway.com/s/c/test/u/token5716' }));
      }
      if (url.includes('/auth/authenticate-via-client')) {
        return createMockResponse(JSON.stringify({ data: { accessToken: 'token-5716' } }));
      }
      if (url.includes('/user/survey-detail')) {
        return createMockResponse(
          JSON.stringify({
            data: {
              config: { title: '호흡기내과 증례강의 만족도 설문', useDepthSurvey: 'N' },
              pageCnt: 2,
              questionCnt: 14,
            },
          }),
        );
      }
      if (url.includes('/user/survey-page/1')) {
        return createMockResponse(
          JSON.stringify({
            data: {
              questions: [
                {
                  id: 1,
                  questionNumber: 1,
                  subject: '[퀴즈] 호흡기 증례 퀴즈 1',
                  type: { key: 'QUIZ_MULTIPLE_CHOICE' },
                  options: [
                    { id: 11, text: '오답' },
                    { id: 12, text: '오답' },
                    { id: 13, text: '오답' },
                    { id: 14, text: '정답4' },
                  ],
                },
                {
                  id: 2,
                  questionNumber: 2,
                  subject: '[퀴즈] 호흡기 증례 퀴즈 2',
                  type: { key: 'QUIZ_MULTIPLE_CHOICE' },
                  options: [
                    { id: 21, text: '정답1' },
                    { id: 22, text: '오답' },
                  ],
                },
                {
                  id: 3,
                  questionNumber: 3,
                  subject: '[퀴즈] 호흡기 증례 퀴즈 3',
                  type: { key: 'QUIZ_MULTIPLE_CHOICE' },
                  options: [
                    { id: 31, text: '오답' },
                    { id: 32, text: '정답2' },
                  ],
                },
              ],
            },
          }),
        );
      }
      if (url.includes('/user/survey-page/2')) {
        // 2페이지: 객관식 문항 11개
        return createMockResponse(
          JSON.stringify({
            data: {
              questions: Array.from({ length: 11 }, (_, i) => ({
                id: 10 + i,
                questionNumber: 4 + i,
                subject: `강의 평가 문항 ${i + 1}`,
                type: { key: 'MC_SELECT', nameKo: '객관식' },
                options: [
                  { id: 100 + i * 2, text: '매우 만족' },
                  { id: 101 + i * 2, text: '만족' },
                ],
              })),
            },
          }),
        );
      }
      return createMockResponse('', 404);
    });

    const result = await fetchSeminarSurveyQuizHttp('5716', mockCheatsheet);
    expect(result.success).toBe(true);
    expect(result.isAdvancedSurvey).toBe(false); // 만족도가 있어도 useDepthSurvey: 'N'이므로 심화설문 아님!
    expect(result.isSuspectedAdvancedSurvey).toBe(false); // 주관식이 없으므로 의심도 아님!
    expect(result.quizQuestionCnt).toBe(3);
    expect(result.quizSummaryMessage).toBe('퀴즈 정답 412'); // + 심화11 이 붙지 않아야 함!
  });

  it('useDepthSurvey === "N"이지만 마지막 페이지에 주관식 문항이 1~3개 있으면 "심화설문?"으로 표시되고, 4개 이상이면 표시되지 않는다', async () => {
    const mockCheatsheet = {
      '단일 퀴즈 문항': '정답1',
    };

    const createMockResponse = (body: string, status = 200): httpClient.HttpResponse => ({
      status,
      statusText: status === 200 ? 'OK' : 'Not Found',
      body,
      headers: {},
      url: 'https://survey.villeway.com',
      redirected: false,
      resultType: status === 200 ? 'SUCCESS' : 'HTTP_ERROR',
    });

    vi.spyOn(httpClient, 'sendDoctorVilleRequest').mockImplementation(async (url: string) => {
      if (url.includes('/survey-url')) {
        return createMockResponse(JSON.stringify({ surveyUrl: 'https://survey.villeway.com/s/c/test/u/token8888' }));
      }
      if (url.includes('/auth/authenticate-via-client')) {
        return createMockResponse(JSON.stringify({ data: { accessToken: 'token-8888' } }));
      }
      if (url.includes('/user/survey-detail')) {
        return createMockResponse(
          JSON.stringify({
            data: {
              config: { title: '일반 강의 설문', useDepthSurvey: 'N' },
              pageCnt: 2,
              questionCnt: 4,
            },
          }),
        );
      }
      if (url.includes('/user/survey-page/1')) {
        return createMockResponse(
          JSON.stringify({
            data: {
              questions: [
                {
                  id: 1,
                  questionNumber: 1,
                  subject: '[퀴즈] 단일 퀴즈 문항',
                  type: { key: 'QUIZ_MULTIPLE_CHOICE' },
                  options: [{ id: 11, text: '정답1' }],
                },
              ],
            },
          }),
        );
      }
      if (url.includes('/user/survey-page/2')) {
        // 2페이지: 주관식 3개 (1~3개 범위 내)
        return createMockResponse(
          JSON.stringify({
            data: {
              questions: [
                {
                  id: 2,
                  questionNumber: 2,
                  subject: '강사님께 전달하고 싶은 의견 1',
                  type: { key: 'TEXT', nameKo: '주관식 서술형' },
                  options: [],
                },
                {
                  id: 3,
                  questionNumber: 3,
                  subject: '강사님께 전달하고 싶은 의견 2',
                  type: { key: 'TEXT', nameKo: '주관식 서술형' },
                  options: [],
                },
                {
                  id: 4,
                  questionNumber: 4,
                  subject: '강사님께 전달하고 싶은 의견 3',
                  type: { key: 'TEXT', nameKo: '주관식 서술형' },
                  options: [],
                },
              ],
            },
          }),
        );
      }
      return createMockResponse('', 404);
    });

    const result = await fetchSeminarSurveyQuizHttp('8888', mockCheatsheet);
    expect(result.success).toBe(true);
    expect(result.isAdvancedSurvey).toBe(false);
    expect(result.isSuspectedAdvancedSurvey).toBe(true); // 마지막 페이지 주관식 3개 (1~3개 범위, 객관식 없음)
    expect(result.quizSummaryMessage).toBe('퀴즈 정답 1 + 심화설문?');
  });

  it('useDepthSurvey === "N"이고 마지막 페이지에 주관식이 1~3개 있더라도, 객관식이 함께 포함되어 있으면 "심화설문?"으로 분류되지 않는다', async () => {
    const mockCheatsheet = {
      '단일 퀴즈 문항': '정답1',
    };

    const createMockResponse = (body: string, status = 200): httpClient.HttpResponse => ({
      status,
      statusText: status === 200 ? 'OK' : 'Not Found',
      body,
      headers: {},
      url: 'https://survey.villeway.com',
      redirected: false,
      resultType: status === 200 ? 'SUCCESS' : 'HTTP_ERROR',
    });

    vi.spyOn(httpClient, 'sendDoctorVilleRequest').mockImplementation(async (url: string) => {
      if (url.includes('/survey-url')) {
        return createMockResponse(JSON.stringify({ surveyUrl: 'https://survey.villeway.com/s/c/test/u/token7777' }));
      }
      if (url.includes('/auth/authenticate-via-client')) {
        return createMockResponse(JSON.stringify({ data: { accessToken: 'token-7777' } }));
      }
      if (url.includes('/user/survey-detail')) {
        return createMockResponse(
          JSON.stringify({
            data: {
              config: { title: '일반 강의 설문', useDepthSurvey: 'N' },
              pageCnt: 2,
              questionCnt: 3,
            },
          }),
        );
      }
      if (url.includes('/user/survey-page/1')) {
        return createMockResponse(
          JSON.stringify({
            data: {
              questions: [
                {
                  id: 1,
                  questionNumber: 1,
                  subject: '[퀴즈] 단일 퀴즈 문항',
                  type: { key: 'QUIZ_MULTIPLE_CHOICE' },
                  options: [{ id: 11, text: '정답1' }],
                },
              ],
            },
          }),
        );
      }
      if (url.includes('/user/survey-page/2')) {
        // 2페이지: 객관식 1개 + 주관식 1개 -> 객관식이 포함되어 있으므로 심화설문 의심(심화설문?)이 아니어야 함!
        return createMockResponse(
          JSON.stringify({
            data: {
              questions: [
                {
                  id: 2,
                  questionNumber: 2,
                  subject: '강의 만족도는 어떠셨나요?',
                  type: { key: 'SINGLE_CHOICE', nameKo: '객관식' },
                  options: [
                    { id: 21, text: '매우 만족' },
                    { id: 22, text: '보통' },
                  ],
                },
                {
                  id: 3,
                  questionNumber: 3,
                  subject: '강사님께 전달하고 싶은 의견',
                  type: { key: 'TEXT', nameKo: '주관식 서술형' },
                  options: [],
                },
              ],
            },
          }),
        );
      }
      return createMockResponse('', 404);
    });

    const result = await fetchSeminarSurveyQuizHttp('7777', mockCheatsheet);
    expect(result.success).toBe(true);
    expect(result.isAdvancedSurvey).toBe(false);
    expect(result.isSuspectedAdvancedSurvey).toBe(false); // 마지막 페이지에 객관식이 있으므로 의심 대상 제외!
    expect(result.quizSummaryMessage).toBe('퀴즈 정답 1'); // + 심화설문? 이 붙지 않아야 함!
  });
});
