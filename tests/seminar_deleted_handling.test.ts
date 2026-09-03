import assert from 'node:assert';
import { describe, it, beforeEach, afterEach, vi } from 'vitest';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as httpClientModule from '../src/modules/http_client';
import * as checkSeminarPointModule from '../src/tasks/check_seminar_point';
import * as seminarRepo from '../src/services/seminar_repository';
import * as seminarSyncService from '../src/services/seminar_sync_service';
import { syncSeminars, type SeminarListItem } from '../src/tasks/apply_seminar';
import { ProcessState } from '../src/modules/seminar_api';

describe('삭제된 세미나(상세 조회 시 빈 객체 / NotFound) 감지 및 DB 삭제 처리 테스트', () => {
  let originalStoredList: SeminarListItem[];

  beforeEach(() => {
    originalStoredList = seminarRepo.getAllSeminars();
    vi.spyOn(checkSeminarPointModule, 'searchSeminarPoints').mockResolvedValue({
      success: true,
      points: new Map(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    seminarRepo.setAllSeminars(originalStoredList);
  });

  it('1. fetchSeminarDetail: 빈 객체 {} 또는 { seminarDetail: {} } 반환 시 isNotFound=true로 판정', async () => {
    // 1-1. 빈 JSON 객체 {}
    vi.spyOn(httpClientModule, 'httpGet').mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({}),
      headers: {},
      cookies: {},
    });

    const res1 = await seminarApiModule.fetchSeminarDetail('99991');
    assert.strictEqual(res1.success, false);
    assert.strictEqual(res1.isNotFound, true);

    // 1-2. { seminarDetail: {} }
    vi.spyOn(httpClientModule, 'httpGet').mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ seminarDetail: {} }),
      headers: {},
      cookies: {},
    });

    const res2 = await seminarApiModule.fetchSeminarDetail('99992');
    assert.strictEqual(res2.success, false);
    assert.strictEqual(res2.isNotFound, true);

    // 1-3. { code: 200, value: {} }
    vi.spyOn(httpClientModule, 'httpGet').mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ code: 200, value: {} }),
      headers: {},
      cookies: {},
    });

    const res3 = await seminarApiModule.fetchSeminarDetail('99993');
    assert.strictEqual(res3.success, false);
    assert.strictEqual(res3.isNotFound, true);

    // 1-4. { code: 404, message: '세미나 정보를 찾을 수 없습니다.' }
    vi.spyOn(httpClientModule, 'httpGet').mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
      body: JSON.stringify({ code: 404, message: '세미나 정보를 찾을 수 없습니다.' }),
      headers: {},
      cookies: {},
    });

    const res4 = await seminarApiModule.fetchSeminarDetail('99994');
    assert.strictEqual(res4.success, false);
    assert.strictEqual(res4.isNotFound, true);
  });

  it('2. enrichSeminarsWithDetail: 삭제된 세미나(isNotFound)를 deletedSeminarIds에 수집하고 반환 목록에서 제외', async () => {
    const inputList: SeminarListItem[] = [
      {
        seminarId: '8001',
        name: '정상 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/8001',
        time: '19:00~20:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: true,
        isAdvancedSurvey: false,
        processState: ProcessState.PROCESS_APPLY,
      },
      {
        seminarId: '8002',
        name: '삭제된 세미나 (과거 ENTER 상태)',
        url: 'https://m.doctorville.co.kr/cme/seminar/8002',
        time: '12:00~13:00',
        currentCount: '50',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
        processState: ProcessState.PROCESS_ENTER,
      },
    ];

    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockImplementation(async (id: string | number) => {
      if (String(id) === '8001') {
        return {
          success: true,
          seminarId: '8001',
          hasEntryHistory: false,
          isPointExcluded: false,
          rawResponse: {
            seminarDetail: {
              seminarId: 8001,
              seminarNm: '정상 세미나 갱신',
              applyCnt: 20,
              maxPeopleCnt: 100,
            },
          },
        };
      }
      // 8002: 삭제된 세미나 -> isNotFound
      return {
        success: false,
        seminarId: '8002',
        isAuthExpired: false,
        statusCode: 404,
        isNotFound: true,
        errorMessage: '세미나 정보를 찾을 수 없습니다.',
      };
    });

    const res = await seminarSyncService.enrichSeminarsWithDetail(inputList, 2, 0);

    assert.strictEqual(res.seminars.length, 1);
    assert.strictEqual(res.seminars[0].seminarId, '8001');
    assert.deepStrictEqual(res.deletedSeminarIds, ['8002']);
  });

  it('3. refreshPastUncompletedSeminars: DB에 ENTER 상태로 남아있던 삭제 세미나가 DB에서 완전히 삭제됨', async () => {
    // 2026-08-01에 진행된 과거 세미나 2개 등록 (하나는 정상 종료, 하나는 삭제됨)
    const pastSeminars: SeminarListItem[] = [
      {
        seminarId: '9001',
        name: '과거 정상 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/9001',
        date: '2026-08-01',
        time: '19:00~20:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: true,
        isAdvancedSurvey: false,
        processState: ProcessState.PROCESS_APPLY, // 미완료 상태로 남아있음
      },
      {
        seminarId: '9002',
        name: '과거 삭제된 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/9002',
        date: '2026-08-01',
        time: '19:00~20:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: true,
        isAdvancedSurvey: false,
        processState: ProcessState.PROCESS_ENTER, // ENTER 상태로 남아있음
      },
    ];

    seminarRepo.setAllSeminars(pastSeminars);
    assert.strictEqual(seminarRepo.getAllSeminars().length, 2);

    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockImplementation(async (id: string | number) => {
      if (String(id) === '9001') {
        return {
          success: true,
          seminarId: '9001',
          hasEntryHistory: false,
          isPointExcluded: false,
          rawResponse: {
            seminarDetail: {
              seminarId: 9001,
              seminarNm: '과거 정상 세미나',
              processState: ProcessState.PROCESS_COMPLETED,
              seminarCompleted: 1,
            },
          },
        };
      }
      // 9002: 삭제된 세미나
      return {
        success: false,
        seminarId: '9002',
        isAuthExpired: false,
        statusCode: 404,
        isNotFound: true,
        errorMessage: '세미나 정보를 찾을 수 없습니다.',
      };
    });

    const result = await seminarSyncService.refreshPastUncompletedSeminars(2, 0);

    assert.strictEqual(result.targetCount, 2);
    // DB 확인: 9002는 삭제되었고 9001은 COMPLETED로 갱신됨
    const all = seminarRepo.getAllSeminars();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].seminarId, '9001');
    assert.strictEqual(all[0].processState, ProcessState.PROCESS_COMPLETED);
    assert.strictEqual(seminarRepo.getSeminarById('9002'), null);
  });

  it('4. syncSeminars: 전체 동기화 시 과거 ENTER 상태의 삭제 세미나가 정리되어 total 통계에서 제외됨', async () => {
    // DB에 과거 삭제된 세미나(9002, ENTER 상태)와 유효한 세미나(9003)가 보관되어 있는 상황
    const initialDb: SeminarListItem[] = [
      {
        seminarId: '9002',
        name: '삭제된 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/9002',
        date: '2026-08-01',
        time: '19:00~20:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: true,
        isAdvancedSurvey: false,
        processState: ProcessState.PROCESS_ENTER, // ENTER 상태
      },
      {
        seminarId: '9003',
        name: '예정된 미래 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/9003',
        date: '2026-09-10',
        time: '19:00~20:00',
        currentCount: '50',
        totalCount: '100',
        nightTime: true,
        isAdvancedSurvey: false,
        processState: ProcessState.PROCESS_CANCEL,
      },
    ];
    seminarRepo.setAllSeminars(initialDb);

    // 메인 API 응답: 미래 세미나 9003만 노출 (9002는 삭제되었으므로 미노출)
    vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
      success: true,
      items: [
        {
          seminarId: 9003,
          seminarNm: '예정된 미래 세미나',
          startDt: '2026-09-10 19:00:00',
          endDt: '2026-09-10 20:00:00',
          applyCnt: 50,
          maxPeopleCnt: 100,
          processState: ProcessState.PROCESS_CANCEL,
          useDepthSurvey: 'N',
          hiddenYn: 'N',
        },
      ],
      rawResponse: {},
    });

    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockImplementation(async (id: string | number) => {
      if (String(id) === '9002') {
        return {
          success: false,
          seminarId: '9002',
          isAuthExpired: false,
          statusCode: 404,
          isNotFound: true,
          errorMessage: '세미나 정보를 찾을 수 없습니다.',
        };
      }
      return {
        success: true,
        seminarId: String(id),
        hasEntryHistory: false,
        isPointExcluded: false,
        rawResponse: {
          seminarDetail: {
            seminarId: Number(id),
            seminarNm: '예정된 미래 세미나',
            processState: ProcessState.PROCESS_CANCEL,
          },
        },
      };
    });

    const syncRes = await syncSeminars({
      notifyNewSeminarsToChannel: false,
      notifyNewSeminarsToTelegram: false,
      silentIfNoNew: true,
      forceEnrich: true,
    });

    assert.strictEqual(syncRes.success, true);
    // DB의 finalSeminars 확인: 9002는 삭제되고 9003만 남아야 함 (total=1, ENTER=0)
    const finalSeminars = seminarRepo.getAllSeminars();
    assert.strictEqual(finalSeminars.length, 1);
    assert.strictEqual(finalSeminars[0].seminarId, '9003');
    assert.strictEqual(
      finalSeminars.some((s) => s.processState === ProcessState.PROCESS_ENTER),
      false,
    );
  });
});
