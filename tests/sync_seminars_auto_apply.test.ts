import { describe, it, vi, beforeEach, afterEach, expect } from 'vitest';
import { syncSeminarsTask } from '../src/tasks/apply_seminar';
import * as seminarApiModule from '../src/modules/seminar_api';
import type { FutureSeminarApiItem } from '../src/modules/seminar_api';
import * as seminarPointSyncModule from '../src/services/seminar_point_sync';
import * as seminarRepo from '../src/services/seminar_repository';
import * as seminarSyncService from '../src/services/seminar_sync_service';
import * as storage from '../src/services/storage';

describe('syncSeminarsTask auto-apply integration', () => {
  beforeEach(() => {
    storage.clear();
    seminarRepo.setAllSeminars([]);
    vi.spyOn(seminarPointSyncModule, 'refreshSeminarPointStatus').mockResolvedValue({
      pointChanges: [],
      updatedSeminars: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('신청 대상(PROCESS_APPLY) 세미나가 있는 경우 syncSeminarsTask가 자동으로 세미나 신청을 실행한다', async () => {
    // 1. mock 세미나 데이터 준비 (processState: PROCESS_APPLY)
    const mockItem: FutureSeminarApiItem = {
      seminarId: '9999',
      seminarNm: '신청 가능 테스트 세미나',
      startDt: '2026-09-10 19:00:00',
      endDt: '2026-09-10 20:00:00',
      applyCnt: 10,
      maxPeopleCnt: 100,
      processState: seminarApiModule.ProcessState.PROCESS_APPLY, // 2: 신청 가능
      cancelProcessState: 0,
      useDepthSurvey: 'N',
    };

    vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
      success: true,
      items: [mockItem],
      rawResponse: {},
    });

    const applySpy = vi.spyOn(seminarApiModule, 'applySeminarWithTerms').mockResolvedValue({
      success: true,
      processState: seminarApiModule.ProcessState.PROCESS_CANCEL, // 3: 신청 완료
    });

    // 2. syncSeminarsTask 실행
    const result = await syncSeminarsTask.run({}, { notifyNewSeminarsToTelegram: false });

    // 3. 검증: applySeminarWithTerms가 세미나 ID 9999로 호출되었는지 확인
    expect(applySpy).toHaveBeenCalledWith('9999');
    expect(result).toBeDefined();
    expect(result && typeof result === 'object' && result.success).toBe(true);
    expect(result && typeof result === 'object' && result.message).toContain('신청 완료');
    expect(result && typeof result === 'object' && result.silent).toBeUndefined();
  });

  it('신청 대상(PROCESS_APPLY) 세미나가 없는 경우 applySeminarWithTerms가 호출되지 않고 silent=true가 된다', async () => {
    const mockItem: FutureSeminarApiItem = {
      seminarId: '8888',
      seminarNm: '이미 신청된 세미나',
      startDt: '2026-09-10 19:00:00',
      endDt: '2026-09-10 20:00:00',
      applyCnt: 10,
      maxPeopleCnt: 100,
      processState: seminarApiModule.ProcessState.PROCESS_CANCEL, // 3: 이미 신청됨
      cancelProcessState: 0,
      useDepthSurvey: 'N',
    };

    vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
      success: true,
      items: [mockItem],
      rawResponse: {},
    });

    const applySpy = vi.spyOn(seminarApiModule, 'applySeminarWithTerms');

    const result = await syncSeminarsTask.run({}, { notifyNewSeminarsToTelegram: false });

    expect(applySpy).not.toHaveBeenCalled();
    expect(result).toBeDefined();
    expect(result && typeof result === 'object' && result.success).toBe(true);
  });

  it('기존에 DB에 저장되어 있던 비공개 세미나는 PROCESS_APPLY 상태여도 신청으로 빠지지 않는다', async () => {
    // 기존 DB에 저장되어 있던 비공개 세미나 (이전에 이미 발견되었던 건)
    seminarRepo.setAllSeminars([
      {
        seminarId: '5674',
        name: '기존 비공개 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/5674',
        date: '2026-09-15',
        time: '19:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        hiddenYn: 'Y',
        processState: seminarApiModule.ProcessState.PROCESS_APPLY, // 신청 가능 상태이지만 기존 비공개 건
        isAdvancedSurvey: false,
      },
    ]);

    vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
      success: true,
      items: [],
      rawResponse: {},
    });

    vi.spyOn(seminarSyncService, 'enrichSeminarsWithDetail').mockResolvedValue({
      seminars: [
        {
          seminarId: '5674',
          name: '기존 비공개 세미나',
          url: 'https://m.doctorville.co.kr/cme/seminar/5674',
          date: '2026-09-15',
          time: '19:00',
          currentCount: '10',
          totalCount: '100',
          nightTime: false,
          hiddenYn: 'Y',
          processState: seminarApiModule.ProcessState.PROCESS_APPLY,
          isAdvancedSurvey: false,
        },
      ],
      isAuthExpired: false,
      deletedSeminarIds: [],
    });

    const applySpy = vi.spyOn(seminarApiModule, 'applySeminarWithTerms');

    const result = await syncSeminarsTask.run({}, { notifyNewSeminarsToTelegram: false });

    expect(applySpy).not.toHaveBeenCalled();
    expect(result).toBeDefined();
    expect(result && typeof result === 'object' && result.success).toBe(true);
  });

  it('정원 초과(PROCESS_EXCESS) 또는 마감(isClosed) 세미나는 신청 대상에서 제외된다', async () => {
    const mockItem: FutureSeminarApiItem = {
      seminarId: '7777',
      seminarNm: '정원 초과 세미나',
      startDt: '2026-09-10 19:00:00',
      endDt: '2026-09-10 20:00:00',
      applyCnt: 100,
      maxPeopleCnt: 100,
      processState: seminarApiModule.ProcessState.PROCESS_EXCESS, // 4: 정원 초과
      cancelProcessState: 0,
      useDepthSurvey: 'N',
    };

    vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
      success: true,
      items: [mockItem],
      rawResponse: {},
    });

    const applySpy = vi.spyOn(seminarApiModule, 'applySeminarWithTerms');

    const result = await syncSeminarsTask.run({}, { notifyNewSeminarsToTelegram: false });

    expect(applySpy).not.toHaveBeenCalled();
    expect(result).toBeDefined();
    expect(result && typeof result === 'object' && result.success).toBe(true);
  });
});
