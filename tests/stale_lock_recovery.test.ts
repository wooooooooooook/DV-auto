import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as storage from '../src/services/storage';
import {
  runTask,
  acquireLock,
  renewLock,
  releaseLock,
  DEFAULT_LOCK_TTL_MS,
  HEARTBEAT_INTERVAL_MS,
  type TaskLockData,
} from '../src/core/runner';
import { isTaskRunning } from '../src/services/seminar_monitor_trigger';
import type { Task } from '../src/types';

describe('Stale Lock Recovery & PID Liveness & Heartbeat 검증', () => {
  beforeEach(() => {
    storage.clear();
  });

  it('기본 Lock TTL은 130초(2분 10초), Heartbeat 주기는 60초(1분)여야 한다', () => {
    expect(DEFAULT_LOCK_TTL_MS).toBe(130 * 1000);
    expect(HEARTBEAT_INTERVAL_MS).toBe(60 * 1000);
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

    storage.set('lock:dead_task', { owner: deadPid, token: 'token-dead', ts: Date.now() });
    storage.set('lock:live_task', { owner: livePid, token: 'token-live', ts: Date.now() });

    const clearedCount = storage.clearStaleLocks(livePid);
    expect(clearedCount).toBe(1);

    expect(storage.get('lock:dead_task')).toBeNull();
    expect(storage.get<TaskLockData>('lock:live_task')?.owner).toBe(livePid);
  });

  it('isTaskRunning은 Lock이 걸려있어도 소유 PID가 죽어있으면 false를 반환해야 한다', () => {
    const deadPid = 999999999;
    storage.set('lock:monitor_lunch_seminars', { owner: deadPid, token: 'token-dead', ts: Date.now() });

    expect(isTaskRunning('monitor_lunch_seminars')).toBe(false);

    // 현재 살아있는 PID인 경우 true 반환
    storage.set('lock:monitor_lunch_seminars', { owner: process.pid, token: 'token-live', ts: Date.now() });
    expect(isTaskRunning('monitor_lunch_seminars')).toBe(true);
  });

  it('isTaskRunning은 살아있는 PID라도 Lock TTL(2분 10초)이 만료되면 false를 반환해야 한다', () => {
    const livePid = process.pid;
    const expiredTs = Date.now() - (DEFAULT_LOCK_TTL_MS + 1000); // 2분 11초 전 (만료됨)

    storage.set('lock:monitor_lunch_seminars', { owner: livePid, token: 'token-expired', ts: expiredTs });

    // 기본 TTL(130초) 기준 만료되었으므로 false
    expect(isTaskRunning('monitor_lunch_seminars')).toBe(false);

    // 1분 전 생성된 최근 Lock은 true
    storage.set('lock:monitor_lunch_seminars', {
      owner: livePid,
      token: 'token-valid',
      ts: Date.now() - HEARTBEAT_INTERVAL_MS,
    });
    expect(isTaskRunning('monitor_lunch_seminars')).toBe(true);
  });

  it('renewLock은 소유자(PID)와 token이 모두 일치하는 Lock의 ts를 최신 시간으로 갱신해야 한다', () => {
    const pastTs = Date.now() - 10000;
    const token = 'my-unique-token';
    storage.set('lock:test_task', { owner: process.pid, token, ts: pastTs });

    const renewed = renewLock('test_task', token);
    expect(renewed).toBe(true);

    const updated = storage.get<TaskLockData>('lock:test_task');
    expect(updated?.owner).toBe(process.pid);
    expect(updated?.token).toBe(token);
    expect(updated?.ts).toBeGreaterThanOrEqual(pastTs);
  });

  it('renewLock은 token이 불일치하거나 다른 PID인 경우 false를 반환해야 한다', () => {
    const validToken = 'valid-token';
    storage.set('lock:test_task', { owner: process.pid, token: validToken, ts: Date.now() });

    // 잘못된 token
    expect(renewLock('test_task', 'wrong-token')).toBe(false);
    expect(renewLock('test_task', '')).toBe(false);

    // 존재하지 않는 task
    expect(renewLock('non_existing_task', validToken)).toBe(false);

    // 다른 PID의 Lock
    storage.set('lock:other_pid_task', { owner: 999999999, token: validToken, ts: Date.now() });
    expect(renewLock('other_pid_task', validToken)).toBe(false);
  });

  it('releaseLock은 token이 일치할 때만 락을 해제하고, 다른 token의 락은 해제하지 않아야 한다', () => {
    const tokenA = 'token-a';
    const tokenB = 'token-b';

    storage.set('lock:test_task', { owner: process.pid, token: tokenB, ts: Date.now() });

    // tokenA로 해제 시도 -> 실패하고 락 유지
    expect(releaseLock('test_task', tokenA)).toBe(false);
    expect(storage.get<TaskLockData>('lock:test_task')?.token).toBe(tokenB);

    // tokenB로 해제 시도 -> 성공하고 락 삭제
    expect(releaseLock('test_task', tokenB)).toBe(true);
    expect(storage.get('lock:test_task')).toBeNull();
  });

  it('시나리오 검증: A stale → B acquire → A heartbeat 시 token 검증으로 B의 lock을 보호해야 한다', () => {
    // 1. Task A가 Lock 획득 (tokenA)
    const tokenA = acquireLock('seminar_monitor_task');
    expect(tokenA).toBeTruthy();
    const lockA = storage.get<TaskLockData>('lock:seminar_monitor_task');
    expect(lockA?.token).toBe(tokenA);

    // 2. Task A의 Lock이 타임아웃되어 Stale 상태가 됨 (ts를 TTL 이전으로 인위적 조작)
    const staleTs = Date.now() - (DEFAULT_LOCK_TTL_MS + 5000);
    storage.set('lock:seminar_monitor_task', { owner: process.pid, token: tokenA!, ts: staleTs });

    // 3. Task B가 만료된 락을 감지하고 새로 Lock을 획득 (tokenB)
    const tokenB = acquireLock('seminar_monitor_task');
    expect(tokenB).toBeTruthy();
    expect(tokenB).not.toBe(tokenA);
    expect(storage.get<TaskLockData>('lock:seminar_monitor_task')?.token).toBe(tokenB);

    // 4. 뒤늦게 깨어난 Task A의 하트비트가 renewLock(tokenA)을 시도 -> 실패해야 함!
    const renewResultA = renewLock('seminar_monitor_task', tokenA!);
    expect(renewResultA).toBe(false);

    // B의 Lock 데이터(tokenB)가 그대로 유지되어야 함
    expect(storage.get<TaskLockData>('lock:seminar_monitor_task')?.token).toBe(tokenB);

    // 5. Task A가 작업을 마치고 releaseLock(tokenA)을 시도 -> 실패하고 B의 락을 지우지 않아야 함!
    const releaseResultA = releaseLock('seminar_monitor_task', tokenA!);
    expect(releaseResultA).toBe(false);
    expect(storage.get<TaskLockData>('lock:seminar_monitor_task')?.token).toBe(tokenB);

    // 6. 정상 실행 중인 Task B의 하트비트 renewLock(tokenB)은 성공해야 함
    const renewResultB = renewLock('seminar_monitor_task', tokenB!);
    expect(renewResultB).toBe(true);

    // 7. Task B가 완료 후 releaseLock(tokenB)을 수행 -> 정상 해제
    const releaseResultB = releaseLock('seminar_monitor_task', tokenB!);
    expect(releaseResultB).toBe(true);
    expect(storage.get('lock:seminar_monitor_task')).toBeNull();
  });

  it('runTask는 이전 죽은 PID의 Lock이 남아있어도 Stale Lock을 무시하고 실행해야 한다', async () => {
    const deadPid = 999999999;
    storage.set('lock:monitor_lunch_seminars', {
      owner: deadPid,
      token: 'dead-token',
      ts: Date.now() - 1000 * 60,
    });

    let executed = false;
    const testTask: Task = {
      name: 'monitor_lunch_seminars',
      run: async () => {
        executed = true;
        return { success: true, message: '완료' };
      },
    };

    const result = await runTask(testTask, {});
    expect(executed).toBe(true);
    expect(result).toEqual({ success: true, message: '완료' });

    // 실행 후 정상 종료 시 releaseLock 됨
    const currentLock = storage.get<TaskLockData>('lock:monitor_lunch_seminars');
    expect(currentLock).toBeNull();
  });

  it('runTask 실행 중 Lock 소유권을 상실하면 ctx.isLockLost가 true로 설정되어야 한다', async () => {
    vi.useFakeTimers();
    try {
      let taskContextRef: import('../src/types').TaskContext | null = null;
      let resolveTask: () => void;
      const taskPromise = new Promise<void>((resolve) => {
        resolveTask = resolve;
      });

      const testTask: Task = {
        name: 'long_running_task',
        run: async (ctx) => {
          taskContextRef = ctx;
          expect(ctx.lockToken).toBeTruthy();
          expect(ctx.isLockLost).toBe(false);
          await taskPromise;
          return { success: true };
        },
      };

      const runPromise = runTask(testTask, {});

      // 1. Task가 시작되어 락을 잡은 상태 확인
      expect(taskContextRef).not.toBeNull();
      const originalToken = taskContextRef!.lockToken;
      expect(originalToken).toBeTruthy();

      // 2. 외부에서 락을 다른 토큰으로 교체 (소유권 상실 시뮬레이션)
      storage.set('lock:long_running_task', {
        owner: process.pid,
        token: 'new-usurper-token',
        ts: Date.now(),
      });

      // 3. 1분(HEARTBEAT_INTERVAL_MS) 시간 진행하여 하트비트 트리거
      await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

      // 4. 하트비트 갱신 실패로 ctx.isLockLost가 true로 변경되었는지 확인
      expect(taskContextRef!.isLockLost).toBe(true);

      // 5. 태스크 종료 처리
      resolveTask!();
      await runPromise;

      // 6. 태스크 종료 후에도 새로 획득된 usurper 토큰이 유지되는지 확인
      const finalLock = storage.get<TaskLockData>('lock:long_running_task');
      expect(finalLock?.token).toBe('new-usurper-token');
    } finally {
      vi.useRealTimers();
    }
  });
});
