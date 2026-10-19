import { describe, it, beforeEach, vi, expect } from 'vitest';
import * as seminarRepo from '../src/services/seminar_repository';
import type { SeminarListItem } from '../src/services/seminar_repository';
import {
  run as runCheckAdvancedSeminars,
  clearCache as clearAdvancedSeminarsCache,
} from '../src/tasks/check_advanced_seminars';
import { refreshSeminarPointStatus } from '../src/services/seminar_point_sync';
import { syncSeminarPointResultToDb } from '../src/tasks/check_seminar_point';
import * as checkSeminarPointModule from '../src/tasks/check_seminar_point';
import {
  getSeminarInfoChanges,
  formatSeminarChangeNotification,
  type SeminarInfoChange,
} from '../src/tasks/apply_seminar_notice';
import { refreshStoredSeminarList, isSeminarInPast } from '../src/tasks/apply_seminar';

describe('심화세미나가 아닌 세미나의 포인트 지급 확인 시 심화세미나 변경 및 알림 제외 테스트', () => {
  beforeEach(() => {
    seminarRepo.clearSeminars();
    clearAdvancedSeminarsCache();
    vi.restoreAllMocks();
  });

  it('1. mergeSeminarRecord: pointPaid가 true인 경우 isAdvancedSurvey가 항상 true로 설정/유지되어야 한다', () => {
    const existing: SeminarListItem = {
      seminarId: '9001',
      name: '일반 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/9001',
      date: '2026-10-14',
      time: '19:00',
      currentCount: '10',
      totalCount: '100',
      nightTime: false,
      isAdvancedSurvey: false,
      pointPaid: true,
      point: 3000,
    };

    // incoming에 isAdvancedSurvey가 false로 들어와도 pointPaid가 true이므로 true 유지
    const incoming: SeminarListItem = {
      ...existing,
      name: '일반 세미나 (이름 변경)',
      isAdvancedSurvey: false,
    };

    const merged = seminarRepo.mergeSeminarRecord(existing, incoming);
    expect(merged.isAdvancedSurvey).toBe(true);
    expect(merged.pointPaid).toBe(true);

    // 신규 세미나인 경우에도 pointPaid가 true이면 isAdvancedSurvey는 true
    const newPaid: SeminarListItem = {
      seminarId: '9002',
      name: '신규 포인트 지급 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/9002',
      date: '2026-10-14',
      time: '19:00',
      currentCount: '10',
      totalCount: '100',
      nightTime: false,
      isAdvancedSurvey: false,
      pointPaid: true,
    };
    const mergedNew = seminarRepo.mergeSeminarRecord(undefined, newPaid);
    expect(mergedNew.isAdvancedSurvey).toBe(true);
  });

  it('2. updateSeminarPointStatus: 포인트 지급(pointPaid=true) 시 is_advanced_survey가 1(true)로 갱신되어야 한다', async () => {
    // 초기 세미나: isAdvancedSurvey = false
    const initial = seminarRepo.upsertSeminar({
      seminarId: '9003',
      name: '비심화 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/9003',
      date: '2026-10-14',
      time: '19:00',
      currentCount: '10',
      totalCount: '100',
      nightTime: false,
      isAdvancedSurvey: false,
      pointPaid: false,
    });
    expect(initial.isAdvancedSurvey).toBe(false);

    // 포인트 지급 상태로 갱신
    const updated = await seminarRepo.updateSeminarPointStatus('9003', {
      pointPaid: true,
      point: 3000,
      pointText: '3,000P',
      pointDate: '2026-10-15',
    });

    expect(updated.pointPaid).toBe(true);
    expect(updated.isAdvancedSurvey).toBe(true);

    // DB에서 재조회하여 검증
    const inDb = seminarRepo.getSeminarById('9003');
    expect(inDb?.pointPaid).toBe(true);
    expect(inDb?.isAdvancedSurvey).toBe(true);
  });

  it('3. syncSeminarPointResultToDb: 적립 확인 시 심화세미나로 변경되고 check_advanced_seminars에 반영되어야 한다', async () => {
    // 최근 날짜 세미나 (2주 이내)
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    seminarRepo.upsertSeminar({
      seminarId: '9004',
      name: '일반 설문 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/9004',
      date: today,
      time: '19:00',
      currentCount: '50',
      totalCount: '500',
      nightTime: false,
      isAdvancedSurvey: false,
      pointPaid: false,
    });

    // 포인트 적립 확인 동기화
    const syncRes = await syncSeminarPointResultToDb('9004', {
      found: true,
      type: '적립',
      point: 3000,
      pointText: '3,000P',
      date: today,
      content: '설문 포인트 9004',
    });

    expect(syncRes.updated).toBe(true);
    expect(syncRes.pointPaid).toBe(true);

    // DB 확인: isAdvancedSurvey가 true여야 함
    const stored = seminarRepo.getSeminarById('9004');
    expect(stored?.isAdvancedSurvey).toBe(true);
    expect(stored?.pointPaid).toBe(true);

    // check_advanced_seminars 실행 시 해당 세미나가 조회되어야 함
    const advResult = runCheckAdvancedSeminars();
    expect(advResult.success).toBe(true);
    expect(advResult.message).toContain('9004');
    expect(advResult.message).toContain('3,000P 지급됨');
  });

  it('4. refreshSeminarPointStatus: 미심화 세미나에 포인트 지급 확인 시 심화세미나로 변경되어야 한다', async () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const sem: SeminarListItem = {
      seminarId: '9005',
      name: '미심화 세미나 9005',
      url: 'https://m.doctorville.co.kr/cme/seminar/9005',
      date: today,
      time: '20:00',
      currentCount: '10',
      totalCount: '200',
      nightTime: false,
      isAdvancedSurvey: false,
      pointPaid: false,
    };
    seminarRepo.upsertSeminar(sem);

    // searchSeminarPoints 모킹
    vi.spyOn(checkSeminarPointModule, 'searchSeminarPoints').mockResolvedValue({
      success: true,
      points: new Map([
        [
          '9005',
          {
            found: true,
            type: '적립',
            point: 2000,
            pointText: '2,000P',
            date: today,
            content: '설문 포인트 9005',
          },
        ],
      ]),
    });

    const res = await refreshSeminarPointStatus(undefined, [sem]);
    expect(res.pointChanges.length).toBe(1);
    expect(res.pointChanges[0].seminarId).toBe('9005');

    const updated = res.seminars.find((s) => s.seminarId === '9005');
    expect(updated?.pointPaid).toBe(true);
    expect(updated?.isAdvancedSurvey).toBe(true);

    // DB 확인
    const inDb = seminarRepo.getSeminarById('9005');
    expect(inDb?.isAdvancedSurvey).toBe(true);

    // check_advanced_seminars 조회 확인
    const advRes = runCheckAdvancedSeminars();
    expect(advRes.success).toBe(true);
    expect(advRes.message).toContain('9005');
    expect(advRes.message).toContain('2,000P 지급됨');
  });

  it('5. 알림 제외 검증: 포인트 지급으로 심화세미나로 변경될 때 정보 변경 알림(isAdvancedSurvey)이 발송되지 않아야 한다', () => {
    const semBefore: SeminarListItem = {
      seminarId: '9006',
      name: '알림 제외 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/9006',
      date: '2026-10-20',
      time: '20:00',
      currentCount: '10',
      totalCount: '200',
      nightTime: false,
      isAdvancedSurvey: false,
      pointPaid: false,
    };

    // 포인트 지급으로 인해 isAdvancedSurvey가 true로 변경된 경우
    const semAfterPaid: SeminarListItem = {
      ...semBefore,
      pointPaid: true,
      point: 3000,
      isAdvancedSurvey: true,
    };

    const changes = getSeminarInfoChanges(semBefore, semAfterPaid);
    const advChange = changes.find((c) => c.field === 'isAdvancedSurvey');
    expect(advChange).toBeUndefined(); // 심화설문 변경 알림 제외!
  });

  it('6. 알림 제외 검증: 이미 지나간 세미나(isSeminarInPast)의 정보 변경은 알림(infoChanges)에서 제외되어야 한다', () => {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

    // 어제 세미나 (명백히 과거 세미나)
    const pastSeminarExisting: SeminarListItem = {
      seminarId: '9007',
      name: '어제 끝난 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/9007',
      date: '2026-10-01',
      time: '19:00~20:00',
      currentCount: '100',
      totalCount: '500',
      nightTime: false,
      isAdvancedSurvey: false,
      pointPaid: false,
    };

    const pastSeminarIncoming: SeminarListItem = {
      ...pastSeminarExisting,
      totalCount: '600', // 정원 변경
      isAdvancedSurvey: true, // 심화설문 변경
    };

    expect(isSeminarInPast(pastSeminarExisting, today)).toBe(true);

    // refreshStoredSeminarList 실행 시 이미 지나간 세미나는 infoChanges에 포함되지 않아야 함
    const { infoChanges, updatedSeminars } = refreshStoredSeminarList(
      [pastSeminarIncoming],
      [pastSeminarExisting],
      today,
    );

    expect(infoChanges.length).toBe(0); // 알림 제외!
    expect(updatedSeminars.length).toBe(1); // DB는 업데이트됨
  });

  it('7. formatSeminarChangeNotification: 이미 지나간 세미나의 infoChanges는 포맷팅 단계에서도 제외되어야 한다', () => {
    const pastInfoChange: SeminarInfoChange = {
      seminarId: '9008',
      name: '지나간 세미나',
      date: '2026-10-01',
      changes: [
        {
          field: 'totalCount',
          label: '총원',
          oldValue: '500',
          newValue: '600',
        },
      ],
    };

    const formatted = formatSeminarChangeNotification([pastInfoChange], [], { filterPast: true });
    expect(formatted).toBeNull(); // 이미 지나간 세미나이므로 알림 메시지가 생성되지 않아야 함
  });
});
