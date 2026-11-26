import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  tryFetchSeminarQuizHttpFast,
  applySeminarQuizHttpFetchResult,
  completeSeminarQuizAnalysis,
  resolveQuizHttpFastStatus,
  QUIZ_HTTP_FAST_MAX_ATTEMPTS,
  QUIZ_HTTP_FAST_RETRY_INTERVAL_MS,
} from '../src/tasks/monitor_seminars_quiz';
import {
  buildSeminarLiveEndMessage,
  buildSeminarStatusMessage,
  parsePrevNoticeSeminars,
  sendSeminarLiveEndNotice,
  isQuizAnalysisPending,
  isQuizAbsentOnly,
  isQuizAbsentLine,
  QUIZ_ABSENT_TEXT,
  QUIZ_ANALYSIS_PENDING_TEXT,
  type MonitoredSeminarItem,
} from '../src/tasks/monitor_seminars_notice';
import * as storage from '../src/services/storage';
import { setBot } from '../src/services/bot_instance';
import { updateSubscription } from '../src/services/subscription_service';
import * as seminarSurveyApi from '../src/modules/seminar_survey_api';
import * as seminarQuiz from '../src/tasks/seminar_quiz';

const CHANNEL_GUIDE_TEXT = '메인 채널에 정답이 업데이트됩니다';

function buildHttpFailure(errorMessage = 'HTTP 500') {
  return {
    success: false as const,
    seminarId: '6001',
    totalPageCnt: 0,
    totalQuestionCnt: 0,
    quizQuestionCnt: 0,
    depthSurveyQuestionCnt: 0,
    isAdvancedSurvey: false,
    quizzes: [],
    allQuestions: [],
    quizSummaryMessage: '',
    errorMessage,
  };
}

function buildHttpSuccess(overrides: Record<string, unknown> = {}) {
  return {
    success: true as const,
    seminarId: '6001',
    totalPageCnt: 1,
    totalQuestionCnt: 3,
    quizQuestionCnt: 2,
    depthSurveyQuestionCnt: 0,
    isAdvancedSurvey: false,
    quizzes: [],
    allQuestions: [],
    quizSummaryMessage: '퀴즈 정답 12',
    quizResultMessage: '퀴즈 정답 12',
    ...overrides,
  };
}

function buildSeminar(overrides: Partial<MonitoredSeminarItem> = {}): MonitoredSeminarItem {
  return {
    seminarId: '6001',
    url: 'https://m.doctorville.co.kr/cme/seminar/6001',
    name: '분석중 상태 테스트 세미나',
    status: '종료',
    time: '19:00~20:00',
    hasSurvey: true,
    ...overrides,
  };
}

describe('HTTP 퀴즈 사전 조회 짧은 재시도', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('첫 시도에서 실패해도 두 번째 시도에서 성공하면 found로 정답을 확보한다', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(seminarQuiz, 'loadCheatsheet').mockResolvedValue({});
    const fetchSpy = vi
      .spyOn(seminarSurveyApi, 'fetchSeminarSurveyQuizHttp')
      .mockResolvedValueOnce(buildHttpFailure('설문 URL 조회 실패 (HTTP 502)'))
      .mockResolvedValueOnce(buildHttpSuccess());

    const res = await tryFetchSeminarQuizHttpFast('6001', false, { sleepFn });

    expect(res.status).toBe('found');
    expect(res.quizResultMessage).toBe('퀴즈 정답 12');
    expect(res.attempts).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).toHaveBeenCalledWith(QUIZ_HTTP_FAST_RETRY_INTERVAL_MS);
  });

  it('최대 3회까지 재시도하고 모두 실패하면 http_failed를 반환한다', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(seminarQuiz, 'loadCheatsheet').mockResolvedValue({});
    const fetchSpy = vi
      .spyOn(seminarSurveyApi, 'fetchSeminarSurveyQuizHttp')
      .mockResolvedValue(buildHttpFailure('Villeway 설문 인증 실패 (HTTP 401)'));

    const res = await tryFetchSeminarQuizHttpFast('6001', false, { sleepFn });

    expect(QUIZ_HTTP_FAST_MAX_ATTEMPTS).toBe(3);
    expect(res.status).toBe('http_failed');
    expect(res.quizResultMessage).toBeNull();
    expect(res.attempts).toBe(3);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(sleepFn).toHaveBeenCalledTimes(2);
  });

  it('재시도 간격을 옵션으로 주입할 수 있다 (테스트/운영 공통)', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(seminarQuiz, 'loadCheatsheet').mockResolvedValue({});
    vi.spyOn(seminarSurveyApi, 'fetchSeminarSurveyQuizHttp').mockResolvedValue(buildHttpFailure());

    await tryFetchSeminarQuizHttpFast('6001', false, { sleepFn, retryIntervalMs: 10, maxAttempts: 2 });

    expect(sleepFn).toHaveBeenCalledTimes(1);
    expect(sleepFn).toHaveBeenCalledWith(10);
  });

  it('seminarId가 없으면 조회/재시도 없이 http_failed를 반환한다', async () => {
    const fetchSpy = vi.spyOn(seminarSurveyApi, 'fetchSeminarSurveyQuizHttp');

    const res = await tryFetchSeminarQuizHttpFast(null, false, { sleepFn: async () => {} });

    expect(res.status).toBe('http_failed');
    expect(res.attempts).toBe(0);
    expect(res.errorMessage).toContain('seminarId');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('http_failed vs no_quiz 구별', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('HTTP 성공 응답에 퀴즈 문항이 0개이고 정답 메시지도 없으면 no_quiz이며 재시도하지 않는다', async () => {
    const sleepFn = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(seminarQuiz, 'loadCheatsheet').mockResolvedValue({});
    const fetchSpy = vi.spyOn(seminarSurveyApi, 'fetchSeminarSurveyQuizHttp').mockResolvedValue(
      buildHttpSuccess({
        quizQuestionCnt: 0,
        depthSurveyQuestionCnt: 0,
        quizSummaryMessage: '',
        quizResultMessage: '',
      }),
    );

    const res = await tryFetchSeminarQuizHttpFast('6001', false, { sleepFn });

    expect(res.status).toBe('no_quiz');
    expect(res.quizResultMessage).toBeNull();
    expect(res.attempts).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sleepFn).not.toHaveBeenCalled();
  });

  it('심화설문 문항만 있는 경우(quizSummaryMessage = 심화N)는 found로 취급한다', async () => {
    vi.spyOn(seminarQuiz, 'loadCheatsheet').mockResolvedValue({});
    vi.spyOn(seminarSurveyApi, 'fetchSeminarSurveyQuizHttp').mockResolvedValue(
      buildHttpSuccess({
        quizQuestionCnt: 0,
        depthSurveyQuestionCnt: 2,
        isAdvancedSurvey: true,
        quizSummaryMessage: '심화2',
        quizResultMessage: '심화2',
      }),
    );

    const res = await tryFetchSeminarQuizHttpFast('6001', true);

    expect(res.status).toBe('found');
    expect(res.quizResultMessage).toBe('심화2');
  });

  it('resolveQuizHttpFastStatus는 응답 형태별로 상태를 구분한다', () => {
    expect(resolveQuizHttpFastStatus({ success: true, quizResultMessage: '퀴즈 정답 1' }).status).toBe('found');
    expect(resolveQuizHttpFastStatus({ success: true, quizQuestionCnt: 0, depthSurveyQuestionCnt: 0 }).status).toBe(
      'no_quiz',
    );
    const abnormal = resolveQuizHttpFastStatus({ success: true, quizQuestionCnt: 2 });
    expect(abnormal.status).toBe('http_failed');
    expect(abnormal.errorMessage).toBeTruthy();
  });
});

describe('세미나 상태 반영 (applySeminarQuizHttpFetchResult)', () => {
  it('http_failed + 정답 없음이면 분석중(quizAnalysisPending) 상태가 된다', () => {
    const seminar = buildSeminar();
    applySeminarQuizHttpFetchResult(seminar, {
      status: 'http_failed',
      quizResultMessage: null,
      attempts: 3,
      seminarId: '6001',
      errorMessage: 'HTTP 500',
    });

    expect(seminar.quizFetchStatus).toBe('http_failed');
    expect(seminar.quizAnalysisPending).toBe(true);
    expect(isQuizAnalysisPending(seminar)).toBe(true);
  });

  it('no_quiz이면 분석중 상태로 두지 않는다', () => {
    const seminar = buildSeminar();
    applySeminarQuizHttpFetchResult(seminar, {
      status: 'no_quiz',
      quizResultMessage: null,
      attempts: 1,
      seminarId: '6001',
    });

    expect(seminar.quizFetchStatus).toBe('no_quiz');
    expect(seminar.quizAnalysisPending).toBe(false);
    expect(isQuizAnalysisPending(seminar)).toBe(false);
  });

  it('found이면 정답 메시지를 저장하고 분석중 상태를 해제한다', () => {
    const seminar = buildSeminar({ quizAnalysisPending: true, quizFetchStatus: 'http_failed' });
    applySeminarQuizHttpFetchResult(seminar, {
      status: 'found',
      quizResultMessage: '퀴즈 정답 31',
      attempts: 2,
      seminarId: '6001',
    });

    expect(seminar.quizResultMessage).toBe('퀴즈 정답 31');
    expect(seminar.quizFetchStatus).toBe('found');
    expect(seminar.quizAnalysisPending).toBe(false);
    expect(isQuizAnalysisPending(seminar)).toBe(false);
  });

  it('이미 정답이 있는 세미나의 http_failed는 분석중 상태로 만들지 않는다', () => {
    const seminar = buildSeminar({ quizResultMessage: '퀴즈 정답 12' });
    applySeminarQuizHttpFetchResult(seminar, {
      status: 'http_failed',
      quizResultMessage: null,
      attempts: 3,
      seminarId: '6001',
    });

    expect(seminar.quizAnalysisPending).toBe(false);
    expect(isQuizAnalysisPending(seminar)).toBe(false);
  });
});

describe('개별 종료 알림 문구 분기', () => {
  it('http_failed로 정답 없이 발송되는 경우 메인 채널 업데이트 안내를 포함한다', () => {
    const seminar = buildSeminar({ quizFetchStatus: 'http_failed', quizAnalysisPending: true });
    const { text } = buildSeminarLiveEndMessage(seminar);

    expect(text).toContain('🔴 <b>[세미나 종료]</b>');
    expect(text).toContain(CHANNEL_GUIDE_TEXT);
    expect(text).not.toContain(QUIZ_ANALYSIS_PENDING_TEXT);
  });

  it('진짜 퀴즈 문항이 없는 세미나(no_quiz)에는 메인 채널 안내 대신 퀴즈없이 설문만😆 문구를 넣는다', () => {
    const seminar = buildSeminar({ quizFetchStatus: 'no_quiz', quizAnalysisPending: false });
    const { text } = buildSeminarLiveEndMessage(seminar);

    expect(text).toContain(QUIZ_ABSENT_TEXT);
    expect(text).not.toContain(CHANNEL_GUIDE_TEXT);
    expect(text).not.toContain(QUIZ_ANALYSIS_PENDING_TEXT);
  });

  it('http_failed(분석 대기)일 때는 퀴즈없이 설문만😆 문구를 넣지 않는다', () => {
    const seminar = buildSeminar({ quizFetchStatus: 'http_failed', quizAnalysisPending: true });
    const { text } = buildSeminarLiveEndMessage(seminar);

    expect(text).not.toContain(QUIZ_ABSENT_TEXT);
    expect(text).toContain(CHANNEL_GUIDE_TEXT);
  });

  it('no_quiz여도 설문 자체가 없는 세미나는 퀴즈없이 설문만😆 대신 (설문이 없는 세미나)를 표시한다', () => {
    const seminar = buildSeminar({ quizFetchStatus: 'no_quiz', hasSurvey: false });
    const { text } = buildSeminarLiveEndMessage(seminar);

    expect(text).toContain('(설문이 없는 세미나)');
    expect(text).not.toContain(QUIZ_ABSENT_TEXT);
  });

  it('포인트 미지급(설문 포인트 제외) 세미나는 no_quiz여도 퀴즈없이 설문만😆 문구를 넣지 않는다', () => {
    const seminar = buildSeminar({ quizFetchStatus: 'no_quiz', isSurveyPointExcluded: true });
    const { text } = buildSeminarLiveEndMessage(seminar);

    expect(text).not.toContain(QUIZ_ABSENT_TEXT);
  });

  it('정답을 확보한 세미나는 기존처럼 정답을 담고 채널 안내를 넣지 않는다', () => {
    const seminar = buildSeminar({ quizResultMessage: '퀴즈 정답 12', quizFetchStatus: 'found' });
    const { text } = buildSeminarLiveEndMessage(seminar);

    expect(text).toContain('퀴즈 정답 12');
    expect(text).not.toContain(CHANNEL_GUIDE_TEXT);
  });
});

describe('공지봇 개별 발송 (sendSeminarLiveEndNotice)', () => {
  beforeEach(() => {
    storage.setDatabasePath(':memory:');
    storage.clear();
  });

  it('http_failed 세미나의 종료 알림을 구독자에게 메인 채널 업데이트 안내와 함께 보낸다', async () => {
    const sentMessages: Array<{ chatId: number; text: string }> = [];
    const mockBot = {
      command: () => {},
      action: () => {},
      telegram: {
        sendMessage: async (chatId: number, text: string) => {
          sentMessages.push({ chatId, text });
          return { message_id: 1001 };
        },
      },
    };
    setBot('notice', mockBot as unknown as Parameters<typeof setBot>[1]);
    updateSubscription(301, { seminarLive: true });

    const seminar = buildSeminar({ quizFetchStatus: 'http_failed', quizAnalysisPending: true });
    const res = await sendSeminarLiveEndNotice(seminar);

    expect(res.successCount).toBe(1);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].chatId).toBe(301);
    expect(sentMessages[0].text).toContain(CHANNEL_GUIDE_TEXT);

    storage.closeDatabase();
  });

  it('no_quiz 세미나의 종료 알림을 구독자에게 퀴즈없이 설문만😆 문구와 함께 보낸다', async () => {
    const sentMessages: Array<{ chatId: number; text: string }> = [];
    const mockBot = {
      command: () => {},
      action: () => {},
      telegram: {
        sendMessage: async (chatId: number, text: string) => {
          sentMessages.push({ chatId, text });
          return { message_id: 1002 };
        },
      },
    };
    setBot('notice', mockBot as unknown as Parameters<typeof setBot>[1]);
    updateSubscription(302, { seminarLive: true });

    const seminar = buildSeminar({ quizFetchStatus: 'no_quiz', quizAnalysisPending: false });
    const res = await sendSeminarLiveEndNotice(seminar);

    expect(res.successCount).toBe(1);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].chatId).toBe(302);
    expect(sentMessages[0].text).toContain(QUIZ_ABSENT_TEXT);
    expect(sentMessages[0].text).not.toContain(CHANNEL_GUIDE_TEXT);

    storage.closeDatabase();
  });
});

describe('메인 채널 현황판 문항분석중 표시와 브라우저 파싱 후 업데이트', () => {
  it('http_failed로 정답이 없으면 현황판에 문항분석중.. 을 표시한다', () => {
    const seminar = buildSeminar({ quizFetchStatus: 'http_failed', quizAnalysisPending: true });
    const { text } = buildSeminarStatusMessage('저녁', [seminar]);

    expect(text).toContain('🔴 종료');
    expect(text).toContain(QUIZ_ANALYSIS_PENDING_TEXT);
  });

  it('브라우저 파싱으로 정답을 얻으면 분석중 표시가 사라지고 정답 요약으로 바뀐다', () => {
    const seminar = buildSeminar({ quizFetchStatus: 'http_failed', quizAnalysisPending: true });
    expect(buildSeminarStatusMessage('저녁', [seminar]).text).toContain(QUIZ_ANALYSIS_PENDING_TEXT);

    completeSeminarQuizAnalysis(
      seminar,
      '퀴즈 정답 24\n\n✅ Q1: 퀴즈1 문제\n   → 정답2 (2번)\n✅ Q2: 퀴즈2 문제\n   → 정답4 (4번)',
    );

    const { text } = buildSeminarStatusMessage('저녁', [seminar]);
    expect(text).not.toContain(QUIZ_ANALYSIS_PENDING_TEXT);
    expect(text).toContain('퀴즈 정답 24');
    expect(text).not.toContain('✅ Q1: 퀴즈1 문제');
  });

  it('브라우저 파싱에서도 정답을 못 얻으면 분석중 표시만 내리고 정답 라인은 남기지 않는다', () => {
    const seminar = buildSeminar({ quizFetchStatus: 'http_failed', quizAnalysisPending: true });

    completeSeminarQuizAnalysis(seminar, null);

    const { text } = buildSeminarStatusMessage('저녁', [seminar]);
    expect(text).not.toContain(QUIZ_ANALYSIS_PENDING_TEXT);
    expect(seminar.quizAnalysisPending).toBe(false);
    expect(seminar.quizFetchStatus).toBe('http_failed');
  });

  it('no_quiz 세미나는 현황판에 문항분석중.. 대신 퀴즈없이 설문만😆 을 표시한다', () => {
    const seminar = buildSeminar({ quizFetchStatus: 'no_quiz' });
    const { text } = buildSeminarStatusMessage('저녁', [seminar]);

    expect(text).toContain(QUIZ_ABSENT_TEXT);
    expect(text).not.toContain(QUIZ_ANALYSIS_PENDING_TEXT);
  });

  it('no_quiz여도 설문 자체가 없는 세미나 현황판에는 퀴즈없이 설문만😆 을 표시하지 않는다', () => {
    const seminar = buildSeminar({ quizFetchStatus: 'no_quiz', hasSurvey: false });
    const { text } = buildSeminarStatusMessage('저녁', [seminar]);

    expect(text).not.toContain(QUIZ_ABSENT_TEXT);
    expect(text).toContain('(설문이 없는 세미나)');
  });

  it('http_failed 후 브라우저 파싱으로 퀴즈가 없음이 확인되면 현황판이 퀴즈없이 설문만😆 으로 바뀐다', () => {
    const seminar = buildSeminar({ quizFetchStatus: 'http_failed', quizAnalysisPending: true });
    expect(buildSeminarStatusMessage('저녁', [seminar]).text).toContain(QUIZ_ANALYSIS_PENDING_TEXT);

    completeSeminarQuizAnalysis(seminar, null, true);

    const { text } = buildSeminarStatusMessage('저녁', [seminar]);
    expect(text).toContain(QUIZ_ABSENT_TEXT);
    expect(text).not.toContain(QUIZ_ANALYSIS_PENDING_TEXT);
    expect(seminar.quizFetchStatus).toBe('no_quiz');
  });

  it('브라우저 파싱으로 정답을 얻은 세미나는 퀴즈없이 설문만😆 을 표시하지 않는다', () => {
    const seminar = buildSeminar({ quizFetchStatus: 'http_failed', quizAnalysisPending: true });

    completeSeminarQuizAnalysis(seminar, '퀴즈 정답 31', true);

    const { text } = buildSeminarStatusMessage('저녁', [seminar]);
    expect(text).toContain('퀴즈 정답 31');
    expect(text).not.toContain(QUIZ_ABSENT_TEXT);
  });

  it('이전 공지 본문의 문항분석중.. 라인은 퀴즈 정답으로 복원하지 않는다', () => {
    const prevText = [
      '🔔 [2026-11-26 (목)] 저녁세미나',
      '',
      '🔴 종료 | 19:00~20:00 분석중 상태 테스트 세미나',
      'https://m.doctorville.co.kr/cme/seminar/6001',
      '문항분석중..',
      '(설문 마감 약 50분 남음)',
    ].join('\n');

    const parsed = parsePrevNoticeSeminars(prevText);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].seminarId).toBe('6001');
    expect(parsed[0].quizResultMessage).toBeUndefined();
  });

  it('이전 공지 본문의 퀴즈없이 설문만😆 라인은 퀴즈 정답으로 복원하지 않고 no_quiz 표시로만 인식한다', () => {
    const prevText = [
      '🔔 [2026-11-26 (목)] 저녁세미나',
      '',
      '🔴 종료 | 19:00~20:00 설문만 있는 세미나',
      'https://m.doctorville.co.kr/cme/seminar/6002',
      QUIZ_ABSENT_TEXT,
      '(설문 마감 약 50분 남음)',
    ].join('\n');

    const parsed = parsePrevNoticeSeminars(prevText);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].seminarId).toBe('6002');
    expect(parsed[0].quizResultMessage).toBeUndefined();
    expect(parsed[0].quizAbsent).toBe(true);
    expect(isQuizAbsentLine(QUIZ_ABSENT_TEXT)).toBe(true);
    expect(isQuizAbsentLine('문항분석중..')).toBe(false);
  });

  it('isQuizAbsentOnly는 no_quiz 확정 + 설문 존재 세미나에서만 true다', () => {
    expect(isQuizAbsentOnly(buildSeminar({ quizFetchStatus: 'no_quiz' }))).toBe(true);
    expect(isQuizAbsentOnly(buildSeminar({ quizFetchStatus: 'http_failed' }))).toBe(false);
    expect(isQuizAbsentOnly(buildSeminar({ quizFetchStatus: 'found' }))).toBe(false);
    expect(isQuizAbsentOnly(buildSeminar({ quizFetchStatus: 'no_quiz', hasSurvey: false }))).toBe(false);
    expect(isQuizAbsentOnly(buildSeminar({ quizFetchStatus: 'no_quiz', isSurveyPointExcluded: true }))).toBe(false);
    expect(isQuizAbsentOnly(buildSeminar({ quizFetchStatus: 'no_quiz', quizResultMessage: '퀴즈 정답 12' }))).toBe(
      false,
    );
  });
});
