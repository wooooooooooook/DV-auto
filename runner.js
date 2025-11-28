const storage = require('./storage');
const logger = require('./logger');

// Acquire a simple process-level lock for a task (not distributed)
function _acquireLock(name, ttlMs = 60 * 1000) {
    const key = `lock:${name}`;
    const now = Date.now();
    const current = storage.get(key);
    if (current && current.ts && now - current.ts < ttlMs) return false;
    storage.set(key, { owner: process.pid, ts: now });
    return true;
}

function _releaseLock(name) {
    const key = `lock:${name}`;
    const cur = storage.get(key);
    if (!cur || cur.owner === process.pid) storage.deleteKey(key);
}

async function runTask(task, ctx = {}) {
    const name = task && task.name ? task.name : (task && task.run ? '(unnamed)' : 'unknown');
    logger.info('runTask start', name);
    const locked = _acquireLock(name, task.lockTtlMs || 60 * 1000);
    if (!locked) {
        logger.warn('task is locked, skipping', name);
        return false;
    }

    try {
        const res = await task.run(ctx, task.options || {});
        storage.set(`lastRun:${name}`, { ts: Date.now(), ok: true });
        logger.info('runTask success', name);
        return res;
    } catch (e) {
        storage.set(`lastRun:${name}`, { ts: Date.now(), ok: false, error: String(e && e.message ? e.message : e) });
        logger.error('runTask error', name, e && e.stack ? e.stack : e);
        throw e;
    } finally {
        _releaseLock(name);
    }
}

module.exports = { runTask };
