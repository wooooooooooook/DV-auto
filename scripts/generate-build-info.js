const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

function getArgOrEnv(argIndex, envName) {
  const argVal = process.argv[argIndex];
  if (argVal && argVal.trim() && argVal.trim() !== '""' && argVal.trim() !== "''") {
    return argVal.trim();
  }
  const envVal = process.env[envName];
  if (envVal && envVal.trim()) {
    return envVal.trim();
  }
  return null;
}

/**
 * 순수 Node.js (zlib + fs)로 .git 디렉터리를 직접 파싱하여
 * commit hash와 commit date를 추출합니다 (git CLI 미설치 환경 대응).
 */
function parseGitDirDirectly(gitDir) {
  try {
    const headPath = path.join(gitDir, 'HEAD');
    if (!fs.existsSync(headPath)) return null;

    let headContent = fs.readFileSync(headPath, 'utf8').trim();
    let refRelative = '';
    let sha = '';

    if (headContent.startsWith('ref:')) {
      refRelative = headContent.replace(/^ref:\s*/, '').trim();
      const refPath = path.join(gitDir, refRelative);
      if (fs.existsSync(refPath)) {
        sha = fs.readFileSync(refPath, 'utf8').trim();
      } else {
        const packedRefsPath = path.join(gitDir, 'packed-refs');
        if (fs.existsSync(packedRefsPath)) {
          const packed = fs.readFileSync(packedRefsPath, 'utf8');
          for (const line of packed.split('\n')) {
            if (line.startsWith('#') || line.startsWith('^')) continue;
            const parts = line.trim().split(/\s+/);
            if (parts.length === 2 && parts[1] === refRelative) {
              sha = parts[0];
              break;
            }
          }
        }
      }
    } else {
      sha = headContent;
    }

    if (!sha) return null;

    let commitDate = null;
    const objPath = path.join(gitDir, 'objects', sha.substring(0, 2), sha.substring(2));
    if (fs.existsSync(objPath)) {
      const buf = fs.readFileSync(objPath);
      const decompressed = zlib.inflateSync(buf).toString('utf8');
      const committerMatch = decompressed.match(/committer\s+.*?<.*?>\s+(\d+)\s+([+-]\d{4})/);
      if (committerMatch) {
        const timestamp = parseInt(committerMatch[1], 10);
        const d = new Date(timestamp * 1000);
        const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
        const yyyy = kst.getUTCFullYear();
        const mm = String(kst.getUTCMonth() + 1).padStart(2, '0');
        const dd = String(kst.getUTCDate()).padStart(2, '0');
        const hh = String(kst.getUTCHours()).padStart(2, '0');
        const min = String(kst.getUTCMinutes()).padStart(2, '0');
        const ss = String(kst.getUTCSeconds()).padStart(2, '0');
        commitDate = `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
      }
    }

    return { commit: sha.substring(0, 7), commitDate };
  } catch {
    return null;
  }
}

function resolveCommitAndDate() {
  // 1. 인자 또는 환경변수 확인
  let commit = getArgOrEnv(2, 'GIT_COMMIT');
  let commitDate = getArgOrEnv(3, 'GIT_COMMIT_DATE');

  // 2. git CLI 실행 시도
  if (!commit || !commitDate) {
    try {
      if (!commit) {
        const stdout = execSync('git rev-parse --short HEAD', {
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf8',
          timeout: 3000,
        });
        if (stdout && stdout.trim()) commit = stdout.trim();
      }
      if (!commitDate) {
        const stdout = execSync('git log -1 --format="%cd" --date=format:"%Y-%m-%d %H:%M:%S"', {
          stdio: ['ignore', 'pipe', 'ignore'],
          encoding: 'utf8',
          timeout: 3000,
        });
        if (stdout && stdout.trim()) commitDate = stdout.trim();
      }
    } catch {
      // 무시
    }
  }

  // 3. 순수 Node.js 파일 파싱 시도 (.git)
  if (!commit || !commitDate) {
    const gitDirs = [
      path.resolve(process.cwd(), '.git'),
      path.resolve(process.cwd(), '.git_build'),
      path.resolve(process.cwd(), '.git_build', '.git'),
      path.resolve(__dirname, '../.git'),
    ];
    for (const dir of gitDirs) {
      const parsed = parseGitDirDirectly(dir);
      if (parsed) {
        if (!commit && parsed.commit) commit = parsed.commit;
        if (!commitDate && parsed.commitDate) commitDate = parsed.commitDate;
        if (commit && commitDate) break;
      }
    }
  }

  // 4. 안전장치: 기존 build-info.json 파일이 있으면 이전 유효값 보존
  const prevPaths = [
    path.resolve(process.cwd(), 'build-info.json'),
    path.resolve(process.cwd(), 'dist', 'build-info.json'),
  ];
  for (const prevPath of prevPaths) {
    if (commit && commitDate) break;
    try {
      if (fs.existsSync(prevPath)) {
        const prev = JSON.parse(fs.readFileSync(prevPath, 'utf8'));
        if (!commit && prev.commit) commit = prev.commit;
        if (!commitDate && prev.commitDate) commitDate = prev.commitDate;
      }
    } catch {
      // 무시
    }
  }

  return { commit: commit || null, commitDate: commitDate || null };
}

function main() {
  const { commit, commitDate } = resolveCommitAndDate();
  const buildTime = new Date().toISOString();

  const buildInfo = {
    commit,
    commitDate,
    buildTime,
  };

  const targets = [
    path.resolve(process.cwd(), 'build-info.json'),
    path.resolve(__dirname, '../build-info.json'),
    path.resolve(process.cwd(), 'dist', 'build-info.json'),
  ];

  const content = JSON.stringify(buildInfo, null, 2);
  const written = new Set();
  for (const target of targets) {
    const normalized = path.normalize(target);
    if (!written.has(normalized)) {
      try {
        fs.mkdirSync(path.dirname(normalized), { recursive: true });
        fs.writeFileSync(normalized, content, 'utf8');
        written.add(normalized);
      } catch (err) {
        console.error(`Failed to write build-info to ${normalized}:`, err.message);
      }
    }
  }

  console.log('[build-info] Generated build info:', JSON.stringify(buildInfo));
}

main();
