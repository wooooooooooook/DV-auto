import { describe, it, expect, beforeEach } from 'vitest';
import * as storage from '../src/services/storage';
import { runTask } from '../src/core/runner';
import { isTaskRunning } from '../src/services/seminar_monitor_trigger';
import type { Task } from '../src/types';

describe('Stale Lock Recovery & PID Liveness 검증', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('isPidAlive는 현재 프로세스 PID에 대해 true, 존재하지 않는 PID에 대해 false를 반환해야 한다', () => {
    expect(storage.isPidAlive(process.pid)).toBe(true);
    expect(storage.isPidAlive(999999999)).toBe(false);
    expect(storage.isPidAlive(undefined)).toBe(false);
    expect(storage.isPidAlive(-1)).toBe(false);
  });

  it('clearStaleLocks는 죽은 프로세스의 Lock만 삭제하고 현재 프로세스의 Lock은 유지해야 한다', () => {
    const deadPid = 999999999;
    const livePid = process.pid;

    storage.set('lock:dead_task', { owner: deadPid, ts: Date.now() });
    storage.set('lock:live_task', { owner: livePid, ts: Date.now() });

    const clearedCount = storage.clearStaleLocks(livePid);
    expect(clearedCount).toBe(1);

    expect(storage.get('lock:dead_task')).toBeNull();
    expect(storage.get<{ owner: number }>('lock:live_task')?.owner).toBe(livePid);
  });

  it('isTaskRunning은 Lock이 걸려있어도 소유 PID가 죽어있으면 false를 반환해야 한다', () => {
    const deadPid = 999999999;
    storage.set('lock:monitor_lunch_seminars', { owner: deadPid, ts: Date.now() });

    expect(isTaskRunning('monitor_lunch_seminars')).toBe(false);

    // 현재 살아있는 PID인 경우 true 반환
    storage.set('lock:monitor_lunch_seminars', { owner: process.pid, ts: Date.now() });
    expect(isTaskRunning('monitor_lunch_seminars')).toBe(true);
  });

  it('runTask는 이전 죽은 PID의 6시간짜리 Lock이 남아있어도 Stale Lock을 무시하고 실행해야 한다', async () => {
    const deadPid = 999999999;
    storage.set('lock:monitor_lunch_seminars', {
      owner: deadPid,
      ts: Date.now() - 1000 * 60, // 1분 전 생성된 6시간 Lock
    });

    let executed = false;
    const testTask: Task = {
      name: 'monitor_lunch_seminars',
      lockTtlMs: 6 * 60 * 60 * 1000,
      run: async () => {
        executed = true;
        return { success: true, message: '완료' };
      },
    };

    const result = await runTask(testTask, {});
    expect(executed).toBe(true);
    expect(result).toEqual({ success: true, message: '완료' });

    // 실행 후 새로운 Lock owner는 현재 process.pid여야 함 (runTask 종료 시 releaseLock으로 삭제되었거나 확인)
    const currentLock = storage.get<{ owner?: number }>('lock:monitor_lunch_seminars');
    expect(currentLock).toBeNull(); // 정상 종료 시 releaseLock 됨
  });
});
