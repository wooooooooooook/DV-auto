import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  tryFetchSeminarQuizHttpFast,
  handleSeminarEndAndQuiz,
  buildSeminarLiveEndMessage,
  type MonitoredSeminarItem,
} from '../src/tasks/monitor_seminars';
import * as seminarSurveyApi from '../src/modules/seminar_survey_api';
import * as seminarQuiz from '../src/tasks/seminar_quiz';

describe('monitor_seminars fast HTTP quiz precheck & end handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('tryFetchSeminarQuizHttpFast', () => {
    it('seminarId가 없거나 falsy이면 즉시 null을 반환한다', async () => {
      const res1 = await tryFetchSeminarQuizHttpFast(null);
      const res2 = await tryFetchSeminarQuizHttpFast(undefined);
      const res3 = await tryFetchSeminarQuizHttpFast('');

      expect(res1).toBeNull();
      expect(res2).toBeNull();
      expect(res3).toBeNull();
    });

    it('fetchSeminarSurveyQuizHttp가 성공하면 퀴즈 요약 메시지와 심화설문 정보를 반환한다', async () => {
      vi.spyOn(seminarQuiz, 'loadCheatsheet').mockResolvedValue({ 키워드: '정답' });
      vi.spyOn(seminarSurveyApi, 'fetchSeminarSurveyQuizHttp').mockResolvedValue({
        success: true,
        seminarId: '5678',
        totalPageCnt: 2,
        totalQuestionCnt: 5,
        quizQuestionCnt: 2,
        depthSurveyQuestionCnt: 0,
        isAdvancedSurvey: true,
        quizzes: [],
        allQuestions: [],
        quizSummaryMessage: '퀴즈 정답 12',
      });

      const res = await tryFetchSeminarQuizHttpFast('5678', false);

      expect(res).not.toBeNull();
      expect(res?.quizResultMessage).toBe('퀴즈 정답 12');
      expect(res?.isAdvancedSurvey).toBe(true);
    });

    it('fetchSeminarSurveyQuizHttp가 실패하면 null을 반환한다', async () => {
      vi.spyOn(seminarQuiz, 'loadCheatsheet').mockResolvedValue({});
      vi.spyOn(seminarSurveyApi, 'fetchSeminarSurveyQuizHttp').mockResolvedValue({
        success: false,
        seminarId: '5678',
        totalPageCnt: 0,
        totalQuestionCnt: 0,
        quizQuestionCnt: 0,
        depthSurveyQuestionCnt: 0,
        isAdvancedSurvey: false,
        quizzes: [],
        allQuestions: [],
        quizSummaryMessage: '',
        errorMessage: '설문 URL 조회 실패',
      });

      const res = await tryFetchSeminarQuizHttpFast('5678', false);
      expect(res).toBeNull();
    });

    it('fetchSeminarSurveyQuizHttp에서 예외가 발생해도 예외를 던지지 않고 null을 반환한다', async () => {
      vi.spyOn(seminarQuiz, 'loadCheatsheet').mockRejectedValue(new Error('Network error'));

      const res = await tryFetchSeminarQuizHttpFast('5678', false);
      expect(res).toBeNull();
    });
  });

  describe('포인트 미지급 세미나 및 종료 메시지 빌더 검증', () => {
    it('포인트 미지급 세미나는 handleSeminarEndAndQuiz에서 바로 스킵되어 null을 반환한다', async () => {
      const mockContext = {} as unknown as import('playwright').BrowserContext;
      const res = await handleSeminarEndAndQuiz(
        mockContext,
        {
          name: '포인트 미지급 세미나',
          seminarId: '1234',
          isSurveyPointExcluded: true,
        },
        'https://m.doctorville.co.kr/cme/seminar/1234',
      );

      expect(res.message).toBeNull();
      expect(res.foundSurveyButton).toBe(false);
    });

    it('종료 메시지에 퀴즈 결과 및 심화설문 태그가 올바르게 포함된다', () => {
      const seminar: MonitoredSeminarItem = {
        seminarId: '5580',
        url: 'https://m.doctorville.co.kr/cme/seminar/5580',
        name: '테스트 세미나',
        status: '종료',
        time: '19:00~20:00',
        isAdvancedSurvey: true,
        quizResultMessage: '퀴즈 정답 12',
      };

      const { text } = buildSeminarLiveEndMessage(seminar);
      expect(text).toContain('🔴 <b>[세미나 종료]</b>');
      expect(text).toContain('[19:00~20:00]');
      expect(text).toContain('테스트 세미나');
      expect(text).toContain('[심화설문]');
      expect(text).toContain('퀴즈 정답 12');
      expect(text).toContain('https://m.doctorville.co.kr/cme/seminar/5580');
    });
  });
});
