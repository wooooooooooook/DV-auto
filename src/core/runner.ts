import crypto from 'crypto';
import * as storage from '../services/storage';
import * as logger from '../services/logger';
import * as utils from '../modules/utils';
import type { Task, TaskContext, TaskResult } from '../types';

export const DEFAULT_LOCK_TTL_MS = 130 * 1000; // 2분 10초
export const HEARTBEAT_INTERVAL_MS = 60 * 1000; // 1분

export interface TaskLockData {
  owner: number;
  token: string;
  ts: number;
}

// Acquire a simple process-level lock for a task (not distributed)
// Returns token string if lock acquired successfully, otherwise null
function acquireLock(name: string, ttlMs = DEFAULT_LOCK_TTL_MS): string | null {
  const key = `lock:${name}`;
  const now = Date.now();
  const current = storage.get<TaskLockData>(key);
  if (current && current.ts && now - current.ts < ttlMs) {
    // owner 프로세스가 존재할 경우 실제 생존 여부 확인 (죽은 PID면 Stale Lock으로 간주하여 재획득 허용)
    const isOwnerAlive = current.owner ? storage.isPidAlive(current.owner) : true;
    if (isOwnerAlive) {
      return null;
    }
  }
  const token = crypto.randomUUID();
  storage.set(key, { owner: process.pid, token, ts: now });
  return token;
}

function renewLock(name: string, token: string): boolean {
  if (!token) return false;
  const key = `lock:${name}`;
  const cur = storage.get<TaskLockData>(key);
  if (cur && cur.owner === process.pid && cur.token === token) {
    storage.set(key, { owner: process.pid, token, ts: Date.now() });
    return true;
  }
  return false;
}

function releaseLock(name: string, token?: string): boolean {
  const key = `lock:${name}`;
  const cur = storage.get<TaskLockData>(key);
  if (!cur) return true;
  if (token) {
    if (cur.owner === process.pid && cur.token === token) {
      storage.deleteKey(key);
      return true;
    }
    return false;
  }
  if (cur.owner === process.pid) {
    storage.deleteKey(key);
    return true;
  }
  return false;
}

async function runTask(task: Task, ctx: TaskContext = {}): Promise<TaskResult | boolean | string | void> {
  const name = task && task.name ? task.name : task && typeof task.run === 'function' ? '(unnamed)' : 'unknown';
  logger.info('runTask start', name);
  const lockToken = acquireLock(name, task.lockTtlMs || DEFAULT_LOCK_TTL_MS);
  if (!lockToken) {
    logger.warn('task is locked, skipping', name);
    return false;
  }

  // 장기 실행 태스크(예: 세미나 모니터링 등)를 위한 주기적 Lock 갱신 Heartbeat 타이머 (동일 인스턴스 token 검증)
  const heartbeatTimer = setInterval(() => {
    const renewed = renewLock(name, lockToken);
    if (!renewed) {
      logger.warn(`Heartbeat renewal skipped/failed for task ${name} (stale or overtaken token)`);
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeatTimer.unref();

  try {
    const res = await task.run(ctx, task.options || {});
    storage.set(`lastRun:${name}`, { ts: Date.now(), ok: true });
    logger.info('runTask success', name);

    // Optionally notify admin on successful run. Can be enabled per-call via
    // ctx.notifyAdminOnSuccess = true or globally with env NOTIFY_ADMIN_ON_SUCCESS=1/true
    const shouldNotify =
      (ctx && ctx.notifyAdminOnSuccess) ||
      process.env.NOTIFY_ADMIN_ON_SUCCESS === '1' ||
      process.env.NOTIFY_ADMIN_ON_SUCCESS === 'true';
    try {
      if (shouldNotify) {
        // Determine whether the task outcome is successful
        const ok = res === true || (res && (res as TaskResult).success !== false);
        const silent = res && typeof res === 'object' && (res as TaskResult).silent;
        if (ok && !silent) {
          const resMsg = res && typeof res === 'object' && (res as TaskResult).message;
          const msg = resMsg || `${name} 작업이 완료되었습니다.`;
          const imagePath = res && typeof res === 'object' ? (res as TaskResult).imagePath : null;
          await utils.sendTelegram(msg, imagePath).catch(() => {});
        }
      }
    } catch (e) {
      logger.warn(
        'notify admin on success failed',
        e && (typeof e === 'object' && 'stack' in e ? (e as Error).stack : e),
      );
    }

    return res;
  } catch (e) {
    const errorMessage = e && typeof e === 'object' && 'message' in e ? (e as Error).message : String(e);
    storage.set(`lastRun:${name}`, { ts: Date.now(), ok: false, error: errorMessage });
    logger.error('runTask error', name, e && (typeof e === 'object' && 'stack' in e ? (e as Error).stack : e));
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearInterval(heartbeatTimer);
    releaseLock(name, lockToken);
  }
}

export { runTask, acquireLock, releaseLock, renewLock };
