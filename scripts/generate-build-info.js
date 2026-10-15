const fs = require('fs');
const path = require('path');
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

function parseGitDirDirectly(gitDir) {
  try {
    const headPath = path.join(gitDir, 'HEAD');
    if (!fs.existsSync(headPath)) return null;

    const headContent = fs.readFileSync(headPath, 'utf8').trim();
    if (!headContent.startsWith('ref:')) {
      return headContent.substring(0, 7);
    }

    const refRelative = headContent.replace(/^ref:\s*/, '').trim();
    const refPath = path.join(gitDir, refRelative);

    if (fs.existsSync(refPath)) {
      const commitHash = fs.readFileSync(refPath, 'utf8').trim();
      return commitHash.substring(0, 7);
    }

    const packedRefsPath = path.join(gitDir, 'packed-refs');
    if (fs.existsSync(packedRefsPath)) {
      const packed = fs.readFileSync(packedRefsPath, 'utf8');
      const lines = packed.split('\n');
      for (const line of lines) {
        if (line.startsWith('#') || line.startsWith('^')) continue;
        const parts = line.trim().split(/\s+/);
        if (parts.length === 2 && parts[1] === refRelative) {
          return parts[0].substring(0, 7);
        }
      }
    }
  } catch {
    // 무시
  }
  return null;
}

function resolveCommit() {
  let commit = getArgOrEnv(2, 'GIT_COMMIT');
  if (commit) return commit;

  try {
    const stdout = execSync('git rev-parse --short HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 3000,
    });
    if (stdout && stdout.trim()) return stdout.trim();
  } catch {
    // git CLI 실행 실패 시 직접 파싱 시도
  }

  const gitDirs = [
    path.resolve(process.cwd(), '.git'),
    path.resolve(process.cwd(), '.git_build'),
    path.resolve(process.cwd(), '.git_build', '.git'),
    path.resolve(__dirname, '../.git'),
  ];
  for (const dir of gitDirs) {
    const found = parseGitDirDirectly(dir);
    if (found) return found;
  }

  return null;
}

function resolveCommitDate() {
  let commitDate = getArgOrEnv(3, 'GIT_COMMIT_DATE');
  if (commitDate) return commitDate;

  try {
    const stdout = execSync('git log -1 --format="%cd" --date=format:"%Y-%m-%d %H:%M:%S"', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 3000,
    });
    if (stdout && stdout.trim()) return stdout.trim();
  } catch {
    // 무시
  }

  return null;
}

function main() {
  const commit = resolveCommit();
  const commitDate = resolveCommitDate();
  const buildTime = new Date().toISOString();

  const buildInfo = {
    commit: commit || null,
    commitDate: commitDate || null,
    buildTime,
  };

  const targets = [path.resolve(process.cwd(), 'build-info.json'), path.resolve(__dirname, '../build-info.json')];

  const distDir = path.resolve(process.cwd(), 'dist');
  if (fs.existsSync(distDir)) {
    targets.push(path.join(distDir, 'build-info.json'));
  }

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
