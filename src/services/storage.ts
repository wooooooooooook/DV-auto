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

    CREATE TABLE IF NOT EXISTS seminars (
      seminar_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      date TEXT,
      time TEXT,
      current_count TEXT,
      total_count TEXT,
      night_time INTEGER DEFAULT 0,
      is_point_excluded INTEGER,
      is_advanced_survey INTEGER DEFAULT 0,
      process_state INTEGER,
      cancel_process_state INTEGER,
      seminar_completed INTEGER,
      point_paid INTEGER DEFAULT 0,
      point INTEGER,
      point_text TEXT,
      point_date TEXT,
      point_content TEXT,
      point_checked_at TEXT,
      detected_date TEXT,
      detected_at TEXT,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_seminars_date ON seminars(date);
    CREATE INDEX IF NOT EXISTS idx_seminars_advanced ON seminars(is_advanced_survey, date);
    CREATE INDEX IF NOT EXISTS idx_seminars_point_paid ON seminars(point_paid);

    CREATE TABLE IF NOT EXISTS channel_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      chunk_index INTEGER DEFAULT 0,
      total_chunks INTEGER DEFAULT 1,
      text TEXT,
      media_type TEXT DEFAULT 'text',
      status TEXT DEFAULT 'sent',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_channel_messages_date ON channel_messages(date);
    CREATE INDEX IF NOT EXISTS idx_channel_messages_msg ON channel_messages(channel_id, message_id);

    CREATE TABLE IF NOT EXISTS channel_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      message_id INTEGER NOT NULL,
      parent_message_id INTEGER,
      attached_to_message_id INTEGER,
      date TEXT NOT NULL,
      user_id TEXT,
      user_name TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_discussion_threads (
      thread_id INTEGER PRIMARY KEY,
      channel_id TEXT NOT NULL,
      channel_message_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS _migration_meta (
      name TEXT PRIMARY KEY,
      migrated_at INTEGER NOT NULL
    );
  `);

  // channel_comments 테이블 컬럼 안전 마이그레이션 (기존 DB 호환)
  try {
    const commentColumns = db.prepare(`PRAGMA table_info(channel_comments)`).all() as Array<{ name: string }>;
    const colNames = commentColumns.map((c) => c.name);
    if (!colNames.includes('parent_message_id')) {
      db.exec(`ALTER TABLE channel_comments ADD COLUMN parent_message_id INTEGER;`);
    }
    if (!colNames.includes('attached_to_message_id')) {
      db.exec(`ALTER TABLE channel_comments ADD COLUMN attached_to_message_id INTEGER;`);
    }
  } catch (_e) {
    // ignore
  }

  // 인덱스 생성 (마이그레이션 컬럼 추가 후 안전하게 생성)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_channel_comments_date ON channel_comments(date);
    CREATE INDEX IF NOT EXISTS idx_channel_comments_msg ON channel_comments(channel_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_channel_comments_parent ON channel_comments(parent_message_id);
    CREATE INDEX IF NOT EXISTS idx_channel_comments_attached ON channel_comments(attached_to_message_id);
    CREATE INDEX IF NOT EXISTS idx_discussion_threads_channel_msg ON channel_discussion_threads(channel_id, channel_message_id);
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

/**
 * kv_store의 apply_seminar:seminar_list 데이터를 SQLite seminars 테이블로 단일 트랜잭션으로 안전하게 이관합니다.
 */
export function migrateSeminarListTableIfNeeded(db: Database.Database): boolean {
  const metaCheck = db.prepare('SELECT name FROM _migration_meta WHERE name = ?').get('seminar_table_migration') as
    | { name: string }
    | undefined;

  if (metaCheck) {
    return false;
  }

  const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('apply_seminar:seminar_list') as
    | { value: string }
    | undefined;

  if (!row || !row.value) {
    db.prepare('INSERT OR IGNORE INTO _migration_meta (name, migrated_at) VALUES (?, ?)').run(
      'seminar_table_migration',
      Date.now(),
    );
    return false;
  }

  let items: Array<Record<string, unknown>>;
  try {
    items = JSON.parse(row.value) as Array<Record<string, unknown>>;
  } catch (err) {
    throw new Error(
      `Seminar table migration failed: unable to parse seminar_list JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!Array.isArray(items)) {
    throw new Error('Seminar table migration failed: seminar_list must be an array.');
  }

  const now = Date.now();
  const migrateTx = db.transaction(() => {
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO seminars (
        seminar_id, name, url, date, time, current_count, total_count,
        night_time, is_point_excluded, is_advanced_survey, process_state,
        cancel_process_state, seminar_completed, point_paid, point,
        point_text, point_date, point_content, point_checked_at,
        detected_date, detected_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?
      )
    `);

    for (const item of items) {
      const seminarId =
        (typeof item.seminarId === 'string' && item.seminarId) ||
        (typeof item.url === 'string' && item.url.match(/(?:seminarId=|\/)(\d+)$/)?.[1]) ||
        (typeof item.url === 'string' && item.url) ||
        null;

      if (!seminarId) continue;

      insertStmt.run(
        seminarId,
        typeof item.name === 'string' ? item.name : '',
        typeof item.url === 'string' ? item.url : `https://m.doctorville.co.kr/cme/seminar/${seminarId}`,
        typeof item.date === 'string' ? item.date : null,
        typeof item.time === 'string' ? item.time : '',
        typeof item.currentCount === 'string' ? item.currentCount : '',
        typeof item.totalCount === 'string' ? item.totalCount : '',
        item.nightTime ? 1 : 0,
        typeof item.isPointExcluded === 'boolean' ? (item.isPointExcluded ? 1 : 0) : null,
        item.isAdvancedSurvey ? 1 : 0,
        typeof item.processState === 'number' ? item.processState : null,
        typeof item.cancelProcessState === 'number' ? item.cancelProcessState : null,
        typeof item.seminarCompleted === 'number' ? item.seminarCompleted : null,
        item.pointPaid ? 1 : 0,
        typeof item.point === 'number' ? item.point : null,
        typeof item.pointText === 'string' ? item.pointText : null,
        typeof item.pointDate === 'string' ? item.pointDate : null,
        typeof item.pointContent === 'string' ? item.pointContent : null,
        typeof item.pointCheckedAt === 'string' ? item.pointCheckedAt : null,
        typeof item.detectedDate === 'string' ? item.detectedDate : null,
        typeof item.detectedAt === 'string' ? item.detectedAt : null,
        now,
      );
    }

    db.prepare('DELETE FROM kv_store WHERE key = ?').run('apply_seminar:seminar_list');
    db.prepare('INSERT OR REPLACE INTO _migration_meta (name, migrated_at) VALUES (?, ?)').run(
      'seminar_table_migration',
      now,
    );
  });

  migrateTx();
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
    // kv_store에 남은 seminar_list가 있으면 seminars 테이블로 자동 마이그레이션
    migrateSeminarListTableIfNeeded(dbInstance);
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
  migrateSeminarListTableIfNeeded(dbInstance);
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
 * - 'apply_seminar:seminar_list' 키인 경우 seminars 테이블의 모든 레코드를 조회하여 호환성을 유지합니다.
 * - 키가 존재하지 않는 경우 fallback을 반환합니다.
 * - DB 오류나 데이터 손상 시 예외를 발생시킵니다.
 */
function get<T = unknown>(key: string, fallback: T | null = null): T | null {
  const db = getDb();
  if (key === 'apply_seminar:seminar_list') {
    const rows = db.prepare('SELECT * FROM seminars ORDER BY date DESC, seminar_id DESC').all() as Array<{
      seminar_id: string;
      name: string;
      url: string;
      date: string | null;
      time: string;
      current_count: string;
      total_count: string;
      night_time: number;
      is_point_excluded: number | null;
      is_advanced_survey: number;
      process_state: number | null;
      cancel_process_state: number | null;
      seminar_completed: number | null;
      point_paid: number;
      point: number | null;
      point_text: string | null;
      point_date: string | null;
      point_content: string | null;
      point_checked_at: string | null;
      detected_date: string | null;
      detected_at: string | null;
    }>;
    if (rows.length === 0) {
      return fallback;
    }
    const items = rows.map((row) => ({
      seminarId: row.seminar_id,
      name: row.name,
      url: row.url,
      date: row.date ?? undefined,
      time: row.time,
      currentCount: row.current_count,
      totalCount: row.total_count,
      nightTime: row.night_time === 1,
      isPointExcluded:
        row.is_point_excluded === null || row.is_point_excluded === undefined ? undefined : row.is_point_excluded === 1,
      isAdvancedSurvey: row.is_advanced_survey === 1,
      processState: row.process_state ?? undefined,
      cancelProcessState: row.cancel_process_state ?? undefined,
      seminarCompleted: row.seminar_completed ?? undefined,
      pointPaid: row.point_paid === 1,
      point: row.point ?? undefined,
      pointText: row.point_text ?? undefined,
      pointDate: row.point_date ?? undefined,
      pointContent: row.point_content ?? undefined,
      pointCheckedAt: row.point_checked_at ?? undefined,
      detectedDate: row.detected_date ?? undefined,
      detectedAt: row.detected_at ?? undefined,
    }));
    return items as unknown as T;
  }

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
 * - 'apply_seminar:seminar_list' 키인 경우 seminars 테이블에 반영하여 호환성을 유지합니다.
 * - DB 오류 시 예외를 발생시킵니다.
 */
function set<T = unknown>(key: string, value: T): void {
  const db = getDb();
  if (key === 'apply_seminar:seminar_list' && Array.isArray(value)) {
    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM seminars').run();
      const insertStmt = db.prepare(`
        INSERT OR REPLACE INTO seminars (
          seminar_id, name, url, date, time, current_count, total_count,
          night_time, is_point_excluded, is_advanced_survey, process_state,
          cancel_process_state, seminar_completed, point_paid, point,
          point_text, point_date, point_content, point_checked_at,
          detected_date, detected_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?
        )
      `);

      for (const item of value as Array<Record<string, unknown>>) {
        const sid =
          (typeof item.seminarId === 'string' && item.seminarId) ||
          (typeof item.url === 'string' && item.url.match(/(?:seminarId=|\/)(\d+)$/)?.[1]) ||
          (typeof item.url === 'string' && item.url) ||
          null;

        if (!sid) continue;

        insertStmt.run(
          sid,
          typeof item.name === 'string' ? item.name : '',
          typeof item.url === 'string' ? item.url : `https://m.doctorville.co.kr/cme/seminar/${sid}`,
          typeof item.date === 'string' ? item.date : null,
          typeof item.time === 'string' ? item.time : '',
          typeof item.currentCount === 'string' ? item.currentCount : '',
          typeof item.totalCount === 'string' ? item.totalCount : '',
          item.nightTime ? 1 : 0,
          typeof item.isPointExcluded === 'boolean' ? (item.isPointExcluded ? 1 : 0) : null,
          item.isAdvancedSurvey ? 1 : 0,
          typeof item.processState === 'number' ? item.processState : null,
          typeof item.cancelProcessState === 'number' ? item.cancelProcessState : null,
          typeof item.seminarCompleted === 'number' ? item.seminarCompleted : null,
          item.pointPaid ? 1 : 0,
          typeof item.point === 'number' ? item.point : null,
          typeof item.pointText === 'string' ? item.pointText : null,
          typeof item.pointDate === 'string' ? item.pointDate : null,
          typeof item.pointContent === 'string' ? item.pointContent : null,
          typeof item.pointCheckedAt === 'string' ? item.pointCheckedAt : null,
          typeof item.detectedDate === 'string' ? item.detectedDate : null,
          typeof item.detectedAt === 'string' ? item.detectedAt : null,
          now,
        );
      }
    });
    tx();
    return;
  }

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
 * - 'apply_seminar:seminar_list' 키인 경우 seminars 테이블도 함께 비웁니다.
 * - DB 오류 시 예외를 발생시킵니다.
 */
function deleteKey(key: string): void {
  const db = getDb();
  if (key === 'apply_seminar:seminar_list') {
    db.prepare('DELETE FROM seminars').run();
  }
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
  db.prepare('DELETE FROM seminars').run();
  try {
    db.prepare('DELETE FROM channel_messages').run();
  } catch (_e) {
    // ignore if table does not exist
  }
  try {
    db.prepare('DELETE FROM channel_comments').run();
  } catch (_e) {
    // ignore if table does not exist
  }
  try {
    db.prepare('DELETE FROM channel_discussion_threads').run();
  } catch (_e) {
    // ignore if table does not exist
  }
}

export { get, set, deleteKey, getAll, clear };
