const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, 'data', 'state.json');

function _ensureDir() {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function _read() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8') || '{}');
  } catch (_e) {
    return {};
  }
}

function _write(obj) {
  try {
    _ensureDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2));
  } catch (_e) {
    console.warn('storage write failed', _e && _e.message ? _e.message : _e);
  }
}

function get(key, fallback = null) {
  const s = _read();
  return s[key] !== undefined ? s[key] : fallback;
}

function set(key, value) {
  const s = _read();
  s[key] = value;
  _write(s);
}

function deleteKey(key) {
  const s = _read();
  delete s[key];
  _write(s);
}

module.exports = { get, set, deleteKey };
