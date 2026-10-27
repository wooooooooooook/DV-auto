import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Page } from 'playwright';
import { processSeminarQuiz } from '../src/tasks/seminar_quiz';
import * as utilsModule from '../src/modules/utils';
import { drainLlmQueue } from '../src/services/llm_queue';

describe('seminar_quiz 다중 페이지 탐색 및 제출하기 감지 테스트', () => {
  let sendTelegramSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    sendTelegramSpy = vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * 1페이지(다음 버튼) -> 2페이지(제출하기 버튼) 다중 페이지 동작을 시뮬레이션하는 mock Page 생성
   */
  function createMultiPageMock() {
    let currentPageNum = 1;
    const clickedButtons: string[] = [];

    const mockPage: Partial<Page> = {
      url: vi.fn().mockImplementation(() => `https://m.doctorville.co.kr/cme/seminar/test/page${currentPageNum}`),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(null),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      waitForURL: vi.fn().mockResolvedValue(true),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
      on: vi.fn(),
      getByRole: vi.fn().mockReturnValue({
        first: vi.fn().mockReturnValue({
          isVisible: vi.fn().mockResolvedValue(true),
          click: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      locator: vi.fn().mockImplementation((selector: string) => {
        const createLocatorObj = (opts: { isNext?: boolean; isSubmit?: boolean }) => ({
          first: vi.fn().mockReturnValue({
            isVisible: vi.fn().mockImplementation(async () => {
              if (opts.isNext) return currentPageNum === 1;
              if (opts.isSubmit) return currentPageNum === 2;
              return false;
            }),
            waitFor: vi.fn().mockResolvedValue(undefined),
            scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
            click: vi.fn().mockImplementation(async () => {
              if (opts.isNext) {
                clickedButtons.push('next');
                currentPageNum = 2;
              }
              if (opts.isSubmit) {
                clickedButtons.push('submit');
              }
            }),
            count: vi.fn().mockResolvedValue(0),
            check: vi.fn().mockResolvedValue(undefined),
            locator: vi.fn().mockImplementation(() => createLocatorObj({})),
          }),
          count: vi.fn().mockResolvedValue(0),
          all: vi.fn().mockResolvedValue([]),
          locator: vi.fn().mockImplementation(() => createLocatorObj({})),
          filter: vi.fn().mockReturnValue({
            first: vi.fn().mockReturnValue({
              isVisible: vi.fn().mockResolvedValue(false),
              click: vi.fn().mockResolvedValue(undefined),
            }),
          }),
        });

        // [다음] 버튼 locator
        if (selector.includes('btn-next') || selector.includes('다음') || selector.includes('Next')) {
          return createLocatorObj({ isNext: true });
        }

        // [제출하기] 버튼 locator
        if (
          selector.includes('btn-primary') ||
          selector.includes('제출하기') ||
          selector.includes('설문완료') ||
          selector.includes('응답완료')
        ) {
          return createLocatorObj({ isSubmit: true });
        }

        return createLocatorObj({});
      }),
      evaluate: vi.fn().mockImplementation(async () => {
        // 1페이지 문항 (퀴즈 2개)
        if (currentPageNum === 1) {
          return [
            {
              questionNumber: 1,
              questionLine: '[퀴즈] 골다공증 치료 가이드라인 데노수맙 투여 대상은?',
              marker: '[퀴즈]',
              isRequired: true,
              inputType: 'radio',
              options: [
                { index: 1, text: '골절 고위험군', value: '1' },
                { index: 2, text: '정상군', value: '2' },
              ],
            },
            {
              questionNumber: 2,
              questionLine: '[퀴즈] 바이오시밀러의 특징은?',
              marker: '[퀴즈]',
              isRequired: true,
              inputType: 'radio',
              options: [
                { index: 1, text: '임상 불필요', value: '1' },
                { index: 2, text: '동등성 입증 불필요', value: '2' },
                { index: 3, text: '1상 임상을 통한 PK/PD 동등성 입증', value: '3' },
              ],
            },
          ];
        }
        // 2페이지 문항 (심화 설문 2개)
        return [
          {
            questionNumber: 3,
            questionLine: '강의 내용에 만족하십니까?',
            marker: null,
            isRequired: true,
            inputType: 'radio',
            options: [
              { index: 1, text: '매우 만족', value: '1' },
              { index: 2, text: '보통', value: '2' },
            ],
          },
          {
            questionNumber: 4,
            questionLine: '향후 추가 희망 주제가 있으십니까?',
            marker: null,
            isRequired: false,
            inputType: 'radio',
            options: [
              { index: 1, text: '해당 없음', value: '1' },
              { index: 2, text: '있음', value: '2' },
            ],
          },
        ];
      }),
    };

    return { mockPage: mockPage as Page, clickedButtons, getCurrentPage: () => currentPageNum };
  }

  it('심화설문: 1페이지에서 [다음] 클릭 -> 2페이지에서 [제출하기] 감지 시 루프 탈출하고 제출하기를 클릭하지 않는다', async () => {
    const { mockPage, clickedButtons, getCurrentPage } = createMultiPageMock();

    const cheatsheet = {
      데노수맙: '골절 고위험군',
      바이오시밀러: 'PK/PD',
    };
    vi.spyOn(await import('../src/tasks/seminar_quiz'), 'loadCheatsheet').mockResolvedValue(cheatsheet);

    const surveyApiModule = await import('../src/modules/seminar_survey_api');
    vi.spyOn(surveyApiModule, 'fetchSeminarSurveyQuizHttp').mockResolvedValue({
      success: true,
      seminarId: '5642',
      totalPageCnt: 2,
      totalQuestionCnt: 4,
      quizQuestionCnt: 2,
      depthSurveyQuestionCnt: 2,
      isAdvancedSurvey: true,
      quizzes: [],
      allQuestions: [],
      quizSummaryMessage: '퀴즈 정답 13 + 심화2',
    });

    const originalFetch = globalThis.fetch;
    let hermesFetchCalled = false;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('hermes:20128')) {
        hermesFetchCalled = true;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [
              {
                message: {
                  content:
                    'Q1: 10년 차 로컬의원 입장에서 강의 내용이 매우 유익했스빈다.\nQ2: 다음에는 부작용 관리 주제를 희망합니다.',
                },
              },
            ],
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });

    const result = await processSeminarQuiz(mockPage, '5642', true);
    // AI 추천 답변 발송은 백그라운드 큐에서 처리되므로 완료될 때까지 대기한다
    await drainLlmQueue();
    globalThis.fetch = originalFetch;

    expect(result.success).toBe(true);
    expect(result.hasQuizResult).toBe(true);
    expect(result.message).not.toContain('심화설문으로 자동 제출이 제외되었습니다');

    // 1페이지에서 [다음]을 눌러 2페이지에 도달했는지 확인
    expect(clickedButtons).toContain('next');
    expect(getCurrentPage()).toBe(2);

    // 심화설문이므로 [제출하기] 버튼은 클릭되지 않아야 함
    expect(clickedButtons).not.toContain('submit');

    // 텔레그램 심화설문 프롬프트 알림, AI 답변 알림, 미등록 퀴즈 알림, 미등록 퀴즈 AI 답변 전송 확인 (총 4회)
    // AI 답변은 백그라운드 큐에서 발송되므로 전송 순서 대신 내용으로 찾는다
    const findMsg = (marker: string): string => {
      const call = sendTelegramSpy.mock.calls.find((c) => String(c[0]).includes(marker));
      return String(call?.[0] ?? '');
    };
    const findOptions = (marker: string): Record<string, unknown> | undefined => {
      const call = sendTelegramSpy.mock.calls.find((c) => String(c[0]).includes(marker));
      return call?.[2] as Record<string, unknown> | undefined;
    };

    expect(sendTelegramSpy).toHaveBeenCalledTimes(4);
    const noticeMarker = '[심화설문] 퀴즈 정답 추출 완료 (자동 제출 제외)';
    const sentMsg1 = findMsg(noticeMarker);
    expect(sentMsg1).toContain(noticeMarker);
    expect(sentMsg1).toContain('<pre><code class="language-text">');
    expect(sentMsg1).toContain('10년 차 로컬의원');
    expect(sentMsg1).toContain('강의 내용에 만족하십니까?');
    expect(sentMsg1).toContain('향후 추가 희망 주제가 있으십니까?');
    expect(findOptions(noticeMarker)?.parse_mode).toBe('HTML');

    expect(hermesFetchCalled).toBe(true);
    const sentMsg2 = findMsg('[심화설문 AI 추천 답변]');
    expect(sentMsg2).toContain('[심화설문 AI 추천 답변]');
    expect(sentMsg2).toContain('10년 차 로컬의원 입장에서 강의 내용이 매우 유익했스빈다');
    expect(findOptions('[심화설문 AI 추천 답변]')?.parse_mode).toBe('HTML');

    expect(findMsg('족보에 없는 퀴즈')).toContain('족보에 없는 퀴즈');

    expect(findMsg('[미등록 퀴즈 AI 추천 정답]')).toContain('[미등록 퀴즈 AI 추천 정답]');
  });

  it('일반설문: 1페이지에서 [다음] 클릭 -> 2페이지에서 [제출하기] 감지 시 루프 탈출 후 [제출하기]를 클릭한다', async () => {
    const { mockPage, clickedButtons, getCurrentPage } = createMultiPageMock();

    const cheatsheet = {
      데노수맙: '골절 고위험군',
      바이오시밀러: 'PK/PD',
    };
    vi.spyOn(await import('../src/tasks/seminar_quiz'), 'loadCheatsheet').mockResolvedValue(cheatsheet);

    const surveyApiModule = await import('../src/modules/seminar_survey_api');
    vi.spyOn(surveyApiModule, 'fetchSeminarSurveyQuizHttp').mockResolvedValue({
      success: true,
      seminarId: '9999',
      totalPageCnt: 2,
      totalQuestionCnt: 4,
      quizQuestionCnt: 2,
      depthSurveyQuestionCnt: 0,
      isAdvancedSurvey: false,
      quizzes: [],
      allQuestions: [],
      quizSummaryMessage: '퀴즈 정답 13',
    });

    const result = await processSeminarQuiz(mockPage, '9999', false, false, cheatsheet);
    // 백그라운드 큐에 남은 AI 작업이 있을 수 있으므로 종료 전에 비운다
    await drainLlmQueue();

    expect(result.success).toBe(true);
    expect(result.hasQuizResult).toBe(true);
    expect(result.message).not.toContain('심화설문으로 자동 제출이 제외되었습니다');

    // 1페이지에서 [다음] 클릭하여 2페이지 도달
    expect(clickedButtons).toContain('next');
    expect(getCurrentPage()).toBe(2);

    // 일반설문이므로 루프 종료 후 [제출하기] 클릭 확인
    expect(clickedButtons).toContain('submit');

    // 텔레그램 알림 확인
    expect(sendTelegramSpy).toHaveBeenCalled();
    const sentMsg = sendTelegramSpy.mock.calls[0]?.[0] as string;
    expect(sentMsg).toContain('설문 제출');
  });

  it('심화설문 의심(심화설문?): 퀴즈가 없어도 자동 제출하지 않고 주관식 문항 프롬프트를 전송한다', async () => {
    const clickedButtons: string[] = [];

    const mockPage: Partial<Page> = {
      url: vi.fn().mockReturnValue('https://m.doctorville.co.kr/cme/seminar/5814'),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(null),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
      on: vi.fn(),
      getByRole: vi.fn().mockReturnValue({
        first: vi.fn().mockReturnValue({
          isVisible: vi.fn().mockResolvedValue(false),
          click: vi.fn().mockResolvedValue(undefined),
        }),
      }),
      locator: vi.fn().mockImplementation((selector: string) => {
        const createLocatorObj = (opts: { isSubmit?: boolean } = {}) => ({
          first: vi.fn().mockReturnValue({
            isVisible: vi.fn().mockImplementation(async () => Boolean(opts.isSubmit)),
            waitFor: vi.fn().mockResolvedValue(undefined),
            scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
            click: vi.fn().mockImplementation(async () => {
              if (opts.isSubmit) clickedButtons.push('submit');
            }),
            count: vi.fn().mockResolvedValue(0),
            check: vi.fn().mockResolvedValue(undefined),
            locator: vi.fn().mockImplementation(() => createLocatorObj()),
          }),
          count: vi.fn().mockResolvedValue(0),
          all: vi.fn().mockResolvedValue([]),
          locator: vi.fn().mockImplementation(() => createLocatorObj()),
        });

        if (
          selector.includes('btn-primary') ||
          selector.includes('제출하기') ||
          selector.includes('설문완료') ||
          selector.includes('응답완료')
        ) {
          return createLocatorObj({ isSubmit: true });
        }
        return createLocatorObj();
      }),
      // 단일 페이지: 일반 설문 1문항 + 주관식 2문항 (퀴즈 없음)
      evaluate: vi.fn().mockResolvedValue([
        {
          questionNumber: 1,
          questionLine: '세미나에 대한 전반적인 만족도는?',
          marker: null,
          isRequired: true,
          inputType: 'radio',
          options: [
            { index: 1, text: '매우 만족', value: '1' },
            { index: 2, text: '보통', value: '2' },
          ],
        },
        {
          questionNumber: 2,
          questionLine: '강사님께 전달하고 싶은 의견을 적어주세요.',
          marker: null,
          isRequired: false,
          inputType: 'text',
          options: [{ index: 1, text: '[주관식]', value: '' }],
        },
        {
          questionNumber: 3,
          questionLine: '향후 다루었으면 하는 주제는?',
          marker: null,
          isRequired: false,
          inputType: 'text',
          options: [{ index: 1, text: '[주관식]', value: '' }],
        },
      ]),
    };

    vi.spyOn(await import('../src/tasks/seminar_quiz'), 'loadCheatsheet').mockResolvedValue({});

    const surveyApiModule = await import('../src/modules/seminar_survey_api');
    vi.spyOn(surveyApiModule, 'fetchSeminarSurveyQuizHttp').mockResolvedValue({
      success: true,
      seminarId: '5814',
      totalPageCnt: 2,
      totalQuestionCnt: 4,
      quizQuestionCnt: 0,
      depthSurveyQuestionCnt: 0,
      isAdvancedSurvey: false,
      isSuspectedAdvancedSurvey: true,
      quizzes: [],
      allQuestions: [],
      quizSummaryMessage: '심화설문?',
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('hermes:20128')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: 'Q2: 강의 내용이 임상에 도움이 되었스빈다.' } }],
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });

    const result = await processSeminarQuiz(mockPage as Page, '5814', false);
    await drainLlmQueue();
    globalThis.fetch = originalFetch;

    expect(result.success).toBe(true);
    expect(result.hasQuizResult).toBe(false);
    expect(result.message).toContain('심화설문?');

    // 심화설문 의심이므로 [제출하기] 버튼은 클릭되지 않아야 함
    expect(clickedButtons).not.toContain('submit');

    const findMsg = (marker: string): string => {
      const call = sendTelegramSpy.mock.calls.find((c) => String(c[0]).includes(marker));
      return String(call?.[0] ?? '');
    };

    const sentMsg = findMsg('[심화설문?] 퀴즈 정답 추출 완료 (자동 제출 제외)');
    expect(sentMsg).toContain('[심화설문?] 퀴즈 정답 추출 완료 (자동 제출 제외)');
    expect(sentMsg).toContain('심화설문?');
    // 의심 케이스 프롬프트는 주관식 문항만 포함한다
    expect(sentMsg).toContain('강사님께 전달하고 싶은 의견을 적어주세요.');
    expect(sentMsg).toContain('향후 다루었으면 하는 주제는?');
    expect(sentMsg).not.toContain('세미나에 대한 전반적인 만족도는?');

    expect(findMsg('[심화설문? AI 추천 답변]')).toContain('[심화설문? AI 추천 답변]');
  });

  it('동일 페이지가 재탐색되거나 퀴즈 문항이 중복 파싱되더라도 채널 결과와 족보 미등록 알림에서 중복되지 않는다', async () => {
    let callCount = 0;
    const clickedButtons: string[] = [];

    // 1페이지가 2번 evaluate 된 후(페이지 전환 지연 시뮬레이션), 2페이지(심화설문)로 이동
    const mockPage: Partial<Page> = {
      url: vi.fn().mockImplementation(() => `https://m.doctorville.co.kr/cme/seminar/5808`),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      waitForSelector: vi.fn().mockResolvedValue(null),
      waitForFunction: vi.fn().mockResolvedValue(undefined),
      screenshot: vi.fn().mockResolvedValue(Buffer.from('fake-screenshot')),
      on: vi.fn(),
      locator: vi.fn().mockImplementation((selector: string) => {
        const createLocatorObj = (opts: { isNext?: boolean; isSubmit?: boolean }) => ({
          first: vi.fn().mockReturnValue({
            isVisible: vi.fn().mockImplementation(async () => {
              if (opts.isNext) return callCount < 2; // 처음 2회는 다음 버튼 노출
              if (opts.isSubmit) return callCount >= 2; // 이후 제출 버튼 노출
              return false;
            }),
            waitFor: vi.fn().mockResolvedValue(undefined),
            scrollIntoViewIfNeeded: vi.fn().mockResolvedValue(undefined),
            click: vi.fn().mockImplementation(async () => {
              if (opts.isNext) {
                clickedButtons.push('next');
              }
              if (opts.isSubmit) {
                clickedButtons.push('submit');
              }
            }),
            count: vi.fn().mockResolvedValue(0),
            check: vi.fn().mockResolvedValue(undefined),
            locator: vi.fn().mockImplementation(() => createLocatorObj({})),
          }),
          count: vi.fn().mockResolvedValue(0),
          all: vi.fn().mockResolvedValue([]),
          locator: vi.fn().mockImplementation(() => createLocatorObj({})),
        });

        if (selector.includes('btn-next') || selector.includes('다음') || selector.includes('Next')) {
          return createLocatorObj({ isNext: true });
        }
        if (selector.includes('btn-primary') || selector.includes('제출')) {
          return createLocatorObj({ isSubmit: true });
        }
        return createLocatorObj({});
      }),
      evaluate: vi.fn().mockImplementation(async () => {
        callCount++;
        // 1~2번째 호출에서는 동일한 퀴즈 3문항 (족보 미등록) 반환
        if (callCount <= 2) {
          return [
            {
              questionNumber: 1,
              questionLine: '[퀴즈] 다음 중 코그테라의 핵심 메시지가 아닌 것은?',
              marker: '[퀴즈]',
              isRequired: true,
              inputType: 'radio',
              options: [
                { index: 1, text: '옵션1', value: '1' },
                { index: 2, text: '옵션2', value: '2' },
              ],
            },
            {
              questionNumber: 2,
              questionLine: '[퀴즈] 코그테라의 식약처 허가 사용 대상으로 알맞은 것은?',
              marker: '[퀴즈]',
              isRequired: true,
              inputType: 'radio',
              options: [
                { index: 1, text: '옵션1', value: '1' },
                { index: 2, text: '옵션2', value: '2' },
              ],
            },
            {
              questionNumber: 3,
              questionLine: '[퀴즈] 다음 중 코그테라 훈련의 핵심 원리로 알맞은 것은?',
              marker: '[퀴즈]',
              isRequired: true,
              inputType: 'radio',
              options: [
                { index: 1, text: '옵션1', value: '1' },
                { index: 2, text: '옵션2', value: '2' },
              ],
            },
          ];
        }
        // 3번째 호출에서는 2페이지 심화설문 1문항 반환
        return [
          {
            questionNumber: 9,
            questionLine: '경도인지장애 디지털치료기기는...',
            marker: null,
            isRequired: true,
            inputType: 'text',
            options: [{ index: 1, text: '[주관식]', value: '' }],
          },
        ];
      }),
    };

    // 족보에는 해당 퀴즈가 등록되어 있지 않음
    vi.spyOn(await import('../src/tasks/seminar_quiz'), 'loadCheatsheet').mockResolvedValue({});

    const surveyApiModule = await import('../src/modules/seminar_survey_api');
    vi.spyOn(surveyApiModule, 'fetchSeminarSurveyQuizHttp').mockResolvedValue({
      success: true,
      seminarId: '5808',
      totalPageCnt: 2,
      totalQuestionCnt: 4,
      quizQuestionCnt: 3,
      depthSurveyQuestionCnt: 1,
      isAdvancedSurvey: true,
      quizzes: [],
      allQuestions: [],
      quizSummaryMessage: '',
    });

    const result = await processSeminarQuiz(mockPage as Page, '5808', true);
    await drainLlmQueue();

    expect(result.success).toBe(true);
    // 퀴즈 결과 메시지에 Q1, Q2, Q3이 각각 1회만 존재해야 함 (총 3문항)
    const matchesQ1 = result.message.match(/Q1:/g) || [];
    const matchesQ2 = result.message.match(/Q2:/g) || [];
    const matchesQ3 = result.message.match(/Q3:/g) || [];
    expect(matchesQ1.length).toBe(1);
    expect(matchesQ2.length).toBe(1);
    expect(matchesQ3.length).toBe(1);
    // 퀴즈 정답 요약은 '-' 3개 (---) + 심화1 이어야 함 (------ 가 아님)
    expect(result.message).toContain('정답 --- + 심화1');

    // '족보에 없는 퀴즈' 알림 메시지에서도 Q1, Q2, Q3이 각각 1회만 존재해야 함
    const unknownCall = sendTelegramSpy.mock.calls.find((c) => String(c[0]).includes('족보에 없는 퀴즈'));
    const unknownText = String(unknownCall?.[0] ?? '');
    expect(unknownText.match(/Q1:/g)?.length).toBe(1);
    expect(unknownText.match(/Q2:/g)?.length).toBe(1);
    expect(unknownText.match(/Q3:/g)?.length).toBe(1);
  });

  it('미해결 퀴즈가 있는 일반설문 (HTTP API 사전 파악): 1페이지 후 페이지 이동을 즉시 중단하고 제출하기를 클릭하지 않은 채 제출 보류 알림을 전송한다', async () => {
    const { mockPage, clickedButtons, getCurrentPage } = createMultiPageMock();

    const surveyApiModule = await import('../src/modules/seminar_survey_api');
    vi.spyOn(surveyApiModule, 'fetchSeminarSurveyQuizHttp').mockResolvedValue({
      success: true,
      seminarId: '5817',
      totalPageCnt: 2,
      totalQuestionCnt: 4,
      quizQuestionCnt: 2,
      depthSurveyQuestionCnt: 0,
      isAdvancedSurvey: false,
      quizzes: [
        {
          questionNumber: 1,
          questionText: '[퀴즈] 알로푸리놀은 처방하기 전...',
          options: [
            { index: 1, text: 'O' },
            { index: 2, text: 'X' },
          ],
          selectedIndex: 1,
          selectedText: 'O',
          matchedKeyword: '알로푸리놀',
        },
        {
          questionNumber: 2,
          questionText: '[퀴즈] 페브릭 40mg은 1 정당...',
          options: [
            { index: 1, text: '하루 5원' },
            { index: 2, text: '하루 10원' },
          ],
          selectedIndex: null,
          selectedText: null,
          matchedKeyword: null,
        },
      ],
      allQuestions: [],
      quizSummaryMessage: '퀴즈 정답 1- (일부 미해결)',
    });

    const result = await processSeminarQuiz(mockPage, '5817', false, false, {});
    await drainLlmQueue();

    expect(result.success).toBe(true);

    // API를 통해 이미 모든 문제를 알고 있고 미해결 퀴즈가 있으므로 [다음] 버튼 클릭 중단 확인
    expect(clickedButtons).not.toContain('next');
    expect(getCurrentPage()).toBe(1);

    // [제출하기] 버튼은 절대 클릭되지 않아야 함
    expect(clickedButtons).not.toContain('submit');

    // 보류 알림 발송 확인
    const pendingCall = sendTelegramSpy.mock.calls.find((c) =>
      String(c[0]).includes('[일부 미해결] 퀴즈 정답 미등록으로 설문 제출 보류'),
    );
    expect(pendingCall).toBeDefined();
    expect(String(pendingCall?.[0])).toContain('https://m.doctorville.co.kr/cme/seminar/5817');

    // 미등록 퀴즈 알림 발송 확인
    const unknownCall = sendTelegramSpy.mock.calls.find((c) => String(c[0]).includes('족보에 없는 퀴즈'));
    expect(unknownCall).toBeDefined();
  });

  it('미해결 퀴즈가 있는 일반설문 (HTTP API 미제공 fallback): 2페이지까지 탐색하되 최종 제출하기는 클릭하지 않고 제출 보류 알림을 전송한다', async () => {
    const { mockPage, clickedButtons, getCurrentPage } = createMultiPageMock();

    const surveyApiModule = await import('../src/modules/seminar_survey_api');
    // HTTP 조회가 실패하여 UI로 탐색해야 하는 상황
    vi.spyOn(surveyApiModule, 'fetchSeminarSurveyQuizHttp').mockResolvedValue({
      success: false,
      error: 'HTTP 조회 불가',
      seminarId: '5817',
      totalPageCnt: 0,
      totalQuestionCnt: 0,
      quizQuestionCnt: 0,
      depthSurveyQuestionCnt: 0,
      isAdvancedSurvey: false,
      quizzes: [],
      allQuestions: [],
      quizSummaryMessage: '',
    });

    // cheatsheet에 등록되지 않아 UI 파싱에서 _hasUnknown = true
    const result = await processSeminarQuiz(mockPage, '5817', false, false, {});
    await drainLlmQueue();

    expect(result.success).toBe(true);

    // 다음 페이지 내용을 봐야 하므로 [다음] 버튼을 눌러 2페이지까지 탐색함
    expect(clickedButtons).toContain('next');
    expect(getCurrentPage()).toBe(2);

    // 하지만 미해결 퀴즈가 있으므로 최종 [제출하기] 버튼은 절대 클릭하지 않음
    expect(clickedButtons).not.toContain('submit');

    // 보류 알림 발송 확인
    const pendingCall = sendTelegramSpy.mock.calls.find((c) =>
      String(c[0]).includes('[일부 미해결] 퀴즈 정답 미등록으로 설문 제출 보류'),
    );
    expect(pendingCall).toBeDefined();

    // 미등록 퀴즈 알림 발송 확인
    const unknownCall = sendTelegramSpy.mock.calls.find((c) => String(c[0]).includes('족보에 없는 퀴즈'));
    expect(unknownCall).toBeDefined();
  });
});
