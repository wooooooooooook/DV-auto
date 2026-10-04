import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { commitAndPushIfChanged } from '../src/services/telegram/quiz_cheatsheet';

type ExecResult = { err?: Error; stdout?: string; stderr?: string };
type ExecHandler = (cmd: string) => ExecResult;

const execMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    exec: (cmd: string, opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      execMock(cmd, opts);
      const res = execHandler(cmd);
      setImmediate(() => cb(res.err ?? null, res.stdout ?? '', res.stderr ?? ''));
    },
  };
});

let execHandler: ExecHandler = () => ({ stdout: '' });

const tempDirs: string[] = [];
function makeTempRepoDir(): string {
  const dir = path.join(os.tmpdir(), `dv-git-sync-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  tempDirs.push(dir);
  return dir;
}

describe('도커 환경 git 동기화 (commitAndPushIfChanged)', () => {
  const originalEnv = {
    DV_DOCKER: process.env.DV_DOCKER,
    DV_GIT_REPO_DIR: process.env.DV_GIT_REPO_DIR,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    DV_GITHUB_REPO: process.env.DV_GITHUB_REPO,
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    execMock.mockClear();
    execHandler = () => ({ stdout: '' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.DV_DOCKER = '1';
    process.env.DV_GIT_REPO_DIR = makeTempRepoDir();
    process.env.GITHUB_TOKEN = 'test-token';
    delete process.env.DV_GITHUB_REPO;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  afterAll(async () => {
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('도커에서 변경사항을 클론 저장소에 커밋하고 GitHub에 푸시한다', async () => {
    process.env.DV_GIT_REPO_DIR = makeTempRepoDir();
    execHandler = (cmd) => {
      if (cmd.startsWith('git status')) return { stdout: ' M data/quiz.json\n' };
      return { stdout: '' };
    };

    const result = await commitAndPushIfChanged(['data/quiz.json'], 'update quiz.json');

    expect(result.performed).toBe(true);
    expect(result.notice).toContain('✅ Git 커밋/푸시 완료');

    const cmds = execMock.mock.calls.map((c) => c[0] as string);
    const repoDir = process.env.DV_GIT_REPO_DIR!;
    expect(cmds.some((c) => c.includes('clone --depth 1') && c.includes('DV-auto.git'))).toBe(true);
    expect(cmds).toContain(
      `git config credential.helper '!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f'`,
    );
    expect(cmds.some((c) => c === 'git pull --rebase')).toBe(true);
    expect(cmds.some((c) => c === `git add 'data/quiz.json'`)).toBe(true);
    expect(cmds.some((c) => c === `git commit -m 'update quiz.json'`)).toBe(true);
    expect(cmds).toContain('git push');

    // git 명령들은 동기화 저장소 디렉터리에서 실행되어야 한다
    const statusCall = execMock.mock.calls.find((c) => (c[0] as string).startsWith('git status'));
    expect(statusCall?.[1]).toMatchObject({ cwd: repoDir });
    const pushCall = execMock.mock.calls.find((c) => c[0] === 'git push');
    expect(pushCall?.[1]).toMatchObject({ cwd: repoDir });
  });

  it('변경사항이 없으면 푸시 없이 "변경사항 없음"을 회신한다', async () => {
    process.env.DV_GIT_REPO_DIR = makeTempRepoDir();
    execHandler = (cmd) => {
      if (cmd.startsWith('git status')) return { stdout: '' };
      return { stdout: '' };
    };

    const result = await commitAndPushIfChanged(['data/quiz.json'], 'noop');

    expect(result.performed).toBe(false);
    expect(result.notice).toContain('Git 변경사항 없음');
    const cmds = execMock.mock.calls.map((c) => c[0] as string);
    expect(cmds).not.toContain('git push');
    expect(cmds.some((c) => c.startsWith('git commit'))).toBe(false);
  });

  it('GITHUB_TOKEN이 없으면 커밋만 하고 푸시는 건너뛴다', async () => {
    process.env.DV_GIT_REPO_DIR = makeTempRepoDir();
    delete process.env.GITHUB_TOKEN;
    execHandler = (cmd) => {
      if (cmd.startsWith('git status')) return { stdout: ' M data/quiz.json\n' };
      return { stdout: '' };
    };

    const result = await commitAndPushIfChanged(['data/quiz.json'], 'update quiz.json');

    expect(result.performed).toBe(true);
    expect(result.notice).toContain('GITHUB_TOKEN');
    expect(result.notice).toContain('✅ Git 커밋 완료');
    const cmds = execMock.mock.calls.map((c) => c[0] as string);
    expect(cmds).not.toContain('git push');
    expect(cmds.some((c) => c === `git commit -m 'update quiz.json'`)).toBe(true);
  });

  it('DV_GIT_REPO_DIR 미설정 시 안내 메시지와 함께 실패한다', async () => {
    delete process.env.DV_GIT_REPO_DIR;

    await expect(commitAndPushIfChanged(['data/quiz.json'], 'msg')).rejects.toThrow(/DV_GIT_REPO_DIR/);
    const cmds = execMock.mock.calls.map((c) => c[0] as string);
    expect(cmds.some((c) => c.includes('clone'))).toBe(false);
  });

  it('push가 거부되면 원격 기준으로 재설정 후 재커밋하여 재시도한다', async () => {
    process.env.DV_GIT_REPO_DIR = makeTempRepoDir();
    let pushCount = 0;
    execHandler = (cmd) => {
      if (cmd.startsWith('git status')) return { stdout: ' M data/quiz.json\n' };
      if (cmd === 'git push') {
        pushCount += 1;
        if (pushCount === 1) {
          return {
            err: new Error('git push failed'),
            stderr: '! [rejected] main -> main (fetch first)\nerror: failed to push some refs to github.com',
          };
        }
        return { stdout: 'To github.com\n   old..new  main -> main\n' };
      }
      return { stdout: '' };
    };

    const result = await commitAndPushIfChanged(['data/quiz.json'], 'update quiz.json');

    expect(result.performed).toBe(true);
    expect(result.notice).toContain('✅ Git 커밋/푸시 완료');
    expect(result.notice).toContain('덮어썼습니다');

    const cmds = execMock.mock.calls.map((c) => c[0] as string);
    expect(cmds).toContain('git fetch origin');
    expect(cmds).toContain(`git reset --hard '@{u}'`);
    expect(cmds.filter((c) => c === 'git push')).toHaveLength(2);
    // 재시도 시 커밋이 한 번 더 발생한다
    expect(cmds.filter((c) => c === `git commit -m 'update quiz.json'`)).toHaveLength(2);
  });

  it('로컬에서 삭제된 파일은 저장소에서도 삭제 후 커밋한다', async () => {
    const repoDir = makeTempRepoDir();
    process.env.DV_GIT_REPO_DIR = repoDir;
    // 저장소 쪽에는 파일이 존재하고, 앱 로컬(프로젝트 data/)에는 없는 상태
    await fs.mkdir(path.join(repoDir, '.git'), { recursive: true });
    await fs.mkdir(path.join(repoDir, 'data'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'data', 'vanished_test.json'), '{"a":1}\n', 'utf8');
    execHandler = (cmd) => {
      if (cmd.startsWith('git status')) return { stdout: ' D data/vanished_test.json\n' };
      return { stdout: '' };
    };

    const result = await commitAndPushIfChanged(['data/vanished_test.json'], 'delete vanished_test');

    expect(result.performed).toBe(true);
    await expect(fs.access(path.join(repoDir, 'data', 'vanished_test.json'))).rejects.toThrow();
    const cmds = execMock.mock.calls.map((c) => c[0] as string);
    expect(cmds.some((c) => c === `git add 'data/vanished_test.json'`)).toBe(true);
    expect(cmds).toContain('git push');
  });

  it('비도커(시스템드) 환경에서는 기존대로 작업중인 저장소(cwd)에서 push한다', async () => {
    process.env.DV_DOCKER = '0';
    delete process.env.DV_GIT_REPO_DIR;
    execHandler = (cmd) => {
      if (cmd.startsWith('git status')) return { stdout: ' M data/quiz.json\n' };
      return { stdout: '' };
    };

    const result = await commitAndPushIfChanged(['data/quiz.json'], 'update quiz.json');

    expect(result.performed).toBe(true);
    expect(result.notice).toContain('✅ Git 커밋/푸시 완료');

    const cmds = execMock.mock.calls.map((c) => c[0] as string);
    // 기존 경로는 clone 하지 않는다
    expect(cmds.some((c) => c.includes('clone'))).toBe(false);
    const statusCall = execMock.mock.calls.find((c) => (c[0] as string).startsWith('git status'));
    expect(statusCall?.[1]).toMatchObject({ cwd: process.cwd() });
    const pushCall = execMock.mock.calls.find((c) => c[0] === 'git push');
    expect(pushCall?.[1]).toMatchObject({ cwd: process.cwd() });
    expect(cmds.some((c) => c === `git commit -m 'update quiz.json'`)).toBe(true);
  });
});
