import { describe, it, expect, vi, beforeEach } from 'vitest';
import { request } from 'undici';
import {
  loginDocple,
  getDocpleCash,
  checkDocpleAttendance,
  getDocpleEdetailingMedicines,
  extractDocpleQuizUrls,
  authDocpleCommunityPassword,
  getDocpleCommunityPosts,
  recommendDocpleCommunityPost,
} from '../src/modules/docple_api';
import {
  executeDocpleDaily,
  formatDocpleDailyReport,
  run as runDocpleDaily,
  type DocpleDailyWorkflowResult,
} from '../src/tasks/docple_daily';

vi.mock('undici', () => ({
  request: vi.fn(),
}));

const mockRequest = vi.mocked(request);

function createMockTextResponse(data: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: {},
    body: {
      text: async () => (typeof data === 'string' ? data : JSON.stringify(data)),
      json: async () => (typeof data === 'string' ? JSON.parse(data) : data),
    },
  } as unknown as Awaited<ReturnType<typeof request>>;
}

function createMockJsonResponse(data: unknown, statusCode = 200) {
  return {
    statusCode,
    headers: {},
    body: {
      text: async () => JSON.stringify(data),
      json: async () => data,
    },
  } as unknown as Awaited<ReturnType<typeof request>>;
}

describe('Docple Plus API & Daily Task Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('API Client Methods', () => {
    it('loginDocple: 로그인 성공 시 토큰 반환', async () => {
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          success: true,
          data: {
            accessToken: 'mock-access-token',
            refreshToken: 'mock-refresh-token',
            joinType: 'DOCTOR',
            uid: 'docple_user_1',
          },
        }),
      );

      const result = await loginDocple('test_user', 'test_pass');
      expect(result.success).toBe(true);
      expect(result.data?.accessToken).toBe('mock-access-token');
      expect(result.data?.joinType).toBe('DOCTOR');
    });

    it('loginDocple: 로그인 실패 시 실패 메시지 반환', async () => {
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse(
          {
            success: false,
            code: 'LOGIN_FAIL',
            message: '아이디 또는 비밀번호가 일치하지 않아요',
          },
          400,
        ),
      );

      const result = await loginDocple('wrong_user', 'wrong_pass');
      expect(result.success).toBe(false);
      expect(result.code).toBe('LOGIN_FAIL');
      expect(result.message).toContain('일치하지 않아요');
    });

    it('getDocpleCash: 캐시 잔액 및 내역 반환', async () => {
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            totalCash: 15400,
            recentList: [
              { id: 1, cash: 10, title: '출석체크 리워드', createdDt: '2026-09-07' },
              { id: 2, cash: 50, title: '추천 리워드', createdDt: '2026-09-07' },
            ],
          },
        }),
      );

      const cashInfo = await getDocpleCash('mock-token');
      expect(cashInfo).not.toBeNull();
      expect(cashInfo?.totalCash).toBe(15400);
      expect(cashInfo?.recentList?.length).toBe(2);
    });

    it('checkDocpleAttendance: 출석체크 성공 및 이미 출석 케이스 처리', async () => {
      // 1. 성공 케이스
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          success: true,
          data: {
            rewardCash: 10,
            accumulatedDays: 5,
          },
        }),
      );

      const successRes = await checkDocpleAttendance('mock-token');
      expect(successRes.status).toBe('SUCCESS');
      expect(successRes.rewardCash).toBe(10);

      // 2. 이미 출석한 케이스
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse(
          {
            success: false,
            code: 'ALREADY_ATTENDED',
            message: '오늘 이미 출석체크를 완료하셨습니다.',
          },
          200,
        ),
      );

      const alreadyRes = await checkDocpleAttendance('mock-token');
      expect(alreadyRes.status).toBe('ALREADY');
      expect(alreadyRes.message).toContain('이미');
    });

    it('getDocpleEdetailingMedicines & extractDocpleQuizUrls: 퀴즈 URL 정상 추출', async () => {
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            items: [
              { id: 101, name: '엔트레스토', companyName: '노바티스', hasQuiz: true },
              { id: 102, name: '자디앙', companyName: '베링거인겔하임', hasQuiz: true },
              { id: 103, name: '트라젠타', companyName: '베링거인겔하임', hasQuiz: false },
            ],
          },
        }),
      );

      const medicines = await getDocpleEdetailingMedicines('mock-token');
      expect(medicines.length).toBe(3);

      const quizUrls = extractDocpleQuizUrls(medicines);
      expect(quizUrls.length).toBe(2);
      expect(quizUrls[0]).toEqual({
        id: 101,
        name: '엔트레스토',
        url: 'https://docple-plus.com/e-detailing/101',
      });
      expect(quizUrls[1]).toEqual({
        id: 102,
        name: '자디앙',
        url: 'https://docple-plus.com/e-detailing/102',
      });
    });

    it('authDocpleCommunityPassword & getDocpleCommunityPosts & recommendDocpleCommunityPost', async () => {
      // 1. 커뮤니티 비밀번호 인증
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          success: true,
          data: {
            communityToken: 'comm-jwt-token',
          },
        }),
      );

      const authRes = await authDocpleCommunityPassword('mock-token', 'my_comm_pass');
      expect(authRes.success).toBe(true);
      expect(authRes.communityToken).toBe('comm-jwt-token');

      // 2. 글 목록 조회
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            list: [
              { tid: 501, title: '[공지] 이용 안내', isNotice: true },
              { tid: 502, title: '[이벤트] 닥플 퀴즈 이벤트', isEvent: true },
              { tid: 503, title: '[SOS] 진료 질문입니다', isSOS: true },
              { tid: 504, title: '일반글 1', isNotice: false, isEvent: false, isSOS: false, isRecommended: false },
              { tid: 505, title: '일반글 2', isNotice: false, isEvent: false, isSOS: false, isRecommended: true },
              { tid: 506, title: '일반글 3', isNotice: false, isEvent: false, isSOS: false, isRecommended: false },
            ],
          },
        }),
      );

      const posts = await getDocpleCommunityPosts('mock-token', { communityToken: 'comm-jwt-token' });
      expect(posts.length).toBe(6);

      // 필터링 검증
      const eligible = posts.filter((p) => !p.isNotice && !p.isEvent && !p.isSOS && !p.isDeleted && !p.isRecommended);
      expect(eligible.length).toBe(2);
      expect(eligible.map((p) => p.tid)).toEqual([504, 506]);

      // 3. 추천
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          success: true,
          message: '게시글이 추천되었습니다.',
        }),
      );

      const recRes = await recommendDocpleCommunityPost('mock-token', 504, 'NI', '', 'comm-jwt-token');
      expect(recRes.success).toBe(true);
    });
  });

  describe('Daily Task Workflow & Report Formatting', () => {
    it('formatDocpleDailyReport: 리포트 문자열이 올바르게 생성되는지 확인', () => {
      const mockResult: DocpleDailyWorkflowResult = {
        success: true,
        message: '완료',
        startCash: 1000,
        endCash: 1110,
        cashDiff: 110,
        attendance: {
          status: 'SUCCESS',
          rewardCash: 10,
          message: '출석체크 성공 (+10 캐시)',
        },
        quizList: [
          { id: 1, name: '의약품 A', url: 'https://docple-plus.com/e-detailing/1' },
          { id: 2, name: '의약품 B', url: 'https://docple-plus.com/e-detailing/2' },
        ],
        recommendedPosts: [
          { tid: 101, title: '게시글 1', success: true, message: '추천 성공' },
          { tid: 102, title: '게시글 2', success: true, message: '추천 성공' },
        ],
        errors: [],
      };

      const report = formatDocpleDailyReport(mockResult);
      expect(report).toContain('📋 [닥플 플러스 일일 자동화 리포트]');
      expect(report).toContain('1,000원 → 1,110원 (+110원)');
      expect(report).toContain('✅ 출석체크: 완료 (+10원)');
      expect(report).toContain('e-디테일링 Quiz (2건)');
      expect(report).toContain('https://docple-plus.com/e-detailing/1');
      expect(report).toContain('커뮤니티 추천 (2건)');
    });

    it('executeDocpleDaily: 로그인 실패 시 에러 throw', async () => {
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse(
          {
            success: false,
            code: 'LOGIN_FAIL',
            message: '아이디/비밀번호 불일치',
          },
          400,
        ),
      );

      await expect(executeDocpleDaily('test_user', 'wrong_pass', 'test_comm')).rejects.toThrow(
        '닥플 로그인 실패: 아이디/비밀번호 불일치',
      );
    });

    it('run: 전체 워크플로우 성공 시 성공 TaskResult 반환', async () => {
      // 1. 로그인
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          success: true,
          data: { accessToken: 'token-123' },
        }),
      );

      // 2. 시작 캐시
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: { totalCash: 5000 },
        }),
      );

      // 3. 출석 캘린더
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: { isAttended: false },
        }),
      );

      // 4. 출석체크 실행
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          success: true,
          data: { rewardCash: 10 },
        }),
      );

      // 5. 퀴즈 의약품 목록
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            items: [{ id: 99, name: '테스트약', hasQuiz: true }],
          },
        }),
      );

      // 6. 커뮤니티 비밀번호 인증
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          success: true,
          data: { communityToken: 'comm-token' },
        }),
      );

      // 7. 커뮤니티 글 목록
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            list: [{ tid: 1234, title: '좋은 하루 되세요', isNotice: false, isRecommended: false }],
          },
        }),
      );

      // 8. 게시글 추천
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          success: true,
          message: '추천 성공',
        }),
      );

      // 9. 종료 캐시
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: { totalCash: 5010 },
        }),
      );

      const taskRes = await runDocpleDaily({
        name: 'docple_daily',
        type: 'daily',
        args: {
          user: 'user1',
          password: 'pass1',
          communityPassword: 'comm1',
        },
      });

      expect(taskRes.success).toBe(true);
      expect(taskRes.message).toContain('📋 [닥플 플러스 일일 자동화 리포트]');
      expect(taskRes.message).toContain('5,000원 → 5,010원 (+10원)');
      expect(taskRes.message).toContain('https://docple-plus.com/e-detailing/99');
      expect(taskRes.message).toContain('[1234] 좋은 하루 되세요');
    });
  });

  describe('Telegram Command Registration Tests', () => {
    it('adminCommands에 run_docple_daily_now가 등록되어 있어야 함', async () => {
      const { adminCommands } = await import('../src/services/telegram');
      const docpleCmd = adminCommands.find((c) => c.command === 'run_docple_daily_now');
      expect(docpleCmd).toBeDefined();
      expect(docpleCmd?.description).toContain('닥플');
    });
  });
});
