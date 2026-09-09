import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { isTelegram429Error, getTelegramRetryAfter, sendTelegram } from '../src/modules/utils';
import { syncBotCommands, loadBotCommandsCache, BOT_COMMANDS_CACHE_PATH } from '../src/services/telegram/command_sync';
import { setBot } from '../src/services/bot_instance';
import type { Telegraf } from 'telegraf';

describe('Telegram 429 Rate Limit and Caching Tests', () => {
  describe('isTelegram429Error & getTelegramRetryAfter', () => {
    it('텔레그램 429 에러 응답 객체를 올바르게 감지해야 함', () => {
      const errWithResponse = {
        response: {
          ok: false,
          error_code: 429,
          description: 'Too Many Requests: retry after 394',
          parameters: { retry_after: 394 },
        },
      };
      expect(isTelegram429Error(errWithResponse)).toBe(true);
      expect(getTelegramRetryAfter(errWithResponse)).toBe(394);
    });

    it('에러 메시지 내 429 및 retry after 문자열을 올바르게 감지해야 함', () => {
      const errWithMessage = new Error('TelegramError: 429: Too Many Requests: retry after 459');
      expect(isTelegram429Error(errWithMessage)).toBe(true);
      expect(getTelegramRetryAfter(errWithMessage)).toBe(459);
    });

    it('일반 에러는 429로 판정되지 않아야 함', () => {
      const normalErr = new Error('Network timeout');
      expect(isTelegram429Error(normalErr)).toBe(false);
      expect(getTelegramRetryAfter(normalErr)).toBeNull();

      expect(isTelegram429Error(null)).toBe(false);
      expect(getTelegramRetryAfter(null)).toBeNull();
    });
  });

  describe('sendTelegram 429 Handling', () => {
    const originalEnvChatId = process.env.TELEGRAM_CHAT_ID;

    beforeEach(() => {
      process.env.TELEGRAM_CHAT_ID = 'test_chat_id';
    });

    afterEach(() => {
      process.env.TELEGRAM_CHAT_ID = originalEnvChatId;
    });

    it('429 에러 발생 시 재시도(실패 알림 전송)를 시도하지 않고 안전하게 false를 반환해야 함', async () => {
      let callCount = 0;
      const mockBot = {
        command: vi.fn(),
        telegram: {
          sendMessage: vi.fn().mockImplementation(async () => {
            callCount++;
            const err = new Error('429: Too Many Requests: retry after 300');
            (err as unknown as { response: unknown }).response = {
              error_code: 429,
              parameters: { retry_after: 300 },
            };
            throw err;
          }),
        },
      } as unknown as Parameters<typeof setBot>[1];

      setBot('admin', mockBot);

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const result = await sendTelegram('안녕하세요');

      expect(result).toBe(false);
      // 최초 전송 시도 1회만 발생하고, 에러 알림 전송(2차 시도)은 호출되지 않아야 함
      expect(callCount).toBe(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('[Telegram] Rate limit exceeded (429) (retry after 300s)'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('syncBotCommands Cache and Abort on 429', () => {
    let backupCache: string | null = null;

    beforeEach(() => {
      if (fs.existsSync(BOT_COMMANDS_CACHE_PATH)) {
        backupCache = fs.readFileSync(BOT_COMMANDS_CACHE_PATH, 'utf-8');
        fs.unlinkSync(BOT_COMMANDS_CACHE_PATH);
      } else {
        backupCache = null;
      }
    });

    afterEach(() => {
      if (backupCache !== null) {
        fs.writeFileSync(BOT_COMMANDS_CACHE_PATH, backupCache, 'utf-8');
      } else if (fs.existsSync(BOT_COMMANDS_CACHE_PATH)) {
        fs.unlinkSync(BOT_COMMANDS_CACHE_PATH);
      }
    });

    it('명령어가 변경되지 않았으면 캐시를 통해 setMyCommands를 건너뛰어야 함', async () => {
      const setMyCommandsMock = vi.fn().mockResolvedValue(true);
      const mockBot = {
        telegram: {
          setMyCommands: setMyCommandsMock,
        },
      } as unknown as Telegraf;

      const commands = [{ command: 'test', description: '테스트' }];

      // 1. 첫 번째 실행 (캐시 없음 -> 4개 scope 등록)
      await syncBotCommands(mockBot, commands, 'TestBot');
      expect(setMyCommandsMock).toHaveBeenCalledTimes(4);

      // 캐시 파일 확인
      const cache = loadBotCommandsCache();
      expect(cache['TestBot']).toBe(JSON.stringify(commands));

      // 2. 두 번째 실행 (캐시 일치 -> setMyCommands 호출 0회 추가)
      setMyCommandsMock.mockClear();
      await syncBotCommands(mockBot, commands, 'TestBot');
      expect(setMyCommandsMock).not.toHaveBeenCalled();
    });

    it('429 에러 발생 시 남은 scope 호출을 즉시 중단(break)해야 함', async () => {
      const setMyCommandsMock = vi.fn().mockImplementation(async () => {
        const err = new Error('429: Too Many Requests: retry after 400');
        (err as unknown as { response: unknown }).response = {
          error_code: 429,
          parameters: { retry_after: 400 },
        };
        throw err;
      });

      const mockBot = {
        telegram: {
          setMyCommands: setMyCommandsMock,
        },
      } as unknown as Telegraf;

      const commands = [{ command: 'abort_test', description: '중단 테스트' }];

      // 429 발생 시 첫 번째 scope만 시도하고 즉시 break해야 하므로 1번만 호출됨
      await syncBotCommands(mockBot, commands, 'AbortBot');
      expect(setMyCommandsMock).toHaveBeenCalledTimes(1);

      // 실패했으므로 캐시에 저장되지 않아야 함
      const cache = loadBotCommandsCache();
      expect(cache['AbortBot']).toBeUndefined();
    });
  });
});
