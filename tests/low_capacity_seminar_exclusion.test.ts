import { describe, it, expect } from 'vitest';
import { isLowCapacitySeminar, MIN_SEMINAR_CAPACITY } from '../src/modules/seminar_api';
import { isEligibleApplyTarget } from '../src/tasks/apply_seminar';
import { buildNewSeminarsNoticeMessage, getSeminarInfoChanges } from '../src/tasks/apply_seminar_notice';
import { buildSeminarStatusMessage, type MonitoredSeminarItem } from '../src/tasks/monitor_seminars_notice';
import { matchesNewSeminarFilter } from '../src/services/subscription_service';
import { handleNewSeminarFromDetail } from '../src/tasks/seminar_detail';
import type { SeminarListItem } from '../src/services/seminar_repository';

describe('정원 100명 미만 세미나 제외 및 무시 처리 (isLowCapacitySeminar)', () => {
  it('MIN_SEMINAR_CAPACITY는 100이어야 함', () => {
    expect(MIN_SEMINAR_CAPACITY).toBe(100);
  });

  it('maxPeopleCnt 또는 totalCount가 100 미만인 세미나를 정확히 판별해야 함', () => {
    // 100명 미만 케이스 (리뷰용, 테스트용)
    expect(isLowCapacitySeminar({ maxPeopleCnt: 3 })).toBe(true);
    expect(isLowCapacitySeminar({ maxPeopleCnt: '3' })).toBe(true);
    expect(isLowCapacitySeminar({ maxPeopleCnt: 99 })).toBe(true);
    expect(isLowCapacitySeminar({ totalCount: '3' })).toBe(true);
    expect(isLowCapacitySeminar({ totalCount: '99' })).toBe(true);
    expect(isLowCapacitySeminar({ maxPeopleCnt: 3, totalCount: '3' })).toBe(true);

    // 100명 이상 케이스 (정상 세미나)
    expect(isLowCapacitySeminar({ maxPeopleCnt: 100 })).toBe(false);
    expect(isLowCapacitySeminar({ maxPeopleCnt: 500 })).toBe(false);
    expect(isLowCapacitySeminar({ maxPeopleCnt: 3000 })).toBe(false);
    expect(isLowCapacitySeminar({ totalCount: '100' })).toBe(false);
    expect(isLowCapacitySeminar({ totalCount: '3000' })).toBe(false);
    expect(isLowCapacitySeminar({ maxPeopleCnt: 3000, totalCount: '3000' })).toBe(false);

    // 정보가 없는 경우 false
    expect(isLowCapacitySeminar(null)).toBe(false);
    expect(isLowCapacitySeminar(undefined)).toBe(false);
    expect(isLowCapacitySeminar({})).toBe(false);
  });

  it('isEligibleApplyTarget: 정원 100명 미만 세미나는 자동 신청 대상에서 제외되어야 함', () => {
    const lowCapSeminar = {
      seminarId: '5654',
      processState: 2, // PROCESS_APPLY
      maxPeopleCnt: 3,
      totalCount: '3',
      isClosed: false,
      hiddenYn: 'Y',
    };
    expect(isEligibleApplyTarget(lowCapSeminar, { newlyAddedIds: new Set(['5654']) })).toBe(false);

    const normalSeminar = {
      seminarId: '5655',
      processState: 2,
      maxPeopleCnt: 3000,
      totalCount: '3000',
      isClosed: false,
      hiddenYn: 'N',
    };
    expect(isEligibleApplyTarget(normalSeminar)).toBe(true);
  });

  it('buildNewSeminarsNoticeMessage: 정원 100명 미만 세미나는 신규 공지 메시지에서 제외되어야 함', () => {
    const seminars: SeminarListItem[] = [
      {
        seminarId: '5654',
        name: '(리뷰용) 단계적으로 치료하는 개원가 천식 관리',
        url: 'https://m.doctorville.co.kr/cme/seminar/5654',
        totalCount: '3',
        currentCount: '1',
        time: '12:30~13:30',
        nightTime: false,
        isAdvancedSurvey: false,
      },
      {
        seminarId: '5655',
        name: '정상 학술 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/5655',
        totalCount: '3000',
        currentCount: '100',
        time: '19:00~20:00',
        nightTime: true,
        isAdvancedSurvey: false,
      },
    ];

    const { text } = buildNewSeminarsNoticeMessage(seminars);
    expect(text).toContain('정상 학술 세미나');
    expect(text).not.toContain('(리뷰용)');
    expect(text).not.toContain('5654');
    expect(text).toContain('누적 1건');
  });

  it('getSeminarInfoChanges: 정원 100명 미만 세미나는 정보 변경 알림에서 제외되어야 함', () => {
    const existing: SeminarListItem = {
      seminarId: '5654',
      name: '리뷰용 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/5654',
      totalCount: '3',
      currentCount: '1',
      time: '12:30~13:30',
      nightTime: false,
      isAdvancedSurvey: false,
    };
    const incoming: SeminarListItem = {
      ...existing,
      time: '13:00~14:00', // 시간 변경
    };

    const changes = getSeminarInfoChanges(existing, incoming);
    expect(changes).toEqual([]);
  });

  it('buildSeminarStatusMessage: 정원 100명 미만 세미나는 모니터링 현황 메시지에서 제외되어야 함', () => {
    const seminars: MonitoredSeminarItem[] = [
      {
        seminarId: '5654',
        name: '(리뷰용) 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/5654',
        totalCount: '3',
        status: '대기',
        time: '12:30~13:30',
      },
      {
        seminarId: '5655',
        name: '정상 점심 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/5655',
        totalCount: '3000',
        status: '입장가능',
        time: '12:30~13:30',
      },
    ];

    const { text } = buildSeminarStatusMessage('점심', seminars);
    expect(text).toContain('정상 점심 세미나');
    expect(text).not.toContain('(리뷰용)');
    expect(text).not.toContain('5654');
  });

  it('matchesNewSeminarFilter: 100명 미만 세미나는 모든 필터에서 false여야 함', () => {
    const lowCap = { currentCount: '1', totalCount: '3', isPointExcluded: false };
    expect(matchesNewSeminarFilter('all', lowCap)).toBe(false);
    expect(matchesNewSeminarFilter('limit_5000', lowCap)).toBe(false);
    expect(matchesNewSeminarFilter('limit_3000', lowCap)).toBe(false);
    expect(matchesNewSeminarFilter('urgent_1000', lowCap)).toBe(false);

    const normal = { currentCount: '100', totalCount: '3000', isPointExcluded: false };
    expect(matchesNewSeminarFilter('all', normal)).toBe(true);
    expect(matchesNewSeminarFilter('limit_3000', normal)).toBe(true);
  });

  it('handleNewSeminarFromDetail: 정원 100명 미만 세미나는 신규 발견 시에도 알림 및 자동 신청이 실행되지 않아야 함', async () => {
    const item: SeminarListItem = {
      seminarId: '5654',
      name: '(리뷰용) 단계적으로 치료하는 개원가 천식 관리',
      url: 'https://m.doctorville.co.kr/cme/seminar/5654',
      totalCount: '3',
      currentCount: '1',
      time: '12:30~13:30',
      nightTime: false,
      isAdvancedSurvey: false,
      processState: 2, // PROCESS_APPLY
    };

    const result = await handleNewSeminarFromDetail(item);
    expect(result.notified).toBe(false);
    expect(result.applied).toBe(false);
  });
});
