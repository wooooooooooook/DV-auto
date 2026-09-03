import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as syncService from '../src/services/seminar_sync_service';
import {
  isPastSeminar,
  isUncompletedSeminar,
  syncSeminarsDetailToDb,
  refreshPastUncompletedSeminars,
  enrichSeminarsWithDetail,
} from '../src/services/seminar_sync_service';
import { ProcessState } from '../src/modules/seminar_api';
import * as seminarRepo from '../src/services/seminar_repository';
import type { SeminarListItem } from '../src/services/seminar_repository';
import * as seminarApiModule from '../src/modules/seminar_api';

describe('seminar_sync_service', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('isPastSeminar', () => {
    // 2026-09-03 19:00:00 KST 기준 (19:00 KST = 10:00 UTC)
    const mockNowMs = Date.parse('2026-09-03T19:00:00+09:00');

    it('과거 날짜의 세미나는 true를 반환한다', () => {
      const seminar = { date: '2026-09-01', time: '18:30 ~ 20:00' };
      expect(isPastSeminar(seminar, mockNowMs)).toBe(true);
    });

    it('오늘 날짜이지만 종료 시각이 현재 시각 이전인 세미나는 true를 반환한다', () => {
      const seminar = { date: '2026-09-03', time: '12:00 ~ 13:00' };
      expect(isPastSeminar(seminar, mockNowMs)).toBe(true);
    });

    it('오늘 날짜이고 종료 시각이 현재 시각 이후인 세미나는 false를 반환한다', () => {
      const seminar = { date: '2026-09-03', time: '18:30 ~ 20:00' };
      expect(isPastSeminar(seminar, mockNowMs)).toBe(false);
    });

    it('미래 날짜의 세미나는 false를 반환한다', () => {
      const seminar = { date: '2026-09-04', time: '12:00 ~ 13:00' };
      expect(isPastSeminar(seminar, mockNowMs)).toBe(false);
    });

    it('날짜 정보가 없으면 false를 반환한다', () => {
      const seminar = { date: undefined, time: '12:00 ~ 13:00' };
      expect(isPastSeminar(seminar, mockNowMs)).toBe(false);
    });
  });

  describe('isUncompletedSeminar', () => {
    it('processState가 COMPLETED(8) 또는 END(7)이면 false를 반환한다', () => {
      expect(isUncompletedSeminar({ processState: ProcessState.PROCESS_COMPLETED })).toBe(false);
      expect(isUncompletedSeminar({ processState: ProcessState.PROCESS_END })).toBe(false);
    });

    it('seminarCompleted가 1이면 false를 반환한다', () => {
      expect(isUncompletedSeminar({ seminarCompleted: 1 })).toBe(false);
      expect(isUncompletedSeminar({ seminarCompleted: true })).toBe(false);
    });

    it('ENTER(1), APPLY(2), CANCEL(3), PREPARING(4), EXCESS(5) 등은 true를 반환한다', () => {
      expect(isUncompletedSeminar({ processState: ProcessState.PROCESS_ENTER })).toBe(true);
      expect(isUncompletedSeminar({ processState: ProcessState.PROCESS_APPLY })).toBe(true);
      expect(isUncompletedSeminar({ processState: ProcessState.PROCESS_CANCEL })).toBe(true);
      expect(isUncompletedSeminar({ processState: ProcessState.PROCESS_PREPARING })).toBe(true);
      expect(isUncompletedSeminar({ processState: ProcessState.PROCESS_EXCESS })).toBe(true);
    });

    it('processState가 undefined/null이고 완료되지 않은 경우 true를 반환한다', () => {
      expect(isUncompletedSeminar({})).toBe(true);
      expect(isUncompletedSeminar({ processState: null, seminarCompleted: 0 })).toBe(true);
    });
  });

  describe('enrichSeminarsWithDetail', () => {
    it('detail API를 호출하여 최신 메타데이터로 enrich한다', async () => {
      vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockResolvedValue({
        success: true,
        surveyState: 2,
        isPointExcluded: false,
        rawResponse: {
          seminarDetail: {
            seminarNm: '테스트 세미나 상세',
            applyCnt: 50,
            maxPeopleCnt: 500,
            processState: ProcessState.PROCESS_COMPLETED,
            seminarCompleted: 1,
            hiddenYn: 'N',
          },
        },
      });

      const input = [
        {
          seminarId: '5001',
          name: '이전 이름',
          url: 'https://m.doctorville.co.kr/cme/seminar/5001',
          time: '',
          currentCount: '10',
          totalCount: '100',
          nightTime: false,
          isAdvancedSurvey: false,
        } as SeminarListItem,
      ];

      const res = await enrichSeminarsWithDetail(input, 1, 0);
      expect(res.seminars.length).toBe(1);
      expect(res.seminars[0].name).toBe('테스트 세미나 상세');
      expect(res.seminars[0].processState).toBe(ProcessState.PROCESS_COMPLETED);
      expect(res.seminars[0].seminarCompleted).toBe(1);
    });
  });

  describe('syncSeminarsDetailToDb', () => {
    it('기본 동시성 3, 딜레이 250ms로 enrichSeminarsWithDetail을 호출하고 DB에 upsert한다', async () => {
      const fetchSpy = vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockResolvedValue({
        success: true,
        surveyState: 2,
        isPointExcluded: false,
        rawResponse: {
          seminarDetail: {
            seminarNm: '종료된 세미나',
            processState: ProcessState.PROCESS_COMPLETED,
            seminarCompleted: 1,
          },
        },
      });
      const upsertSpy = vi.spyOn(seminarRepo, 'upsertSeminars').mockImplementation((list) => list);

      const input = [{ seminarId: '5001' }];
      const res = await syncSeminarsDetailToDb(input, 3, 250);

      expect(fetchSpy).toHaveBeenCalledWith('5001');
      expect(upsertSpy).toHaveBeenCalledTimes(1);
      expect(res[0].processState).toBe(ProcessState.PROCESS_COMPLETED);
      expect(res[0].seminarCompleted).toBe(1);
    });

    it('seminarId가 없는 빈 목록이면 호출하지 않고 빈 배열을 반환한다', async () => {
      const enrichSpy = vi.spyOn(syncService, 'enrichSeminarsWithDetail');
      const upsertSpy = vi.spyOn(seminarRepo, 'upsertSeminars');

      const res = await syncSeminarsDetailToDb([{ seminarId: '' }, { seminarId: null }]);
      expect(enrichSpy).not.toHaveBeenCalled();
      expect(upsertSpy).not.toHaveBeenCalled();
      expect(res).toEqual([]);
    });
  });

  describe('refreshPastUncompletedSeminars', () => {
    it('지나간 세미나 중 미완료 세미나만 선별하여 detail 동기화를 수행한다', async () => {
      const mockAll: Partial<SeminarListItem>[] = [
        // 과거 날짜 + 미완료 -> 동기화 대상
        { seminarId: '101', date: '2026-08-20', time: '18:30 ~ 20:00', processState: ProcessState.PROCESS_ENTER },
        // 과거 날짜 + 이미 완료 -> 제외
        {
          seminarId: '102',
          date: '2026-08-20',
          time: '18:30 ~ 20:00',
          processState: ProcessState.PROCESS_COMPLETED,
          seminarCompleted: 1,
        },
        // 미래 날짜 -> 제외
        { seminarId: '103', date: '2026-09-10', time: '18:30 ~ 20:00', processState: ProcessState.PROCESS_CANCEL },
      ];

      vi.spyOn(seminarRepo, 'getAllSeminars').mockReturnValue(mockAll as SeminarListItem[]);

      const fetchSpy = vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockResolvedValue({
        success: true,
        surveyState: 2,
        isPointExcluded: false,
        rawResponse: {
          seminarDetail: {
            seminarNm: '업데이트된 세미나',
            processState: ProcessState.PROCESS_COMPLETED,
            seminarCompleted: 1,
          },
        },
      });
      const upsertSpy = vi.spyOn(seminarRepo, 'upsertSeminars').mockReturnValue([]);

      const result = await refreshPastUncompletedSeminars(3, 250);

      expect(result.total).toBe(3);
      expect(result.targetCount).toBe(1);
      expect(result.updatedCount).toBe(1);

      expect(fetchSpy).toHaveBeenCalledWith('101');
      expect(upsertSpy).toHaveBeenCalledTimes(1);
    });

    it('미완료 과거 세미나가 없으면 API 호출 없이 0건을 반환한다', async () => {
      const mockAll: Partial<SeminarListItem>[] = [
        {
          seminarId: '201',
          date: '2026-08-20',
          time: '18:30 ~ 20:00',
          processState: ProcessState.PROCESS_COMPLETED,
          seminarCompleted: 1,
        },
      ];
      vi.spyOn(seminarRepo, 'getAllSeminars').mockReturnValue(mockAll as SeminarListItem[]);
      const enrichSpy = vi.spyOn(syncService, 'enrichSeminarsWithDetail');

      const result = await refreshPastUncompletedSeminars(3, 250);

      expect(result.targetCount).toBe(0);
      expect(enrichSpy).not.toHaveBeenCalled();
    });
  });
});
