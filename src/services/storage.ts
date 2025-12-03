import fs from 'fs';
import path from 'path';

const STATE_FILE = path.join(process.cwd(), 'data', 'state.json');

type StorageState = Record<string, unknown>;

function ensureDir(): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readState(): StorageState {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8') || '{}') as StorageState;
  } catch (_e) {
    return {};
  }
}

function writeState(obj: StorageState): void {
  try {
    ensureDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(obj, null, 2));
  } catch (_e) {
    console.warn('storage write failed', _e && (typeof _e === 'object' && 'message' in _e) ? (_e as Error).message : _e);
  }
}

function get<T = unknown>(key: string, fallback: T | null = null): T | null {
  const state = readState();
  return (state[key] as T | undefined) ?? fallback;
}

function set<T = unknown>(key: string, value: T): void {
  const state = readState();
  state[key] = value;
  writeState(state);
}

function deleteKey(key: string): void {
  const state = readState();
  delete state[key];
  writeState(state);
}

export { get, set, deleteKey };
