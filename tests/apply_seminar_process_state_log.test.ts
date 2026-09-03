import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  formatProcessStateDistribution,
  logProcessStateDistribution,
  runHttpOnly,
  applySeminarExtraTask,
} from '../src/tasks/apply_seminar';
import { ProcessState } from '../src/modules/seminar_api';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as checkSeminarPointModule from '../src/tasks/check_seminar_point';

describe('apply_seminar_extra processState 상태 분포 로그 테스트', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('formatProcessStateDistribution', () => {
    it('요구사항 예시와 동일한 분포를 올바른 형식의 문자열로 포맷팅한다', () => {
      const seminars = [
        // ENTER 2개 (1)
        { processState: ProcessState.PROCESS_ENTER },
        { processState: ProcessState.PROCESS_ENTER },
        // APPLY 3개 (2)
        { processState: ProcessState.PROCESS_APPLY },
        { processState: ProcessState.PROCESS_APPLY },
        { processState: ProcessState.PROCESS_APPLY },
        // CANCEL 1개 (3)
        { processState: ProcessState.PROCESS_CANCEL },
        // PREPARING 5개 (4)
        { processState: ProcessState.PROCESS_PREPARING },
        { processState: ProcessState.PROCESS_PREPARING },
        { processState: ProcessState.PROCESS_PREPARING },
        { processState: ProcessState.PROCESS_PREPARING },
        { processState: ProcessState.PROCESS_PREPARING },
        // EXCESS 0개 (5)
        // STARTED 4개 (6)
        { processState: ProcessState.PROCESS_STARTED },
        { processState: ProcessState.PROCESS_STARTED },
        { processState: ProcessState.PROCESS_STARTED },
        { processState: ProcessState.PROCESS_STARTED },
        // END 6개 (7)
        { processState: ProcessState.PROCESS_END },
        { processState: ProcessState.PROCESS_END },
        { processState: ProcessState.PROCESS_END },
        { processState: ProcessState.PROCESS_END },
        { processState: ProcessState.PROCESS_END },
        { processState: ProcessState.PROCESS_END },
        // COMPLETED 2개 (8)
        { processState: ProcessState.PROCESS_COMPLETED },
        { processState: ProcessState.PROCESS_COMPLETED },
      ];

      expect(seminars.length).toBe(23);

      const result = formatProcessStateDistribution(seminars);
      expect(result).toBe(
        '[apply_seminar_extra] processState: total=23 ENTER=2 APPLY=3 CANCEL=1 PREPARING=5 EXCESS=0 STARTED=4 END=6 COMPLETED=2 unknown=0',
      );
    });

    it('undefined, null, 알 수 없는 숫자 및 잘못된 문자열은 unknown으로 집계한다', () => {
      const seminars = [
        { processState: undefined },
        { processState: null },
        { processState: 99 },
        { processState: -1 },
        { processState: 'invalid' as unknown as number },
        { processState: ProcessState.PROCESS_ENTER },
      ];

      const result = formatProcessStateDistribution(seminars);
      expect(result).toBe(
        '[apply_seminar_extra] processState: total=6 ENTER=1 APPLY=0 CANCEL=0 PREPARING=0 EXCESS=0 STARTED=0 END=0 COMPLETED=0 unknown=5',
      );
    });

    it('문자열 형태의 숫자 processState도 올바른 상태로 변환하여 집계한다', () => {
      const seminars = [
        { processState: '1' as unknown as number },
        { processState: '2' as unknown as number },
        { processState: '3' as unknown as number },
      ];

      const result = formatProcessStateDistribution(seminars);
      expect(result).toBe(
        '[apply_seminar_extra] processState: total=3 ENTER=1 APPLY=1 CANCEL=1 PREPARING=0 EXCESS=0 STARTED=0 END=0 COMPLETED=0 unknown=0',
      );
    });

    it('빈 세미나 목록인 경우 모든 카운트가 0으로 포맷팅된다', () => {
      const result = formatProcessStateDistribution([]);
      expect(result).toBe(
        '[apply_seminar_extra] processState: total=0 ENTER=0 APPLY=0 CANCEL=0 PREPARING=0 EXCESS=0 STARTED=0 END=0 COMPLETED=0 unknown=0',
      );
    });
  });

  describe('logProcessStateDistribution', () => {
    it('console.log를 통해 정확한 포맷으로 1회 출력한다', () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      logProcessStateDistribution([
        { processState: ProcessState.PROCESS_ENTER },
        { processState: ProcessState.PROCESS_CANCEL },
      ]);

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      expect(consoleLogSpy).toHaveBeenCalledWith(
        '[apply_seminar_extra] processState: total=2 ENTER=1 APPLY=0 CANCEL=1 PREPARING=0 EXCESS=0 STARTED=0 END=0 COMPLETED=0 unknown=0',
      );
    });
  });

  describe('runHttpOnly 실행 흐름', () => {
    it('일반적인 runHttpOnly 실행 시 최신 세미나 목록에 대해 상태 분포 로그가 정확히 1줄 출력된다', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(checkSeminarPointModule, 'searchSeminarPoints').mockResolvedValue({
        success: true,
        points: new Map(),
      });

      // 신청 완료 상태 (PROCESS_CANCEL)로만 구성되어 run()으로 위임되지 않음
      vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
        success: true,
        items: [
          {
            seminarId: 1001,
            seminarNm: '테스트 세미나 1',
            startDt: '2026-09-03 19:00:00',
            endDt: '2026-09-03 20:00:00',
            applyCnt: 10,
            maxPeopleCnt: 1000,
            processState: ProcessState.PROCESS_CANCEL,
            cancelProcessState: 0,
            seminarCompleted: 0,
          },
          {
            seminarId: 1002,
            seminarNm: '테스트 세미나 2',
            startDt: '2026-09-03 20:00:00',
            endDt: '2026-09-03 21:00:00',
            applyCnt: 20,
            maxPeopleCnt: 1000,
            processState: ProcessState.PROCESS_ENTER,
            cancelProcessState: 0,
            seminarCompleted: 0,
          },
        ],
      });

      const res = await runHttpOnly({ silentIfNoNew: true, forceEnrich: false });
      expect(res.success).toBe(true);

      // [apply_seminar_extra] processState: 로그가 정확히 1번 호출되었는지 확인
      const processStateLogs = consoleLogSpy.mock.calls.filter((call) =>
        String(call[0]).startsWith('[apply_seminar_extra] processState:'),
      );
      expect(processStateLogs.length).toBe(1);
      expect(processStateLogs[0][0]).toMatch(
        /^\[apply_seminar_extra\] processState: total=\d+ ENTER=\d+ APPLY=\d+ CANCEL=\d+ PREPARING=\d+ EXCESS=\d+ STARTED=\d+ END=\d+ COMPLETED=\d+ unknown=\d+$/,
      );
    });

    it('applySeminarExtraTask.run 실행 시에도 동일하게 1회 출력된다', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(checkSeminarPointModule, 'searchSeminarPoints').mockResolvedValue({
        success: true,
        points: new Map(),
      });

      vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
        success: true,
        items: [
          {
            seminarId: 2001,
            seminarNm: '테스트 세미나',
            startDt: '2026-09-03 19:00:00',
            endDt: '2026-09-03 20:00:00',
            applyCnt: 10,
            maxPeopleCnt: 1000,
            processState: ProcessState.PROCESS_PREPARING,
            cancelProcessState: 0,
            seminarCompleted: 0,
          },
        ],
      });

      const res = await applySeminarExtraTask.run({});
      expect(res.success).toBe(true);

      const processStateLogs = consoleLogSpy.mock.calls.filter((call) =>
        String(call[0]).startsWith('[apply_seminar_extra] processState:'),
      );
      expect(processStateLogs.length).toBe(1);
      expect(processStateLogs[0][0]).toMatch(
        /^\[apply_seminar_extra\] processState: total=\d+ ENTER=\d+ APPLY=\d+ CANCEL=\d+ PREPARING=\d+ EXCESS=\d+ STARTED=\d+ END=\d+ COMPLETED=\d+ unknown=\d+$/,
      );
    });

    it('신청 대상(PROCESS_APPLY)이 있어 run()으로 위임되는 경우에도 상태 분포 로그가 정확히 1줄 출력된다', async () => {
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      vi.spyOn(checkSeminarPointModule, 'searchSeminarPoints').mockResolvedValue({
        success: true,
        points: new Map(),
      });
      vi.spyOn(seminarApiModule, 'applySeminarWithTerms').mockResolvedValue({
        success: true,
        processState: ProcessState.PROCESS_CANCEL,
      });

      vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
        success: true,
        items: [
          {
            seminarId: 3001,
            seminarNm: '신청 대상 세미나',
            startDt: '2026-09-03 19:00:00',
            endDt: '2026-09-03 20:00:00',
            applyCnt: 10,
            maxPeopleCnt: 1000,
            processState: ProcessState.PROCESS_APPLY,
            cancelProcessState: 0,
            seminarCompleted: 0,
          },
        ],
      });

      const res = await runHttpOnly({ silentIfNoNew: true, forceEnrich: false });
      expect(res.success).toBe(true);

      const processStateLogs = consoleLogSpy.mock.calls.filter((call) =>
        String(call[0]).startsWith('[apply_seminar_extra] processState:'),
      );
      expect(processStateLogs.length).toBe(1);
      expect(processStateLogs[0][0]).toMatch(
        /^\[apply_seminar_extra\] processState: total=\d+ ENTER=\d+ APPLY=\d+ CANCEL=\d+ PREPARING=\d+ EXCESS=\d+ STARTED=\d+ END=\d+ COMPLETED=\d+ unknown=\d+$/,
      );
    });
  });
});
