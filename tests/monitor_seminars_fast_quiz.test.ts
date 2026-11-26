import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  tryFetchSeminarQuizHttpFast,
  handleSeminarEndAndQuiz,
  QUIZ_HTTP_FAST_RETRY_INTERVAL_MS,
} from '../src/tasks/monitor_seminars_quiz';
import {
  buildSeminarLiveEndMessage,
  buildSurveyClosingMessage,
  buildSeminarStatusMessage,
  type MonitoredSeminarItem,
} from '../src/tasks/monitor_seminars_notice';
import * as seminarSurveyApi from '../src/modules/seminar_survey_api';
import * as seminarQuiz from '../src/tasks/seminar_quiz';
import * as utilsModule from '../src/modules/utils';

describe('monitor_seminars fast HTTP quiz precheck & end handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('tryFetchSeminarQuizHttpFast', () => {
    it('seminarId가 없으면 조회 없이 http_failed 상태를 반환한다', async () => {
      const fetchSpy = vi.spyOn(seminarSurveyApi, 'fetchSeminarSurveyQuizHttp');
      const res1 = await tryFetchSeminarQuizHttpFast(null);
      const res2 = await tryFetchSeminarQuizHttpFast(undefined);
      const res3 = await tryFetchSeminarQuizHttpFast('');

      for (const res of [res1, res2, res3]) {
        expect(res.status).toBe('http_failed');
        expect(res.quizResultMessage).toBeNull();
        expect(res.attempts).toBe(0);
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetchSeminarSurveyQuizHttp가 성공하면 found 상태와 상세 퀴즈 결과 메시지·심화설문 정보를 반환한다', async () => {
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
        quizResultMessage: '퀴즈 정답 12\n\n✅ Q1: 퀴즈1 문제\n   → 정답1 (1번)\n✅ Q2: 퀴즈2 문제\n   → 정답2 (2번)',
      });

      const res = await tryFetchSeminarQuizHttpFast('5678', false);

      expect(res.status).toBe('found');
      expect(res.quizResultMessage).toBe(
        '퀴즈 정답 12\n\n✅ Q1: 퀴즈1 문제\n   → 정답1 (1번)\n✅ Q2: 퀴즈2 문제\n   → 정답2 (2번)',
      );
      expect(res.isAdvancedSurvey).toBe(true);
      expect(res.attempts).toBe(1);
    });

    it('fetchSeminarSurveyQuizHttp가 실패하면 짧은 간격으로 3회 재시도 후 http_failed를 반환한다', async () => {
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      vi.spyOn(seminarQuiz, 'loadCheatsheet').mockResolvedValue({});
      const fetchSpy = vi.spyOn(seminarSurveyApi, 'fetchSeminarSurveyQuizHttp').mockResolvedValue({
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

      const res = await tryFetchSeminarQuizHttpFast('5678', false, { sleepFn });

      expect(res.status).toBe('http_failed');
      expect(res.quizResultMessage).toBeNull();
      expect(res.attempts).toBe(3);
      expect(res.errorMessage).toContain('설문 URL 조회 실패');
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(sleepFn).toHaveBeenCalledTimes(2);
      expect(sleepFn).toHaveBeenNthCalledWith(1, QUIZ_HTTP_FAST_RETRY_INTERVAL_MS);
    });

    it('fetchSeminarSurveyQuizHttp에서 예외가 발생해도 예외를 던지지 않고 재시도 후 http_failed를 반환한다', async () => {
      vi.spyOn(seminarQuiz, 'loadCheatsheet').mockRejectedValue(new Error('Network error'));

      const res = await tryFetchSeminarQuizHttpFast('5678', false, { sleepFn: async () => {} });
      expect(res.status).toBe('http_failed');
      expect(res.attempts).toBe(3);
      expect(res.errorMessage).toContain('Network error');
    });
  });

  describe('브라우저 파싱 quizAbsent(퀴즈없이 설문만) 판정 — 설문 문항 존재 확인', () => {
    function buildMockPage(): import('playwright').Page {
      return {
        locator: (selector: string) => ({
          first: () => ({
            isVisible: async () => !selector.includes('개인정보'),
            isEnabled: async () => true,
            isChecked: async () => false,
            click: async () => {},
            count: async () => 0,
            waitFor: async () => {},
          }),
        }),
        waitForTimeout: async () => {},
        waitForLoadState: async () => {},
        screenshot: async () => {},
        url: () => 'https://m.doctorville.co.kr/cme/seminar/6002',
        close: async () => {},
      } as unknown as import('playwright').Page;
    }

    const mockContext = {
      newPage: async () => buildMockPage(),
      waitForEvent: async () => null,
      close: async () => {},
    } as unknown as import('playwright').BrowserContext;

    beforeEach(() => {
      vi.restoreAllMocks();
      vi.spyOn(utilsModule, 'ensureLoggedIn').mockResolvedValue(undefined as never);
      vi.spyOn(utilsModule, 'safeGoto').mockResolvedValue(undefined as never);
      vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true);
    });

    it('설문 문항을 0개 읽은 경우(조회 실패)에는 quizAbsent로 확정하지 않는다', async () => {
      vi.spyOn(seminarQuiz, 'processSeminarQuiz').mockResolvedValue({
        success: true,
        hasQuizResult: false,
        message: '설문 페이지에서 읽은 문항이 없습니다',
        surveyQuestionCnt: 0,
      });

      const res = await handleSeminarEndAndQuiz(
        mockContext,
        { name: '설문 조회 실패 세미나', seminarId: '6002' },
        'https://m.doctorville.co.kr/cme/seminar/6002',
      );

      expect(res.quizAbsent).toBe(false);
      expect(res.surveyQuestionCnt).toBe(0);
      expect(res.message).toBeNull();
    });

    it('설문 문항이 실제로 있고 퀴즈만 없으면 quizAbsent로 확정한다', async () => {
      vi.spyOn(seminarQuiz, 'processSeminarQuiz').mockResolvedValue({
        success: true,
        hasQuizResult: false,
        message: '설문 페이지에서 퀴즈를 찾지 못했습니다',
        surveyQuestionCnt: 3,
      });

      const res = await handleSeminarEndAndQuiz(
        mockContext,
        { name: '설문만 있는 세미나', seminarId: '6002' },
        'https://m.doctorville.co.kr/cme/seminar/6002',
      );

      expect(res.quizAbsent).toBe(true);
      expect(res.surveyQuestionCnt).toBe(3);
    });

    it('브라우저에서 정답을 얻으면 퀴즈없이 설문만으로 판정하지 않는다', async () => {
      vi.spyOn(seminarQuiz, 'processSeminarQuiz').mockResolvedValue({
        success: true,
        hasQuizResult: true,
        message: '퀴즈 정답 12',
        surveyQuestionCnt: 3,
      });

      const res = await handleSeminarEndAndQuiz(
        mockContext,
        { name: '정답 확보 세미나', seminarId: '6002' },
        'https://m.doctorville.co.kr/cme/seminar/6002',
      );

      expect(res.quizAbsent).toBe(false);
      expect(res.message).toBe('퀴즈 정답 12');
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

    it('종료 메시지와 마감임박(20분/10분) 알림에는 상세 퀴즈 전체 텍스트가 포함되고, 공지채널 메시지에는 요약만 포함된다', () => {
      const fullQuizText = '퀴즈 정답 12\n\n✅ Q1: 퀴즈1 문제\n   → 정답1 (1번)\n✅ Q2: 퀴즈2 문제\n   → 정답2 (2번)';
      const seminar: MonitoredSeminarItem = {
        seminarId: '5580',
        url: 'https://m.doctorville.co.kr/cme/seminar/5580',
        name: '테스트 세미나',
        status: '종료',
        time: '19:00~20:00',
        isAdvancedSurvey: true,
        quizResultMessage: fullQuizText,
      };

      // 1. 종료 알림 (전체 텍스트 포함 확인)
      const { text: endText } = buildSeminarLiveEndMessage(seminar);
      expect(endText).toContain('🔴 <b>[세미나 종료]</b>');
      expect(endText).toContain('[19:00~20:00]');
      expect(endText).toContain('테스트 세미나');
      expect(endText).toContain('[심화설문]');
      expect(endText).toContain('퀴즈 정답 12');
      expect(endText).toContain('✅ Q1: 퀴즈1 문제');
      expect(endText).toContain('→ 정답1 (1번)');
      expect(endText).toContain('https://m.doctorville.co.kr/cme/seminar/5580');

      // 2. 20분전 / 10분전 알림 (전체 텍스트 포함 확인)
      const { text: closing20Text } = buildSurveyClosingMessage(seminar, 20);
      expect(closing20Text).toContain('⏳ <b>[설문 마감 20분 전]</b>');
      expect(closing20Text).toContain('퀴즈 정답 12');
      expect(closing20Text).toContain('✅ Q1: 퀴즈1 문제');

      const { text: closing10Text } = buildSurveyClosingMessage(seminar, 10);
      expect(closing10Text).toContain('⏳ <b>[설문 마감 10분 전]</b>');
      expect(closing10Text).toContain('퀴즈 정답 12');
      expect(closing10Text).toContain('✅ Q1: 퀴즈1 문제');

      // 3. 공지채널 메시지 (요약만 포함되고 상세 Q1, Q2 문항은 미포함 확인)
      const { text: channelNoticeText } = buildSeminarStatusMessage('저녁', [seminar]);
      expect(channelNoticeText).toContain('🔴 종료');
      expect(channelNoticeText).toContain('퀴즈 정답 12');
      expect(channelNoticeText).not.toContain('✅ Q1: 퀴즈1 문제');
      expect(channelNoticeText).not.toContain('→ 정답1 (1번)');
    });
  });
});
