import { inspect } from 'util';

function timestamp(): string {
  return new Date().toISOString();
}

/**
 * 최근 로그를 메모리에 보관하는 링버퍼 크기.
 * 도커 환경에서는 journalctl 을 사용할 수 없어 /log 명령이 이 버퍼를 읽습니다.
 */
const LOG_BUFFER_SIZE = 500;
const logBuffer: string[] = [];

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  try {
    return inspect(arg, { depth: 4, breakLength: Infinity });
  } catch {
    return String(arg);
  }
}

function pushToBuffer(level: string, args: unknown[]): void {
  const line = `[${level}] ${timestamp()} ${args.map(formatArg).join(' ')}`;
  // 개별 로그 항목이 지나치면 버퍼를 채우지 않도록 잘라냅니다
  const clipped = line.length > 4000 ? `${line.slice(0, 4000)}... (truncated)` : line;
  logBuffer.push(clipped);
  if (logBuffer.length > LOG_BUFFER_SIZE) {
    logBuffer.splice(0, logBuffer.length - LOG_BUFFER_SIZE);
  }
}

/**
 * 인메모리 링버퍼에 기록된 최근 로그를 최대 count개 반환합니다.
 * (항목 단위이며, 각 항목은 개별 로그 호출 하나입니다)
 */
export function getRecentLogs(count: number): string[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  return logBuffer.slice(-count);
}

/** 테스트용: 인메모리 로그 버퍼를 비웁니다. */
export function clearLogBuffer(): void {
  logBuffer.length = 0;
}

function info(...args: unknown[]): void {
  pushToBuffer('info', args);
  console.log('[info]', timestamp(), ...args);
}

function warn(...args: unknown[]): void {
  pushToBuffer('warn', args);
  console.warn('[warn]', timestamp(), ...args);
}

function error(...args: unknown[]): void {
  pushToBuffer('error', args);
  console.error('[error]', timestamp(), ...args);
}

function debug(...args: unknown[]): void {
  if (process.env.DEBUG && process.env.DEBUG !== '0') {
    pushToBuffer('debug', args);
    console.debug('[debug]', timestamp(), ...args);
  }
}

export { info, warn, error, debug };
