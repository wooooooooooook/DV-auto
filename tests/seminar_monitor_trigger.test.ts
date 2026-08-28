import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as storage from '../src/services/storage';
import {
  isSeminarEnterable,
  isSeminarActiveOrEnded,
  getSeminarPeriod,
  checkAndTriggerSeminarMonitors,
  isTaskRunning,
} from '../src/services/seminar_monitor_trigger';
import { ProcessState } from '../src/modules/seminar_api';
import * as taskRegistry from '../src/core/taskRegistry';
import * as channelRepo from '../src/services/channel_message_repository';
import type { SeminarListItem } from '../src/services/seminar_repository';

describe('seminar_monitor_trigger (10분 주기 모니터링 트리거 및 상태 감지)', () => {
  beforeEach(() => {
    storage.setDatabasePath(':memory:');
    storage.clear();
  });

  afterEach(() => {
    storage.closeDatabase();
    vi.restoreAllMocks();
  });

  it('isSeminarEnterable 판정 로직 검증', () => {
    const nowMs = new Date('2026-08-28T12:30:00+09:00').getTime();

    // 1. 포인트 미지급 세미나는 입장 가능 대상에서 제외
    expect(
      isSeminarEnterable(
        {
          seminarId: '101',
          name: '포인트 제외 세미나',
          url: 'https://example.com/101',
          date: '2026-08-28',
          time: '12:00~13:00',
          currentCount: '0',
          totalCount: '100',
          nightTime: false,
          isPointExcluded: true,
          isAdvancedSurvey: false,
          processState: ProcessState.PROCESS_ENTER,
        },
        nowMs,
      ),
    ).toBe(false);

    // 2. 이미 종료된 세미나는 제외 (processState 7, 8 또는 seminarCompleted 1)
    expect(
      isSeminarEnterable(
        {
          seminarId: '102',
          name: '종료된 세미나',
          url: 'https://example.com/102',
          date: '2026-08-28',
          time: '12:00~13:00',
          currentCount: '10',
          totalCount: '100',
          nightTime: false,
          isAdvancedSurvey: false,
          processState: ProcessState.PROCESS_END,
        },
        nowMs,
      ),
    ).toBe(false);

    expect(
      isSeminarEnterable(
        {
          seminarId: '103',
          name: '완료된 세미나',
          url: 'https://example.com/103',
          date: '2026-08-28',
          time: '12:00~13:00',
          currentCount: '10',
          totalCount: '100',
          nightTime: false,
          isAdvancedSurvey: false,
          seminarCompleted: 1,
        },
        nowMs,
      ),
    ).toBe(false);

    // 3. 입장하기 상태(processState 1) 또는 진행중(processState 6) -> true
    expect(
      isSeminarEnterable(
        {
          seminarId: '104',
          name: '입장 가능 세미나',
          url: 'https://example.com/104',
          date: '2026-08-28',
          time: '12:00~13:00',
          currentCount: '10',
          totalCount: '100',
          nightTime: false,
          isAdvancedSurvey: false,
          processState: ProcessState.PROCESS_ENTER,
        },
        nowMs,
      ),
    ).toBe(true);

    expect(
      isSeminarEnterable(
        {
          seminarId: '105',
          name: '진행 중 세미나',
          url: 'https://example.com/105',
          date: '2026-08-28',
          time: '12:00~13:00',
          currentCount: '10',
          totalCount: '100',
          nightTime: false,
          isAdvancedSurvey: false,
          processState: ProcessState.PROCESS_STARTED,
        },
        nowMs,
      ),
    ).toBe(true);

    // 4. 시작 시간 도래 시 true (현재 12:30, 세미나 시작 12:00)
    expect(
      isSeminarEnterable(
        {
          seminarId: '106',
          name: '시간 도래 세미나',
          url: 'https://example.com/106',
          date: '2026-08-28',
          time: '12:00~13:00',
          currentCount: '10',
          totalCount: '100',
          nightTime: false,
          isAdvancedSurvey: false,
          processState: ProcessState.PROCESS_CANCEL, // 신청완료 상태
        },
        nowMs,
      ),
    ).toBe(true);

    // 5. 미래 시작 세미나 -> false (현재 12:30, 세미나 시작 13:00)
    expect(
      isSeminarEnterable(
        {
          seminarId: '107',
          name: '미래 시작 세미나',
          url: 'https://example.com/107',
          date: '2026-08-28',
          time: '13:00~14:00',
          currentCount: '10',
          totalCount: '100',
          nightTime: false,
          isAdvancedSurvey: false,
          processState: ProcessState.PROCESS_CANCEL,
        },
        nowMs,
      ),
    ).toBe(false);
  });

  it('isSeminarActiveOrEnded 판정 로직 검증 (다운타임 중 종료된 세미나 포함)', () => {
    const nowMs = new Date('2026-08-28T14:30:00+09:00').getTime();

    // 1. 이미 종료된 포인트 지급 세미나 -> true
    expect(
      isSeminarActiveOrEnded(
        {
          seminarId: '201',
          name: '다운 중 종료된 세미나',
          url: 'https://example.com/201',
          date: '2026-08-28',
          time: '12:00~13:00',
          currentCount: '10',
          totalCount: '100',
          nightTime: false,
          isAdvancedSurvey: false,
          processState: ProcessState.PROCESS_END,
        },
        nowMs,
      ),
    ).toBe(true);

    // 2. 포인트 미지급 종료 세미나 -> false
    expect(
      isSeminarActiveOrEnded(
        {
          seminarId: '202',
          name: '포인트 미지급 종료 세미나',
          url: 'https://example.com/202',
          date: '2026-08-28',
          time: '12:00~13:00',
          currentCount: '10',
          totalCount: '100',
          nightTime: false,
          isPointExcluded: true,
          isAdvancedSurvey: false,
          processState: ProcessState.PROCESS_END,
        },
        nowMs,
      ),
    ).toBe(false);
  });

  it('getSeminarPeriod 시간대 판정 검증', () => {
    expect(
      getSeminarPeriod({
        url: '',
        name: '',
        date: '2026-08-28',
        time: '12:00~13:00',
        currentCount: '0',
        totalCount: '0',
        nightTime: false,
        isAdvancedSurvey: false,
      }),
    ).toBe('점심');

    expect(
      getSeminarPeriod({
        url: '',
        name: '',
        date: '2026-08-28',
        time: '18:00~19:00',
        currentCount: '0',
        totalCount: '0',
        nightTime: true,
        isAdvancedSurvey: false,
      }),
    ).toBe('저녁');
  });

  it('checkAndTriggerSeminarMonitors가 입장 가능 세미나 감지 시 점심/저녁 모니터를 시작해야 한다', async () => {
    let _lunchRan = false;
    let _dinnerRan = false;

    taskRegistry.registerTask({
      name: 'monitor_lunch_seminars',
      run: async () => {
        _lunchRan = true;
        return true;
      },
    });

    taskRegistry.registerTask({
      name: 'monitor_dinner_seminars',
      run: async () => {
        _dinnerRan = true;
        return true;
      },
    });

    const mockSeminars: SeminarListItem[] = [
      {
        seminarId: '301',
        name: '점심 라이브 세미나',
        url: 'https://example.com/301',
        date: '2026-08-28',
        time: '12:30~13:30',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
        processState: ProcessState.PROCESS_ENTER, // 입장가능
      },
      {
        seminarId: '302',
        name: '저녁 미래 세미나',
        url: 'https://example.com/302',
        date: '2026-08-28',
        time: '19:00~20:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: true,
        isAdvancedSurvey: false,
        processState: ProcessState.PROCESS_CANCEL, // 아직 미시작
      },
    ];

    const testNow = new Date('2026-08-28T12:30:00+09:00');
    const result = await checkAndTriggerSeminarMonitors(mockSeminars, { now: testNow, targetDate: '2026-08-28' });

    expect(result.triggeredLunch).toBe(true);
    expect(result.triggeredDinner).toBe(false);
  });

  it('이미 공지방에 모두 종료 공지가 나갔거나 이미 실행 중인 경우 트리거하지 않아야 한다', async () => {
    taskRegistry.registerTask({
      name: 'monitor_lunch_seminars',
      run: async () => true,
    });

    // 1. 이미 모두 종료 공지가 나간 경우
    channelRepo.recordChannelMessage({
      channelId: 'test_chan',
      messageId: 501,
      date: '2026-08-28',
      text: '🔔 점심세미나\n\n🟢 종료 | 세미나1\n\n🏁 점심세미나가 모두 종료되었습니다.',
    });

    const mockSeminars: SeminarListItem[] = [
      {
        seminarId: '401',
        name: '점심 세미나',
        url: 'https://example.com/401',
        date: '2026-08-28',
        time: '12:30~13:30',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isAdvancedSurvey: false,
        processState: ProcessState.PROCESS_END,
      },
    ];

    const testNow = new Date('2026-08-28T13:00:00+09:00');
    const resCompleted = await checkAndTriggerSeminarMonitors(mockSeminars, {
      now: testNow,
      targetDate: '2026-08-28',
    });
    expect(resCompleted.triggeredLunch).toBe(false);

    // 2. 이미 태스크가 락(실행 중)인 경우
    storage.clear();
    storage.set('lock:monitor_lunch_seminars', { owner: process.pid, ts: Date.now() });
    expect(isTaskRunning('monitor_lunch_seminars')).toBe(true);

    const resRunning = await checkAndTriggerSeminarMonitors(mockSeminars, {
      now: testNow,
      targetDate: '2026-08-28',
    });
    expect(resRunning.triggeredLunch).toBe(false);
  });
});
