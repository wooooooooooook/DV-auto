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
  getDocpleCommunityPostDetail,
  getDocpleBanners,
  clickDocpleAdBanner,
  findAndClickDocpleRewardBanner,
  findAndClickAllDocpleRewardBanners,
  recommendDocpleCommunityPost,
  getDocpleSeminars,
  getDocplePopularSeminars,
  getDocpleSeminarDetail,
  agreeDocpleSeminarTerms,
  startDocpleSeminarWatch,
  reportDocpleSeminarWatchProgress,
  endDocpleSeminarWatch,
  claimDocpleSeminarReward,
  processDocpleCastReward,
  processAllDocpleCastRewards,
} from '../src/modules/docple_api';
import {
  executeDocpleDaily,
  formatDocpleDailyReport,
  run as runDocpleDaily,
  type DocpleDailyWorkflowResult,
} from '../src/tasks/docple_daily';
import * as utilsModule from '../src/modules/utils';

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
    vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true);
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

    it('submitDocpleQuiz: 퀴즈 정답 제출 및 보상 결과 확인', async () => {
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            isPassed: true,
            isCashGranted: true,
            grantedCash: 100,
            remainingAttempts: 2,
          },
        }),
      );

      const { submitDocpleQuiz } = await import('../src/modules/docple_api');
      const submitRes = await submitDocpleQuiz('mock-token', 49, [{ questionId: 133, selectedOptionId: 369 }]);

      expect(submitRes.success).toBe(true);
      expect(submitRes.isPassed).toBe(true);
      expect(submitRes.isCashGranted).toBe(true);
      expect(submitRes.grantedCash).toBe(100);
      expect(submitRes.remainingAttempts).toBe(2);
    });

    it('matchDocpleQuizAnswersWithCheatsheet: 족보와 퀴즈 매칭 검증', async () => {
      const { matchDocpleQuizAnswersWithCheatsheet } = await import('../src/modules/docple_api');

      const quizDetail = {
        quizId: 49,
        quizName: '테스트 퀴즈',
        questions: [
          {
            questionId: 10,
            questionText: '아르시스주는 어떤 수액제일까요?',
            options: [
              { optionId: 1, optionText: '분말 수액제' },
              { optionId: 2, optionText: 'Pre-mix 수액제' },
            ],
          },
          {
            questionId: 20,
            questionText: '다음 중 혈압약은 무엇일까요?',
            options: [
              { optionId: 3, optionText: '노바스크' },
              { optionId: 4, optionText: '타이레놀' },
            ],
          },
        ],
      };

      const cheatsheet = {
        '아르시스주는 어떤 수액제': 'Pre-mix 수액제',
        혈압약: '노바스크',
      };

      const matchRes = matchDocpleQuizAnswersWithCheatsheet(quizDetail, cheatsheet);
      expect(matchRes.isFullyMatched).toBe(true);
      expect(matchRes.answers.length).toBe(2);
      expect(matchRes.answers[0].selectedOptionId).toBe(2);
      expect(matchRes.answers[1].selectedOptionId).toBe(3);
      expect(matchRes.unmatchedQuestions.length).toBe(0);

      // 미매칭 테스트
      const unmatchedRes = matchDocpleQuizAnswersWithCheatsheet(quizDetail, {
        '아르시스주는 어떤 수액제': 'Pre-mix 수액제',
      });
      expect(unmatchedRes.isFullyMatched).toBe(false);
      expect(unmatchedRes.unmatchedQuestions.length).toBe(1);
      expect(unmatchedRes.unmatchedQuestions[0]).toContain('혈압약');
    });

    it('parseQuizQuestionsFromText: 닥플 포맷 및 세미나 포맷 파싱 검증', async () => {
      const { parseQuizQuestionsFromText } = await import('../src/services/telegram/quiz_cheatsheet');

      // 1. 닥플 퀴즈 포맷 (이모지 포함)
      const docpleMsg = `
💊 [닥플 e-디테일링 Quiz 안내]
📌 퀴즈명: 일화 아르시스주
💰 보상: +100 캐시

📝 [문제 및 보기]

❓ [Q1] 아르시스주는 어떤 수액제일까요?
  1️⃣ 분말 수액제
  2️⃣ Pre-mix 수액제

❓ [Q2] 성분으로 올바른 것은?
  1️⃣ L-아르기닌
  2️⃣ 비타민C
  3️⃣ 아스피린
`;
      const parsedDocple = parseQuizQuestionsFromText(docpleMsg);
      expect(parsedDocple.length).toBe(2);
      expect(parsedDocple[0].keyword).toBe('아르시스주는 어떤 수액제일까요?');
      expect(parsedDocple[0].options).toEqual(['분말 수액제', 'Pre-mix 수액제']);
      expect(parsedDocple[1].keyword).toBe('성분으로 올바른 것은?');
      expect(parsedDocple[1].options).toEqual(['L-아르기닌', '비타민C', '아스피린']);

      // 2. 세미나 퀴즈 포맷
      const seminarMsg = `
Q1: [퀴즈] 리바로의 주요 적응증은?
1. 고지혈증
2. 감기
Q2: 복용 방법은?
1. 식후
2. 식전
`;
      const parsedSeminar = parseQuizQuestionsFromText(seminarMsg);
      expect(parsedSeminar.length).toBe(2);
      expect(parsedSeminar[0].keyword).toBe('리바로의 주요 적응증은?');
      expect(parsedSeminar[0].options).toEqual(['고지혈증', '감기']);
      expect(parsedSeminar[1].keyword).toBe('복용 방법은?');
      expect(parsedSeminar[1].options).toEqual(['식후', '식전']);
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

    it('getDocpleCommunityPostDetail: 게시글 상세 정보 조회', async () => {
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          resultCode: '0',
          result: {
            bid: 504,
            no: 104,
            title: '일반글 1',
            content: '게시글 상세 본문 내용',
            grpCode: 'NI',
          },
        }),
      );

      const detail = await getDocpleCommunityPostDetail('mock-token', {
        bid: 504,
        grpCode: 'NI',
        communityToken: 'comm-token',
      });
      expect(detail).not.toBeNull();
      expect(detail?.bid).toBe(504);
      expect(detail?.title).toBe('일반글 1');
    });

    it('getDocpleBanners: 배너 목록 조회', async () => {
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [
            {
              accountNo: 100000824,
              adId: '100000019-100000089-100000824',
              accountName: 'MC_M_닥플몰 혜택모음',
              rewardPoints: 10,
              maxClicksPerDay: 1,
              canReceiveReward: true,
            },
          ],
        }),
      );

      const banners = await getDocpleBanners('mock-token', 'M_D_COM_M');
      expect(banners.length).toBe(1);
      expect(banners[0].accountNo).toBe(100000824);
      expect(banners[0].rewardPoints).toBe(10);
      expect(banners[0].canReceiveReward).toBe(true);
    });

    it('clickDocpleAdBanner: 배너 클릭 성공 및 이미 클릭 케이스', async () => {
      // 1. 성공 케이스
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          code: 'SUCCESS',
          message: '성공',
          data: {
            canClickMore: false,
            rewardCash: 10,
          },
        }),
      );

      const successRes = await clickDocpleAdBanner('mock-token', 100000824, 'ad-123');
      expect(successRes.status).toBe('SUCCESS');
      expect(successRes.rewardCash).toBe(10);
      expect(successRes.canClickMore).toBe(false);

      // 2. 이미 클릭한 케이스
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse(
          {
            success: false,
            code: 'ALREADY_CLICKED',
            message: '이미 오늘 배너를 클릭하셨습니다.',
          },
          200,
        ),
      );

      const alreadyRes = await clickDocpleAdBanner('mock-token', 100000824, 'ad-123');
      expect(alreadyRes.status).toBe('ALREADY');
      expect(alreadyRes.rewardCash).toBe(0);
      expect(alreadyRes.message).toContain('이미 오늘');
    });

    it('hasDocpleRewardFlag & getDocpleRewardFlagText: 리워드 플래그 활성 조건 및 텍스트 검증', async () => {
      const { hasDocpleRewardFlag, getDocpleRewardFlagText } = await import('../src/modules/docple_api');

      // 1. 유효한 리워드 배너 (플래그 활성)
      const validBanner = {
        accountNo: 101,
        adId: 'ad-1',
        accountName: '리워드 광고 1',
        rewardPoints: 10,
        canReceiveReward: true,
      };
      expect(hasDocpleRewardFlag(validBanner)).toBe(true);
      expect(getDocpleRewardFlagText(validBanner)).toBe('클릭하고 10캐시 받기!');

      // 2. 가변 포인트 (20캐시)
      const dynamicBanner = {
        accountNo: 102,
        adId: 'ad-2',
        accountName: '리워드 광고 2',
        rewardPoints: 20,
        canReceiveReward: true,
      };
      expect(hasDocpleRewardFlag(dynamicBanner)).toBe(true);
      expect(getDocpleRewardFlagText(dynamicBanner)).toBe('클릭하고 20캐시 받기!');

      // 3. rewardPoints가 없거나 0인 일반 배너
      const normalBanner = {
        accountNo: 103,
        adId: 'ad-3',
        accountName: '일반 배너',
        rewardPoints: 0,
      };
      expect(hasDocpleRewardFlag(normalBanner)).toBe(false);
      expect(getDocpleRewardFlagText(normalBanner)).toBeUndefined();

      // 4. canReceiveReward가 false인 경우 (한도 소진)
      const limitReachedBanner = {
        accountNo: 104,
        adId: 'ad-4',
        accountName: '한도 도달 배너',
        rewardPoints: 10,
        canReceiveReward: false,
      };
      expect(hasDocpleRewardFlag(limitReachedBanner)).toBe(false);
      expect(getDocpleRewardFlagText(limitReachedBanner)).toBeUndefined();

      // 5. remainingRewardCount가 0인 경우
      const zeroRemainingBanner = {
        accountNo: 105,
        adId: 'ad-5',
        accountName: '잔여 리워드 0 배너',
        rewardPoints: 10,
        canReceiveReward: true,
        remainingRewardCount: 0,
      };
      expect(hasDocpleRewardFlag(zeroRemainingBanner)).toBe(false);

      // 6. userTodayClickCount >= maxClicksPerDay 인 경우
      const clickExceededBanner = {
        accountNo: 106,
        adId: 'ad-6',
        accountName: '클릭수 초과 배너',
        rewardPoints: 10,
        canReceiveReward: true,
        maxClicksPerDay: 1,
        userTodayClickCount: 1,
      };
      expect(hasDocpleRewardFlag(clickExceededBanner)).toBe(false);
    });

    it('findAndClickDocpleRewardBanner: 1순위 본문 배너 성공 및 폴백 동작 검증', async () => {
      // 1. M_D_COM_M 배너에 리워드 광고가 있는 경우 즉시 클릭 성공
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [
            {
              accountNo: 100000824,
              adId: 'ad-m-1',
              accountName: 'MC_M_닥플몰 혜택모음',
              rewardPoints: 10,
              canReceiveReward: true,
            },
          ],
        }),
      );
      // ad-click
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          code: 'SUCCESS',
          data: { canClickMore: false, rewardCash: 10 },
        }),
      );

      const res1 = await findAndClickDocpleRewardBanner('mock-token', ['M_D_COM_M', 'D_COM3']);
      expect(res1.status).toBe('SUCCESS');
      expect(res1.rewardCash).toBe(10);
      expect(res1.accountName).toBe('MC_M_닥플몰 혜택모음');
      expect(res1.bannerKey).toBe('M_D_COM_M');

      // 2. M_D_COM_M이 비어있어서 D_COM_R1으로 폴백 성공
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [], // M_D_COM_M empty
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [
            {
              accountNo: 100000873,
              adId: 'ad-r1-1',
              accountName: 'D_CR1_닥플몰_라이넥주',
              rewardPoints: 10,
              canReceiveReward: true,
            },
          ],
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          code: 'SUCCESS',
          data: { canClickMore: false, rewardCash: 10 },
        }),
      );

      const res2 = await findAndClickDocpleRewardBanner('mock-token', ['M_D_COM_M', 'D_COM_R1']);
      expect(res2.status).toBe('SUCCESS');
      expect(res2.rewardCash).toBe(10);
      expect(res2.accountName).toBe('D_CR1_닥플몰_라이넥주');
      expect(res2.bannerKey).toBe('D_COM_R1');

      // 3. 배너가 canReceiveReward: false로 이미 오늘 참여 완료된 경우
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [
            {
              accountNo: 100000824,
              adId: 'ad-m-1',
              accountName: 'MC_M_닥플몰 혜택모음',
              rewardPoints: 10,
              canReceiveReward: false,
            },
          ],
        }),
      );

      const res3 = await findAndClickDocpleRewardBanner('mock-token', ['M_D_COM_M']);
      expect(res3.status).toBe('ALREADY');
      expect(res3.rewardCash).toBe(0);

      // 4. excludeAccountNos에 포함된 배너는 건너뛰고 새로운 배너 클릭
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [
            {
              accountNo: 100000824,
              adId: 'ad-m-1',
              accountName: 'MC_M_닥플몰 혜택모음',
              rewardPoints: 10,
              canReceiveReward: true,
            },
            {
              accountNo: 100000999,
              adId: 'ad-m-2',
              accountName: '새로운_광고_배너',
              rewardPoints: 20,
              canReceiveReward: true,
            },
          ],
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          code: 'SUCCESS',
          data: { canClickMore: true, rewardCash: 20 },
        }),
      );

      const res4 = await findAndClickDocpleRewardBanner('mock-token', ['M_D_COM_M'], {
        excludeAccountNos: [100000824],
      });
      expect(res4.status).toBe('SUCCESS');
      expect(res4.accountNo).toBe(100000999);
      expect(res4.rewardCash).toBe(20);
    });

    it('findAndClickAllDocpleRewardBanners: 여러 슬롯에 걸쳐 있는 리워드 배너를 한도까지 모두 클릭', async () => {
      // 1회차: M_D_COM_M에서 배너 1 (101) 발견 및 클릭
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [{ accountNo: 101, adId: 'ad-1', accountName: '광고 1', rewardPoints: 10, canReceiveReward: true }],
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({ success: true, code: 'SUCCESS', data: { rewardCash: 10 } }),
      );

      // 2회차: 101은 제외 -> D_COM3에서 배너 2 (102) 발견 및 클릭
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [{ accountNo: 101, adId: 'ad-1', accountName: '광고 1', rewardPoints: 10, canReceiveReward: true }],
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [{ accountNo: 102, adId: 'ad-2', accountName: '광고 2', rewardPoints: 20, canReceiveReward: true }],
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({ success: true, code: 'SUCCESS', data: { rewardCash: 20 } }),
      );

      // 3회차: 101, 102 모두 제외 -> 더 이상 유효 배너 없음 -> ALREADY
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [{ accountNo: 101, adId: 'ad-1', accountName: '광고 1', rewardPoints: 10, canReceiveReward: true }],
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [{ accountNo: 102, adId: 'ad-2', accountName: '광고 2', rewardPoints: 20, canReceiveReward: true }],
        }),
      );
      for (let i = 0; i < 5; i++) {
        mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));
      }

      const results = await findAndClickAllDocpleRewardBanners('mock-token', undefined, { intervalMs: 0 });
      expect(results.length).toBe(3);
      expect(results[0].status).toBe('SUCCESS');
      expect(results[0].accountNo).toBe(101);
      expect(results[1].status).toBe('SUCCESS');
      expect(results[1].accountNo).toBe(102);
      expect(results[2].status).toBe('ALREADY');
    });

    it('getDocpleSeminars & getDocplePopularSeminars: 닥플캐스트 목록 및 인기 목록 정상 조회', async () => {
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            content: [
              {
                id: 26,
                title: '최신 당뇨병 치료 전략',
                rewardCash: 100,
                rewardType: 'DAILY',
                availablePeriod: '2026.01.01 ~ 2026.12.31',
              },
            ],
            totalElements: 1,
            totalPages: 1,
          },
        }),
      );

      const listRes = await getDocpleSeminars('mock-token', { page: 1, size: 20 });
      expect(listRes.items.length).toBe(1);
      expect(listRes.items[0].id).toBe(26);
      expect(listRes.items[0].rewardCash).toBe(100);
      expect(listRes.totalElements).toBe(1);

      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [
            {
              id: 26,
              title: '인기 당뇨 세미나',
              rewardCash: 100,
            },
          ],
        }),
      );

      const popRes = await getDocplePopularSeminars('mock-token');
      expect(popRes.length).toBe(1);
      expect(popRes[0].id).toBe(26);
    });

    it('getDocpleSeminarDetail & agreeDocpleSeminarTerms: 세미나 상세 정보 및 약관 동의', async () => {
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            id: 26,
            title: '상세 테스트 세미나',
            rewardCash: 100,
            rewardType: 'DAILY',
            isTermsAgreed: false,
            terms: {
              title: '사전등록 약관',
              clauses: [{ id: 1, title: '개인정보 수집 이용 동의', isRequired: true }],
            },
          },
        }),
      );

      const detail = await getDocpleSeminarDetail('mock-token', 26);
      expect(detail).toBeDefined();
      expect(detail?.title).toBe('상세 테스트 세미나');
      expect(detail?.terms).toBeDefined();

      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true }));
      const agreeSuccess = await agreeDocpleSeminarTerms('mock-token', 26);
      expect(agreeSuccess).toBe(true);
    });

    it('startDocpleSeminarWatch, reportDocpleSeminarWatchProgress, endDocpleSeminarWatch, claimDocpleSeminarReward: 시청 생명주기 메서드 정상 호출', async () => {
      // 1. watch start
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: { sessionId: 'sess-abc', signedVideoUrl: 'https://cdn.example.com/v.mp4' },
        }),
      );
      const startRes = await startDocpleSeminarWatch('mock-token', 26);
      expect(startRes?.sessionId).toBe('sess-abc');

      // 2. watch progress
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: { success: true, canClaimReward: true, rewardCash: 100 },
        }),
      );
      const progressRes = await reportDocpleSeminarWatchProgress('mock-token', 26, {
        sessionId: 'sess-abc',
        watchedStart: 0,
        watchedEnd: 300,
      });
      expect(progressRes.success).toBe(true);
      expect(progressRes.canClaimReward).toBe(true);

      // 3. watch end
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true }));
      const endRes = await endDocpleSeminarWatch('mock-token', 26, {
        sessionId: 'sess-abc',
        watchedStart: 0,
        watchedEnd: 300,
      });
      expect(endRes).toBe(true);

      // 4. claim reward
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: { rewardGranted: true, rewardCash: 100, rewardType: 'DAILY' },
        }),
      );
      const claimRes = await claimDocpleSeminarReward('mock-token', 26);
      expect(claimRes.rewardGranted).toBe(true);
      expect(claimRes.rewardCash).toBe(100);
    });

    it('processDocpleCastReward: 이미 리워드 수령한 경우 ALREADY 반환', async () => {
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            id: 26,
            title: '완료된 세미나',
            rewardCash: 100,
            rewardType: 'DAILY',
            watchProgress: {
              isRewardGranted: true,
            },
          },
        }),
      );

      const res = await processDocpleCastReward('mock-token', 26);
      expect(res.status).toBe('ALREADY');
      expect(res.seminarId).toBe(26);
      expect(res.rewardCash).toBe(0);
      expect(res.message).toContain('이미');
    });

    it('processDocpleCastReward: 약관 동의 -> 시청 세션 시작 -> 진행률 보고 -> 리워드 100캐시 수령 성공', async () => {
      // 1. 상세 조회 (약관 미동의, 시청 필요)
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            id: 26,
            title: '당뇨병 최신 지견',
            rewardCash: 100,
            rewardType: 'DAILY',
            isTermsAgreed: false,
            terms: { title: '약관' },
            watchProgress: { isRewardGranted: false },
          },
        }),
      );
      // 2. 약관 동의
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true }));
      // 3. 시청 세션 시작
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            sessionId: 'session-1234',
            signedVideoUrl: 'https://cdn.example.com/video.mp4',
            canClaimReward: false,
          },
        }),
      );
      // 4. 진행률 보고
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: { success: true, canClaimReward: true, rewardCash: 100 },
        }),
      );
      // 5. 시청 종료 보고
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true }));
      // 6. 리워드 수령
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            rewardGranted: true,
            rewardCash: 100,
            rewardType: 'DAILY',
            message: '오늘 리워드 수령 완료! 내일 다시 받을 수 있습니다',
          },
        }),
      );

      const res = await processDocpleCastReward('mock-token', 26);
      expect(res.status).toBe('SUCCESS');
      expect(res.seminarId).toBe(26);
      expect(res.rewardCash).toBe(100);
      expect(res.message).toContain('수령 완료');
    });

    it('processAllDocpleCastRewards: 인기 및 일반 목록 중 리워드 대상 세미나들을 찾아 순차 수령', async () => {
      // 1. 인기 목록
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [{ id: 26, title: '세미나 26', rewardCash: 100 }],
        }),
      );
      // 2. 일반 목록
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            content: [
              { id: 26, title: '세미나 26', rewardCash: 100 },
              { id: 27, title: '세미나 27', rewardCash: 0 },
            ],
            totalElements: 2,
          },
        }),
      );

      // 세미나 26 상세 조회 (이미 완료)
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            id: 26,
            title: '세미나 26',
            rewardCash: 100,
            watchProgress: { isRewardGranted: true },
          },
        }),
      );

      const allRes = await processAllDocpleCastRewards('mock-token');
      expect(allRes.length).toBe(1);
      expect(allRes[0].seminarId).toBe(26);
      expect(allRes[0].status).toBe('ALREADY');
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
        bannerClicks: [
          {
            status: 'SUCCESS',
            rewardCash: 10,
            message: '배너 클릭 캐시 적립 성공 (+10 캐시)',
            accountName: 'MC_M_닥플몰 혜택모음',
          },
          {
            status: 'ALREADY',
            rewardCash: 0,
            message: '이미 오늘 배너 클릭 캐시를 적립했습니다.',
            accountName: 'MC_M_닥플몰 혜택모음',
          },
        ],
        bannerClick: {
          status: 'SUCCESS',
          rewardCash: 10,
          message: '배너 클릭 캐시 적립 성공 (+10 캐시)',
          accountName: 'MC_M_닥플몰 혜택모음',
        },
        quizList: [
          { id: 1, name: '의약품 A', url: 'https://docple-plus.com/e-detailing/1' },
          { id: 2, name: '의약품 B', url: 'https://docple-plus.com/e-detailing/2' },
        ],
        recommendedPosts: [
          { tid: 101, title: '게시글 1', success: true, message: '추천 성공' },
          { tid: 102, title: '게시글 2', success: true, message: '추천 성공' },
        ],
        castRewards: [
          {
            seminarId: 26,
            title: '최신 당뇨병 치료 전략',
            status: 'SUCCESS',
            rewardCash: 100,
            message: '시청 리워드 수령 완료 (+100 캐시)',
            rewardType: 'DAILY',
          },
          {
            seminarId: 27,
            title: '고혈압 관리 지침',
            status: 'ALREADY',
            rewardCash: 0,
            message: '오늘 이미 시청 리워드를 수령했습니다.',
            rewardType: 'DAILY',
          },
        ],
        errors: [],
      };

      const report = formatDocpleDailyReport(mockResult);
      expect(report).toContain('📋 [닥플 플러스 일일 자동화 리포트]');
      expect(report).toContain('1,000원 → 1,110원 (+110원)');
      expect(report).toContain('✅ 출석체크: 완료 (+10원)');
      expect(report).toContain('🎯 배너 클릭 (2건, 성공 1건 (+10원)):');
      expect(report).toContain('1. ✅ [MC_M_닥플몰 혜택모음] 배너 클릭 캐시 적립 성공');
      expect(report).toContain('2. ℹ️ [MC_M_닥플몰 혜택모음] 이미 오늘 배너 클릭 캐시를 적립했습니다.');
      expect(report).toContain('e-디테일링 Quiz (2건)');
      expect(report).toContain('https://docple-plus.com/e-detailing/1');
      expect(report).toContain('커뮤니티 추천 (2건)');
      expect(report).toContain('🎬 닥플캐스트 VOD (2건, 성공 1건 (+100원)):');
      expect(report).toContain('1. ✅ [26] 최신 당뇨병 치료 전략 [DAILY] (시청 리워드 수령 완료 (+100 캐시))');
      expect(report).toContain('2. ℹ️ [27] 고혈압 관리 지침 [DAILY] (오늘 이미 시청 리워드를 수령했습니다.)');
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

      // 8. 게시글 상세 조회 (조회수 및 상세 데이터)
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          resultCode: '0',
          result: { bid: 1234, no: 888, title: '좋은 하루 되세요', grpCode: 'NI' },
        }),
      );

      // 9. 게시글 추천
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          resultCode: '0',
          result: { cashGrantInfo: { rewarded: true, cashAmount: 10 } },
        }),
      );

      // 10. 리워드 배너 전체 클릭: 1회차 M_D_COM_M 배너 발견 및 클릭
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [
            {
              accountNo: 100000824,
              adId: 'ad-m-1',
              accountName: 'MC_M_닥플몰 혜택모음',
              rewardPoints: 10,
              canReceiveReward: true,
            },
          ],
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          code: 'SUCCESS',
          data: { rewardCash: 10 },
        }),
      );

      // 10-2. 2회차: 100000824 제외 -> 나머지 슬롯 빈 목록 -> ALREADY
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [
            {
              accountNo: 100000824,
              adId: 'ad-m-1',
              accountName: 'MC_M_닥플몰 혜택모음',
              rewardPoints: 10,
              canReceiveReward: true,
            },
          ],
        }),
      );
      for (let i = 0; i < 6; i++) {
        mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));
      }

      // 닥플캐스트 목록 (리워드 없음)
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { content: [] } }));

      // 11. 종료 캐시: users/info
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: { myCash: 5070 },
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
      expect(taskRes.message).toContain('5,000원 → 5,070원 (+70원)');
      expect(taskRes.message).toContain('🎯 배너 클릭 (2건, 성공 1건 (+10원)):');
      expect(taskRes.message).toContain('[MC_M_닥플몰 혜택모음] (클릭하고 10캐시 받기!) 배너 클릭 캐시 적립 성공');
      expect(taskRes.message).toContain('https://docple-plus.com/e-detailing/99');
      expect(taskRes.message).toContain('[1234] 좋은 하루 되세요');
    });

    it('executeDocpleDaily: 추가 배너가 없을 때 ALREADY 상태 정상 수집 검증', async () => {
      // 1. 로그인
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          success: true,
          data: { accessToken: 'token-multi' },
        }),
      );

      // 2. 시작 캐시
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { myCash: 1000 } }));
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));

      // 3. 출석 캘린더 & 출석체크 (이미 완료)
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { attendedDates: [] } }));
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({ success: false, code: 'ALREADY_ATTENDED', message: '오늘 이미 출석 완료' }),
      );

      // 4. 퀴즈 (없음)
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { quizzes: [] } }));
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { content: [] } }));

      // 5. 커뮤니티 인증
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({ resultCode: '0', result: { communityToken: 'token' } }),
      );

      // 6. 커뮤니티 글 목록 (2개 일반글)
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          resultCode: '0',
          result: {
            communityList: [
              { bid: 1001, no: 1, title: '첫 번째 글', noticeYN: 'N', useYN: 'Y', reCom: 'N' },
              { bid: 1002, no: 2, title: '두 번째 글', noticeYN: 'N', useYN: 'Y', reCom: 'N' },
            ],
          },
        }),
      );

      // 글 1 조회 및 추천
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({ resultCode: '0', result: { bid: 1001, no: 1, title: '첫 번째 글' } }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({ resultCode: '0', result: { cashGrantInfo: { rewarded: true, cashAmount: 10 } } }),
      );

      // 글 2 조회 및 추천
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({ resultCode: '0', result: { bid: 1002, no: 2, title: '두 번째 글' } }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({ resultCode: '0', result: { cashGrantInfo: { rewarded: true, cashAmount: 10 } } }),
      );

      // 리워드 배너 전체 클릭: 1회차 배너 1 (101) 클릭 성공
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [{ accountNo: 101, adId: 'ad-1', accountName: '광고 1', rewardPoints: 20, canReceiveReward: true }],
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({ success: true, code: 'SUCCESS', data: { rewardCash: 20 } }),
      );

      // 2회차: 101 제외 -> 나머지 슬롯 빈 목록 -> ALREADY
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [{ accountNo: 101, adId: 'ad-1', accountName: '광고 1', rewardPoints: 20, canReceiveReward: true }],
        }),
      );
      for (let i = 0; i < 6; i++) {
        mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));
      }

      // 닥플캐스트 목록 (리워드 없음)
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { content: [] } }));

      // 7. 종료 캐시
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { myCash: 1030 } }));
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));

      const result = await executeDocpleDaily('user', 'pass', 'comm');
      expect(result.recommendedPosts.length).toBe(2);
      expect(result.bannerClicks.length).toBe(2);
      expect(result.bannerClicks[0].status).toBe('SUCCESS');
      expect(result.bannerClicks[0].rewardCash).toBe(20);
      expect(result.bannerClicks[1].status).toBe('ALREADY');
    });

    it('executeDocpleDaily: 여러 슬롯에 있는 배너들을 한 번에 모두 탐색하여 한도까지 클릭 적립', async () => {
      // 1. 로그인
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          success: true,
          data: { accessToken: 'token-multi-2' },
        }),
      );

      // 2. 시작 캐시
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { myCash: 1000 } }));
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));

      // 3. 출석 캘린더 & 출석체크 (이미 완료)
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { attendedDates: [] } }));
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({ success: false, code: 'ALREADY_ATTENDED', message: '오늘 이미 출석 완료' }),
      );

      // 4. 퀴즈 (없음)
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { quizzes: [] } }));
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { content: [] } }));

      // 5. 커뮤니티 인증
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({ resultCode: '0', result: { communityToken: 'token' } }),
      );

      // 6. 커뮤니티 글 목록 (2개 일반글)
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          resultCode: '0',
          result: {
            communityList: [
              { bid: 2001, no: 1, title: '첫 번째 글', noticeYN: 'N', useYN: 'Y', reCom: 'N' },
              { bid: 2002, no: 2, title: '두 번째 글', noticeYN: 'N', useYN: 'Y', reCom: 'N' },
            ],
          },
        }),
      );

      // 글 1 조회 및 추천
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({ resultCode: '0', result: { bid: 2001, no: 1, title: '첫 번째 글' } }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({ resultCode: '0', result: { cashGrantInfo: { rewarded: true, cashAmount: 10 } } }),
      );

      // 글 2 조회 및 추천
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({ resultCode: '0', result: { bid: 2002, no: 2, title: '두 번째 글' } }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({ resultCode: '0', result: { cashGrantInfo: { rewarded: true, cashAmount: 10 } } }),
      );

      // --- 리워드 배너 전체 클릭: 1회차 배너 1 (accountNo: 101) 클릭 성공 ---
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [{ accountNo: 101, adId: 'ad-1', accountName: '광고 1', rewardPoints: 20, canReceiveReward: true }],
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({ success: true, code: 'SUCCESS', data: { rewardCash: 20 } }),
      );

      // --- 2회차: 배너 1(101) 제외 후 D_COM3에서 배너 2 (accountNo: 102) 클릭 성공 ---
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [{ accountNo: 101, adId: 'ad-1', accountName: '광고 1', rewardPoints: 20, canReceiveReward: true }],
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [{ accountNo: 102, adId: 'ad-2', accountName: '광고 2', rewardPoints: 10, canReceiveReward: true }],
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({ success: true, code: 'SUCCESS', data: { rewardCash: 10 } }),
      );

      // --- 3회차: 101, 102 제외 -> 더 이상 새 배너 없음 -> ALREADY ---
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [{ accountNo: 101, adId: 'ad-1', accountName: '광고 1', rewardPoints: 20, canReceiveReward: true }],
        }),
      );
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: [{ accountNo: 102, adId: 'ad-2', accountName: '광고 2', rewardPoints: 10, canReceiveReward: true }],
        }),
      );
      for (let i = 0; i < 5; i++) {
        mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));
      }

      // 닥플캐스트 목록 (리워드 없음)
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { content: [] } }));

      // 7. 종료 캐시
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { myCash: 1050 } }));
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));

      const result = await executeDocpleDaily('user', 'pass', 'comm');
      expect(result.recommendedPosts.length).toBe(2);
      expect(result.bannerClicks.length).toBe(3);
      expect(result.bannerClicks[0].status).toBe('SUCCESS');
      expect(result.bannerClicks[0].rewardCash).toBe(20);
      expect(result.bannerClicks[0].accountName).toBe('광고 1');
      expect(result.bannerClicks[1].status).toBe('SUCCESS');
      expect(result.bannerClicks[1].rewardCash).toBe(10);
      expect(result.bannerClicks[1].accountName).toBe('광고 2');
      expect(result.bannerClicks[2].status).toBe('ALREADY');
    });

    it('executeDocpleDaily: 닥플캐스트 VOD 리워드 세미나 발견 시 시청 및 100캐시 수령 통합 검증', async () => {
      // 1. 로그인
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({
          success: true,
          data: { accessToken: 'token-cast-integration' },
        }),
      );

      // 2. 시작 캐시
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { myCash: 1000 } }));
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));

      // 3. 출석 (이미 완료)
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { attendedDates: [] } }));
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({ success: false, code: 'ALREADY_ATTENDED', message: '오늘 이미 출석 완료' }),
      );

      // 4. 퀴즈 (없음)
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { quizzes: [] } }));
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { content: [] } }));

      // 5. 커뮤니티 인증 (생략 또는 빈 목록)
      mockRequest.mockResolvedValueOnce(
        createMockTextResponse({ resultCode: '0', result: { communityToken: 'token' } }),
      );
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ resultCode: '0', result: { communityList: [] } }));

      // 6. 배너 (리워드 배너 없음: 7개 슬롯)
      for (let i = 0; i < 7; i++) {
        mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));
      }

      // 7. 닥플캐스트
      // 7-1. 인기 세미나 (빈 목록)
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));
      // 7-2. 세미나 목록 (1개 100캐시 리워드 세미나 발견)
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            content: [
              {
                id: 26,
                title: '최신 당뇨병 치료 전략',
                rewardCash: 100,
                rewardType: 'DAILY',
              },
            ],
            totalElements: 1,
            totalPages: 1,
          },
        }),
      );
      // 7-3. 세미나 26 상세 조회
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            id: 26,
            title: '최신 당뇨병 치료 전략',
            rewardCash: 100,
            rewardType: 'DAILY',
            isTermsAgreed: true,
            watchProgress: { isRewardGranted: false },
          },
        }),
      );
      // 7-4. 시청 세션 시작
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            sessionId: 'session-26-cast',
            signedVideoUrl: 'https://cdn.example.com/cast26.mp4',
            canClaimReward: false,
          },
        }),
      );
      // 7-5. 시청 진행률 보고
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: { success: true, canClaimReward: true, rewardCash: 100 },
        }),
      );
      // 7-6. 시청 세션 종료
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true }));
      // 7-7. 리워드 수령
      mockRequest.mockResolvedValueOnce(
        createMockJsonResponse({
          success: true,
          data: {
            rewardGranted: true,
            rewardCash: 100,
            rewardType: 'DAILY',
            message: '시청 리워드가 지급되었습니다!',
          },
        }),
      );

      // 8. 종료 캐시
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: { myCash: 1100 } }));
      mockRequest.mockResolvedValueOnce(createMockJsonResponse({ success: true, data: [] }));

      const result = await executeDocpleDaily('user', 'pass', 'comm');
      expect(result.castRewards).toBeDefined();
      expect(result.castRewards?.length).toBe(1);
      expect(result.castRewards?.[0].status).toBe('SUCCESS');
      expect(result.castRewards?.[0].rewardCash).toBe(100);
      expect(result.castRewards?.[0].seminarId).toBe(26);
      expect(result.castRewards?.[0].title).toBe('최신 당뇨병 치료 전략');
      expect(result.cashDiff).toBe(100);
    });
  });

  describe('Telegram Command Registration Tests', () => {
    it('adminCommands에 run_docple_daily_now가 등록되어 있어야 함', async () => {
      const { adminCommands } = await import('../src/services/telegram/command_definitions');
      const docpleCmd = adminCommands.find((c) => c.command === 'run_docple_daily_now');
      expect(docpleCmd).toBeDefined();
      expect(docpleCmd?.description).toContain('닥플');
    });
  });
});
