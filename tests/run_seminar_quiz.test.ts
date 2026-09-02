import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as seminarQuizModule from '../src/tasks/seminar_quiz';
import * as monitorSeminarsModule from '../src/tasks/monitor_seminars';
import * as utilsModule from '../src/modules/utils';
import { run } from '../src/tasks/run_seminar_quiz';
import type { Page, BrowserContext } from 'playwright';

describe('run_seminar_quiz 태스크 단위 테스트', () => {
  let mockPage: Partial<Page>;
  let mockSurveyPage: Partial<Page>;
  let mockBrowserCtx: Partial<BrowserContext>;

  beforeEach(() => {
    mockSurveyPage = {
      close: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue({
        first: vi.fn().mockReturnValue({
          isVisible: vi.fn().mockResolvedValue(true),
          click: vi.fn().mockResolvedValue(undefined),
          isChecked: vi.fn().mockResolvedValue(false),
        }),
      }),
      waitForLoadState: vi.fn().mockResolvedValue(undefined),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    };

    mockBrowserCtx = {
      newPage: vi.fn().mockResolvedValue(mockSurveyPage as Page),
      waitForEvent: vi.fn().mockResolvedValue(null),
    };

    mockPage = {
      context: vi.fn().mockReturnValue(mockBrowserCtx as BrowserContext),
    };

    vi.spyOn(utilsModule, 'ensureLoggedIn').mockResolvedValue(undefined);
    vi.spyOn(utilsModule, 'safeGoto').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('seminarId가 없는 경우 실패 반환', async () => {
    const res = await run({ page: mockPage as Page }, { args: {} });
    expect(res.success).toBe(false);
    expect(res.message).toContain('seminarId 가 비어 있습니다');
  });

  it('퀴즈 풀이 성공 시 setSeminarQuizAnswer를 호출하여 공지 메시지를 수정하고 결과를 반환', async () => {
    const processQuizSpy = vi.spyOn(seminarQuizModule, 'processSeminarQuiz').mockResolvedValue({
      success: true,
      hasQuizResult: true,
      message: '[퀴즈] 정답 123\n\n✅ Q1: 문제1 (1번)\n✅ Q2: 문제2 (2번)\n✅ Q3: 문제3 (3번)',
    });

    const setAnswerSpy = vi.spyOn(monitorSeminarsModule, 'setSeminarQuizAnswer').mockResolvedValue({
      success: true,
      message: '📢 공지방 세미나(5612) 퀴즈 정답 수정 완료!',
      formattedAnswer: '[퀴즈] 정답 123',
      channelMessageId: 2489,
      isLiveUpdated: true,
    });

    const res = await run({ page: mockPage as Page }, { args: { seminarId: '5612' } });

    expect(processQuizSpy).toHaveBeenCalledWith(expect.anything(), '5612', false);
    expect(setAnswerSpy).toHaveBeenCalledWith('5612', '[퀴즈] 정답 123');
    expect(res.success).toBe(true);
    expect(res.message).toContain('[수동세미나 5612]');
    expect(res.message).toContain('📢 공지방 세미나(5612) 퀴즈 정답 수정 완료!');
  });

  it('퀴즈 결과가 없는 세미나의 경우 setSeminarQuizAnswer를 호출하지 않음', async () => {
    const processQuizSpy = vi.spyOn(seminarQuizModule, 'processSeminarQuiz').mockResolvedValue({
      success: true,
      hasQuizResult: false,
      message: 'ℹ️ 설문 페이지에서 퀴즈를 찾지 못했습니다.',
    });

    const setAnswerSpy = vi.spyOn(monitorSeminarsModule, 'setSeminarQuizAnswer');

    const res = await run({ page: mockPage as Page }, { args: { seminarId: '5612' } });

    expect(processQuizSpy).toHaveBeenCalled();
    expect(setAnswerSpy).not.toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(res.message).toContain('ℹ️ 설문 페이지에서 퀴즈를 찾지 못했습니다.');
  });
});
