import assert from 'assert';
import path from 'path';
import fs from 'fs';
import * as storage from '../src/services/storage';
import * as seminarRepo from '../src/services/seminar_repository';
import type { SeminarListItem } from '../src/services/seminar_repository';
import { describe, it } from 'vitest';

describe('Seminar Repository & SQLite Table Migration', () => {
  it('기본 CRUD 및 SQLite 마이그레이션 검증', async () => {
    console.log('=== [Test] Seminar Repository & SQLite Table Migration Tests Started ===\n');

    const testDbDir = path.join(process.cwd(), 'data');
    const testDbPath = path.join(testDbDir, 'test_seminar_repo.db');

    // DB 초기화
    if (fs.existsSync(testDbPath)) {
      try {
        storage.closeDatabase();
        fs.unlinkSync(testDbPath);
      } catch (_e) {
        /* ignore */
      }
    }
    storage.setDatabasePath(testDbPath);

    // ----------------------------------------------------
    // Test 1: 기본 CRUD 및 upsertSeminar / getAllSeminars 검증
    // ----------------------------------------------------
    console.log('--- [Test 1] 기본 CRUD 및 upsertSeminar / getAllSeminars 검증 ---');
    seminarRepo.clearSeminars();
    assert.strictEqual(seminarRepo.getAllSeminars().length, 0, '초기 세미나 목록은 비어있어야 함');

    const sample1: SeminarListItem = {
      seminarId: '5001',
      name: '당뇨병 최신 지견',
      url: 'https://m.doctorville.co.kr/cme/seminar/5001',
      date: '2026-08-30',
      time: '19:00',
      currentCount: '10',
      totalCount: '100',
      nightTime: false,
      isPointExcluded: false,
      isAdvancedSurvey: true,
      processState: 2,
      detectedDate: '2026-08-25',
      detectedAt: '2026-08-25T10:00:00Z',
    };

    const inserted1 = seminarRepo.upsertSeminar(sample1);
    assert.strictEqual(inserted1.seminarId, '5001', 'seminarId 일치');
    assert.strictEqual(inserted1.name, '당뇨병 최신 지견');
    assert.strictEqual(inserted1.isAdvancedSurvey, true);

    const fetched1 = seminarRepo.getSeminarById('5001');
    assert.ok(fetched1, '5001 조회 성공');
    assert.strictEqual(fetched1?.seminarId, '5001');
    assert.strictEqual(fetched1?.name, '당뇨병 최신 지견');
    assert.strictEqual(fetched1?.isPointExcluded, false);
    assert.strictEqual(fetched1?.isAdvancedSurvey, true);
    console.log('  ✓ [Pass] 단건 upsert 및 getSeminarById 정상 동작 확인\n');

    // ----------------------------------------------------
    // Test 2: pointPaid/pointCheckedAt semantics 및 Merge Semantics 검증 (핵심 요구사항)
    // ----------------------------------------------------
    console.log('--- [Test 2] pointPaid / pointCheckedAt Merge Semantics 보존 검증 ---');

    // 2-1. 포인트 적립 정보 업데이트
    const pointUpdated = seminarRepo.upsertSeminar({
      seminarId: '5001',
      name: '당뇨병 최신 지견 (수정명)',
      url: 'https://m.doctorville.co.kr/cme/seminar/5001',
      time: '19:00',
      currentCount: '15',
      totalCount: '100',
      nightTime: false,
      isAdvancedSurvey: true,
      pointPaid: true,
      point: 2000,
      pointText: '2,000P',
      pointDate: '2026-08-25',
      pointContent: '세미나 설문 완료 포인트',
      pointCheckedAt: '2026-08-25T12:00:00Z',
    });

    assert.strictEqual(pointUpdated.pointPaid, true);
    assert.strictEqual(pointUpdated.point, 2000);
    assert.strictEqual(pointUpdated.pointText, '2,000P');
    assert.strictEqual(pointUpdated.pointCheckedAt, '2026-08-25T12:00:00Z');

    // 2-2. 이후 세미나 목록 재조회(기본 메타데이터만 포함된 incoming)가 들어왔을 때 기존 pointPaid 정보가 절대 덮어써지지 않아야 함!
    const metaOnlyIncoming: SeminarListItem = {
      seminarId: '5001',
      name: '당뇨병 최신 지견 (최신명)',
      url: 'https://m.doctorville.co.kr/cme/seminar/5001',
      date: '2026-08-30',
      time: '19:30',
      currentCount: '50',
      totalCount: '100',
      nightTime: true,
      isPointExcluded: false,
      isAdvancedSurvey: true,
      processState: 3,
      pointCheckedAt: '2026-08-25T15:00:00Z', // 확인 시간만 갱신
    };

    const reMerged = seminarRepo.upsertSeminar(metaOnlyIncoming);
    assert.strictEqual(reMerged.name, '당뇨병 최신 지견 (최신명)', '이름 갱신 반영');
    assert.strictEqual(reMerged.time, '19:30', '시간 갱신 반영');
    assert.strictEqual(reMerged.nightTime, true, 'nightTime 갱신 반영');
    assert.strictEqual(reMerged.processState, 3, 'processState 갱신 반영');
    assert.strictEqual(reMerged.pointCheckedAt, '2026-08-25T15:00:00Z', 'pointCheckedAt 갱신 반영');

    // 핵심 검증: pointPaid, point, pointText, pointDate, pointContent가 원본대로 보존되어야 함!
    assert.strictEqual(reMerged.pointPaid, true, 'pointPaid: true 보존');
    assert.strictEqual(reMerged.point, 2000, 'point: 2000 보존');
    assert.strictEqual(reMerged.pointText, '2,000P', 'pointText 보존');
    assert.strictEqual(reMerged.pointDate, '2026-08-25', 'pointDate 보존');
    assert.strictEqual(reMerged.pointContent, '세미나 설문 완료 포인트', 'pointContent 보존');

    // DB 재조회하여 검증
    const dbCheck = seminarRepo.getSeminarById('5001');
    assert.strictEqual(dbCheck?.pointPaid, true);
    assert.strictEqual(dbCheck?.point, 2000);
    assert.strictEqual(dbCheck?.pointText, '2,000P');
    assert.strictEqual(dbCheck?.pointDate, '2026-08-25');
    assert.strictEqual(dbCheck?.pointCheckedAt, '2026-08-25T15:00:00Z');
    console.log('  ✓ [Pass] pointPaid === true 세미나의 포인트 필드 보존 및 merge semantics 검증 완료\n');

    // ----------------------------------------------------
    // Test 3: upsertSeminars 배치 단일 트랜잭션 및 getAdvancedSeminars 인덱스 쿼리 검증
    // ----------------------------------------------------
    console.log('--- [Test 3] upsertSeminars 배치 트랜잭션 및 getAdvancedSeminars 쿼리 검증 ---');

    const batchList: SeminarListItem[] = [
      {
        seminarId: '5002',
        name: '고혈압 가이드라인 2026',
        url: 'https://m.doctorville.co.kr/cme/seminar/5002',
        date: '2026-08-20',
        time: '13:00',
        currentCount: '20',
        totalCount: '50',
        nightTime: false,
        isAdvancedSurvey: true,
      },
      {
        seminarId: '5003',
        name: '일반 세미나 A (심화설문 아님)',
        url: 'https://m.doctorville.co.kr/cme/seminar/5003',
        date: '2026-08-22',
        time: '19:00',
        currentCount: '5',
        totalCount: '30',
        nightTime: false,
        isAdvancedSurvey: false,
      },
      {
        seminarId: '5004',
        name: '심화설문 세미나 B (범위 외)',
        url: 'https://m.doctorville.co.kr/cme/seminar/5004',
        date: '2026-07-01',
        time: '19:00',
        currentCount: '5',
        totalCount: '30',
        nightTime: false,
        isAdvancedSurvey: true,
      },
    ];

    const batchResults = seminarRepo.upsertSeminars(batchList);
    assert.strictEqual(batchResults.length, 3, '3건 배치 upsert 성공');

    // 2026-08-15 ~ 2026-08-31 사이의 심화설문 세미나만 조회
    const advList = seminarRepo.getAdvancedSeminars('2026-08-15', '2026-08-31');
    assert.strictEqual(advList.length, 2, '기간 내 심화설문 세미나 2건(5001, 5002)만 조회되어야 함');
    const advIds = advList.map((s) => s.seminarId);
    assert.ok(advIds.includes('5001'), '5001 포함');
    assert.ok(advIds.includes('5002'), '5002 포함');
    assert.ok(!advIds.includes('5003'), '5003(비심화) 제외');
    assert.ok(!advIds.includes('5004'), '5004(날짜 범위 외) 제외');
    console.log('  ✓ [Pass] 배치 upsert 및 getAdvancedSeminars 인덱스 쿼리 정확성 검증 완료\n');

    // ----------------------------------------------------
    // Test 4: deleteExpiredSeminars (60일 만료 정리) 검증
    // ----------------------------------------------------
    console.log('--- [Test 4] deleteExpiredSeminars 60일 보존 기간 정리 검증 ---');
    const deletedCount = seminarRepo.deleteExpiredSeminars('2026-08-25', 30); // 30일 초과 삭제 기준
    assert.strictEqual(deletedCount, 1, '2026-07-01 세미나 1건 삭제되어야 함');
    assert.strictEqual(seminarRepo.getSeminarById('5004'), null, '5004 세미나 DB에서 삭제됨');
    console.log('  ✓ [Pass] deleteExpiredSeminars 만료 정리 검증 완료\n');

    // ----------------------------------------------------
    // Test 5: kv_store -> seminars 단일 SQLite 트랜잭션 마이그레이션 검증 (핵심 요구사항)
    // ----------------------------------------------------
    console.log('--- [Test 5] kv_store 단일 SQLite 트랜잭션 자동 마이그레이션 검증 ---');

    const migrationDbPath = path.join(testDbDir, 'test_migration.db');
    if (fs.existsSync(migrationDbPath)) {
      try {
        storage.closeDatabase();
        fs.unlinkSync(migrationDbPath);
      } catch (_e) {
        /* ignore */
      }
    }

    // 레거시 DB 환경 구성: kv_store에 apply_seminar:seminar_list 데이터만 들어있는 상태 시뮬레이션
    const Database = (await import('better-sqlite3')).default;
    const rawDb = new Database(migrationDbPath);
    rawDb.exec(`
    CREATE TABLE kv_store (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE _migration_meta (
      name TEXT PRIMARY KEY,
      migrated_at INTEGER NOT NULL
    );
  `);

    const legacyList = [
      {
        seminarId: '9001',
        name: '레거시 세미나 1',
        url: 'https://m.doctorville.co.kr/cme/seminar/9001',
        date: '2026-08-25',
        time: '20:00',
        currentCount: '3',
        totalCount: '10',
        nightTime: true,
        isAdvancedSurvey: true,
        pointPaid: true,
        point: 1000,
        pointDate: '2026-08-25',
      },
      {
        seminarId: '9002',
        name: '레거시 세미나 2',
        url: 'https://m.doctorville.co.kr/cme/seminar/9002',
        date: '2026-08-26',
        time: '19:00',
        currentCount: '1',
        totalCount: '20',
        nightTime: false,
        isAdvancedSurvey: false,
      },
    ];

    rawDb
      .prepare('INSERT INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)')
      .run('apply_seminar:seminar_list', JSON.stringify(legacyList), Date.now());
    rawDb.close();

    // storage 모듈로 해당 DB 열기 -> 자동 마이그레이션(migrateSeminarListTableIfNeeded) 트리거
    storage.setDatabasePath(migrationDbPath);

    // 검증 1: seminars 테이블로 이관되었는지 확인
    const migratedSeminars = seminarRepo.getAllSeminars();
    assert.strictEqual(migratedSeminars.length, 2, '2건의 세미나가 seminars 테이블로 이관됨');
    const m1 = seminarRepo.getSeminarById('9001');
    assert.ok(m1, '9001 이관 확인');
    assert.strictEqual(m1?.name, '레거시 세미나 1');
    assert.strictEqual(m1?.pointPaid, true);
    assert.strictEqual(m1?.point, 1000);

    // 검증 2: kv_store에서는 apply_seminar:seminar_list 키가 삭제되었는지 확인
    const dbInst = storage.getDatabase();
    const kvRow = dbInst.prepare('SELECT value FROM kv_store WHERE key = ?').get('apply_seminar:seminar_list');
    assert.strictEqual(kvRow, undefined, 'kv_store에서 apply_seminar:seminar_list가 성공적으로 삭제됨');

    // 검증 3: _migration_meta에 seminar_table_migration 기록이 남았는지 확인
    const metaRow = dbInst.prepare('SELECT * FROM _migration_meta WHERE name = ?').get('seminar_table_migration');
    assert.ok(metaRow, '_migration_meta에 seminar_table_migration 기록 완료');

    console.log('  ✓ [Pass] 단일 SQLite 트랜잭션 마이그레이션 및 메타데이터 기록 검증 완료\n');

    // ----------------------------------------------------
    // Test 6: storage.get / storage.set 호환 레이어 검증
    // ----------------------------------------------------
    console.log('--- [Test 6] storage.get / storage.set 호환 레이어 검증 ---');

    const compatList = storage.get<SeminarListItem[]>('apply_seminar:seminar_list', []);
    assert.strictEqual(compatList?.length, 2, 'storage.get으로 seminars 테이블 데이터 정상 조회');

    storage.set('apply_seminar:seminar_list', [
      {
        seminarId: '9999',
        name: '새 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/9999',
        time: '19:00',
        currentCount: '0',
        totalCount: '10',
        nightTime: false,
        isAdvancedSurvey: false,
      },
    ]);

    const afterSet = seminarRepo.getAllSeminars();
    assert.strictEqual(afterSet.length, 1, 'storage.set으로 seminars 테이블 정상 갱신');
    assert.strictEqual(afterSet[0].seminarId, '9999');

    storage.deleteKey('apply_seminar:seminar_list');
    assert.strictEqual(seminarRepo.getAllSeminars().length, 0, 'storage.deleteKey로 seminars 테이블 정상 비움');
    console.log('  ✓ [Pass] storage.get / storage.set / storage.deleteKey 호환 레이어 검증 완료\n');

    // 정리
    storage.closeDatabase();
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(migrationDbPath)) fs.unlinkSync(migrationDbPath);

    console.log('🎉 모든 Seminar Repository 및 SQLite 테이블 승격 테스트 성공적으로 통과!\n');
  });
});
