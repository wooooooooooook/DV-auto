import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const DEFAULT_STATE_FILE = path.join(process.cwd(), 'data', 'state.json');
const DEFAULT_PROD_DB_PATH = path.join(process.cwd(), 'data', 'app.db');
const DEFAULT_TEST_DB_PATH = path.join(process.cwd(), 'data', 'test.db');

function resolveDefaultDbPath(): string {
  if (process.env.SQLITE_DB_PATH) {
    return process.env.SQLITE_DB_PATH;
  }
  if (process.env.NODE_ENV === 'test') {
    return DEFAULT_TEST_DB_PATH;
  }
  return DEFAULT_PROD_DB_PATH;
}

let currentDbPath = resolveDefaultDbPath();
let dbInstance: Database.Database | null = null;

function initDatabase(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _migration_meta (
      name TEXT PRIMARY KEY,
      migrated_at INTEGER NOT NULL
    );
  `);
}

/**
 * state.json 파일에서 SQLite DB로 데이터를 안전하게 이관합니다.
 * - Transaction 성공 후에만 .bak 백업 파일 생성
 * - Migration 중 오류 발생 시 원본 state.json 절대 변경/삭제하지 않음
 * - 이미 DB에 데이터가 있거나 이관 완료 기록이 있으면 재이관 건너뜀
 */
export function migrateFromJsonIfNeeded(db: Database.Database, jsonFilePath: string = DEFAULT_STATE_FILE): boolean {
  if (!fs.existsSync(jsonFilePath)) {
    return false;
  }

  // 1. 이미 마이그레이션이 완료되었는지 확인
  const metaCheck = db.prepare('SELECT name FROM _migration_meta WHERE name = ?').get('state_json_migration') as
    | { name: string }
    | undefined;

  if (metaCheck) {
    return false;
  }

  // 2. DB에 이미 데이터가 존재하는지 확인 (기존 DB 존재 시 무조건 재이관 방지)
  const countRow = db.prepare('SELECT count(*) as count FROM kv_store').get() as { count: number } | undefined;
  if (countRow && countRow.count > 0) {
    db.prepare('INSERT OR IGNORE INTO _migration_meta (name, migrated_at) VALUES (?, ?)').run(
      'state_json_migration',
      Date.now(),
    );
    return false;
  }

  // 3. JSON 파일 파싱 검증 (파싱 실패 시 원본 보존 및 예외 발생)
  let rawContent: string;
  let parsed: Record<string, unknown>;
  try {
    rawContent = fs.readFileSync(jsonFilePath, 'utf8');
    parsed = JSON.parse(rawContent || '{}') as Record<string, unknown>;
  } catch (readErr) {
    throw new Error(
      `Migration failed: unable to read/parse ${jsonFilePath}: ${readErr instanceof Error ? readErr.message : String(readErr)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Migration failed: JSON in ${jsonFilePath} must be an object.`);
  }

  const entries = Object.entries(parsed);
  const now = Date.now();

  // 4. 트랜잭션 정의: 전체 데이터 삽입 및 메타데이터 기록
  const migrateTx = db.transaction(() => {
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO kv_store (key, value, updated_at)
      VALUES (?, ?, ?)
    `);

    for (const [key, val] of entries) {
      insertStmt.run(key, JSON.stringify(val), now);
    }

    db.prepare(
      `
      INSERT OR REPLACE INTO _migration_meta (name, migrated_at)
      VALUES (?, ?)
    `,
    ).run('state_json_migration', now);
  });

  // 5. 트랜잭션 실행 (오류 시 rollback되고 아래 백업 로직으로 가지 않음)
  migrateTx();

  // 6. 트랜잭션 성공 후에만 .bak 파일 생성 및 원본 파일 이동/백업
  const backupPath = `${jsonFilePath}.bak`;
  try {
    fs.copyFileSync(jsonFilePath, backupPath);
    fs.unlinkSync(jsonFilePath);
  } catch (backupErr) {
    console.warn(
      `Migration succeeded, but failed to create backup file ${backupPath}: ${backupErr instanceof Error ? backupErr.message : String(backupErr)}`,
    );
  }

  return true;
}

function getDb(): Database.Database {
  if (!dbInstance) {
    if (currentDbPath !== ':memory:') {
      const dir = path.dirname(currentDbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    dbInstance = new Database(currentDbPath);
    initDatabase(dbInstance);
    // state.json이 존재하면 자동 마이그레이션 수행
    migrateFromJsonIfNeeded(dbInstance);
  }
  return dbInstance;
}

/**
 * DB 파일 경로를 변경합니다 (테스트 시 :memory: 또는 별도 파일 지정용)
 */
export function setDatabasePath(dbPath: string, autoMigrate: boolean = false): void {
  closeDatabase();
  currentDbPath = dbPath;
  if (dbPath !== ':memory:') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  dbInstance = new Database(currentDbPath);
  initDatabase(dbInstance);
  if (autoMigrate) {
    migrateFromJsonIfNeeded(dbInstance);
  }
}

/**
 * 현재 열려있는 DB 연결을 닫습니다.
 */
export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (_e) {
      // ignore
    }
    dbInstance = null;
  }
}

/**
 * 내부 Database 인스턴스를 반환합니다.
 */
export function getDatabase(): Database.Database {
  return getDb();
}

/**
 * 저장소에서 키에 해당하는 값을 가져옵니다.
 * - 키가 존재하지 않는 경우 fallback을 반환합니다.
 * - DB 오류나 데이터 손상 시 예외를 발생시킵니다.
 */
function get<T = unknown>(key: string, fallback: T | null = null): T | null {
  const db = getDb();
  const stmt = db.prepare('SELECT value FROM kv_store WHERE key = ?');
  const row = stmt.get(key) as { value: string } | undefined;
  if (!row) {
    return fallback;
  }
  try {
    return JSON.parse(row.value) as T;
  } catch (parseErr) {
    throw new Error(
      `Corrupted JSON value in storage for key "${key}": ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
    );
  }
}

/**
 * 저장소에 키/값을 저장합니다.
 * - DB 오류 시 예외를 발생시킵니다.
 */
function set<T = unknown>(key: string, value: T): void {
  const db = getDb();
  const serialized = JSON.stringify(value);
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO kv_store (key, value, updated_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(key, serialized, now);
}

/**
 * 저장소에서 키를 삭제합니다.
 * - DB 오류 시 예외를 발생시킵니다.
 */
function deleteKey(key: string): void {
  const db = getDb();
  const stmt = db.prepare('DELETE FROM kv_store WHERE key = ?');
  stmt.run(key);
}

/**
 * 저장소의 모든 키/값을 조회합니다.
 */
function getAll(): Record<string, unknown> {
  const db = getDb();
  const stmt = db.prepare('SELECT key, value FROM kv_store');
  const rows = stmt.all() as Array<{ key: string; value: string }>;
  const result: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      result[row.key] = JSON.parse(row.value);
    } catch {
      result[row.key] = row.value;
    }
  }
  return result;
}

/**
 * 저장소의 모든 데이터를 삭제합니다 (테스트용)
 */
function clear(): void {
  const db = getDb();
  db.prepare('DELETE FROM kv_store').run();
}

export { get, set, deleteKey, getAll, clear };
