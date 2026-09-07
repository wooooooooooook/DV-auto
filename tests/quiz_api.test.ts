import { describe, it, expect } from 'vitest';
import { extractQuizIdFromHtml, validateAndParseQuizData, type ProductQuizData } from '../src/modules/quiz_api';

describe('quiz_api 모듈 테스트', () => {
  describe('extractQuizIdFromHtml', () => {
    it('인라인 스크립트의 var quizId = "3604" 에서 ID를 추출해야 한다', () => {
      const html = `
        <script>
          var quizId = "3604";
          if (quizId) {
            getProductQuizDetails(quizId);
          }
        </script>
      `;
      expect(extractQuizIdFromHtml(html)).toBe('3604');
    });

    it('product-quiz/3604 경로에서도 ID를 추출할 수 있어야 한다', () => {
      const html = `
        <script>
          url: "https://api.doctorville.co.kr/api/product-quiz/3604"
        </script>
      `;
      expect(extractQuizIdFromHtml(html)).toBe('3604');
    });

    it('quizId가 없으면 null을 반환해야 한다', () => {
      const html = '<div>내용 없음</div>';
      expect(extractQuizIdFromHtml(html)).toBeNull();
    });
  });

  describe('validateAndParseQuizData', () => {
    const validSampleData: ProductQuizData = {
      quizId: 3604,
      quizNm: '에빅사',
      point: 500,
      useSt: 'Y',
      startDt: '2026-09-01',
      endDt: '2026-09-30',
      pid: 138,
      title: '에빅사',
      questionList: [
        {
          questionId: 101,
          quizId: 3604,
          questionNm: '1번 문제 지문입니다.',
          answerInfo: 'O$X',
          answerNum: 1,
          answerExplanation: '1번 정답 해설',
        },
        {
          questionId: 102,
          quizId: 3604,
          questionNm: '2번 문제 지문입니다.',
          answerInfo: '보기1$보기2$보기3$보기4',
          answerNum: 3,
          answerExplanation: '3번이 정답입니다.',
        },
      ],
    };

    it('정상적인 퀴즈 데이터를 올바르게 파싱 및 검증해야 한다', () => {
      const result = validateAndParseQuizData(validSampleData, {
        expectedPid: '138',
        targetDateKst: '2026-09-07',
      });

      expect(result).not.toBeNull();
      expect(result?.quizId).toBe(3604);
      expect(result?.pid).toBe('138');
      expect(result?.productTitle).toBe('에빅사');
      expect(result?.point).toBe(500);
      expect(result?.answers).toEqual([1, 3]);
      expect(result?.questions).toHaveLength(2);
      expect(result?.questions[0].answerText).toBe('O');
      expect(result?.questions[1].answerText).toBe('보기3');
    });

    it('useSt가 Y가 아니면 null을 반환해야 한다', () => {
      const invalidData = { ...validSampleData, useSt: 'N' };
      const result = validateAndParseQuizData(invalidData);
      expect(result).toBeNull();
    });

    it('종료일이 지난 퀴즈는 null을 반환해야 한다', () => {
      const expiredData = { ...validSampleData, endDt: '2026-09-05' };
      const result = validateAndParseQuizData(expiredData, {
        targetDateKst: '2026-09-07',
      });
      expect(result).toBeNull();
    });

    it('시작일 이전의 퀴즈는 null을 반환해야 한다', () => {
      const futureData = { ...validSampleData, startDt: '2026-09-10' };
      const result = validateAndParseQuizData(futureData, {
        targetDateKst: '2026-09-07',
      });
      expect(result).toBeNull();
    });

    it('pid가 기대값과 일치하지 않으면 null을 반환해야 한다', () => {
      const result = validateAndParseQuizData(validSampleData, {
        expectedPid: '999',
      });
      expect(result).toBeNull();
    });

    it('정답 번호가 보기 범위를 벗어난 경우 null을 반환해야 한다', () => {
      const invalidAnswerNumData = {
        ...validSampleData,
        questionList: [
          {
            questionId: 101,
            quizId: 3604,
            questionNm: '문제',
            answerInfo: 'O$X',
            answerNum: 3, // 범위 초과 (1~2여야 함)
          },
        ],
      };
      const result = validateAndParseQuizData(invalidAnswerNumData);
      expect(result).toBeNull();
    });
  });
});
