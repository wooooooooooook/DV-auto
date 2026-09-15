import { describe, it, expect } from 'vitest';
import { formatAdvancedSurveyPrompt, type SurveyQuestionForPrompt } from '../src/tasks/seminar_quiz';

describe('formatAdvancedSurveyPrompt 단위 테스트', () => {
  it('질문 목록이 비어 있으면 빈 문자열을 반환한다', () => {
    expect(formatAdvancedSurveyPrompt([])).toBe('');
  });

  it('주관식 및 객관식 심화설문 질문에 대해 올바른 코드블럭 프롬프트를 생성한다', () => {
    const questions: SurveyQuestionForPrompt[] = [
      {
        questionNumber: 1,
        questionText: '본 약제를 주로 처방하시는 환자군의 특징과 실제 임상 효과에 대해 간략히 말씀해 주세요.',
        options: [],
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

    const result = formatAdvancedSurveyPrompt(questions);

    // 코드블럭 시작 및 끝 검증
    expect(result.startsWith('```text\n')).toBe(true);
    expect(result.endsWith('\n```')).toBe(true);

    // 가이드라인 및 페르소나 포함 검증
    expect(result).toContain('10년 차 로컬의원(개원의) 의사');
    expect(result).toContain('100~200자');
    expect(result).toContain('괄호()는 사용하지 않습니다');
    expect(result).toContain('-스빈다');
    expect(result).toContain('-할 떄');
    expect(result).toContain('하ㅗㄴ자');

    // 질문 및 보기 포맷팅 검증
    expect(result).toContain(
      '1. Q1: 본 약제를 주로 처방하시는 환자군의 특징과 실제 임상 효과에 대해 간략히 말씀해 주세요.',
    );
    expect(result).toContain('2. Q2: 기존 치료제 대비 본 약제의 장점이나 보완되었으면 하는 점은 무엇인가요?');
    expect(result).toContain('   1) 복약 순응도 개선');
    expect(result).toContain('   2) 부작용 감소');
    expect(result).toContain('   3) 기타');
  });
});
