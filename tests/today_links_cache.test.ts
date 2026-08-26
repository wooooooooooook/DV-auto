import assert from 'node:assert';
import * as storage from '../src/services/storage';
import {
  TODAY_LINKS_CACHE_KEY,
  getTodayLinksCache,
  setTodayLinksCache,
  clearTodayLinksCache,
  formatTodayLinksBroadcast,
} from '../src/tasks/today_links';
import { setBot } from '../src/services/bot_instance';
import type { Telegraf } from 'telegraf';

async function runTests(): Promise<void> {
  console.log('=== [Test] today_links 캐시 및 공지봇 전용 핸들러 테스트 시작 ===\n');

  const originalCache = storage.get(TODAY_LINKS_CACHE_KEY);

  try {
    // 1. 캐시 CRUD 검증
    clearTodayLinksCache();
    assert.strictEqual(getTodayLinksCache(), null, '초기 캐시는 null이어야 함');

    const sampleCache = {
      date: '2026-08-24',
      message: '📌 [2026-08-24] 오늘의 링크 모음\n1. 세미나 A\n2. 퀴즈 B',
      options: { parse_mode: 'HTML' as const },
      cachedAt: new Date().toISOString(),
    };

    setTodayLinksCache(sampleCache);
    const retrieved = getTodayLinksCache();
    assert.deepStrictEqual(retrieved, sampleCache, '저장된 캐시가 정확히 조회되어야 함');

    clearTodayLinksCache();
    assert.strictEqual(getTodayLinksCache(), null, 'clearTodayLinksCache 후 캐시는 null이어야 함');
    console.log('  ✓ [Pass] getTodayLinksCache, setTodayLinksCache, clearTodayLinksCache 기본 동작 검증 완료');

    // 2. 공지봇 커맨드 등록 및 캐시 반환 검증
    const registeredCommands: Record<string, (ctx: unknown) => Promise<unknown>> = {};
    const mockNoticeBot = {
      command: (cmd: string | string[], handler: (ctx: unknown) => Promise<unknown>) => {
        if (Array.isArray(cmd)) {
          for (const c of cmd) {
            registeredCommands[c] = handler;
          }
        } else {
          registeredCommands[cmd] = handler;
        }
      },
    } as unknown as Telegraf;

    setBot('notice', mockNoticeBot);

    assert(typeof registeredCommands['today_links'] === 'function', 'noticeBot에 today_links 커맨드가 등록되어야 함');

    // 2-1. 캐시가 없을 때 공지봇 /today_links 호출
    clearTodayLinksCache();
    let replyMsg = '';
    let replyOptions: unknown = null;
    const mockCtxWithoutCache = {
      message: { text: '/today_links' },
      reply: async (msg: string, opts?: unknown) => {
        replyMsg = msg;
        replyOptions = opts;
      },
    };

    await registeredCommands['today_links'](mockCtxWithoutCache);
    assert(replyMsg.includes('아직 생성되지 않았습니다'), '캐시가 없을 때 준비 중 안내 메시지가 반환되어야 함');
    console.log('  ✓ [Pass] 캐시 미존재 시 안내 메시지 반환 검증 완료');

    // 2-2. 캐시가 있을 때 공지봇 /today_links 호출 (즉시 캐시 반환)
    setTodayLinksCache(sampleCache);
    replyMsg = '';
    replyOptions = null;
    const mockCtxWithCache = {
      message: { text: '/today_links' },
      reply: async (msg: string, opts?: unknown) => {
        replyMsg = msg;
        replyOptions = opts;
      },
    };

    await registeredCommands['today_links'](mockCtxWithCache);
    assert.strictEqual(replyMsg, sampleCache.message, '캐시된 메시지가 그대로 반환되어야 함');
    assert.deepStrictEqual(replyOptions, sampleCache.options, '캐시된 옵션이 그대로 전달되어야 함');
    console.log('  ✓ [Pass] 캐시 존재 시 캐시된 메시지 및 옵션 반환 검증 완료');

    // 2-3. 날짜 인자가 포함되어도 날짜 지정 무시하고 오늘 기준 캐시 반환 검증
    replyMsg = '';
    replyOptions = null;
    const mockCtxWithCustomDateArg = {
      message: { text: '/today_links 8/25' },
      reply: async (msg: string, opts?: unknown) => {
        replyMsg = msg;
        replyOptions = opts;
      },
    };

    await registeredCommands['today_links'](mockCtxWithCustomDateArg);
    assert.strictEqual(
      replyMsg,
      sampleCache.message,
      '날짜 인자가 전달되어도 무시하고 현재 캐시된 결과가 반환되어야 함',
    );
    console.log('  ✓ [Pass] 공지봇에서 날짜 인자 입력 시 무시하고 캐시 반환 검증 완료');

    // 3. formatTodayLinksBroadcast 및 캐시 연계 검증
    const formatted = formatTodayLinksBroadcast({
      quizInfo: null,
      seminarMessage: { date: '2026-08-24', lunchSeminarIds: [], dinnerSeminarIds: [], message: '세미나 없음' },
      storedNewSeminars: [],
      pointConversionInfo: null,
      isCustomDate: false,
    });

    assert(formatted.message.length > 0, '포맷팅된 메시지가 생성되어야 함');
    const newCache = {
      date: '2026-08-24',
      message: formatted.message,
      options: formatted.options,
      cachedAt: new Date().toISOString(),
    };
    setTodayLinksCache(newCache);
    assert.strictEqual(getTodayLinksCache()?.message, formatted.message);
    console.log('  ✓ [Pass] 오늘자 링크 포맷 결과 캐시 저장 검증 완료');

    console.log('\n🎉 모든 today_links 캐시 및 공지봇 전용 핸들러 테스트 100% 통과!');
  } finally {
    if (originalCache !== undefined) {
      storage.set(TODAY_LINKS_CACHE_KEY, originalCache);
    } else {
      clearTodayLinksCache();
    }
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
