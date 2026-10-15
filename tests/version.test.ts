import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { formatCommitHash, formatCommitDate, getCommitInfo, formatCommitInfo } from '../src/core/version';

describe('Version & Commit Info 모듈 테스트', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GIT_COMMIT;
    delete process.env.GIT_COMMIT_DATE;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('formatCommitHash', () => {
    it('40자리 SHA-1 해시를 7자리 단축 해시로 변환한다', () => {
      const fullSha = '2db0c71a39f607d2c38096c42171c7784f1837b9';
      expect(formatCommitHash(fullSha)).toBe('2db0c71');
    });

    it('이미 단축된 7자리 해시는 그대로 반환한다', () => {
      expect(formatCommitHash('2db0c71')).toBe('2db0c71');
    });

    it('빈 값 또는 무효한 값(unknown, null 등)은 null을 반환한다', () => {
      expect(formatCommitHash(null)).toBeNull();
      expect(formatCommitHash(undefined)).toBeNull();
      expect(formatCommitHash('')).toBeNull();
      expect(formatCommitHash('   ')).toBeNull();
      expect(formatCommitHash('unknown')).toBeNull();
      expect(formatCommitHash('UNKNOWN')).toBeNull();
      expect(formatCommitHash('null')).toBeNull();
    });
  });

  describe('formatCommitDate', () => {
    it('이미 YYYY-MM-DD HH:mm:ss 형식인 경우 그대로 반환한다', () => {
      expect(formatCommitDate('2026-10-15 19:30:00')).toBe('2026-10-15 19:30:00');
    });

    it('ISO 8601 문자열을 KST 기준 YYYY-MM-DD HH:mm:ss 형식으로 변환한다', () => {
      // 2026-10-15T10:30:00Z -> UTC+9 이므로 2026-10-15 19:30:00
      const isoStr = '2026-10-15T10:30:00.000Z';
      expect(formatCommitDate(isoStr)).toBe('2026-10-15 19:30:00');
    });

    it('빈 값 또는 무효한 값은 null을 반환한다', () => {
      expect(formatCommitDate(null)).toBeNull();
      expect(formatCommitDate(undefined)).toBeNull();
      expect(formatCommitDate('')).toBeNull();
      expect(formatCommitDate('   ')).toBeNull();
      expect(formatCommitDate('unknown')).toBeNull();
    });
  });

  describe('getCommitInfo & formatCommitInfo', () => {
    it('환경변수 GIT_COMMIT 및 GIT_COMMIT_DATE 가 설정되어 있으면 최우선으로 사용한다', () => {
      process.env.GIT_COMMIT = 'abc1234567890abcdef1234567890abcdef12345';
      process.env.GIT_COMMIT_DATE = '2026-10-15 18:00:00';

      const info = getCommitInfo();
      expect(info.commit).toBe('abc1234');
      expect(info.commitDate).toBe('2026-10-15 18:00:00');

      const formatted = formatCommitInfo();
      expect(formatted).toBe('abc1234 (2026-10-15 18:00:00)');
    });

    it('커밋 해시만 있고 커밋 일시가 없으면 커밋 해시만 반환한다', () => {
      process.env.GIT_COMMIT = '1234567';
      process.env.GIT_COMMIT_DATE = '';

      const formatted = formatCommitInfo();
      expect(formatted).toBe('1234567');
    });

    it('앱 온라인 알림 메시지 조합 시 커밋 정보가 포함된다', () => {
      process.env.GIT_COMMIT = 'f0e1d2c';
      process.env.GIT_COMMIT_DATE = '2026-10-15 19:00:00';

      const nowStr = '2026. 10. 15. 오후 7:30:00';
      const commitInfo = formatCommitInfo();
      let startupMsg = `🚀 앱이 온라인 상태입니다. (${nowStr})`;
      if (commitInfo) {
        startupMsg += `\n• 커밋: ${commitInfo}`;
      }

      expect(startupMsg).toContain('🚀 앱이 온라인 상태입니다.');
      expect(startupMsg).toContain('• 커밋: f0e1d2c (2026-10-15 19:00:00)');
    });

    it('fetchCommitFromGithub 는 GitHub API를 통해 최신 커밋 정보를 가져온다', async () => {
      const mockCommitSha = '433d42e73da06cb6b668e3a3baa73dd33affb307';
      const mockDateIso = '2026-10-15T11:24:32Z';

      const originalFetch = global.fetch;
      global.fetch = async () =>
        ({
          ok: true,
          json: async () => ({
            sha: mockCommitSha,
            commit: { committer: { date: mockDateIso } },
          }),
        }) as unknown as Response;

      try {
        const { fetchCommitFromGithub } = await import('../src/core/version');
        const info = await fetchCommitFromGithub();
        expect(info?.commit).toBe('433d42e');
        expect(info?.commitDate).toBe('2026-10-15 20:24:32');
      } finally {
        global.fetch = originalFetch;
      }
    });
  });
});
