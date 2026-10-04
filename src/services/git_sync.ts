import path from 'path';
import fs from 'fs/promises';
import { exec } from 'child_process';
import * as logger from './logger';

export type GitPushResult = { performed: boolean; notice: string };

type ShellResult = { stdout: string; stderr: string };
type ShellError = Error & { stdout?: string; stderr?: string };

/** 기본 대상 저장소 (DV_GITHUB_REPO 로 재정의 가능) */
const DEFAULT_GITHUB_REPO = 'wooooooooooook/DV-auto';

/**
 * git push 인증용 credential helper.
 * 토큰을 명령어 인자나 설정 파일에 노출하지 않고,
 * helper 가 실행되는 시점에 환경변수 GITHUB_TOKEN 에서 읽도록 한다.
 */
const CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo password=$GITHUB_TOKEN; }; f';

const GIT_USER_NAME = () => process.env.DV_GIT_USER_NAME?.trim() || 'dv-auto-bot';
const GIT_USER_EMAIL = () => process.env.DV_GIT_USER_EMAIL?.trim() || 'dv-auto-bot@users.noreply.github.com';

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function run(cmd: string, cwd: string): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const wrapped: ShellError = new Error(error.message);
        wrapped.stdout = String(stdout ?? '');
        wrapped.stderr = String(stderr ?? '');
        return reject(wrapped);
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

function getRepoDir(): string | null {
  return process.env.DV_GIT_REPO_DIR?.trim() || null;
}

function getGithubRepoUrl(): string {
  const repo = process.env.DV_GITHUB_REPO?.trim() || DEFAULT_GITHUB_REPO;
  return `https://github.com/${repo}.git`;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function configureRepo(repoDir: string): Promise<void> {
  await run(`git config credential.helper ${shellQuote(CREDENTIAL_HELPER)}`, repoDir);
  await run(`git config user.name ${shellQuote(GIT_USER_NAME())}`, repoDir);
  await run(`git config user.email ${shellQuote(GIT_USER_EMAIL())}`, repoDir);
}

/**
 * 도커용 동기화 저장소를 준비한다.
 * - 최초: shallow clone (public 저장소는 인증 불필요, 비공개는 credential helper 사용)
 * - 그 외: 설정(인증 helper/커밋 계정) 갱신 + 원격 변경 반영(실패해도 진행 가능)
 * 충돌 시 rebase 를 정리하고 로컬 워킹트리를 보존하며, 조율은 푸시 단계에서 한다.
 */
export async function prepareGitSyncRepo(): Promise<string> {
  const repoDir = getRepoDir();
  if (!repoDir) {
    throw new Error('도커 Git 동기화 미설정: DV_GIT_REPO_DIR 환경변수가 없습니다. (예: /app/runtime-data/repo)');
  }
  const resolvedRepoDir = path.resolve(repoDir);

  if (!(await pathExists(path.join(resolvedRepoDir, '.git')))) {
    const repoUrl = getGithubRepoUrl();
    const parentDir = path.dirname(resolvedRepoDir);
    await fs.mkdir(parentDir, { recursive: true });

    const targetEntries = await fs.readdir(resolvedRepoDir).catch(() => null);
    if (targetEntries && targetEntries.length > 0) {
      throw new Error(
        `DV_GIT_REPO_DIR(${resolvedRepoDir})에 .git 이 없는 기존 파일이 있습니다. 디렉터리를 비우거나 다른 경로로 지정해주세요.`,
      );
    }

    logger.info('도커 Git 동기화: 저장소 클론 시도', { repoUrl, repoDir: resolvedRepoDir });
    await run(
      `git -c ${shellQuote(`credential.helper=${CREDENTIAL_HELPER}`)} clone --depth 1 ${shellQuote(repoUrl)} ${shellQuote(resolvedRepoDir)}`,
      parentDir,
    );
  }

  await configureRepo(resolvedRepoDir);

  // 원격 변경 반영 (best effort). 충돌/오프라인이면 정리 후 진행하고,
  // 실제 조율은 push 단계의 거부-재시도 로직이 처리한다.
  try {
    await run('git pull --rebase', resolvedRepoDir);
  } catch (e) {
    logger.warn('도커 Git 동기화: pull 실패, 로컬 상태 정리 후 진행', e);
    await run('git rebase --abort', resolvedRepoDir).catch(() => {});
    await run('git merge --abort', resolvedRepoDir).catch(() => {});
  }

  return resolvedRepoDir;
}

function isPushRejected(error: unknown): boolean {
  const err = error as ShellError;
  const text = `${err?.message ?? ''}\n${err?.stderr ?? ''}\n${err?.stdout ?? ''}`;
  return /rejected|non-fast-forward|fetch first/i.test(text);
}

async function syncFilesIntoRepo(repoDir: string, files: string[]): Promise<void> {
  for (const file of files) {
    const src = path.resolve(process.cwd(), file);
    const dst = path.resolve(repoDir, file);
    if (src === dst) continue;

    if (await pathExists(src)) {
      await fs.mkdir(path.dirname(dst), { recursive: true });
      await fs.copyFile(src, dst);
    } else {
      // 로컬에서 삭제된 파일은 저장소에서도 삭제 반영
      await fs.rm(dst, { force: true });
    }
  }
}

async function statusForFiles(repoDir: string, files: string[]): Promise<string> {
  const fileArgs = files.map(shellQuote).join(' ');
  const { stdout } = await run(`git status --porcelain -- ${fileArgs}`, repoDir);
  return stdout;
}

async function addAndCommit(repoDir: string, files: string[], message: string): Promise<void> {
  const fileArgs = files.map(shellQuote).join(' ');
  await run(`git add ${fileArgs}`, repoDir);
  await run(`git commit -m ${shellQuote(message)}`, repoDir);
}

/**
 * 도커 컨테이너에서 앱 데이터 파일의 변경사항을 GitHub 에 커밋/푸시한다.
 * 클론은 DV_GIT_REPO_DIR(볼륨)에 유지되므로 컨테이너 재생성 후에도 이어진다.
 *
 * 원격이 더 최신이라 push 가 거부되면 원격 기준으로 초기화 후
 * 앱 데이터 파일로 재커밋하여 재시도한다 (파일 단위 last-wins).
 * 이때 되돌려지는 외부 변경이 있을 수 있으므로 결과에 경고를 남긴다.
 */
export async function commitAndPushInRepo(files: string[], message: string): Promise<GitPushResult> {
  const repoDir = await prepareGitSyncRepo();

  await syncFilesIntoRepo(repoDir, files);
  const status = await statusForFiles(repoDir, files);
  if (!status.trim()) {
    return { performed: false, notice: 'ℹ️ Git 변경사항 없음' };
  }

  await addAndCommit(repoDir, files, message);

  if (!process.env.GITHUB_TOKEN?.trim()) {
    return {
      performed: true,
      notice:
        '✅ Git 커밋 완료 (로컬)\n⚠️ GITHUB_TOKEN 미설정으로 푸시를 건너뛰었습니다. .env 에 GITHUB_TOKEN 추가 후 재시도하면 푸시됩니다.',
    };
  }

  const attemptPush = (): Promise<ShellResult> => run('git push', repoDir);

  try {
    const { stdout, stderr } = await attemptPush();
    const output = `${stdout}${stderr}`.trim();
    return { performed: true, notice: `✅ Git 커밋/푸시 완료${output ? `\n${output}` : ''}` };
  } catch (error) {
    if (!isPushRejected(error)) {
      throw error;
    }

    // 원격이 더 최신: 원격 기준으로 초기화 후 앱 데이터로 재커밋하여 재시도
    logger.warn('도커 Git 동기화: push 거부됨. 원격 기준으로 재설정 후 재시도합니다.', error);
    await run('git fetch origin', repoDir);
    await run("git reset --hard '@{u}'", repoDir);
    await syncFilesIntoRepo(repoDir, files);

    const retryStatus = await statusForFiles(repoDir, files);
    if (!retryStatus.trim()) {
      return { performed: false, notice: 'ℹ️ Git 변경사항 없음 (원격 저장소와 이미 동일합니다)' };
    }

    await addAndCommit(repoDir, files, message);
    const { stdout, stderr } = await attemptPush();
    const output = `${stdout}${stderr}`.trim();

    return {
      performed: true,
      notice:
        `✅ Git 커밋/푸시 완료 (충돌 자동 해결)` +
        `\n⚠️ 원격 저장소가 더 최신이어서 컨테이너의 데이터 파일로 덮어썼습니다. 외부에서 데이터 파일을 수정했다면 결과를 확인해주세요.` +
        (output ? `\n${output}` : ''),
    };
  }
}
