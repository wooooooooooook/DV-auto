import assert from 'assert';
import { describe, it, vi } from 'vitest';
import { isAuthorizedAdmin } from '../src/services/telegram';

describe('Admin Bot 인가(Authorization) 가드 테스트', () => {
  describe('isAuthorizedAdmin 단위 테스트', () => {
    it('TELEGRAM_CHAT_ID 환경변수가 없을 경우 항상 false 반환', () => {
      const mockCtx = {
        from: { id: 123456 },
        chat: { id: 123456 },
      } as Parameters<typeof isAuthorizedAdmin>[0];

      assert.strictEqual(isAuthorizedAdmin(mockCtx, undefined), false);
      assert.strictEqual(isAuthorizedAdmin(mockCtx, ''), false);
    });

    it('단일 관리자 ID 설정 시 from.id가 일치하면 true 반환', () => {
      const mockCtx = {
        from: { id: 123456 },
        chat: { id: 999999 },
      } as Parameters<typeof isAuthorizedAdmin>[0];

      assert.strictEqual(isAuthorizedAdmin(mockCtx, '123456'), true);
    });

    it('단일 관리자 ID 설정 시 chat.id가 일치하면 true 반환', () => {
      const mockCtx = {
        from: { id: 999999 },
        chat: { id: 123456 },
      } as Parameters<typeof isAuthorizedAdmin>[0];

      assert.strictEqual(isAuthorizedAdmin(mockCtx, '123456'), true);
    });

    it('ID가 일치하지 않는 경우 false 반환', () => {
      const mockCtx = {
        from: { id: 999999 },
        chat: { id: 888888 },
      } as Parameters<typeof isAuthorizedAdmin>[0];

      assert.strictEqual(isAuthorizedAdmin(mockCtx, '123456'), false);
    });

    it('쉼표로 구분된 복수 관리자 ID를 정상 지원', () => {
      const configuredIds = '11111, 22222, 33333';

      const ctx1 = { from: { id: 11111 }, chat: { id: 99999 } } as Parameters<typeof isAuthorizedAdmin>[0];
      const ctx2 = { from: { id: 22222 }, chat: { id: 99999 } } as Parameters<typeof isAuthorizedAdmin>[0];
      const ctx3 = { from: { id: 33333 }, chat: { id: 99999 } } as Parameters<typeof isAuthorizedAdmin>[0];
      const ctxUnauthorized = { from: { id: 44444 }, chat: { id: 99999 } } as Parameters<typeof isAuthorizedAdmin>[0];

      assert.strictEqual(isAuthorizedAdmin(ctx1, configuredIds), true);
      assert.strictEqual(isAuthorizedAdmin(ctx2, configuredIds), true);
      assert.strictEqual(isAuthorizedAdmin(ctx3, configuredIds), true);
      assert.strictEqual(isAuthorizedAdmin(ctxUnauthorized, configuredIds), false);
    });
  });

  describe('관리자 미들웨어 차단 동작 시뮬레이션', () => {
    it('비인가 유저는 next()가 호출되지 않고 차단 안내가 전송되어야 함', async () => {
      const replies: string[] = [];
      const mockCtx = {
        from: { id: 99999, username: 'hacker' },
        chat: { id: 99999, type: 'private' },
        reply: vi.fn(async (text: string) => {
          replies.push(text);
          return { message_id: 1 };
        }),
      };

      const next = vi.fn(async () => {});

      // 미들웨어 로직 실행 시뮬레이션 (configuredChatId: '12345')
      const configuredChatId = '12345';
      const isAuth = isAuthorizedAdmin(mockCtx as unknown as Parameters<typeof isAuthorizedAdmin>[0], configuredChatId);

      if (!isAuth) {
        await mockCtx.reply('⛔ 접근 권한이 없습니다.');
      } else {
        await next();
      }

      assert.strictEqual(next.mock.calls.length, 0, 'next()가 호출되지 않아야 함');
      assert.strictEqual(replies.length, 1);
      assert.strictEqual(replies[0], '⛔ 접근 권한이 없습니다.');
    });

    it('인가된 유저는 next()가 정상 호출되어야 함', async () => {
      const replies: string[] = [];
      const mockCtx = {
        from: { id: 12345, username: 'admin' },
        chat: { id: 12345, type: 'private' },
        reply: vi.fn(async (text: string) => {
          replies.push(text);
          return { message_id: 1 };
        }),
      };

      let nextCalled = false;
      const next = vi.fn(async () => {
        nextCalled = true;
      });

      const configuredChatId = '12345';
      const isAuth = isAuthorizedAdmin(mockCtx as unknown as Parameters<typeof isAuthorizedAdmin>[0], configuredChatId);

      if (!isAuth) {
        await mockCtx.reply('⛔ 접근 권한이 없습니다.');
      } else {
        await next();
      }

      assert.strictEqual(nextCalled, true, 'next()가 호출되어야 함');
      assert.strictEqual(replies.length, 0, '차단 메시지가 전송되지 않아야 함');
    });
  });
});
