import { describe, it, expect, vi, beforeEach } from 'vitest';
import { refreshStoredSeminarList, isSeminarRecordChanged, applySeminars } from '../src/tasks/apply_seminar';
import type { SeminarListItem } from '../src/services/seminar_repository';
import * as seminarApi from '../src/modules/seminar_api';
import * as seminarRepo from '../src/services/seminar_repository';

describe('apply_seminar 최적화 검증 (델타 Upsert & 신청 동시 2개 제어)', () => {
  const baseDate = '2026-09-08';

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('1. 델타 Upsert 및 isSeminarRecordChanged 검증', () => {
    it('동일한 필드 값을 가진 기존 세미나는 isSeminarRecordChanged에서 false를 반환해야 함', () => {
      const existing: SeminarListItem = {
        seminarId: '101',
        name: '당뇨병 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        date: '2026-09-10',
        time: '19:00',
        currentCount: '50',
        totalCount: '100',
        nightTime: true,
        isAdvancedSurvey: false,
        isPointExcluded: false,
        processState: seminarApi.ProcessState.PROCESS_APPLY,
      };

      const incoming: SeminarListItem = { ...existing };
      expect(isSeminarRecordChanged(existing, incoming)).toBe(false);
    });

    it('currentCount, totalCount, processState 등 필드가 변경되면 true를 반환해야 함', () => {
      const existing: SeminarListItem = {
        seminarId: '101',
        name: '당뇨병 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        date: '2026-09-10',
        time: '19:00',
        currentCount: '50',
        totalCount: '100',
        nightTime: true,
        isAdvancedSurvey: false,
        isPointExcluded: false,
        processState: seminarApi.ProcessState.PROCESS_APPLY,
      };

      const changedCount: SeminarListItem = { ...existing, currentCount: '55' };
      expect(isSeminarRecordChanged(existing, changedCount)).toBe(true);

      const changedState: SeminarListItem = {
        ...existing,
        processState: seminarApi.ProcessState.PROCESS_CANCEL,
      };
      expect(isSeminarRecordChanged(existing, changedState)).toBe(true);
    });

    it('refreshStoredSeminarList는 신규 및 변경된 세미나만 updatedSeminars에 포함해야 함', () => {
      const stored: SeminarListItem[] = [
        {
          seminarId: '101',
          name: '세미나 1',
          url: 'https://m.doctorville.co.kr/cme/seminar/101',
          date: '2026-09-10',
          time: '19:00',
          currentCount: '50',
          totalCount: '100',
          nightTime: false,
          isAdvancedSurvey: false,
        },
        {
          seminarId: '102',
          name: '세미나 2 (변경 없음)',
          url: 'https://m.doctorville.co.kr/cme/seminar/102',
          date: '2026-09-11',
          time: '19:00',
          currentCount: '20',
          totalCount: '100',
          nightTime: false,
          isAdvancedSurvey: false,
        },
      ];

      const current: SeminarListItem[] = [
        // 101: currentCount가 50 -> 60으로 변경됨
        {
          ...stored[0],
          currentCount: '60',
        },
        // 102: 변경 없음
        {
          ...stored[1],
        },
        // 103: 신규 추가
        {
          seminarId: '103',
          name: '세미나 3 (신규)',
          url: 'https://m.doctorville.co.kr/cme/seminar/103',
          date: '2026-09-12',
          time: '13:00',
          currentCount: '5',
          totalCount: '50',
          nightTime: false,
          isAdvancedSurvey: false,
        },
      ];

      const result = refreshStoredSeminarList(current, stored, baseDate);

      // 전체 세미나는 3개
      expect(result.seminars).toHaveLength(3);
      // 신규 추가는 103 1개
      expect(result.newlyAdded).toHaveLength(1);
      expect(result.newlyAdded[0].seminarId).toBe('103');

      // updatedSeminars에는 변경된 101과 신규 103만 포함되고, 변경 없는 102는 제외되어야 함
      expect(result.updatedSeminars).toHaveLength(2);
      const updatedIds = result.updatedSeminars.map((s) => s.seminarId);
      expect(updatedIds).toContain('101');
      expect(updatedIds).toContain('103');
      expect(updatedIds).not.toContain('102');
    });

    it('모든 세미나에 변경이 없는 경우 updatedSeminars는 빈 배열이어야 함', () => {
      const stored: SeminarListItem[] = [
        {
          seminarId: '101',
          name: '세미나 1',
          url: 'https://m.doctorville.co.kr/cme/seminar/101',
          date: '2026-09-10',
          time: '19:00',
          currentCount: '50',
          totalCount: '100',
          nightTime: false,
          isAdvancedSurvey: false,
        },
      ];

      const current: SeminarListItem[] = [{ ...stored[0] }];
      const result = refreshStoredSeminarList(current, stored, baseDate);

      expect(result.updatedSeminars).toHaveLength(0);
      expect(result.newlyAdded).toHaveLength(0);
    });
  });

  describe('2. applySeminars 동시 2개 청크 신청 제어 검증', () => {
    it('여러 개의 세미나 신청 시 동시 2개씩 applySeminarWithTerms가 호출되어야 함', async () => {
      let activeRequests = 0;
      let maxConcurrentRequests = 0;

      const applyCallLog: string[] = [];

      vi.spyOn(seminarApi, 'applySeminarWithTerms').mockImplementation(async (seminarId: string | number) => {
        activeRequests++;
        maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests);
        applyCallLog.push(`start:${seminarId}`);

        // 비동기 지연 시뮬레이션
        await new Promise((resolve) => setTimeout(resolve, 20));

        activeRequests--;
        applyCallLog.push(`end:${seminarId}`);

        return {
          success: true,
          processState: seminarApi.ProcessState.PROCESS_CANCEL,
          isAuthExpired: false,
        };
      });

      vi.spyOn(seminarRepo, 'getAllSeminars').mockReturnValue([]);

      const mockSyncData = {
        success: true,
        currentSeminars: [
          {
            seminarId: '201',
            url: 'https://m.doctorville.co.kr/cme/seminar/201',
            name: '신청 대상 1',
            date: '2026-09-10',
            time: '19:00',
            currentCount: '10',
            totalCount: '100',
            nightTime: false,
            isAdvancedSurvey: false,
            processState: seminarApi.ProcessState.PROCESS_APPLY,
          },
          {
            seminarId: '202',
            url: 'https://m.doctorville.co.kr/cme/seminar/202',
            name: '신청 대상 2',
            date: '2026-09-10',
            time: '19:00',
            currentCount: '20',
            totalCount: '100',
            nightTime: false,
            isAdvancedSurvey: false,
            processState: seminarApi.ProcessState.PROCESS_APPLY,
          },
          {
            seminarId: '203',
            url: 'https://m.doctorville.co.kr/cme/seminar/203',
            name: '신청 대상 3',
            date: '2026-09-10',
            time: '19:00',
            currentCount: '30',
            totalCount: '100',
            nightTime: false,
            isAdvancedSurvey: false,
            processState: seminarApi.ProcessState.PROCESS_APPLY,
          },
          {
            seminarId: '204',
            url: 'https://m.doctorville.co.kr/cme/seminar/204',
            name: '신청 대상 4',
            date: '2026-09-10',
            time: '19:00',
            currentCount: '40',
            totalCount: '100',
            nightTime: false,
            isAdvancedSurvey: false,
            processState: seminarApi.ProcessState.PROCESS_APPLY,
          },
        ],
        finalSeminars: [],
        newlyAdded: [],
        hasApplyTarget: true,
      };

      const res = await applySeminars({}, {}, mockSyncData);

      expect(res.success).toBe(true);
      // 4개 대상 모두 신청되었는지 확인
      expect(seminarApi.applySeminarWithTerms).toHaveBeenCalledTimes(4);
      // 동시 요청 수가 2개를 초과하지 않았는지 확인
      expect(maxConcurrentRequests).toBe(2);
      // 메시지에 4개 세미나 신청 완료가 포함되어 있는지 확인
      expect(res.message).toContain('4개 세미나 신청 완료');
    });
  });
});
