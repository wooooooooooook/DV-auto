function timestamp(): string {
  return new Date().toISOString();
}

function info(...args: unknown[]): void {
  console.log('[info]', timestamp(), ...args);
}

function warn(...args: unknown[]): void {
  console.warn('[warn]', timestamp(), ...args);
}

function error(...args: unknown[]): void {
  console.error('[error]', timestamp(), ...args);
}

function debug(...args: unknown[]): void {
  if (process.env.DEBUG && process.env.DEBUG !== '0') console.debug('[debug]', timestamp(), ...args);
}

export { info, warn, error, debug };
