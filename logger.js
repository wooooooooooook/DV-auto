function _ts() { return new Date().toISOString(); }
function info(...args) { console.log('[info]', _ts(), ...args); }
function warn(...args) { console.warn('[warn]', _ts(), ...args); }
function error(...args) { console.error('[error]', _ts(), ...args); }
function debug(...args) { if (process.env.DEBUG && process.env.DEBUG !== '0') console.debug('[debug]', _ts(), ...args); }

module.exports = { info, warn, error, debug };
