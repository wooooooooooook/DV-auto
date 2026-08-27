import assert from 'assert';
import path from 'path';
import fs from 'fs';
import {
  InterMDClient,
  loadEnvFromFile,
  type InterMDTodayQuiz,
  type InterMDSubmitResult,
} from '../src/modules/intermd_api';
import {
  stripHtmlTags,
  formatInterMDQuizMessage,
  run as runInterMDQuiz,
  getInterMDQuizCache,
  setInterMDQuizCache,
  clearInterMDQuizCache,
  type InterMDQuizCache,
} from '../src/tasks/intermd_quiz';
import {
  addInterMDQuizSubscriber,
  removeInterMDQuizSubscriber,
  getInterMDQuizSubscribers,
  INTERMD_QUIZ_SUBSCRIBERS_KEY,
} from '../src/services/intermd_quiz_subscribers';
import * as storage from '../src/services/storage';
import { describe, it } from 'vitest';

describe('InterMD Quiz Tests', () => {
  it('InterMD 퀴즈 HTML 파싱, 제출 및 구독자 알림 종합 테스트', async () => {
    console.log('=== [Test] InterMD Quiz Tests Started ===\n');

    // Test 1: stripHtmlTags
    {
      console.log('Test 1: stripHtmlTags');
      const input =
        '<p>레치타티보(recitativo)는<br/>이탈리아어&nbsp;recitare에서&nbsp;유래한&nbsp;음악&nbsp;용어로&hellip;</p>';
      const output = stripHtmlTags(input);
      assert.strictEqual(output, '레치타티보(recitativo)는\n이탈리아어 recitare에서 유래한 음악 용어로…');
      console.log('  ✓ stripHtmlTags correctly strips HTML and decodes entities');
    }

    // Test 2: formatInterMDQuizMessage
    {
      console.log('Test 2: formatInterMDQuizMessage');
      const mockQuiz: InterMDTodayQuiz = {
        quiz_pseq: 2273,
        poll_pseq: 6087,
        page_pseq: 7014,
        quiz_group_pseq: 1145,
        quiz_group_type: 10,
        quiz_group_title: '8월 퀴즈',
        quiz_title: '오페라',
        date: '2026.08.26 (수)',
        hint: '보통의 화법, 내지는 연설이나 낭창을 모방하기도 하고...',
        guide: '<p>레치타티보 해설 내용입니다.</p>',
        already_submitted: false,
        questions: [
          {
            ques_pseq: 17224,
            title: '다음 중 오페라에서 사용하는 노래 양식은?',
            order: 1,
            type: 1,
            items: [
              { item_pseq: 62703, title: '아리아(Aria)', order: 1, is_answer_hint: false },
              { item_pseq: 62704, title: '레치타티보(Recitativo)', order: 2, is_answer_hint: true },
              { item_pseq: 62705, title: '카바티나(Cavatina)', order: 3, is_answer_hint: false },
            ],
          },
        ],
      };

      const mockSubmitResult: InterMDSubmitResult = {
        success: true,
        already_submitted: false,
        message: '성공',
        submitted_item: { item_pseq: 62704, title: '레치타티보(Recitativo)', order: 2, is_answer_hint: true },
      };

      // 관리자용 포맷팅 (제출 결과/상태 정보 포함)
      const adminFormatted = formatInterMDQuizMessage(mockQuiz, mockSubmitResult);
      assert(adminFormatted.includes('📋 [인터엠디 오늘의 퀴즈]'), 'Must include header');
      assert(adminFormatted.includes('오페라 (2026.08.26 (수))'), 'Must include title and date');
      assert(adminFormatted.includes('정답: 2. 레치타티보(Recitativo)'), 'Must include answer directly below date');
      assert(adminFormatted.includes('💡 힌트: 보통의 화법'), 'Must include hint');
      assert(adminFormatted.includes('2. 레치타티보(Recitativo) (★ 정답)'), 'Must mark correct answer with star');
      assert(
        adminFormatted.includes('🎯 제출 결과: ✅ 정답 제출 완료 (선택: 2. 레치타티보(Recitativo))'),
        'Admin must include submit result',
      );
      assert(adminFormatted.includes('📖 [해설]\n레치타티보 해설 내용입니다.'), 'Must include stripped guide');

      // 공지봇용 포맷팅 (상태 정보 제외된 순수 퀴즈 정보)
      const noticeFormatted = formatInterMDQuizMessage(mockQuiz);
      assert(noticeFormatted.includes('📋 [인터엠디 오늘의 퀴즈]'), 'Notice must include header');
      assert(noticeFormatted.includes('정답: 2. 레치타티보(Recitativo)'), 'Notice must include answer below date');
      assert(noticeFormatted.includes('2. 레치타티보(Recitativo) (★ 정답)'), 'Notice must include quiz questions');
      assert(!noticeFormatted.includes('제출 결과'), 'Notice must NOT include submit result');
      assert(!noticeFormatted.includes('상태:'), 'Notice must NOT include status');
      console.log('  ✓ formatInterMDQuizMessage correctly separates notice quiz info and admin status');
    }

    // Test 3: loadEnvFromFile & getCredentials
    {
      console.log('Test 3: loadEnvFromFile and getCredentials');
      const tmpEnvPath = path.join(process.cwd(), 'data', 'test_intermd.env');
      fs.writeFileSync(tmpEnvPath, 'INTERMD_USER_ID="testuser"\nINTERMD_USER_PW="testpass"\n# comment\n', 'utf8');
      const envs = loadEnvFromFile(tmpEnvPath);
      assert.strictEqual(envs.INTERMD_USER_ID, 'testuser');
      assert.strictEqual(envs.INTERMD_USER_PW, 'testpass');

      const clientWithEnv = new InterMDClient({ envPath: tmpEnvPath });
      const creds = clientWithEnv.getCredentials();
      assert.strictEqual(creds.userId, 'testuser');
      assert.strictEqual(creds.userPw, 'testpass');

      fs.unlinkSync(tmpEnvPath);
      console.log('  ✓ loadEnvFromFile and getCredentials correctly parse INTERMD_USER_ID and INTERMD_USER_PW');
    }

    // Test 4: InterMD Quiz Caching (TTL 1일)
    {
      console.log('Test 4: InterMD Quiz Caching and TTL');
      clearInterMDQuizCache();
      assert.strictEqual(getInterMDQuizCache(), null, 'Should return null when cache empty');

      const sampleCache: InterMDQuizCache = {
        date: '2026-08-26',
        timestamp: Date.now(),
        quizTitle: '오페라',
        dateText: '2026.08.26 (수)',
        hint: '힌트',
        questions: [],
        answerItem: { order: 2, title: '레치타티보(Recitativo)' },
        formattedMessage: '📋 [인터엠디 오늘의 퀴즈] 오페라',
      };

      setInterMDQuizCache(sampleCache);
      const cached = getInterMDQuizCache();
      assert.strictEqual(cached?.quizTitle, '오페라');
      assert.strictEqual(cached?.answerItem?.order, 2);

      // TTL expired test (> 24h)
      const expiredCache: InterMDQuizCache = {
        ...sampleCache,
        timestamp: Date.now() - 25 * 60 * 60 * 1000,
      };
      setInterMDQuizCache(expiredCache);
      assert.strictEqual(getInterMDQuizCache(), null, 'Expired cache should return null');
      clearInterMDQuizCache();
      console.log('  ✓ InterMD quiz caching and 1-day TTL work correctly');
    }

    // Test 5: Subscribers management
    {
      console.log('Test 5: InterMD Quiz Subscriber Management');
      storage.deleteKey(INTERMD_QUIZ_SUBSCRIBERS_KEY);
      assert.deepStrictEqual(getInterMDQuizSubscribers(), []);

      assert.strictEqual(addInterMDQuizSubscriber(123456), true);
      assert.strictEqual(addInterMDQuizSubscriber(123456), false, 'Duplicate add should return false');
      assert.strictEqual(addInterMDQuizSubscriber(789012), true);
      assert.deepStrictEqual(getInterMDQuizSubscribers(), [123456, 789012]);

      assert.strictEqual(removeInterMDQuizSubscriber(123456), true);
      assert.strictEqual(removeInterMDQuizSubscriber(123456), false, 'Duplicate remove should return false');
      assert.deepStrictEqual(getInterMDQuizSubscribers(), [789012]);

      storage.deleteKey(INTERMD_QUIZ_SUBSCRIBERS_KEY);
      console.log('  ✓ add/remove/getInterMDQuizSubscriber work correctly');
    }

    // Test 6: InterMDClient mock run and automatic caching
    {
      console.log('Test 6: InterMDClient mock run, auto caching and subscriber dispatch');
      clearInterMDQuizCache();

      class MockInterMDClient extends InterMDClient {
        override async ensureAuthenticated(): Promise<boolean> {
          return true;
        }

        override async getTodayQuiz(): Promise<InterMDTodayQuiz | null> {
          return {
            quiz_pseq: 2273,
            poll_pseq: 6087,
            page_pseq: 7014,
            quiz_group_pseq: 1145,
            quiz_group_type: 10,
            quiz_group_title: '8월 퀴즈',
            quiz_title: '오페라',
            date: '2026.08.26 (수)',
            hint: '힌트 텍스트',
            guide: '<p>가이드 텍스트</p>',
            already_submitted: false,
            questions: [
              {
                ques_pseq: 17224,
                title: '오페라 문제',
                order: 1,
                type: 1,
                items: [
                  { item_pseq: 62703, title: '보기1', order: 1, is_answer_hint: false },
                  { item_pseq: 62704, title: '보기2', order: 2, is_answer_hint: true },
                ],
              },
            ],
          };
        }

        override async submitTodayQuiz(quiz?: InterMDTodayQuiz | null): Promise<InterMDSubmitResult> {
          return {
            success: true,
            already_submitted: false,
            message: '답안 제출 및 퀴즈 완료 성공',
            quiz_title: quiz?.quiz_title,
            submitted_item: { item_pseq: 62704, title: '보기2', order: 2, is_answer_hint: true },
            is_correct: true,
          };
        }
      }

      const mockClient = new MockInterMDClient();
      const result = await runInterMDQuiz({}, { client: mockClient, notify: false });
      assert.strictEqual(result.success, true);
      assert(result.message && result.message.includes('정답 제출 완료'), 'Result message should indicate success');

      // Verify cache was populated with pure quiz info (no submit result)
      const cache = getInterMDQuizCache();
      assert.strictEqual(cache?.quizTitle, '오페라');
      assert.strictEqual(cache?.answerItem?.order, 2);
      assert.strictEqual(cache?.answerItem?.title, '보기2');
      assert(cache?.formattedMessage.includes('오페라'), 'Cache formattedMessage should contain quiz info');
      assert(!cache?.formattedMessage.includes('제출 결과'), 'Cache formattedMessage must NOT contain submit result');
      console.log('  ✓ runInterMDQuiz successfully runs, submits quiz, and caches pure quiz info');
    }

    // Test 7: InterMDClient no quiz today -> silent mode
    {
      console.log('Test 7: No quiz today returns silent: true');
      class MockNoQuizClient extends InterMDClient {
        override async ensureAuthenticated(): Promise<boolean> {
          return true;
        }

        override async getTodayQuiz(): Promise<InterMDTodayQuiz | null> {
          return null;
        }
      }

      const mockClient = new MockNoQuizClient();
      const result = await runInterMDQuiz({}, { client: mockClient, notify: false });
      assert.strictEqual(result.success, true);
      assert.strictEqual(result.silent, true, 'Should return silent: true when no quiz is found');
      console.log('  ✓ No quiz day correctly sets silent: true for scheduler and notice bot');
    }

    // Test 8: InterMDClient already submitted handling
    {
      console.log('Test 8: InterMDClient already submitted quiz');
      class MockSubmittedClient extends InterMDClient {
        override async ensureAuthenticated(): Promise<boolean> {
          return true;
        }

        override async getTodayQuiz(): Promise<InterMDTodayQuiz | null> {
          return {
            quiz_pseq: 2273,
            poll_pseq: 6087,
            page_pseq: 7014,
            quiz_group_pseq: 1145,
            quiz_group_type: 10,
            quiz_group_title: '8월 퀴즈',
            quiz_title: '오페라',
            date: '2026.08.26 (수)',
            hint: '힌트 텍스트',
            guide: '',
            already_submitted: true,
            questions: [],
          };
        }
      }

      const mockClient = new MockSubmittedClient();
      const result = await runInterMDQuiz({}, { client: mockClient, notify: false });
      assert.strictEqual(result.success, true);
      assert(
        result.message && result.message.includes('이미 참여 완료된 퀴즈입니다'),
        'Result message should indicate already completed',
      );
      console.log('  ✓ runInterMDQuiz correctly handles already submitted quiz');
    }

    console.log('\n🎉 All InterMD quiz tests passed successfully!\n');
  });
});
