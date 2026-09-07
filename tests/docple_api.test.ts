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
      // 1. users/info
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            myCash: 15400,
            name: '홍길동',
          },
        }),
      );

      // 2. cash/recent
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [
            { id: 1, cash: 10, title: '출석체크 리워드', createdDt: '2026-09-07' },
            { id: 2, cash: 50, title: '추천 리워드', createdDt: '2026-09-07' },
          ],
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

    it('getDocpleActiveQuizzes & getDocpleQuizDetail & getDocpleMedicineDetail & formatDocpleQuizTelegramMessage', async () => {
      // 1. 활성 퀴즈 목록
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            quizzes: [
              {
                quizId: 49,
                quizName: '선착순 퀴즈',
                rewardCash: 100,
                medicineId: 3,
              },
            ],
          },
        }),
      );

      const { getDocpleActiveQuizzes, getDocpleQuizDetail, getDocpleMedicineDetail, formatDocpleQuizTelegramMessage } =
        await import('../src/modules/docple_api');

      const quizzes = await getDocpleActiveQuizzes('mock-token');
      expect(quizzes.length).toBe(1);
      expect(quizzes[0].quizId).toBe(49);

      // 2. 퀴즈 상세
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            quizId: 49,
            quizName: '선착순 퀴즈',
            remainingAttempts: 3,
            maxDailyAttempts: 3,
            questions: [
              {
                questionId: 133,
                questionText: '아르시스주는 어떤 수액제일까요?',
                options: [
                  { optionId: 368, optionText: '분말 수액제' },
                  { optionId: 369, optionText: 'Pre-mix 수액제' },
                ],
              },
            ],
          },
        }),
      );

      const quizDetail = await getDocpleQuizDetail('mock-token', 49);
      expect(quizDetail).not.toBeNull();
      expect(quizDetail?.questions.length).toBe(1);

      // 3. 의약품 상세
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            id: 3,
            medicineName: '아르시스주',
            pharmaCompanyName: '일화',
            mainIngredient: 'L-아르기닌염산염',
          },
        }),
      );

      const medDetail = await getDocpleMedicineDetail('mock-token', 3);
      expect(medDetail).not.toBeNull();
      expect(medDetail?.medicineName).toBe('아르시스주');

      // 4. 메시지 포맷팅
      const msg = formatDocpleQuizTelegramMessage({
        quiz: quizDetail!,
        medicine: medDetail,
        medicineId: 3,
      });

      expect(msg).toContain('💊 [닥플 e-디테일링 Quiz 안내]');
      expect(msg).toContain('선착순 퀴즈');
      expect(msg).toContain('+100 캐시');
      expect(msg).toContain('아르시스주 (일화)');
      expect(msg).toContain('L-아르기닌염산염');
      expect(msg).toContain('아르시스주는 어떤 수액제일까요?');
      expect(msg).toContain('1️⃣ 분말 수액제');
      expect(msg).toContain('2️⃣ Pre-mix 수액제');
    });

    it('authDocpleCommunityPassword & getDocpleCommunityPosts & recommendDocpleCommunityPost', async () => {
      // 1. 커뮤니티 비밀번호 인증
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          resultCode: '0',
          result: {
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
          resultCode: '0',
          result: {
            communityList: [
              { bid: 501, no: 101, title: '[공지] 이용 안내', noticeYN: 'Y' },
              { bid: 502, no: 102, title: '[이벤트] 닥플 퀴즈 이벤트', noticeYN: 'E' },
              { bid: 503, no: 103, title: '[SOS] 진료 질문입니다', noticeYN: 'P' },
              { bid: 504, no: 104, title: '일반글 1', noticeYN: 'N', useYN: 'Y', reCom: 'N' },
              { bid: 505, no: 105, title: '일반글 2', noticeYN: 'N', useYN: 'Y', reCom: 'R' },
              { bid: 506, no: 106, title: '일반글 3', noticeYN: 'N', useYN: 'Y', reCom: 'N' },
            ],
          },
        }),
      );

      const posts = await getDocpleCommunityPosts('mock-token', { communityToken: 'comm-jwt-token' });
      expect(posts.length).toBe(6);

      // 필터링 검증
      const eligible = posts.filter((p) => !p.isNotice && !p.isEvent && !p.isSOS && !p.isDeleted && !p.isRecommended);
      expect(eligible.length).toBe(2);
      expect(eligible.map((p) => p.bid)).toEqual([504, 506]);

      // 3. 추천
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          resultCode: '0',
          result: {
            cashGrantInfo: {
              rewarded: true,
              cashAmount: 10,
              message: '추천 보상 10 캐시가 적립되었습니다',
            },
          },
        }),
      );

      const recRes = await recommendDocpleCommunityPost('mock-token', {
        bid: 504,
        no: 104,
        grpCode: 'NI',
        subCode: '',
        communityToken: 'comm-jwt-token',
      });
      expect(recRes.success).toBe(true);
      expect(recRes.rewardCash).toBe(10);
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

      // 2. 시작 캐시: users/info
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: { myCash: 5000 },
        }),
      );
      // 시작 캐시: cash/recent
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [],
        }),
      );

      // 3. 출석 캘린더
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: { attendedDates: [] },
        }),
      );

      // 4. 출석체크 실행
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          success: true,
          data: { dailyGranted: true, dailyCash: 50 },
        }),
      );

      // 5. 퀴즈 활성 목록, 상세, 의약품 상세
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            quizzes: [{ quizId: 49, quizName: '테스트 퀴즈', medicineId: 99 }],
          },
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            quizId: 49,
            quizName: '테스트 퀴즈',
            remainingAttempts: 3,
            questions: [{ questionId: 1, questionText: '테스트 질문', options: [] }],
          },
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            id: 99,
            medicineName: '테스트약',
          },
        }),
      );

      // 6. 커뮤니티 비밀번호 인증
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          resultCode: '0',
          result: { communityToken: 'comm-token' },
        }),
      );

      // 7. 커뮤니티 글 목록
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          resultCode: '0',
          result: {
            communityList: [{ bid: 1234, no: 888, title: '좋은 하루 되세요', noticeYN: 'N', useYN: 'Y', reCom: 'N' }],
          },
        }),
      );

      // 8. 게시글 추천
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          resultCode: '0',
          result: { cashGrantInfo: { rewarded: true, cashAmount: 10 } },
        }),
      );

      // 9. 종료 캐시: users/info
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: { myCash: 5060 },
        }),
      );
      // 종료 캐시: cash/recent
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [],
        }),
      );

      const taskRes = await runDocpleDaily({
        args: {
          user: 'user1',
          password: 'pass1',
          communityPassword: 'comm1',
        },
      });

      expect(taskRes.success).toBe(true);
      expect(taskRes.message).toContain('📋 [닥플 플러스 일일 자동화 리포트]');
      expect(taskRes.message).toContain('5,000원 → 5,060원 (+60원)');
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
