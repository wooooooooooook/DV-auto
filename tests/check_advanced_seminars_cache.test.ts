import assert from 'node:assert';
import * as storage from '../src/services/storage';
import { SEMINAR_LIST_KEY } from '../src/tasks/apply_seminar';
import * as checkAdvancedSeminarsModule from '../src/tasks/check_advanced_seminars';
import { setBot, getBot } from '../src/services/bot_instance';
import type { Telegraf, Context } from 'telegraf';

async function runTests(): Promise<void> {
  console.log('=== [Test] check_advanced_seminars Cache & NoticeBot Support Tests Started ===\n');

  const originalStoredList = storage.get(SEMINAR_LIST_KEY);

  try {
    // 1. 방장 계정 기준 텍스트 포함 확인 (빈 목록)
    storage.set(SEMINAR_LIST_KEY, []);
    checkAdvancedSeminarsModule.clearCache();
    const emptyResult = checkAdvancedSeminarsModule.run();
    assert.strictEqual(emptyResult.success, true);
    assert(
      emptyResult.message.includes('방장 계정 기준'),
      '빈 세미나 목록 메시지에 방장 계정 기준 명시가 포함되어야 함',
    );
    console.log('  ✓ [Pass] 빈 목록 응답에 "방장 계정 기준" 문구 포함 검증');

    // 2. 세미나 데이터 추가 후 응답 메시지 검증
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    storage.set(SEMINAR_LIST_KEY, [
      {
        seminarId: '9991',
        name: '당뇨병 최신 진료지침',
        date: todayStr,
        isAdvancedSurvey: true,
        pointPaid: true,
        pointText: '5,000P',
      },
    ]);

    checkAdvancedSeminarsModule.clearCache();
    const result1 = checkAdvancedSeminarsModule.runCached();
    assert.strictEqual(result1.success, true);
    assert(result1.message.includes('방장 계정 기준'), '응답 메시지에 방장 계정 기준 문구가 포함되어야 함');
    assert(result1.message.includes('9991'), '9991 세미나가 포함되어야 함');
    console.log('  ✓ [Pass] 세미나 목록 응답에 "방장 계정 기준" 문구 및 항목 정상 포함 검증');

    // 3. 10분 캐시 검증
    // storage 내용을 변경하더라도 clearCache가 호출되지 않으면 이전 캐시 결과 반환해야 함
    storage.set(SEMINAR_LIST_KEY, []);
    const cachedResult = checkAdvancedSeminarsModule.runCached();
    assert.strictEqual(
      cachedResult.message,
      result1.message,
      '10분 이내 재호출 시 storage가 바뀌어도 캐시된 결과가 반환되어야 함',
    );
    console.log('  ✓ [Pass] 10분 캐시 히트 동작 검증');

    // 4. clearCache 후 갱신 검증
    checkAdvancedSeminarsModule.clearCache();
    const refreshedResult = checkAdvancedSeminarsModule.runCached();
    assert(refreshedResult.message.includes('심화설문 세미나가 없습니다'), '캐시 초기화 후 새 상태로 갱신되어야 함');
    console.log('  ✓ [Pass] 캐시 만료/초기화 후 결과 갱신 검증');

    // 5. noticeBot 및 adminBot 명령어 등록 및 핸들러 동작 검증
    const registeredCommands: Record<string, (ctx: unknown) => Promise<unknown>> = {};
    const mockNoticeBot = {
      command: (cmd: string, handler: (ctx: unknown) => Promise<unknown>) => {
        registeredCommands[cmd] = handler;
      },
    } as unknown as Telegraf;

    setBot('notice', mockNoticeBot);

    assert(
      typeof registeredCommands['check_advanced_seminars'] === 'function',
      'check_advanced_seminars 명령어 등록 확인',
    );

    // 핸들러 실행 시 응답 확인
    let repliedMessage = '';
    const mockCtx = {
      reply: async (msg: string) => {
        repliedMessage = msg;
      },
    };

    await registeredCommands['check_advanced_seminars'](mockCtx);
    assert(
      repliedMessage.includes('방장 계정 기준'),
      '핸들러 실행 시 방장 계정 기준 문구가 포함된 응답이 전송되어야 함',
    );
    console.log('  ✓ [Pass] noticeBot 명령어 핸들러 등록 및 응답 동작 검증 (/check_advanced_seminars)');

    console.log('\n🎉 모든 check_advanced_seminars 캐시 및 공지봇 연동 테스트 통과!');
  } finally {
    if (originalStoredList !== undefined) {
      storage.set(SEMINAR_LIST_KEY, originalStoredList);
    }
    checkAdvancedSeminarsModule.clearCache();
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
