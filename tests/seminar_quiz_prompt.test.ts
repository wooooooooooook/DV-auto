import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatAdvancedSurveyPrompt,
  generateAdvancedSurveyPromptText,
  requestHermesAiSurveyAnswer,
  HERMES_TIMEOUT_MS,
  generateUnknownQuizPromptText,
  handleUnknownQuestions,
  cleanAndExtractQuestionText,
  isMetaOrUiText,
  containsAdvancedSurveyNotice,
  type SurveyQuestionForPrompt,
  type SurveyQuestion,
  type QuizResult,
} from '../src/tasks/seminar_quiz';
import * as utilsModule from '../src/modules/utils';
import { drainLlmQueue } from '../src/services/llm_queue';

describe('formatAdvancedSurveyPrompt & generateAdvancedSurveyPromptText 단위 테스트', () => {
  it('질문 목록이 비어 있으면 빈 문자열을 반환한다', () => {
    expect(formatAdvancedSurveyPrompt([])).toBe('');
    expect(generateAdvancedSurveyPromptText([])).toBe('');
  });

  it('주관식 및 객관식 심화설문 질문에 대해 올바른 HTML 코드블럭 프롬프트 및 순수 텍스트를 생성한다', () => {
    const questions: SurveyQuestionForPrompt[] = [
      {
        questionNumber: 1,
        questionText: '본 약제를 주로 처방하시는 환자군의 특징과 실제 임상 효과에 대해 간략히 말씀해 주세요.',
        options: [{ index: 1, text: '[주관식]' }], // 주관식 더미 옵션 필터링 대상
      },
      {
        questionNumber: 2,
        questionText: '기존 치료제 대비 본 약제의 장점이나 보완되었으면 하는 점은 무엇인가요?',
        options: [
          { index: 1, text: '복약 순응도 개선' },
          { index: 2, text: '부작용 감소' },
          { index: 3, text: '기타' },
        ],
      },
    ];

    const rawText = generateAdvancedSurveyPromptText(questions);
    expect(rawText).toContain('10년 차 로컬의원(개원의) 의사');
    expect(rawText).toContain(
      'Q1: 본 약제를 주로 처방하시는 환자군의 특징과 실제 임상 효과에 대해 간략히 말씀해 주세요.',
    );
    expect(rawText).not.toContain('[주관식]');
    expect(rawText).toContain('   1) 복약 순응도 개선');

    const result = formatAdvancedSurveyPrompt(questions);

    // HTML 코드블럭 시작 및 끝 검증
    expect(result.startsWith('<pre><code class="language-text">')).toBe(true);
    expect(result.endsWith('</code></pre>')).toBe(true);

    // 가이드라인 및 페르소나 포함 검증
    expect(result).toContain('10년 차 로컬의원(개원의) 의사');
    expect(result).toContain('100~150자');
    expect(result).toContain('괄호()는 사용하지 않습니다');
    expect(result).toContain('-스빈다');
    expect(result).toContain('-할 떄');
    expect(result).toContain('하ㅗㄴ자');

    // 번호 중복 없이 Q1:, Q2: 형태 검증
    expect(result).toContain(
      'Q1: 본 약제를 주로 처방하시는 환자군의 특징과 실제 임상 효과에 대해 간략히 말씀해 주세요.',
    );
    expect(result).not.toContain('1. Q1:');

    // 주관식 더미 옵션("[주관식]")이 보기로 출력되지 않는지 검증
    expect(result).not.toContain('[주관식]');

    // 객관식 보기는 정상 출력
    expect(result).toContain('Q2: 기존 치료제 대비 본 약제의 장점이나 보완되었으면 하는 점은 무엇인가요?');
    expect(result).toContain('   1) 복약 순응도 개선');
    expect(result).toContain('   2) 부작용 감소');
    expect(result).toContain('   3) 기타');
  });
});

describe('requestHermesAiSurveyAnswer 단위 테스트', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('빈 프롬프트가 주어지면 null을 반환한다', async () => {
    const result = await requestHermesAiSurveyAnswer('');
    expect(result).toBeNull();
  });

  it('타임아웃은 200초(HERMES_TIMEOUT_MS = 200_000)로 설정되어 있다', () => {
    expect(HERMES_TIMEOUT_MS).toBe(200_000);
  });

  it('Hermes AI 서버에 올바른 JSON body로 요청하고 응답텍스트를 반환한다', async () => {
    let requestedUrl = '';
    let requestedBody:
      | { model?: string; stream?: boolean; messages?: Array<{ role: string; content: string }> }
      | undefined;

    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      requestedUrl = url;
      requestedBody = JSON.parse(init?.body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              message: {
                content:
                  'Q1: 고령층 골다공증 환자군에서 효과적이며 골밀도 개선이 뚜렷하게 관찰되어 처방 만족도가 높스빈다.',
              },
            },
          ],
        }),
      } as unknown as Response;
    });

    const result = await requestHermesAiSurveyAnswer('테스트 프롬프트');

    expect(requestedUrl).toBe('http://hermes:20128/v1/chat/completions');
    expect(requestedBody).toBeDefined();
    expect(requestedBody!.model).toBe('my-combo');
    expect(requestedBody!.stream).toBe(false);
    expect(requestedBody!.messages?.[0]?.content).toBe('테스트 프롬프트');
    expect(result).toBe(
      'Q1: 고령층 골다공증 환자군에서 효과적이며 골밀도 개선이 뚜렷하게 관찰되어 처방 만족도가 높스빈다.',
    );
  });

  it('HERMES_API_KEY 환경변수가 설정되어 있으면 Authorization Bearer 헤더를 포함하여 요청한다', async () => {
    const prevKey = process.env.HERMES_API_KEY;
    process.env.HERMES_API_KEY = 'test-secret-key-123';

    let requestedHeaders: Record<string, string> | undefined;

    globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      requestedHeaders = init?.headers as Record<string, string>;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '응답' } }],
        }),
      } as unknown as Response;
    });

    try {
      const result = await requestHermesAiSurveyAnswer('프롬프트');
      expect(result).toBe('응답');
      expect(requestedHeaders).toBeDefined();
      expect(requestedHeaders!['Authorization']).toBe('Bearer test-secret-key-123');
      expect(requestedHeaders!['Content-Type']).toBe('application/json');
    } finally {
      if (prevKey !== undefined) {
        process.env.HERMES_API_KEY = prevKey;
      } else {
        delete process.env.HERMES_API_KEY;
      }
    }
  });

  it('HERMES_URL 환경변수가 설정되어 있으면 해당 URL(/chat/completions 자동 부착)로 요청한다', async () => {
    const prevUrl = process.env.HERMES_URL;
    process.env.HERMES_URL = 'http://custom-hermes:8000/v1';

    let requestedUrl = '';
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '응답' } }],
        }),
      } as unknown as Response;
    });

    try {
      const result = await requestHermesAiSurveyAnswer('프롬프트');
      expect(result).toBe('응답');
      expect(requestedUrl).toBe('http://custom-hermes:8000/v1/chat/completions');
    } finally {
      if (prevUrl !== undefined) {
        process.env.HERMES_URL = prevUrl;
      } else {
        delete process.env.HERMES_URL;
      }
    }
  });

  it('Hermes AI 서버가 에러를 반환하면 null을 반환하고 실패 알림을 전송한다', async () => {
    vi.spyOn(await import('../src/modules/utils'), 'sendTelegram').mockResolvedValue(true);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as unknown as Response);

    const result = await requestHermesAiSurveyAnswer('프롬프트');
    expect(result).toBeNull();
  });

  it('요청 실패 시 조용히 실패하지 않고 텔레그램 실패 메시지를 전송한다', async () => {
    const sendTelegramSpy = vi.fn().mockResolvedValue(true);
    vi.spyOn(await import('../src/modules/utils'), 'sendTelegram').mockImplementation(sendTelegramSpy);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as unknown as Response);

    const result = await requestHermesAiSurveyAnswer('프롬프트', '심화설문 AI 추천 답변');
    expect(result).toBeNull();
    expect(sendTelegramSpy).toHaveBeenCalledTimes(1);

    const failMsg = sendTelegramSpy.mock.calls[0][0] as string;
    expect(failMsg).toContain('⚠️ [심화설문 AI 추천 답변 요청 실패]');
    expect(failMsg).toContain('HTTP 500 오류 응답');
  });

  it('타임아웃 발생 시 텔레그램 타임아웃 실패 메시지를 전송한다', async () => {
    const sendTelegramSpy = vi.fn().mockResolvedValue(true);
    vi.spyOn(await import('../src/modules/utils'), 'sendTelegram').mockImplementation(sendTelegramSpy);

    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    globalThis.fetch = vi.fn().mockRejectedValue(abortError);

    const result = await requestHermesAiSurveyAnswer('프롬프트', '오늘의 퀴즈 AI 추천 정답');
    expect(result).toBeNull();
    expect(sendTelegramSpy).toHaveBeenCalledTimes(1);

    const failMsg = sendTelegramSpy.mock.calls[0][0] as string;
    expect(failMsg).toContain('⚠️ [오늘의 퀴즈 AI 추천 정답 요청 실패]');
    expect(failMsg).toContain('타임아웃');
    expect(failMsg).toContain('200초');
  });

  it('notifyFailure=false이면 텔레그램 실패 알림을 전송하지 않는다', async () => {
    const sendTelegramSpy = vi.fn().mockResolvedValue(true);
    vi.spyOn(await import('../src/modules/utils'), 'sendTelegram').mockImplementation(sendTelegramSpy);

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    } as unknown as Response);

    const result = await requestHermesAiSurveyAnswer('프롬프트', 'Hermes LLM 테스트', false);
    expect(result).toBeNull();
    expect(sendTelegramSpy).not.toHaveBeenCalled();
  });
});

describe('generateUnknownQuizPromptText & handleUnknownQuestions 단위 테스트', () => {
  it('미등록 퀴즈가 없으면 빈 문자열을 반환한다', () => {
    const questions = [
      {
        questionNumber: 1,
        questionText: '문제1',
        options: [],
        inputType: 'radio' as const,
        isRequired: true,
        marker: null,
        kind: 'quiz' as const,
      },
    ];
    const results = [
      {
        questionIndex: 1,
        questionText: '문제1',
        selectedIndex: 1,
        selectedText: '보기1',
        matchedKeyword: null,
        multipleMatches: null,
        marker: null,
        kind: 'quiz' as const,
      },
    ];
    expect(generateUnknownQuizPromptText(questions, results)).toBe('');
  });

  it('미등록 퀴즈 문항들을 포맷하여 AI 프롬프트를 생성한다', () => {
    const questions = [
      {
        questionNumber: 1,
        questionText: '다음 중 당뇨병 1차 치료제는?',
        options: [
          { index: 1, text: '메트포르민', value: '1' },
          { index: 2, text: '인슐린', value: '2' },
        ],
        inputType: 'radio' as const,
        isRequired: true,
        marker: '[퀴즈]',
        kind: 'quiz' as const,
      },
    ];
    const results = [
      {
        questionIndex: 1,
        questionText: '다음 중 당뇨병 1차 치료제는?',
        selectedIndex: null,
        selectedText: null,
        matchedKeyword: null,
        multipleMatches: null,
        marker: '[퀴즈]',
        kind: 'quiz' as const,
      },
    ];

    const prompt = generateUnknownQuizPromptText(questions, results);
    expect(prompt).toContain('Q1: 다음 중 당뇨병 1차 치료제는?');
    expect(prompt).toContain('  1. 메트포르민');
    expect(prompt).toContain('  2. 인슐린');
    expect(prompt).toContain('전문의 입장');
  });
});

describe('Docple AI 프롬프트 생성 및 정답 파싱 단위 테스트', () => {
  it('generateDocpleQuizAiPrompt: 의약품 정보와 퀴즈 문제를 JSON 포맷 요청 가이드라인으로 올바르게 포맷한다', async () => {
    const { generateDocpleQuizAiPrompt } = await import('../src/modules/docple_api');

    const prompt = generateDocpleQuizAiPrompt({
      quiz: {
        quizId: 101,
        quizName: '엔도맵 퀴즈',
        questions: [
          {
            questionId: 1,
            questionText: '본 약제의 주요 적응증은?',
            options: [
              { optionId: 10, optionText: '제2형 당뇨병' },
              { optionId: 11, optionText: '고혈압' },
            ],
          },
        ],
      },
      medicine: {
        id: 201,
        medicineName: '다파글리플로진',
        mainIngredient: 'Dapagliflozin',
        therapeuticCategory: '당뇨병용제',
      },
    });

    expect(prompt).toContain('다파글리플로진');
    expect(prompt).toContain('Dapagliflozin');
    expect(prompt).toContain('Q1: 본 약제의 주요 적응증은?');
    expect(prompt).toContain('  1. 제2형 당뇨병');
    expect(prompt).toContain('"answers": [');
    expect(prompt).toContain('JSON 포맷으로만 출력');
  });

  it('parseDocpleAiAnswerIndices: JSON 및 다양한 AI 응답 포맷에서 정답 인덱스를 정확히 추출한다', async () => {
    const { parseDocpleAiAnswerIndices } = await import('../src/modules/docple_api');

    // Case 1: 순수 JSON 객체 { answers: [1, 2], reasons: [...] }
    expect(
      parseDocpleAiAnswerIndices(
        JSON.stringify({
          answers: [1, 2],
          reasons: ['1번 정답 근거', '2번 정답 근거'],
        }),
        2,
      ),
    ).toEqual([1, 2]);

    // Case 2: 마크다운 코드블록 내의 JSON ```json { "answers": [2, 3] } ```
    expect(
      parseDocpleAiAnswerIndices('```json\n{\n  "answers": [2, 3],\n  "reasons": ["근거1", "근거2"]\n}\n```', 2),
    ).toEqual([2, 3]);

    // Case 3: JSON 배열 [1, 2]
    expect(parseDocpleAiAnswerIndices('[1, 2]', 2)).toEqual([1, 2]);

    // Case 4: JSON 객체 내 상세 객체 배열 { answers: [{ answerIndex: 2 }, { answerIndex: 1 }] }
    expect(
      parseDocpleAiAnswerIndices(
        JSON.stringify({
          answers: [{ answerIndex: 2 }, { answerIndex: 1 }],
        }),
        2,
      ),
    ).toEqual([2, 1]);

    // Case 5: 텍스트 fallback ("정답: 1 2")
    expect(parseDocpleAiAnswerIndices('Q1: 설명...\nQ2: 설명...\n\n정답: 1 2', 2)).toEqual([1, 2]);

    // Case 6: 텍스트 fallback ("정답: 2, 1")
    expect(parseDocpleAiAnswerIndices('근거 내용\n정답: 2, 1', 2)).toEqual([2, 1]);

    // Case 7: 텍스트 fallback (Q1: 1번, Q2: 3번)
    expect(parseDocpleAiAnswerIndices('Q1: 1번 (효과 우수)\nQ2: 3번 (부작용 적음)', 2)).toEqual([1, 3]);

    // Case 8: 텍스트 fallback (마지막 줄 숫자 나열 "1 2 3")
    expect(parseDocpleAiAnswerIndices('설명 텍스트\n1 2 3', 3)).toEqual([1, 2, 3]);

    // Case 9: 문항 수 불일치 시 null
    expect(parseDocpleAiAnswerIndices('{"answers": [1]}', 2)).toBeNull();
  });
});

describe('handleUnknownQuestions 백그라운드 AI 요청 테스트', () => {
  const originalFetch = globalThis.fetch;

  const questions: SurveyQuestion[] = [
    {
      questionNumber: 1,
      questionText: '다음 중 당뇨병 1차 치료제는?',
      options: [
        { index: 1, text: '메트포르민', value: '1' },
        { index: 2, text: '인슐린', value: '2' },
      ],
      inputType: 'radio',
      isRequired: true,
      marker: '[퀴즈]',
      kind: 'quiz',
    },
  ];

  const results: QuizResult[] = [
    {
      questionIndex: 1,
      questionText: '다음 중 당뇨병 1차 치료제는?',
      selectedIndex: null,
      selectedText: null,
      matchedKeyword: null,
      multipleMatches: null,
      marker: '[퀴즈]',
      kind: 'quiz',
    },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(async () => {
    await drainLlmQueue();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('AI 응답을 기다리지 않고 미등록 퀴즈 안내만 발송한 채 먼저 반환한다', async () => {
    let fetchResolved = false;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      fetchResolved = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'Q1: 1번이 정답입니다.' } }] }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const sendTelegramSpy = vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true);

    await handleUnknownQuestions(questions, results);

    // AI 응답 대기 없이 반환되었으므로(백그라운드 큐) 안내 메시지만 발송된 상태다
    expect(fetchResolved).toBe(false);
    expect(sendTelegramSpy).toHaveBeenCalledTimes(1);
    expect(String(sendTelegramSpy.mock.calls[0][0])).toContain('족보에 없는 퀴즈');

    await drainLlmQueue();

    expect(fetchResolved).toBe(true);
    expect(sendTelegramSpy).toHaveBeenCalledTimes(2);
    expect(String(sendTelegramSpy.mock.calls[1][0])).toContain('[미등록 퀴즈 AI 추천 정답]');
  });
});

describe('cleanAndExtractQuestionText 및 문제 번호 기반 끝까지 추출 테스트', () => {
  it('단독 줄 번호("8.")와 여러 문단으로 이루어진 설문 지문을 끝까지 보존하고 UI 텍스트를 제거한다', () => {
    const rawInput = `8.
2025년 개정 국내 H. pylori 치료 가이드라인은 클래리스로마이신 내성률 증가(33.3%)로 표준 3제요법의 제균율이 66.9%까지 낮아짐에 따라, 맞춤치료와 경험적 4제요법(동시요법 등) 2축 전략으로 개정되었으며, P-CAB 기반 병용요법이 PPI 기반 요법을 대체할 수 있는 1차 요법으로 권고되었습니다.
펙수프라잔 기반 3제요법은 허가 임상 3상에서 란소프라졸 기반 3제요법 대비 비열등한 제균율(83.6% vs 77.9%)을 입증하였으며, 클래리스로마이신 내성 환자에서도 54.76% vs 28.57%(p=0.0112)로 높은 제균율을 보였습니다.

현재 H. pylori 제균치료를 하실 때 가장 어려운 점은 무엇이며, 펙수프라잔이 제균치료에서 어떤 환자나 상황에 쓰일 때 가장 의미가 있다고 보시는지 그 이유와 함께 말씀 부탁드립니다.
(예: 환자 특성 / 치료 단계(1차·2차) / 요법 등 진료 경험을 바탕으로 자유롭게 작성) - (100자 이상)
내용을 입력해주세요 (마우스 우클릭 금지, 복사&붙여넣기 기능 사용 불가)

0 / 최소 100 자

설문 마감 45분 전`;

    const extracted = cleanAndExtractQuestionText(rawInput, 0);

    expect(extracted.questionNumber).toBe(8);
    // 첫 문단뿐만 아니라 2번째, 3번째, 4번째 문단까지 모두 포함되어야 함
    expect(extracted.questionText).toContain('2025년 개정 국내 H. pylori 치료 가이드라인은');
    expect(extracted.questionText).toContain('펙수프라잔 기반 3제요법은 허가 임상 3상에서');
    expect(extracted.questionText).toContain('현재 H. pylori 제균치료를 하실 때 가장 어려운 점은 무엇이며');
    expect(extracted.questionText).toContain(
      '(예: 환자 특성 / 치료 단계(1차·2차) / 요법 등 진료 경험을 바탕으로 자유롭게 작성) - (100자 이상)',
    );

    // UI 메타 텍스트는 제외되어야 함
    expect(extracted.questionText).not.toContain('내용을 입력해주세요');
    expect(extracted.questionText).not.toContain('마우스 우클릭 금지');
    expect(extracted.questionText).not.toContain('0 / 최소 100 자');
    expect(extracted.questionText).not.toContain('설문 마감 45분 전');

    // AI 프롬프트 생성 시 Q8: 아래에 전체 문단이 누락 없이 포맷되는지 검증
    const promptQuestions: SurveyQuestionForPrompt[] = [
      {
        questionNumber: extracted.questionNumber,
        questionText: extracted.questionText,
      },
    ];
    const promptText = generateAdvancedSurveyPromptText(promptQuestions);

    expect(promptText).toContain('Q8: 2025년 개정 국내 H. pylori 치료 가이드라인은');
    expect(promptText).toContain('펙수프라잔 기반 3제요법은 허가 임상 3상에서');
    expect(promptText).toContain('현재 H. pylori 제균치료를 하실 때 가장 어려운 점은 무엇이며');
    expect(promptText).toContain(
      '(예: 환자 특성 / 치료 단계(1차·2차) / 요법 등 진료 경험을 바탕으로 자유롭게 작성) - (100자 이상)',
    );
  });

  it('마커와 문제 번호가 접두어로 붙어있을 때 마커와 번호를 분리하고 본문을 끝까지 추출한다', () => {
    const rawInput = `[주관식] Q3. 본 약제를 처방하면서 경험하신 주요 효과는 무엇인가요?
환자 반응과 복약 편의성 측면에서
자세히 기술해 주십시오. *
내용을 입력해주세요`;

    const extracted = cleanAndExtractQuestionText(rawInput, 1);
    expect(extracted.marker).toBe('[주관식]');
    expect(extracted.questionNumber).toBe(3);
    expect(extracted.questionText).toBe(
      '본 약제를 처방하면서 경험하신 주요 효과는 무엇인가요?\n환자 반응과 복약 편의성 측면에서\n자세히 기술해 주십시오.',
    );
  });

  it('isMetaOrUiText: UI 및 메타 안내 문구를 올바르게 판별한다', () => {
    expect(isMetaOrUiText('내용을 입력해주세요')).toBe(true);
    expect(isMetaOrUiText('마우스 우클릭 금지')).toBe(true);
    expect(isMetaOrUiText('0 / 최소 100 자')).toBe(true);
    expect(isMetaOrUiText('설문 마감 45분 전')).toBe(true);
    expect(isMetaOrUiText('실제 임상 환자에서의 치료 효과')).toBe(false);
  });
});

describe('containsAdvancedSurveyNotice 심화설문 안내 문구 인식 테스트', () => {
  it('포인트 지급 및 제외 사유가 포함된 심화설문 안내 문구를 정확히 인식한다', () => {
    const surveyNotice = `제출해주시는 답변은 제품 발전 및 개선을 위한 목적으로 수집되며,
담당자 확인 후 소정의 포인트가 지급될 예정입니다. (영업일 기준 7일이내)

단, 아래와 같은 사유는 담당자 검토 후 포인트 지급대상에서 제외될 수 있습니다.
1. 문항별 최소 글자 수 기준 미 충족
2. 의미 없는 문장 또는 반복 응답
3. 질문과 무관한 내용
4. 기타 직접 작성한 응답으로 보기 어려운 경우(AI 활용)`;

    expect(containsAdvancedSurveyNotice(surveyNotice)).toBe(true);
  });

  it('키워드가 2개 이상일 때만 심화설문으로 인식한다 (단일 키워드 단독은 false)', () => {
    // 키워드 2개 이상: "리뷰형" + "소정의 포인트 지급" -> true
    const titleWithPoint = '[D-DDW 2026] 펙수클루 Triple Web Symposium 설문조사 (리뷰형, 소정의 포인트 지급)';
    expect(containsAdvancedSurveyNotice(titleWithPoint)).toBe(true);

    // 키워드 1개 단독: "리뷰형"만 있음 -> false
    const titleOnly = '[D-DDW 2026] 펙수클루 Triple Web Symposium 설문조사 (펙수클루_리뷰형_총 8문항)';
    expect(containsAdvancedSurveyNotice(titleOnly)).toBe(false);

    // 키워드 1개 단독: "소정의 포인트"만 있음 -> false
    expect(containsAdvancedSurveyNotice('소정의 포인트를 드립니다.')).toBe(false);

    // 키워드 1개 단독: "최소 100자"만 있음 -> false
    expect(containsAdvancedSurveyNotice('답변은 최소 100자 작성해 주세요.')).toBe(false);
  });

  it('최소 글자수와 포인트/AI 키워드가 2개 이상 조합된 문장을 인식한다', () => {
    // 최소 글자수 + 담당자 검토 + 소정의 포인트 -> true
    expect(containsAdvancedSurveyNotice('100자 이상 서술 시 담당자 검토 후 소정의 포인트 지급')).toBe(true);
    // 최소 글자수 + AI 작성 + 포인트 지급 제외 -> true
    expect(containsAdvancedSurveyNotice('문항당 최소 100자 미충족 또는 AI 작성 시 포인트 지급 제외')).toBe(true);
  });

  it('일반 설문 및 단순 퀴즈 문구에 대해서는 false를 반환한다', () => {
    expect(containsAdvancedSurveyNotice('오늘 강의의 전반적인 만족도를 평가해 주세요.')).toBe(false);
    expect(containsAdvancedSurveyNotice('[퀴즈] 다음 중 고혈압 치료제로 올바른 것은?')).toBe(false);
    expect(containsAdvancedSurveyNotice('')).toBe(false);
    expect(containsAdvancedSurveyNotice(null)).toBe(false);
  });
});
