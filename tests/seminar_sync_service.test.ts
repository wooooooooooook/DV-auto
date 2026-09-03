import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isPastSeminar,
  isUncompletedSeminar,
  syncSeminarsDetailToDb,
  refreshPastUncompletedSeminars,
} from '../src/services/seminar_sync_service';
import { ProcessState } from '../src/modules/seminar_api';
import * as seminarRepo from '../src/services/seminar_repository';
import type { SeminarListItem } from '../src/services/seminar_repository';
import * as applySeminarModule from '../src/tasks/apply_seminar';

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

  describe('syncSeminarsDetailToDb', () => {
    it('기본 동시성 3, 딜레이 250ms로 enrichSeminarsWithDetail을 호출하고 DB에 upsert한다', async () => {
      const mockEnriched = [
        {
          seminarId: '5001',
          name: '종료된 세미나',
          url: 'https://m.doctorville.co.kr/cme/seminar/5001',
          time: '18:30 ~ 20:00',
          currentCount: '100',
          totalCount: '1000',
          nightTime: true,
          isAdvancedSurvey: false,
          processState: ProcessState.PROCESS_COMPLETED,
          seminarCompleted: 1,
        },
      ];

      const enrichSpy = vi.spyOn(applySeminarModule, 'enrichSeminarsWithDetail').mockResolvedValue({
        seminars: mockEnriched as SeminarListItem[],
        isAuthExpired: false,
      });
      const upsertSpy = vi.spyOn(seminarRepo, 'upsertSeminars').mockReturnValue(mockEnriched as SeminarListItem[]);

      const input = [{ seminarId: '5001' }];
      const res = await syncSeminarsDetailToDb(input, 3, 250);

      expect(enrichSpy).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ seminarId: '5001' })]),
        3,
        250,
      );
      expect(upsertSpy).toHaveBeenCalledWith(mockEnriched);
      expect(res).toEqual(mockEnriched);
    });

    it('seminarId가 없는 빈 목록이면 호출하지 않고 빈 배열을 반환한다', async () => {
      const enrichSpy = vi.spyOn(applySeminarModule, 'enrichSeminarsWithDetail');
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

      const enrichSpy = vi.spyOn(applySeminarModule, 'enrichSeminarsWithDetail').mockResolvedValue({
        seminars: [
          {
            seminarId: '101',
            name: '업데이트된 세미나',
            url: '',
            time: '',
            currentCount: '',
            totalCount: '',
            nightTime: false,
            isAdvancedSurvey: false,
            processState: ProcessState.PROCESS_COMPLETED,
            seminarCompleted: 1,
          },
        ] as SeminarListItem[],
        isAuthExpired: false,
      });
      const upsertSpy = vi.spyOn(seminarRepo, 'upsertSeminars').mockReturnValue([]);

      const result = await refreshPastUncompletedSeminars(3, 250);

      expect(result.total).toBe(3);
      expect(result.targetCount).toBe(1);
      expect(result.updatedCount).toBe(1);

      expect(enrichSpy).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ seminarId: '101' })]),
        3,
        250,
      );
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
      const enrichSpy = vi.spyOn(applySeminarModule, 'enrichSeminarsWithDetail');

      const result = await refreshPastUncompletedSeminars(3, 250);

      expect(result.targetCount).toBe(0);
      expect(enrichSpy).not.toHaveBeenCalled();
    });
  });
});
