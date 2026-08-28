import * as storage from '../services/storage';
import * as logger from '../services/logger';
import * as utils from '../modules/utils';
import type { Task, TaskContext, TaskResult } from '../types';

// Acquire a simple process-level lock for a task (not distributed)
function acquireLock(name: string, ttlMs = 60 * 1000): boolean {
  const key = `lock:${name}`;
  const now = Date.now();
  const current = storage.get<{ owner?: number; ts?: number }>(key);
  if (current && current.ts && now - current.ts < ttlMs) {
    // owner 프로세스가 존재할 경우 실제 생존 여부 확인 (죽은 PID면 Stale Lock으로 간주하여 재획득 허용)
    const isOwnerAlive = current.owner ? storage.isPidAlive(current.owner) : true;
    if (isOwnerAlive) {
      return false;
    }
  }
  storage.set(key, { owner: process.pid, ts: now });
  return true;
}

function releaseLock(name: string): void {
  const key = `lock:${name}`;
  const cur = storage.get<{ owner?: number }>(key);
  if (!cur || cur.owner === process.pid) storage.deleteKey(key);
}

async function runTask(task: Task, ctx: TaskContext = {}): Promise<TaskResult | boolean | string | void> {
  const name = task && task.name ? task.name : task && typeof task.run === 'function' ? '(unnamed)' : 'unknown';
  logger.info('runTask start', name);
  const locked = acquireLock(name, task.lockTtlMs || 60 * 1000);
  if (!locked) {
    logger.warn('task is locked, skipping', name);
    return false;
  }

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
    releaseLock(name);
  }
}

export { runTask };
