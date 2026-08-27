import assert from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'vitest';
import { noticeCommands, adminCommands } from '../src/services/telegram';
import { setBot, clearNoticeCooldowns } from '../src/services/bot_instance';
import * as storage from '../src/services/storage';
import type { Telegraf } from 'telegraf';

describe('공지봇 봇커맨드 및 구독설정(settings) 통합 테스트', () => {
  beforeEach(() => {
    storage.setDatabasePath(':memory:');
    storage.clear();
    clearNoticeCooldowns();
  });

  afterEach(() => {
    storage.closeDatabase();
  });

  it('관리자 봇 커맨드 목록(adminCommands)에서 삭제된 3가지 메시지 관리 명령어가 제외되어야 한다', () => {
    const adminCommandNames = adminCommands.map((c) => c.command);

    assert(
      !adminCommandNames.includes('edit_channel_message'),
      'adminCommands에 edit_channel_message가 포함되지 않아야 함',
    );
    assert(
      !adminCommandNames.includes('delete_channel_message'),
      'adminCommands에 delete_channel_message가 포함되지 않아야 함',
    );
    assert(
      !adminCommandNames.includes('delete_today_channel_messages'),
      'adminCommands에 delete_today_channel_messages가 포함되지 않아야 함',
    );
    assert(adminCommandNames.includes('channel_messages'), 'adminCommands에 channel_messages는 유지되어야 함');
  });

  it('공지봇 커맨드 목록(noticeCommands)에서 구독설정이 settings로 통합되어야 한다', () => {
    const commandNames = noticeCommands.map((c) => c.command);

    // settings는 포함되어 있어야 함
    assert(commandNames.includes('settings'), 'noticeCommands에 settings 명령어가 포함되어야 함');

    // 개별 구독/구독해제 및 구버전 subscribe_settings 명령어는 noticeCommands에 노출되지 않아야 함
    assert(!commandNames.includes('subscribe_settings'), 'noticeCommands에 subscribe_settings가 노출되지 않아야 함');
    assert(
      !commandNames.includes('subscribe_seminar_changes'),
      'noticeCommands에 subscribe_seminar_changes가 노출되지 않아야 함',
    );
    assert(
      !commandNames.includes('unsubscribe_seminar_changes'),
      'noticeCommands에 unsubscribe_seminar_changes가 노출되지 않아야 함',
    );
    assert(
      !commandNames.includes('subscribe_intermd_quiz'),
      'noticeCommands에 subscribe_intermd_quiz가 노출되지 않아야 함',
    );
    assert(
      !commandNames.includes('unsubscribe_intermd_quiz'),
      'noticeCommands에 unsubscribe_intermd_quiz가 노출되지 않아야 함',
    );

    // 필수 기본 커맨드 포함 확인
    assert(commandNames.includes('today_links'), 'today_links 포함 확인');
    assert(commandNames.includes('intermd_quiz'), 'intermd_quiz 포함 확인');
    assert(commandNames.includes('seminar_detail'), 'seminar_detail 포함 확인');
    assert(commandNames.includes('check_advanced_seminars'), 'check_advanced_seminars 포함 확인');
    assert(commandNames.includes('help'), 'help 포함 확인');
  });

  it('bot_instance에서 settings 및 별칭 커맨드가 구독 설정 UI를 정상 응답해야 한다', async () => {
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
      action: () => {},
    } as unknown as Telegraf;

    setBot('notice', mockNoticeBot);

    // settings 및 동의어 커맨드 핸들러 등록 확인
    assert(typeof registeredCommands['settings'] === 'function', 'settings 커맨드 등록 확인');
    assert(typeof registeredCommands['구독설정'] === 'function', '구독설정 커맨드 등록 확인');
    assert(typeof registeredCommands['구독'] === 'function', '구독 커맨드 등록 확인');
    assert(typeof registeredCommands['subscribe'] === 'function', 'subscribe 커맨드 등록 확인');
    assert(typeof registeredCommands['subscribe_settings'] === 'function', 'subscribe_settings 커맨드 등록 확인');

    // settings 커맨드 실행 검증
    let repliedText = '';
    let repliedOptions: Record<string, unknown> | undefined;

    const mockCtx = {
      from: { id: 12345 },
      chat: { id: 12345 },
      reply: async (text: string, options?: Record<string, unknown>) => {
        repliedText = text;
        repliedOptions = options;
      },
    };

    await registeredCommands['settings'](mockCtx);

    assert(repliedText.includes('알림 구독 설정'), '구독 설정 메뉴 제목이 포함되어야 함');
    assert(repliedOptions !== undefined, '인라인 키보드 reply_markup 옵션이 포함되어야 함');
    assert(repliedOptions && 'reply_markup' in repliedOptions, 'reply_markup이 전달되어야 함');
  });
});
