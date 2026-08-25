import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as storage from '../src/services/storage';
import Database from 'better-sqlite3';

async function runStorageSqliteTests() {
  console.log('===========================================================');
  console.log('  SQLite Storage & Migration 종합 테스트 시작');
  console.log('===========================================================\n');

  const testDir = path.join(__dirname, '..', 'data', 'temp_test');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }

  try {
    // 1. 기본 동기식 Key-Value 동작 테스트 (격리된 메모리 DB)
    console.log('▶ [1/6] 기본 동기식 get/set/deleteKey 동작 검증');
    storage.setDatabasePath(':memory:');
    storage.clear();

    assert.strictEqual(storage.get('non_existent', 'default_val'), 'default_val', '키 미존재 시 fallback 반환');
    assert.strictEqual(storage.get('non_existent'), null, 'fallback 생략 시 null 반환');

    // 다양한 타입 저장 및 조회
    storage.set('str_key', 'hello_world');
    storage.set('num_key', 12345);
    storage.set('bool_key', true);
    storage.set('obj_key', { a: 1, b: ['x', 'y'], c: { nested: true } });
    storage.set('arr_key', [1, 2, 3, { item: 4 }]);

    assert.strictEqual(storage.get('str_key'), 'hello_world');
    assert.strictEqual(storage.get('num_key'), 12345);
    assert.strictEqual(storage.get('bool_key'), true);
    assert.deepStrictEqual(storage.get('obj_key'), { a: 1, b: ['x', 'y'], c: { nested: true } });
    assert.deepStrictEqual(storage.get('arr_key'), [1, 2, 3, { item: 4 }]);

    // getAll 확인
    const all = storage.getAll();
    assert.strictEqual(Object.keys(all).length, 5);

    // deleteKey 확인
    storage.deleteKey('str_key');
    assert.strictEqual(storage.get('str_key'), null);
    assert.strictEqual(Object.keys(storage.getAll()).length, 4);

    console.log('  ✓ get/set/deleteKey 동기식 기본 동작 정상 검증 완료');

    // 2. JSON -> SQLite Migration 정확성 및 원본 JSON과의 완벽한 일치 검증
    console.log('\n▶ [2/6] JSON -> SQLite Migration 데이터 무결성 및 .bak 생성 검증');
    const mockJsonPath = path.join(testDir, 'mock_state.json');
    const mockBakPath = path.join(testDir, 'mock_state.json.bak');
    const mockDbPath = path.join(testDir, 'test_migration.db');

    if (fs.existsSync(mockJsonPath)) fs.unlinkSync(mockJsonPath);
    if (fs.existsSync(mockBakPath)) fs.unlinkSync(mockBakPath);
    if (fs.existsSync(mockDbPath)) fs.unlinkSync(mockDbPath);

    const initialJsonData: Record<string, unknown> = {
      'lock:apply_seminar': { owner: 9999, ts: 1787655000000 },
      'lastRun:attendance': { ts: 1787655100000, ok: true },
      today_seminars: {
        date: '2026-08-25',
        lunchSeminarIds: [101, 102],
        dinnerSeminarIds: [201],
      },
      seminar_change_subscribers: [111222, 333444, 555666],
      today_links_cache: {
        date: '2026-08-25',
        message: '<b>test message</b>',
        options: { parse_mode: 'HTML' },
      },
      empty_array: [],
      empty_obj: {},
      null_value: null,
      boolean_flag: false,
      nested_structure: {
        level1: {
          level2: {
            deepKey: 'deepValue',
            arr: [1, 2, { three: 3 }],
          },
        },
      },
    };

    fs.writeFileSync(mockJsonPath, JSON.stringify(initialJsonData, null, 2), 'utf8');

    // 마이그레이션 실행
    const dbForMigration = new Database(mockDbPath);
    dbForMigration.pragma('journal_mode = WAL');
    dbForMigration.exec(`
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

    const migrated = storage.migrateFromJsonIfNeeded(dbForMigration, mockJsonPath);
    assert.strictEqual(migrated, true, '마이그레이션이 성공적으로 수행되어야 함');

    // 원본 파일은 .bak로 이동되었고 원본 json 파일은 없어야 함
    assert.strictEqual(fs.existsSync(mockJsonPath), false, '원본 json 파일은 이동되어 존재하지 않아야 함');
    assert.strictEqual(fs.existsSync(mockBakPath), true, '성공 시 .bak 백업 파일이 생성되어야 함');

    // DB에서 모든 키를 가져와 원본 데이터와 1:1 완벽 일치 비교
    const rows = dbForMigration.prepare('SELECT key, value FROM kv_store').all() as Array<{
      key: string;
      value: string;
    }>;
    const originalKeys = Object.keys(initialJsonData);
    assert.strictEqual(
      rows.length,
      originalKeys.length,
      '마이그레이션된 DB row 개수와 원본 JSON key 개수가 일치해야 함',
    );

    for (const [k, v] of Object.entries(initialJsonData)) {
      const row = dbForMigration.prepare('SELECT value FROM kv_store WHERE key = ?').get(k) as
        | { value: string }
        | undefined;
      assert.ok(row, `키 ${k}가 DB에 존재해야 함`);
      const restored = JSON.parse(row.value);
      assert.deepStrictEqual(restored, v, `키 ${k}의 데이터가 원본 JSON과 정확히 일치해야 함`);
    }
    dbForMigration.close();

    console.log('  ✓ 모든 key/value 복원 및 key 개수/값 비교 검증 성공');
    console.log('  ✓ 트랜잭션 성공 후 .bak 파일 정상 생성 확인');

    // 3. Migration 실패 시 원본 state.json 보존 및 에러 발생 검증
    console.log('\n▶ [3/6] Migration 오류 시 원본 파일 보존 및 에러 전파 검증');
    const brokenJsonPath = path.join(testDir, 'broken_state.json');
    const brokenBakPath = path.join(testDir, 'broken_state.json.bak');
    const errorDbPath = path.join(testDir, 'test_error.db');

    if (fs.existsSync(brokenJsonPath)) fs.unlinkSync(brokenJsonPath);
    if (fs.existsSync(brokenBakPath)) fs.unlinkSync(brokenBakPath);
    if (fs.existsSync(errorDbPath)) fs.unlinkSync(errorDbPath);

    fs.writeFileSync(brokenJsonPath, 'INVALID_JSON_DATA___{{{', 'utf8');

    const dbForError = new Database(errorDbPath);
    dbForError.exec(`
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

    let caughtError: unknown = null;
    try {
      storage.migrateFromJsonIfNeeded(dbForError, brokenJsonPath);
    } catch (e) {
      caughtError = e;
    }

    assert.ok(caughtError !== null, 'JSON 파싱 오류 시 예외를 던져야 함');
    assert.strictEqual(
      fs.existsSync(brokenJsonPath),
      true,
      '오류 발생 시 원본 state.json 파일이 절대 삭제/변경되지 않아야 함',
    );
    assert.strictEqual(fs.existsSync(brokenBakPath), false, '오류 발생 시 .bak 파일이 생성되지 않아야 함');
    dbForError.close();

    console.log('  ✓ 오류 발생 시 원본 파일 완벽 보존 및 에러 throw 확인');

    // 4. 이미 DB가 존재하거나 마이그레이션이 완료된 경우 재이관 방지 검증
    console.log('\n▶ [4/6] 이미 DB에 데이터/메타가 존재할 때 재이관 방지 검증');
    const existingDbPath = path.join(testDir, 'existing.db');
    const dummyJsonPath = path.join(testDir, 'dummy.json');

    if (fs.existsSync(existingDbPath)) fs.unlinkSync(existingDbPath);
    if (fs.existsSync(dummyJsonPath)) fs.unlinkSync(dummyJsonPath);

    fs.writeFileSync(dummyJsonPath, JSON.stringify({ key1: 'val1' }), 'utf8');

    const dbExisting = new Database(existingDbPath);
    dbExisting.exec(`
      CREATE TABLE IF NOT EXISTS kv_store (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS _migration_meta (
        name TEXT PRIMARY KEY,
        migrated_at INTEGER NOT NULL
      );
      INSERT INTO kv_store (key, value, updated_at) VALUES ('existing_key', '"existing_value"', 12345);
    `);

    const shouldSkip = storage.migrateFromJsonIfNeeded(dbExisting, dummyJsonPath);
    assert.strictEqual(shouldSkip, false, '이미 DB에 데이터가 존재하면 마이그레이션을 스킵해야 함');
    assert.strictEqual(fs.existsSync(dummyJsonPath), true, '스킵되었으므로 dummy.json은 그대로 남아있어야 함');
    dbExisting.close();

    console.log('  ✓ 기존 DB 존재 시 재이관 방지 및 스킵 검증 완료');

    // 5. DB 에러 / 손상 데이터 시 침묵(fallback)하지 않고 예외 발생 검증
    console.log('\n▶ [5/6] SQLite 에러 및 손상된 JSON 처리 시 침묵하지 않고 예외 발생 검증');
    storage.setDatabasePath(':memory:');
    const rawDb = storage.getDatabase();
    rawDb
      .prepare('INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)')
      .run('corrupt_key', '{not_json', Date.now());

    let parseThrow: unknown = null;
    try {
      storage.get('corrupt_key');
    } catch (e) {
      parseThrow = e;
    }
    assert.ok(parseThrow !== null, '손상된 데이터 조회 시 침묵하지 않고 예외가 발생해야 함');

    console.log('  ✓ 오류 침묵 없이 명시적 예외 발생 검증 완료');

    // 6. DB 경로 분리 및 WAL 모드 검증
    console.log('\n▶ [6/6] DB 경로 분리 및 WAL 모드 적용 검증');
    const customDbPath = path.join(testDir, 'custom_wal_test.db');
    storage.setDatabasePath(customDbPath);
    const walDb = storage.getDatabase();
    const journalMode = walDb.pragma('journal_mode', { simple: true });
    assert.strictEqual(String(journalMode).toLowerCase(), 'wal', 'journal_mode가 wal이어야 함');

    storage.set('wal_test_key', 'wal_success');
    assert.strictEqual(storage.get('wal_test_key'), 'wal_success');
    storage.closeDatabase();

    console.log('  ✓ WAL 모드 및 DB 경로 분리 정상 검증 완료');
  } finally {
    storage.closeDatabase();
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch (_e) {
      // ignore
    }
  }

  console.log('\n🎉 SQLite Storage의 모든 테스트 검증을 완벽하게 통과했습니다!');
}

runStorageSqliteTests().catch((err) => {
  console.error('❌ SQLite Storage 테스트 실패:', err);
  process.exit(1);
});
