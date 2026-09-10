import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { TaskLockData } from '../types';

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
      urgent_notified INTEGER DEFAULT 0,
      is_closed INTEGER DEFAULT 0,
      hidden_yn TEXT DEFAULT 'N',
      disease_category_nm TEXT,
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

    CREATE INDEX IF NOT EXISTS idx_channel_comments_date ON channel_comments(date);
    CREATE INDEX IF NOT EXISTS idx_channel_comments_msg ON channel_comments(channel_id, message_id);
    CREATE INDEX IF NOT EXISTS idx_channel_comments_parent ON channel_comments(parent_message_id);
    CREATE INDEX IF NOT EXISTS idx_channel_comments_attached ON channel_comments(attached_to_message_id);

    CREATE TABLE IF NOT EXISTS channel_discussion_threads (
      thread_id INTEGER PRIMARY KEY,
      channel_id TEXT NOT NULL,
      channel_message_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_discussion_threads_channel_msg ON channel_discussion_threads(channel_id, channel_message_id);

    CREATE TABLE IF NOT EXISTS subscriptions (
      chat_id INTEGER PRIMARY KEY,
      today_links INTEGER DEFAULT 0,
      today_links_time TEXT DEFAULT '09:00',
      today_links_sent_date TEXT,
      new_seminar TEXT DEFAULT 'off',
      new_seminar_include_point_excluded INTEGER DEFAULT 0,
      intermd_quiz INTEGER DEFAULT 0,
      seminar_changes INTEGER DEFAULT 0,
      seminar_live INTEGER DEFAULT 0,
      survey_closing_20 INTEGER DEFAULT 0,
      survey_closing_10 INTEGER DEFAULT 0,
      point_conversion INTEGER DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
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
  }
  return dbInstance;
}

/**
 * DB 파일 경로를 변경합니다 (테스트 시 :memory: 또는 별도 파일 지정용)
 */
export function setDatabasePath(dbPath: string): void {
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
function get<T>(key: string, fallback: T): T;
function get<T = unknown>(key: string, fallback?: null): T | null;
function get<T = unknown>(key: string, fallback: T | null = null): T | null {
  const db = getDb();
  if (key === 'intermd_quiz_subscribers') {
    const rows = db.prepare('SELECT chat_id FROM subscriptions WHERE intermd_quiz = 1').all() as Array<{
      chat_id: number;
    }>;
    return rows.map((r) => r.chat_id) as unknown as T;
  }
  if (key === 'seminar_change_subscribers') {
    const rows = db.prepare('SELECT chat_id FROM subscriptions WHERE seminar_changes = 1').all() as Array<{
      chat_id: number;
    }>;
    return rows.map((r) => r.chat_id) as unknown as T;
  }
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
      urgentNotified: (row as unknown as { urgent_notified?: number }).urgent_notified === 1,
      isClosed: (row as unknown as { is_closed?: number }).is_closed === 1,
      hiddenYn: (row as unknown as { hidden_yn?: string }).hidden_yn ?? undefined,
      diseaseCategoryNm: (row as unknown as { disease_category_nm?: string }).disease_category_nm ?? undefined,
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
 * - 'intermd_quiz_subscribers', 'seminar_change_subscribers' 키인 경우 subscriptions 테이블과 동기화합니다.
 * - DB 오류 시 예외를 발생시킵니다.
 */
function set<T = unknown>(key: string, value: T): void {
  const db = getDb();
  if (key === 'intermd_quiz_subscribers' && Array.isArray(value)) {
    const now = Date.now();
    const ids = (value as number[]).map(Number).filter((n) => !Number.isNaN(n));
    const tx = db.transaction(() => {
      db.prepare('UPDATE subscriptions SET intermd_quiz = 0, updated_at = ?').run(now);
      const upsertStmt = db.prepare(`
        INSERT INTO subscriptions (
          chat_id, today_links, today_links_time, today_links_sent_date,
          new_seminar, intermd_quiz, seminar_changes, seminar_live, point_conversion,
          created_at, updated_at
        ) VALUES (?, 0, '09:00', NULL, 'off', 1, 0, 0, 0, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET intermd_quiz = 1, updated_at = ?
      `);
      for (const id of ids) {
        upsertStmt.run(id, now, now, now);
      }
    });
    tx();
    return;
  }

  if (key === 'seminar_change_subscribers' && Array.isArray(value)) {
    const now = Date.now();
    const ids = (value as number[]).map(Number).filter((n) => !Number.isNaN(n));
    const tx = db.transaction(() => {
      db.prepare('UPDATE subscriptions SET seminar_changes = 0, updated_at = ?').run(now);
      const upsertStmt = db.prepare(`
        INSERT INTO subscriptions (
          chat_id, today_links, today_links_time, today_links_sent_date,
          new_seminar, intermd_quiz, seminar_changes, seminar_live, point_conversion,
          created_at, updated_at
        ) VALUES (?, 0, '09:00', NULL, 'off', 0, 1, 0, 0, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET seminar_changes = 1, updated_at = ?
      `);
      for (const id of ids) {
        upsertStmt.run(id, now, now, now);
      }
    });
    tx();
    return;
  }

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
          detected_date, detected_at, is_closed, hidden_yn, disease_category_nm, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?
        )
      `);

      for (const item of value as Array<Record<string, unknown>>) {
        const sid =
          (typeof item.seminarId === 'string' && item.seminarId) ||
          (typeof item.url === 'string' && item.url.match(/(?:seminarId=|\/)(\d+)$/)?.[1]) ||
          (typeof item.url === 'string' && item.url) ||
          null;

        if (!sid) continue;

        const hiddenYn = typeof item.hiddenYn === 'string' ? item.hiddenYn : 'N';

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
          item.isClosed ? 1 : 0,
          hiddenYn,
          typeof item.diseaseCategoryNm === 'string' ? item.diseaseCategoryNm : null,
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
 * - 'intermd_quiz_subscribers', 'seminar_change_subscribers' 키인 경우 subscriptions 테이블의 해당 플래그를 0으로 리셋합니다.
 * - DB 오류 시 예외를 발생시킵니다.
 */
function deleteKey(key: string): void {
  const db = getDb();
  if (key === 'apply_seminar:seminar_list') {
    db.prepare('DELETE FROM seminars').run();
  }
  if (key === 'intermd_quiz_subscribers') {
    db.prepare('UPDATE subscriptions SET intermd_quiz = 0, updated_at = ?').run(Date.now());
  }
  if (key === 'seminar_change_subscribers') {
    db.prepare('UPDATE subscriptions SET seminar_changes = 0, updated_at = ?').run(Date.now());
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
    db.prepare('DELETE FROM subscriptions').run();
  } catch (_e) {
    // ignore if table does not exist
  }
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

/**
 * 주어진 PID의 프로세스가 현재 OS 상에서 살아있는지 확인합니다.
 */
export function isPidAlive(pid?: number): boolean {
  if (!pid || typeof pid !== 'number' || Number.isNaN(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return !!(err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EPERM');
  }
}

/**
 * DB에 남아있는 고아(Stale) Lock 키들을 정리합니다.
 * - 현재 PID와 다르면서 해당 PID가 이미 종료된 경우 정리
 * - 손상된 JSON 데이터인 경우 정리
 */
export function clearStaleLocks(currentPid: number = process.pid): number {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM kv_store WHERE key LIKE 'lock:%'").all() as Array<{
    key: string;
    value: string;
  }>;
  let cleared = 0;
  const deleteStmt = db.prepare('DELETE FROM kv_store WHERE key = ?');
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.value) as TaskLockData;
      if (parsed.owner !== currentPid && !isPidAlive(parsed.owner)) {
        deleteStmt.run(row.key);
        cleared++;
      }
    } catch {
      deleteStmt.run(row.key);
      cleared++;
    }
  }
  return cleared;
}

export { get, set, deleteKey, getAll, clear, getDb };
