import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Telegraf, type Context } from 'telegraf';
import { setupSystemCommands } from '../src/services/telegram/admin_handlers/system';
import * as utilsModule from '../src/modules/utils';
import {
  isPortainerConfigured,
  triggerPortainerStackRedeploy,
  PortainerApiError,
  resetPortainerAuthCache,
} from '../src/services/portainer_client';

type FetchResult = { status?: number; body?: unknown };
type FetchHandler = (url: string, init?: RequestInit) => FetchResult;

const PORTAINER_ENV_KEYS = [
  'PORTAINER_URL',
  'PORTAINER_API_KEY',
  'PORTAINER_USERNAME',
  'PORTAINER_PASSWORD',
  'PORTAINER_ENDPOINT_ID',
  'PORTAINER_STACK_ID',
  'PORTAINER_STACK_NAME',
  'DV_DOCKER',
] as const;

let fetchHandler: FetchHandler = () => ({ body: {} });
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const result = fetchHandler(String(url), init);
  const body = result.body === undefined ? '' : JSON.stringify(result.body);
  return new Response(body, {
    status: result.status ?? 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

function setPortainerEnv(overrides: Record<string, string | undefined>): void {
  for (const key of PORTAINER_ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('Portainer 클라이언트', () => {
  const originalEnv = Object.fromEntries(PORTAINER_ENV_KEYS.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockClear();
    resetPortainerAuthCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchHandler = () => ({ body: {} });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setPortainerEnv({ DV_DOCKER: '1' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('PORTAINER_URL 미설정 시 비활성화된다', () => {
    setPortainerEnv({});
    expect(isPortainerConfigured()).toBe(false);

    setPortainerEnv({ PORTAINER_URL: 'https://portainer.example:9443' });
    expect(isPortainerConfigured()).toBe(true);
  });

  it('API 키 인증으로 endpoint/스택을 자동 발견하고 git redeploy를 호출한다', async () => {
    setPortainerEnv({
      PORTAINER_URL: 'https://portainer.example:9443/',
      PORTAINER_API_KEY: 'secret-key',
    });
    fetchHandler = (url) => {
      if (url.includes('/api/endpoints')) return { body: [{ Id: 1, Name: 'local' }] };
      if (url.includes('/api/stacks/')) return { body: { Id: 7 } };
      if (url.endsWith('/api/stacks')) return { body: [{ Id: 7, Name: 'dv-auto', EndpointId: 1 }] };
      return { body: {} };
    };

    const message = await triggerPortainerStackRedeploy();

    expect(message).toContain("'dv-auto'");

    const redeployCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/git/redeploy'));
    expect(redeployCall).toBeDefined();
    // 끝의 / 를 정규화한 베이스 URL + endpointId 쿼리
    expect(String(redeployCall![0])).toBe('https://portainer.example:9443/api/stacks/7/git/redeploy?endpointId=1');
    expect(redeployCall![1]).toMatchObject({ method: 'PUT' });
    expect(JSON.parse(String(redeployCall![1]!.body))).toEqual({ prune: false, repullImageAndRedeploy: true });
    const headers = redeployCall![1]!.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('secret-key');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('API 키가 없으면 username/password로 JWT를 발급받아 Bearer 인증한다', async () => {
    setPortainerEnv({
      PORTAINER_URL: 'https://portainer.example:9443',
      PORTAINER_USERNAME: 'admin',
      PORTAINER_PASSWORD: 'pw1234',
    });
    fetchHandler = (url) => {
      if (url.endsWith('/api/auth')) return { body: { jwt: 'jwt-token-1' } };
      if (url.includes('/api/endpoints')) return { body: [{ Id: 2, Name: 'local' }] };
      if (url.includes('/api/stacks/')) return { body: { Id: 3 } };
      if (url.endsWith('/api/stacks')) return { body: [{ Id: 3, Name: 'only-stack', EndpointId: 2 }] };
      return { body: {} };
    };

    await triggerPortainerStackRedeploy();

    const authCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/api/auth'));
    expect(authCall).toBeDefined();
    expect(JSON.parse(String(authCall![1]!.body))).toEqual({ username: 'admin', password: 'pw1234' });

    const redeployCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/git/redeploy'));
    const headers = redeployCall![1]!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer jwt-token-1');
    expect(headers['X-API-Key']).toBeUndefined();
  });

  it('ENDPOINT_ID/STACK_ID 환경변수가 지정되면 자동 발견 없이 해당 ID를 사용한다', async () => {
    setPortainerEnv({
      PORTAINER_URL: 'https://portainer.example:9443',
      PORTAINER_API_KEY: 'k',
      PORTAINER_ENDPOINT_ID: '3',
      PORTAINER_STACK_ID: '9',
    });
    fetchHandler = (url) => {
      if (url.endsWith('/api/stacks')) return { body: [{ Id: 9, Name: 'dv-auto', EndpointId: 3 }] };
      return { body: { Id: 9 } };
    };

    await triggerPortainerStackRedeploy();

    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/api/endpoints'))).toBe(false);
    expect(urls.some((u) => u === 'https://portainer.example:9443/api/stacks/9/git/redeploy?endpointId=3')).toBe(true);
  });

  it('이미 배포 중이면(409) 안내 메시지와 함께 실패한다', async () => {
    setPortainerEnv({
      PORTAINER_URL: 'https://portainer.example:9443',
      PORTAINER_API_KEY: 'k',
      PORTAINER_ENDPOINT_ID: '1',
      PORTAINER_STACK_ID: '5',
    });
    fetchHandler = (url) => {
      if (url.endsWith('/api/stacks')) return { body: [{ Id: 5, Name: 'dv-auto', EndpointId: 1 }] };
      if (url.endsWith('/api/stacks/5')) return { body: { Env: [], GitConfig: { ReferenceName: 'refs/heads/main' } } };
      return { status: 409, body: { message: 'conflict' } };
    };

    await expect(triggerPortainerStackRedeploy()).rejects.toThrow(/이미 배포가 진행 중/);
  });

  it('재배포 시 스택 환경변수가 사라지지 않도록 redeploy 페이로드에 그대로 실어 보낸다', async () => {
    setPortainerEnv({
      PORTAINER_URL: 'https://portainer.example:9443',
      PORTAINER_API_KEY: 'k',
      PORTAINER_ENDPOINT_ID: '1',
      PORTAINER_STACK_ID: '5',
    });
    const env = [
      { Name: 'DV_USER', Value: 'user' },
      { Name: 'DV_PASS', Value: 'pw' },
      { Name: 'TELEGRAM_BOT_TOKEN', Value: 'token' },
    ];
    fetchHandler = (url) => {
      if (url.endsWith('/api/stacks')) return { body: [{ Id: 5, Name: 'dv-auto', EndpointId: 1 }] };
      if (url.endsWith('/api/stacks/5')) return { body: { Env: env, GitConfig: { ReferenceName: 'refs/heads/main' } } };
      return { body: {} };
    };

    await triggerPortainerStackRedeploy();

    const redeployCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/git/redeploy'));
    expect(redeployCall).toBeDefined();
    const payload = JSON.parse(String((redeployCall![1] as RequestInit).body));

    // 구버전 Portainer 는 stack.Env = payload.Env 로 무조건 덮어쓴다.
    expect(payload.Env).toEqual(env);
    // 브랜치도 무조건 덮어써지므로 되돌려 보내야 한다.
    expect(payload.RepositoryReferenceName).toBe('refs/heads/main');
    expect(payload.repullImageAndRedeploy).toBe(true);
  });

  it('신버전(git 설정이 CurrentDeploymentInfo 에만 있는 경우)에서도 브랜치를 보존한다', async () => {
    setPortainerEnv({
      PORTAINER_URL: 'https://portainer.example:9443',
      PORTAINER_API_KEY: 'k',
      PORTAINER_ENDPOINT_ID: '1',
      PORTAINER_STACK_ID: '5',
    });
    fetchHandler = (url) => {
      if (url.endsWith('/api/stacks')) return { body: [{ Id: 5, Name: 'dv-auto', EndpointId: 1 }] };
      if (url.endsWith('/api/stacks/5'))
        return {
          body: { Env: [{ Name: 'A', Value: '1' }], CurrentDeploymentInfo: { ReferenceName: 'refs/heads/dev' } },
        };
      return { body: {} };
    };

    await triggerPortainerStackRedeploy();

    const redeployCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/git/redeploy'));
    const payload = JSON.parse(String((redeployCall![1] as RequestInit).body));
    expect(payload.RepositoryReferenceName).toBe('refs/heads/dev');
    expect(payload.Env).toEqual([{ Name: 'A', Value: '1' }]);
  });

  it('비공개 저장소 자격증명이 있으면 재사용을 요청한다', async () => {
    setPortainerEnv({
      PORTAINER_URL: 'https://portainer.example:9443',
      PORTAINER_API_KEY: 'k',
      PORTAINER_ENDPOINT_ID: '1',
      PORTAINER_STACK_ID: '5',
    });
    fetchHandler = (url) => {
      if (url.endsWith('/api/stacks')) return { body: [{ Id: 5, Name: 'dv-auto', EndpointId: 1 }] };
      if (url.endsWith('/api/stacks/5'))
        return {
          body: {
            Env: [{ Name: 'A', Value: '1' }],
            GitConfig: { ReferenceName: 'refs/heads/main', Authentication: { Username: 'git-user' } },
          },
        };
      return { body: {} };
    };

    await triggerPortainerStackRedeploy();

    const redeployCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/git/redeploy'));
    const payload = JSON.parse(String((redeployCall![1] as RequestInit).body));
    expect(payload.RepositoryAuthentication).toBe(true);
    expect(payload.RepositoryUsername).toBe('git-user');
    // 비밀번호는 비워 보냅니다(빈 값이면 저장된 자격증명 유지).
    expect(payload.RepositoryPassword).toBeUndefined();
  });

  it('스택에 환경변수가 하나도 없으면 Env 를 payload 에 넣지 않는다', async () => {
    setPortainerEnv({
      PORTAINER_URL: 'https://portainer.example:9443',
      PORTAINER_API_KEY: 'k',
      PORTAINER_ENDPOINT_ID: '1',
      PORTAINER_STACK_ID: '5',
    });
    fetchHandler = (url) => {
      if (url.endsWith('/api/stacks')) return { body: [{ Id: 5, Name: 'dv-auto', EndpointId: 1 }] };
      if (url.endsWith('/api/stacks/5')) return { body: { Env: [], GitConfig: { ReferenceName: 'refs/heads/main' } } };
      return { body: {} };
    };

    await triggerPortainerStackRedeploy();

    const redeployCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/git/redeploy'));
    const payload = JSON.parse(String((redeployCall![1] as RequestInit).body));
    expect(payload.Env).toBeUndefined();
    expect(payload.RepositoryReferenceName).toBe('refs/heads/main');
  });

  it('git 기반 스택이 아니면(400) 유형 안내와 함께 실패한다', async () => {
    setPortainerEnv({
      PORTAINER_URL: 'https://portainer.example:9443',
      PORTAINER_API_KEY: 'k',
      PORTAINER_ENDPOINT_ID: '1',
      PORTAINER_STACK_ID: '5',
    });
    fetchHandler = (url) => {
      if (url.endsWith('/api/stacks')) return { body: [{ Id: 5, Name: 'dv-auto', EndpointId: 1 }] };
      if (url.endsWith('/api/stacks/5')) return { body: { Env: [], GitConfig: { ReferenceName: 'refs/heads/main' } } };
      return { status: 400, body: { message: 'Stack is not created from git' } };
    };

    await expect(triggerPortainerStackRedeploy()).rejects.toThrow(/git\(Repository\) 기반/);
  });

  it('스택이 여러 개이고 이름 지정이 없으면 PORTAINER_STACK_NAME 안내와 함께 실패한다', async () => {
    setPortainerEnv({
      PORTAINER_URL: 'https://portainer.example:9443',
      PORTAINER_API_KEY: 'k',
    });
    fetchHandler = (url) => {
      if (url.includes('/api/endpoints')) return { body: [{ Id: 1, Name: 'local' }] };
      if (url.endsWith('/api/stacks'))
        return {
          body: [
            { Id: 1, Name: 'alpha', EndpointId: 1 },
            { Id: 2, Name: 'beta', EndpointId: 1 },
          ],
        };
      return { body: {} };
    };

    await expect(triggerPortainerStackRedeploy()).rejects.toThrow(/PORTAINER_STACK_NAME/);
  });

  it('인증 정보가 없으면 요청 전에 실패한다', async () => {
    setPortainerEnv({ PORTAINER_URL: 'https://portainer.example:9443' });

    await expect(triggerPortainerStackRedeploy()).rejects.toThrow(PortainerApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('/update_app 명령어 Portainer 연동', () => {
  type CommandHandler = (ctx: unknown) => Promise<unknown> | unknown;
  const originalEnv = Object.fromEntries(PORTAINER_ENV_KEYS.map((k) => [k, process.env[k]]));

  let commandHandlers: Map<string, CommandHandler>;
  let replyMock: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockClear();
    resetPortainerAuthCache();
    vi.stubGlobal('fetch', fetchMock);
    fetchHandler = () => ({ body: {} });
    commandHandlers = new Map();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const adminBot = {
      command: vi.fn().mockImplementation((commands: string | string[], handler: CommandHandler) => {
        const cmdList = Array.isArray(commands) ? commands : [commands];
        for (const cmd of cmdList) {
          commandHandlers.set(cmd, handler);
        }
      }),
    } as unknown as Telegraf;
    setupSystemCommands(adminBot);

    replyMock = vi.spyOn(utilsModule, 'replyWithSplit').mockResolvedValue(undefined);
    setPortainerEnv({ DV_DOCKER: '1' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('도커 + Portainer 설정 시 시작 안내 후 재배포를 요청하고 완료를 회신한다', async () => {
    setPortainerEnv({
      DV_DOCKER: '1',
      PORTAINER_URL: 'https://portainer.example:9443',
      PORTAINER_API_KEY: 'k',
      PORTAINER_ENDPOINT_ID: '1',
      PORTAINER_STACK_ID: '4',
    });
    fetchHandler = (url) => {
      if (url.endsWith('/api/stacks')) return { body: [{ Id: 4, Name: 'dv-auto', EndpointId: 1 }] };
      return { body: { Id: 4 } };
    };

    const handler = commandHandlers.get('update_app')!;
    const ctx = { message: { text: '/update_app' }, from: { username: 'admin' } } as unknown as Context;
    await handler(ctx);

    // 1차: 시작 안내 (즉시) — 완료 회신과의 레이스를 피해 메시지 내용만 검증
    expect(replyMock.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(replyMock.mock.calls[0][1]).toContain('Portainer로 스택 업데이트');

    // 2차: 완료 회신 (재배포 응답 수신 후)
    await vi.waitFor(() => {
      expect(replyMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    const finalMessage = replyMock.mock.calls[1][1] as string;
    expect(finalMessage).toContain('✅ Portainer 재배포 완료');
    expect(finalMessage).toContain("'dv-auto'");

    const redeployCall = fetchMock.mock.calls.find((c) => String(c[0]).includes('/git/redeploy'));
    expect(redeployCall).toBeDefined();
  });

  it('도커 + Portainer 설정 시 실패하면 오류를 회신한다', async () => {
    setPortainerEnv({
      DV_DOCKER: '1',
      PORTAINER_URL: 'https://portainer.example:9443',
      PORTAINER_API_KEY: 'k',
      PORTAINER_ENDPOINT_ID: '1',
      PORTAINER_STACK_ID: '4',
    });
    fetchHandler = () => ({ status: 500, body: { message: 'boom' } });

    const handler = commandHandlers.get('update_app')!;
    const ctx = { message: { text: '/update_app' }, from: { username: 'admin' } } as unknown as Context;
    await handler(ctx);

    await vi.waitFor(() => {
      expect(replyMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    const finalMessage = replyMock.mock.calls[1][1] as string;
    expect(finalMessage).toContain('❌ Portainer 업데이트 실패');
    expect(finalMessage).toContain('HTTP 500');
  });

  it('도커 + Portainer 미설정 시 기존 호스트 안내 메시지를 회신한다', async () => {
    setPortainerEnv({ DV_DOCKER: '1' });

    const handler = commandHandlers.get('update_app')!;
    const ctx = { message: { text: '/update_app' }, from: { username: 'admin' } } as unknown as Context;
    await handler(ctx);

    expect(replyMock).toHaveBeenCalledTimes(1);
    const message = replyMock.mock.calls[0][1] as string;
    expect(message).toContain('docker compose up -d --build');
    expect(message).toContain('PORTAINER_URL');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
