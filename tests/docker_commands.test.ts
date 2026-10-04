import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Telegraf, type Context } from 'telegraf';
import { setupSystemCommands } from '../src/services/telegram/admin_handlers/system';
import * as utilsModule from '../src/modules/utils';
import * as cheatsheetModule from '../src/services/telegram/quiz_cheatsheet';
import * as logger from '../src/services/logger';
import { isDockerEnv } from '../src/core/runtime_env';

type CommandHandler = (ctx: unknown) => Promise<unknown> | unknown;

// update_app 의 systemctl restart 는 실제 실행되지 않도록 spawn 을 모킹한다
const spawnMock = vi.hoisted(() => vi.fn(() => ({ unref: vi.fn() })));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: spawnMock };
});

describe('도커/시스템드 환경 감지 (runtime_env)', () => {
  const originalDocker = process.env.DV_DOCKER;

  afterEach(() => {
    if (originalDocker === undefined) {
      delete process.env.DV_DOCKER;
    } else {
      process.env.DV_DOCKER = originalDocker;
    }
  });

  it('DV_DOCKER=1이면 도커 환경으로 판별한다', () => {
    process.env.DV_DOCKER = '1';
    expect(isDockerEnv()).toBe(true);
  });

  it('DV_DOCKER=0이면 도커 환경이 아니라고 판별한다', () => {
    process.env.DV_DOCKER = '0';
    expect(isDockerEnv()).toBe(false);
  });

  it('오버라이드가 없으면 실제 감지 결과를 반환한다 (boolean)', () => {
    delete process.env.DV_DOCKER;
    expect(typeof isDockerEnv()).toBe('boolean');
  });
});

describe('로거 인메모리 로그 버퍼', () => {
  beforeEach(() => {
    logger.clearLogBuffer();
    // 콘솔 출력 소음을 줄이기 위해 로거의 console 출력을 흡수
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('로그 호출 시 버퍼에 기록되고 최근 순으로 조회된다', () => {
    logger.info('buffer-line-1');
    logger.warn('buffer-line-2');
    logger.error('buffer-line-3');

    const lines = logger.getRecentLogs(10);
    expect(lines.length).toBe(3);
    expect(lines[0]).toContain('buffer-line-1');
    expect(lines[2]).toContain('buffer-line-3');
    expect(lines[2]).toContain('[error]');
  });

  it('count를 초과하는 최근 로그만 반환한다', () => {
    for (let i = 1; i <= 5; i++) {
      logger.info(`line-${i}`);
    }
    const lines = logger.getRecentLogs(2);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain('line-4');
    expect(lines[1]).toContain('line-5');
  });

  it('버퍼는 최대 500개 항목으로 제한된다', () => {
    for (let i = 0; i < 600; i++) {
      logger.info(`flood-${i}`);
    }
    const lines = logger.getRecentLogs(600);
    expect(lines.length).toBe(500);
    expect(lines[0]).toContain('flood-100');
    expect(lines[499]).toContain('flood-599');
  });

  it('비정상 count는 빈 배열을 반환한다', () => {
    logger.info('anything');
    expect(logger.getRecentLogs(0)).toEqual([]);
    expect(logger.getRecentLogs(-1)).toEqual([]);
    expect(logger.getRecentLogs(NaN)).toEqual([]);
  });
});

describe('/log 명령어: 도커 vs 시스템드 분기', () => {
  let adminBot: Telegraf;
  let commandHandlers: Map<string, CommandHandler>;
  let replyMock: ReturnType<typeof vi.spyOn>;
  const originalDocker = process.env.DV_DOCKER;

  beforeEach(() => {
    vi.restoreAllMocks();
    logger.clearLogBuffer();
    commandHandlers = new Map();

    adminBot = {
      command: vi.fn().mockImplementation((commands: string | string[], handler: CommandHandler) => {
        const cmdList = Array.isArray(commands) ? commands : [commands];
        for (const cmd of cmdList) {
          commandHandlers.set(cmd, handler);
        }
      }),
    } as unknown as Telegraf;

    setupSystemCommands(adminBot);
    replyMock = vi.spyOn(utilsModule, 'replyWithSplit').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDocker === undefined) {
      delete process.env.DV_DOCKER;
    } else {
      process.env.DV_DOCKER = originalDocker;
    }
  });

  it('도커 환경에서는 journalctl 대신 인메모리 로그 버퍼를 사용한다', async () => {
    process.env.DV_DOCKER = '1';
    const execSpy = vi.spyOn(cheatsheetModule, 'runShellCommandWithAllowedExitCodes');
    logger.info('docker-log-entry');

    const handler = commandHandlers.get('log')!;
    const ctx = { message: { text: '/log 5' }, from: { username: 'admin' } } as unknown as Context;
    await handler(ctx);

    expect(execSpy).not.toHaveBeenCalled();
    const message = replyMock.mock.calls.at(-1)?.[1] as string;
    expect(message).toContain('인메모리 버퍼');
    expect(message).toContain('docker-log-entry');
  });

  it('도커 환경에서는 journalctl 에러 대신 버퍼 로그를 그대로 회신한다', async () => {
    process.env.DV_DOCKER = '1';

    const handler = commandHandlers.get('log')!;
    const ctx = { message: { text: '/log' }, from: { username: 'admin' } } as unknown as Context;
    await handler(ctx);

    const message = replyMock.mock.calls.at(-1)?.[1] as string;
    expect(message).toContain('인메모리 버퍼');
    expect(message).not.toContain('journalctl');
  });

  it('시스템드 환경에서는 기존대로 journalctl을 호출한다', async () => {
    process.env.DV_DOCKER = '0';
    const execSpy = vi
      .spyOn(cheatsheetModule, 'runShellCommandWithAllowedExitCodes')
      .mockResolvedValue({ stdout: 'journal line 1\njournal line 2', stderr: '' });

    const handler = commandHandlers.get('log')!;
    const ctx = { message: { text: '/log 10' }, from: { username: 'admin' } } as unknown as Context;
    await handler(ctx);

    expect(execSpy).toHaveBeenCalledTimes(1);
    const cmd = execSpy.mock.calls[0][0] as string;
    expect(cmd).toContain('journalctl');
    expect(cmd).toContain('-n 10');
    const message = replyMock.mock.calls.at(-1)?.[1] as string;
    expect(message).toContain('journal line 1');
  });
});

describe('/update_app 명령어: 도커 vs 시스템드 분기', () => {
  let adminBot: Telegraf;
  let commandHandlers: Map<string, CommandHandler>;
  let replyMock: ReturnType<typeof vi.spyOn>;
  const originalDocker = process.env.DV_DOCKER;

  beforeEach(() => {
    vi.restoreAllMocks();
    commandHandlers = new Map();

    adminBot = {
      command: vi.fn().mockImplementation((commands: string | string[], handler: CommandHandler) => {
        const cmdList = Array.isArray(commands) ? commands : [commands];
        for (const cmd of cmdList) {
          commandHandlers.set(cmd, handler);
        }
      }),
    } as unknown as Telegraf;

    setupSystemCommands(adminBot);
    replyMock = vi.spyOn(utilsModule, 'replyWithSplit').mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDocker === undefined) {
      delete process.env.DV_DOCKER;
    } else {
      process.env.DV_DOCKER = originalDocker;
    }
  });

  it('도커 환경에서는 셸 명령 없이 호스트 재빌드 안내를 회신한다', async () => {
    process.env.DV_DOCKER = '1';
    delete process.env.PORTAINER_URL;
    const execSpy = vi.spyOn(cheatsheetModule, 'runShellCommand');

    const handler = commandHandlers.get('update_app')!;
    const ctx = { message: { text: '/update_app' }, from: { username: 'admin' } } as unknown as Context;
    await handler(ctx);

    expect(execSpy).not.toHaveBeenCalled();
    expect(replyMock).toHaveBeenCalledTimes(1);
    const message = replyMock.mock.calls[0][1] as string;
    expect(message).toContain('도커 컨테이너 환경에서는 /update_app 으로 재빌드할 수 없습니다');
    expect(message).toContain('docker compose up -d --build');
  });

  it('시스템드 환경에서는 기존대로 빌드 명령을 실행한다', async () => {
    process.env.DV_DOCKER = '0';
    const execSpy = vi.spyOn(cheatsheetModule, 'runShellCommand').mockResolvedValue({ stdout: 'built ok', stderr: '' });

    const handler = commandHandlers.get('update_app')!;
    const ctx = { message: { text: '/update_app' }, from: { username: 'admin' } } as unknown as Context;
    await handler(ctx);

    // 빌드 완료 후 재시작이 별도 프로세스로 실행되므로 마이크로태스크 플러시 대기
    await vi.waitFor(() => {
      expect(execSpy).toHaveBeenCalledTimes(1);
    });
    const cmd = execSpy.mock.calls[0][0] as string;
    expect(cmd).toContain('git pull');
    expect(cmd).toContain('systemctl daemon-reload');
    // 재시작은 독립 프로세스로 실행된다
    await vi.waitFor(() => {
      expect(spawnMock).toHaveBeenCalledWith('systemctl', ['restart', 'doctorville-auto.service'], expect.anything());
    });
    await vi.waitFor(() => {
      const message = replyMock.mock.calls.at(-1)?.[1] as string;
      expect(message).toContain('앱 업데이트 및 빌드 성공');
    });
  });
});
