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
                  subject: '강의에 만족하십니까?',
                  type: { key: 'MC_SELECT', nameKo: '객관식' },
                  options: [
                    { id: 11, optionNumber: 1, text: '매우 만족' },
                    { id: 12, optionNumber: 2, text: '보통' },
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
                  id: 2,
                  questionNumber: 2,
                  subject: '[퀴즈] 다음 중 펙수클루 적응증이 아닌 것은 무엇일까요?',
                  type: { key: 'QUIZ_MULTIPLE_CHOICE', nameKo: '객관식 퀴즈형' },
                  options: [
                    { id: 21, optionNumber: 1, text: '위염 치료' },
                    { id: 22, optionNumber: 2, text: '과민성 대장증후군 (IBS)' },
                  ],
                },
                {
                  id: 3,
                  questionNumber: 3,
                  subject: '펙수클루 특장점이 아닌 것은 무엇인가요?',
                  type: { key: 'QUIZ_MULTIPLE_CHOICE', nameKo: '객관식 퀴즈형' },
                  options: [
                    { id: 31, optionNumber: 1, text: '1일 3회 복용' },
                    { id: 32, optionNumber: 2, text: '식사와 무관하게 복용' },
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
    expect(result.isAdvancedSurvey).toBe(true); // '심화' 포함
    expect(result.quizzes).toHaveLength(2);
    expect(result.quizzes[0].selectedIndex).toBe(2);
    expect(result.quizzes[0].selectedText).toBe('과민성 대장증후군 (IBS)');
    expect(result.quizzes[1].selectedIndex).toBe(1);
    expect(result.quizzes[1].selectedText).toBe('1일 3회 복용');
    expect(result.quizSummaryMessage).toBe('퀴즈 정답 21');
  });

  it('findMinimalBranchOptionIndex: 아니오/해당없음/기타 등 분기 최소화 옵션을 올바르게 우선 선택한다', async () => {
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
  });
});
