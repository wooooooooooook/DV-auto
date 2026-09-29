import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatAdvancedSurveyPrompt,
  generateAdvancedSurveyPromptText,
  requestHermesAiSurveyAnswer,
  generateUnknownQuizPromptText,
  type SurveyQuestionForPrompt,
} from '../src/tasks/seminar_quiz';

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

  it('Hermes AI 서버가 에러를 반환하면 null을 반환한다', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'Internal Server Error',
    } as unknown as Response);

    const result = await requestHermesAiSurveyAnswer('프롬프트');
    expect(result).toBeNull();
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
