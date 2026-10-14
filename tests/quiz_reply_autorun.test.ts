import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractSeminarInfoFromText, parseQuizQuestionsFromText } from '../src/services/telegram/quiz_cheatsheet';
import { formatUnknownQuestions, type SurveyQuestion, type QuizResult } from '../src/tasks/seminar_quiz';
import * as quizAdminHandler from '../src/services/telegram/admin_handlers/quiz';
import * as taskRegistry from '../src/core/taskRegistry';
import * as runner from '../src/core/runner';
import type { Context } from 'telegraf';

describe('extractSeminarInfoFromText 단위 테스트', () => {
  it('다양한 세미나 헤더 및 포맷에서 seminarId와 isAdvancedSurvey를 정확하게 추출한다', () => {
    // 1. 기본 세미나 미등록 퀴즈 포맷
    const text1 = `❓ 족보에 없는 퀴즈 [세미나: 5612]:\n\nQ1: 문제\n  1. 보기1\n  2. 보기2`;
    expect(extractSeminarInfoFromText(text1)).toEqual({
      seminarId: '5612',
      isAdvancedSurvey: false,
    });

    // 2. 심화설문 미등록 퀴즈 포맷
    const text2 = `❓ 족보에 없는 퀴즈 [세미나: 5612 (심화)]:\n\nQ1: 문제\n  1. 보기1\n  2. 보기2`;
    expect(extractSeminarInfoFromText(text2)).toEqual({
      seminarId: '5612',
      isAdvancedSurvey: true,
    });

    // 3. /run_seminar_quiz 커맨드가 포함된 경우
    const text3 = `세미나 퀴즈\n/run_seminar_quiz 12345 advanced`;
    expect(extractSeminarInfoFromText(text3)).toEqual({
      seminarId: '12345',
      isAdvancedSurvey: true,
    });

    // 4. URL 링크가 포함된 경우
    const text4 = `세미나 링크: https://m.doctorville.co.kr/cme/seminar/9999\n심화설문 대상`;
    expect(extractSeminarInfoFromText(text4)).toEqual({
      seminarId: '9999',
      isAdvancedSurvey: true,
    });

    // 5. 세미나 번호가 없는 일반 퀴즈
    const text5 = `❓ 족보에 없는 퀴즈:\n\nQ1: 문제\n  1. 보기1`;
    expect(extractSeminarInfoFromText(text5)).toEqual({
      seminarId: null,
      isAdvancedSurvey: false,
    });
  });
});

describe('formatUnknownQuestions 세미나 정보 표기 테스트', () => {
  const dummyQuestions: SurveyQuestion[] = [
    {
      questionNumber: 1,
      questionText: '다음 중 적응증은?',
      options: [
        { index: 1, text: '고혈압' },
        { index: 2, text: '당뇨' },
      ],
      inputType: 'radio',
      isRequired: true,
      marker: '[퀴즈]',
      kind: 'quiz',
    },
  ];

  const dummyResults: QuizResult[] = [
    {
      questionIndex: 1,
      questionText: '다음 중 적응증은?',
      selectedIndex: null,
      selectedText: null,
      matchedKeyword: null,
      multipleMatches: null,
      marker: '[퀴즈]',
      kind: 'quiz',
    },
  ];

  it('seminarId가 주어지면 메시지 헤더와 하단 가이드라인에 세미나 ID와 자동 실행 안내를 포함한다', () => {
    const msg = formatUnknownQuestions(dummyQuestions, dummyResults, '5612', false);
    expect(msg).toContain('❓ 족보에 없는 퀴즈 [세미나: 5612]:');
    expect(msg).toContain('/run_seminar_quiz 5612 가 자동 실행됩니다.');

    const parsed = parseQuizQuestionsFromText(msg);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].keyword).toBe('다음 중 적응증은?');
    expect(parsed[0].options).toEqual(['고혈압', '당뇨']);
  });

  it('심화설문인 경우 (심화) 및 advanced 옵션이 포함된다', () => {
    const msg = formatUnknownQuestions(dummyQuestions, dummyResults, '5612', true);
    expect(msg).toContain('❓ 족보에 없는 퀴즈 [세미나: 5612 (심화)]:');
    expect(msg).toContain('/run_seminar_quiz 5612 advanced 가 자동 실행됩니다.');
  });

  it('seminarId가 주어지지 않으면 기존 포맷을 유지한다', () => {
    const msg = formatUnknownQuestions(dummyQuestions, dummyResults);
    expect(msg).toContain('❓ 족보에 없는 퀴즈:\n\n');
    expect(msg).not.toContain('[세미나:');
    expect(msg).not.toContain('/run_seminar_quiz');
  });
});

describe('executeRunSeminarQuiz 실행 로직 테스트', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('executeRunSeminarQuiz 호출 시 태스크를 조회하고 runner.runTask를 올바른 인자로 비동기 실행한다', async () => {
    const mockTask = { name: 'run_seminar_quiz', run: vi.fn() };
    vi.spyOn(taskRegistry, 'getByName').mockReturnValue(
      mockTask as unknown as ReturnType<typeof taskRegistry.getByName>,
    );

    const runTaskSpy = vi.spyOn(runner, 'runTask').mockResolvedValue('완료');

    const replyMock = vi.fn().mockResolvedValue(undefined);
    const mockCtx = {
      reply: replyMock,
      from: { username: 'testuser' },
    } as unknown as Context;

    await quizAdminHandler.executeRunSeminarQuiz(mockCtx, '5612', true);

    expect(taskRegistry.getByName).toHaveBeenCalledWith('run_seminar_quiz');
    expect(runTaskSpy).toHaveBeenCalledWith(mockTask, {
      args: { seminarId: '5612', isAdvancedSurvey: 'true' },
    });
    expect(replyMock).toHaveBeenCalledWith(
      expect.stringContaining('Starting run_seminar_quiz (seminarId=5612, 심화설문)...'),
      undefined,
    );
  });
});
