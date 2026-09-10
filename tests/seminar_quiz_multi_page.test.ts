import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Page } from 'playwright';
import { processSeminarQuiz } from '../src/tasks/seminar_quiz';
import * as utilsModule from '../src/modules/utils';

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

    const result = await processSeminarQuiz(mockPage, '5642', true);

    expect(result.success).toBe(true);
    expect(result.hasQuizResult).toBe(true);
    expect(result.message).toContain('(※ 심화설문으로 자동 제출이 제외되었습니다)');

    // 1페이지에서 [다음]을 눌러 2페이지에 도달했는지 확인
    expect(clickedButtons).toContain('next');
    expect(getCurrentPage()).toBe(2);

    // 심화설문이므로 [제출하기] 버튼은 클릭되지 않아야 함
    expect(clickedButtons).not.toContain('submit');

    // 텔레그램 심화설문 알림 전송 확인
    expect(sendTelegramSpy).toHaveBeenCalled();
    const sentMsg = sendTelegramSpy.mock.calls[0]?.[0] as string;
    expect(sentMsg).toContain('[심화설문] 퀴즈 정답 추출 완료 (자동 제출 제외)');
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

    const result = await processSeminarQuiz(mockPage, '9999', false);

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
});
