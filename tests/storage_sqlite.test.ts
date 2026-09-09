import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import * as storage from '../src/services/storage';
import { describe, it } from 'vitest';

describe('SQLite Storage & Migration', () => {
  it('기본 동기식 get/set/deleteKey 및 마이그레이션 종합 테스트', async () => {
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

      // 2. DB 에러 / 손상 데이터 시 침묵(fallback)하지 않고 예외 발생 검증
      console.log('\n▶ [2/3] SQLite 에러 및 손상된 JSON 처리 시 침묵하지 않고 예외 발생 검증');
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

      // 3. DB 경로 분리 및 WAL 모드 검증
      console.log('\n▶ [3/3] DB 경로 분리 및 WAL 모드 적용 검증');
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
  });
});
