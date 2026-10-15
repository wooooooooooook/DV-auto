import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

export interface CommitInfo {
  commit: string | null;
  commitDate: string | null;
}

export function formatCommitHash(raw?: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'unknown' || lower === 'null' || lower === 'undefined' || lower === '""' || lower === "''") {
    return null;
  }

  // 40자리 git sha1인 경우 앞 7자리로 축약
  if (/^[0-9a-f]{40}$/i.test(trimmed)) {
    return trimmed.substring(0, 7);
  }
  return trimmed;
}

export function formatCommitDate(raw?: string | null): string | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();
  if (lower === 'unknown' || lower === 'null' || lower === 'undefined' || lower === '""' || lower === "''") {
    return null;
  }

  // 이미 YYYY-MM-DD HH:mm:ss 형식인 경우 그대로 사용
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(trimmed)) {
    return trimmed;
  }

  // Date 파싱 시도
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) {
    // 한국 시간(KST, UTC+9) 기준으로 YYYY-MM-DD HH:mm:ss 포맷팅
    const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    const yyyy = kst.getUTCFullYear();
    const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(kst.getUTCDate()).padStart(2, '0');
    const hh = String(kst.getUTCHours()).padStart(2, '0');
    const min = String(kst.getUTCMinutes()).padStart(2, '0');
    const ss = String(kst.getUTCSeconds()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  }

  return trimmed;
}

function loadBuildInfoFile(): CommitInfo | null {
  const candidatePaths = [
    path.resolve(process.cwd(), 'build-info.json'),
    path.resolve(process.cwd(), 'dist', 'build-info.json'),
    path.resolve(__dirname, '../../build-info.json'),
    path.resolve(__dirname, '../build-info.json'),
    path.resolve(__dirname, 'build-info.json'),
  ];

  for (const target of candidatePaths) {
    try {
      if (fs.existsSync(target)) {
        const raw = fs.readFileSync(target, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          return {
            commit: typeof parsed.commit === 'string' ? parsed.commit : null,
            commitDate: typeof parsed.commitDate === 'string' ? parsed.commitDate : null,
          };
        }
      }
    } catch {
      // 파싱 실패 시 다음 경로 시도
    }
  }

  return null;
}

function resolveFromGitCli(): CommitInfo {
  let commit: string | null = null;
  let commitDate: string | null = null;

  try {
    const hashOutput = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 2000,
    });
    if (hashOutput && hashOutput.trim()) {
      commit = hashOutput.trim();
    }
  } catch {
    // git CLI 미설치 또는 git 저장소 아님
  }

  try {
    const dateOutput = execSync('git log -1 --format="%cd" --date=format:"%Y-%m-%d %H:%M:%S"', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 2000,
    });
    if (dateOutput && dateOutput.trim()) {
      commitDate = dateOutput.trim();
    }
  } catch {
    // 무시
  }

  return { commit, commitDate };
}

/**
 * 현재 애플리케이션의 Git 커밋 번호 및 커밋 일시를 확인합니다.
 * 1. process.env.GIT_COMMIT / GIT_COMMIT_DATE
 * 2. build-info.json
 * 3. 로컬 git CLI 실행
 *
 * 감지된 정보는 process.env에도 동기화하여 프로세스 전역에서 일관되게 접근할 수 있습니다.
 */
export function getCommitInfo(): CommitInfo {
  // 1. 환경변수 확인
  let commit = formatCommitHash(process.env.GIT_COMMIT);
  let commitDate = formatCommitDate(process.env.GIT_COMMIT_DATE);

  if (commit) {
    return { commit, commitDate: commitDate ?? null };
  }

  // 2. build-info.json 확인
  const fileInfo = loadBuildInfoFile();
  if (fileInfo?.commit) {
    commit = formatCommitHash(fileInfo.commit);
    commitDate = formatCommitDate(fileInfo.commitDate);
    if (commit) {
      if (!process.env.GIT_COMMIT) process.env.GIT_COMMIT = commit;
      if (commitDate && !process.env.GIT_COMMIT_DATE) process.env.GIT_COMMIT_DATE = commitDate;
      return { commit, commitDate: commitDate ?? null };
    }
  }

  // 3. 로컬 git CLI 확인
  const cliInfo = resolveFromGitCli();
  if (cliInfo.commit) {
    commit = formatCommitHash(cliInfo.commit);
    commitDate = formatCommitDate(cliInfo.commitDate);
    if (commit) {
      if (!process.env.GIT_COMMIT) process.env.GIT_COMMIT = commit;
      if (commitDate && !process.env.GIT_COMMIT_DATE) process.env.GIT_COMMIT_DATE = commitDate;
      return { commit, commitDate: commitDate ?? null };
    }
  }

  return { commit: null, commitDate: null };
}

/**
 * 텔레그램 메시지 등에 노출하기 적합한 커밋 정보 문자열을 포맷팅합니다.
 * - 커밋 번호 + 일시: "2db0c71 (2026-10-15 19:30:19)"
 * - 커밋 번호만: "2db0c71"
 * - 둘 다 없음: null
 */
export function formatCommitInfo(): string | null {
  const { commit, commitDate } = getCommitInfo();
  if (!commit) return null;
  if (commitDate) {
    return `${commit} (${commitDate})`;
  }
  return commit;
}
