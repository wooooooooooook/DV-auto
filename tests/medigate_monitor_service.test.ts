import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  getTodayKstDateString,
  getWatchedKey,
  isSymposiumWatchedToday,
  markSymposiumWatchedToday,
  checkAndWatchMedigateSymposiums,
} from '../src/services/medigate_monitor_service';
import * as storage from '../src/services/storage';
import * as runner from '../src/core/runner';
import * as taskRegistry from '../src/core/taskRegistry';
import { MedigateClient, type MedigateSymposiumItem } from '../src/modules/medigate_api';

describe('Medigate Monitor Service Tests', () => {
  beforeEach(() => {
    storage.setDatabasePath(':memory:');
    vi.restoreAllMocks();
  });

  it('getTodayKstDateString 및 getWatchedKey 날짜 키 생성 테스트', () => {
    const fixedDate = new Date('2026-09-15T09:30:00.000Z');
    const kstStr = getTodayKstDateString(fixedDate);
    expect(kstStr).toBe('2026-09-15');

    const key = getWatchedKey(5011, '2026-09-15');
    expect(key).toBe('medigate_watched:5011:2026-09-15');
  });

  it('markSymposiumWatchedToday 및 isSymposiumWatchedToday 상태 저장/확인 테스트', () => {
    expect(isSymposiumWatchedToday(5011, '2026-09-15')).toBe(false);

    markSymposiumWatchedToday(
      5011,
      {
        subject: '테스트 심포지움',
        watchedAt: '2026-09-15T19:30:00.000Z',
        durationMinutes: 20,
        heartbeatCount: 10,
        success: true,
      },
      '2026-09-15',
    );

    expect(isSymposiumWatchedToday(5011, '2026-09-15')).toBe(true);
    // 다른 날짜에 대해서는 false
    expect(isSymposiumWatchedToday(5011, '2026-09-16')).toBe(false);
  });

  it('checkAndWatchMedigateSymposiums - On-Air가 없는 경우', async () => {
    const mockClient = new MedigateClient();
    vi.spyOn(mockClient, 'login').mockResolvedValue({ success: true, message: '로그인 성공' });
    vi.spyOn(mockClient, 'getSymposiumList').mockResolvedValue([
      { webinarIdx: 5001, subject: '대기 중 심포지움', status: 'APPLY', applyFlag: 'Y' } as MedigateSymposiumItem,
    ]);

    const res = await checkAndWatchMedigateSymposiums({ client: mockClient });
    expect(res.checked).toBe(true);
    expect(res.totalOnAir).toBe(0);
    expect(res.targets).toHaveLength(0);
    expect(res.message).toContain('On-Air 심포지움 없음');
    expect(res.silent).toBe(true);
  });

  it('checkAndWatchMedigateSymposiums - On-Air 심포지움 발견 시 태스크 트리거 테스트', async () => {
    const mockClient = new MedigateClient();
    vi.spyOn(mockClient, 'login').mockResolvedValue({ success: true, message: '로그인 성공' });
    vi.spyOn(mockClient, 'getSymposiumList').mockResolvedValue([
      { webinarIdx: 5011, subject: '진행 중 심포지움 1', status: 'ING', applyFlag: 'Y' } as MedigateSymposiumItem,
    ]);

    const runTaskSpy = vi.spyOn(runner, 'runTask').mockResolvedValue(true as unknown as void);

    const res = await checkAndWatchMedigateSymposiums({
      client: mockClient,
      now: new Date('2026-09-15T10:00:00Z'),
    });

    expect(res.checked).toBe(true);
    expect(res.totalOnAir).toBe(1);
    expect(res.targets).toHaveLength(1);
    expect(res.targets[0].webinarIdx).toBe(5011);

    const watchTask = taskRegistry.getByName('medigate_watch_symposium');
    if (watchTask) {
      expect(runTaskSpy).toHaveBeenCalledWith(watchTask, expect.anything());
    }
  });

  it('checkAndWatchMedigateSymposiums - 이미 오늘 시청 완료된 On-Air 심포지움은 스킵', async () => {
    const mockClient = new MedigateClient();
    vi.spyOn(mockClient, 'login').mockResolvedValue({ success: true, message: '로그인 성공' });
    vi.spyOn(mockClient, 'getSymposiumList').mockResolvedValue([
      { webinarIdx: 5011, subject: '진행 중 심포지움 1', status: 'ING', applyFlag: 'Y' } as MedigateSymposiumItem,
    ]);

    const runTaskSpy = vi.spyOn(runner, 'runTask');

    // 오늘 날짜로 이미 시청 완료 기록
    markSymposiumWatchedToday(
      5011,
      {
        subject: '진행 중 심포지움 1',
        watchedAt: '2026-09-15T10:00:00Z',
        durationMinutes: 20,
        heartbeatCount: 10,
        success: true,
      },
      '2026-09-15',
    );

    const res = await checkAndWatchMedigateSymposiums({
      client: mockClient,
      now: new Date('2026-09-15T10:30:00Z'),
    });

    expect(res.checked).toBe(true);
    expect(res.totalOnAir).toBe(1);
    expect(res.skippedCount).toBe(1);
    expect(res.targets).toHaveLength(0);
    expect(runTaskSpy).not.toHaveBeenCalled();
  });
});
