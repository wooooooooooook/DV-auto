import assert from 'node:assert';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as checkSeminarPointModule from '../src/tasks/check_seminar_point';
import * as checkAdvancedSeminarsModule from '../src/tasks/check_advanced_seminars';
import { refreshSeminarPointStatus, type SeminarListItem } from '../src/tasks/apply_seminar';
import * as seminarRepo from '../src/services/seminar_repository';
import { describe, it, vi } from 'vitest';

describe('Point-Only 세미나 발견 시 세미나 상세 API 연동 테스트', () => {
  it('포인트 테이블 세미나 상세 API 연동 종합 테스트', async () => {
    console.log('===========================================================');
    console.log('  Point-Only 세미나 발견 시 세미나 상세 API 연동 테스트');
    console.log('===========================================================\n');

    // 테스트 종료 후 복구를 위한 storage 백업
    const originalStoredList = seminarRepo.getAllSeminars();

    try {
      // 1. 포인트 테이블에만 존재하는 심화 세미나 (ID: 5999) 및 일반 세미나 (ID: 5888)
      const mockPointHistory = new Map<string, checkSeminarPointModule.SeminarPointResult>([
        [
          '5999',
          {
            found: true,
            point: 5000,
            pointText: '5,000P',
            date: '2026-08-20',
            content: '8/20 설문 포인트 5999',
            type: '적립',
          },
        ],
        [
          '5888',
          {
            found: true,
            point: 1000,
            pointText: '1,000P',
            date: '2026-08-21',
            content: '8/21 설문 포인트 5888',
            type: '적립',
          },
        ],
        [
          '5777',
          {
            found: true,
            point: 2000,
            pointText: '2,000P',
            date: '2026-08-22',
            content: '8/22 설문 포인트 5777',
            type: '적립',
          },
        ],
      ]);

      vi.spyOn(checkSeminarPointModule, 'searchSeminarPoints').mockResolvedValue({
        success: true,
        points: mockPointHistory,
      });

      // 세미나 상세 API Mocking
      vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockImplementation(async (seminarId: string | number) => {
        const sid = String(seminarId);
        if (sid === '5999') {
          return {
            success: true,
            seminarId: '5999',
            hasEntryHistory: false,
            isPointExcluded: false,
            rawResponse: {
              code: 200,
              seminarDetail: {
                seminarId: 5999,
                seminarNm: '당뇨병 최신 지견 심화 세미나',
                startDt: '2026-08-20 13:00:00',
                endDt: '2026-08-20 14:00:00',
                useDepthSurvey: 'Y',
                useSurvey: 'Y',
                applyCnt: 85,
                maxPeopleCnt: 100,
                processState: 8,
                cancelProcessState: 0,
                seminarCompleted: 1,
                createDt: '2026-08-10 09:00:00',
                survey: {
                  point: 5000,
                  surveyId: 1234,
                },
              },
            },
          };
        }

        if (sid === '5888') {
          return {
            success: true,
            seminarId: '5888',
            hasEntryHistory: false,
            isPointExcluded: false,
            rawResponse: {
              code: 200,
              seminarDetail: {
                seminarId: 5888,
                seminarNm: '고혈압 가이드라인 세미나',
                startDt: '2026-08-21 19:00:00',
                endDt: '2026-08-21 20:00:00',
                useDepthSurvey: 'N',
                useSurvey: 'Y',
                applyCnt: 50,
                maxPeopleCnt: 200,
                processState: 8,
                cancelProcessState: 0,
                seminarCompleted: 1,
                createDt: '2026-08-11 10:00:00',
                survey: {
                  point: 1000,
                  surveyId: 1235,
                },
              },
            },
          };
        }

        // 5777: 상세 API 조회 실패 케이스 (fallback 검증)
        return {
          success: false,
          seminarId: '5777',
          isAuthExpired: false,
          errorMessage: '세미나 정보를 찾을 수 없습니다.',
        };
      });

      // 기존 세미나 목록: 5888(이름/날짜가 비어있는 기존 세미나), 5001(일반 기존 세미나)
      const initialSeminars: SeminarListItem[] = [
        {
          seminarId: '5888',
          name: '',
          url: 'https://m.doctorville.co.kr/cme/seminar/5888',
          date: '',
          time: '',
          currentCount: '',
          totalCount: '',
          nightTime: false,
          isAdvancedSurvey: false,
        },
        {
          seminarId: '5001',
          name: '5001 기존 정상 세미나',
          url: 'https://m.doctorville.co.kr/cme/seminar/5001',
          date: '2026-08-22',
          time: '13:00~14:00',
          currentCount: '10',
          totalCount: '100',
          nightTime: false,
          isAdvancedSurvey: true,
          pointPaid: false,
        },
      ];

      console.log('--- Case 1: Point-only 신규 세미나 추가 시 detail API로 정보 채우기 검증 ---');
      const { seminars: updated, pointChanges } = await refreshSeminarPointStatus(undefined, initialSeminars);

      const sem5999 = updated.find((s) => s.seminarId === '5999');
      assert(sem5999 !== undefined, '5999 세미나가 seminar_list에 추가되어야 함');
      assert.strictEqual(sem5999.name, '당뇨병 최신 지견 심화 세미나', '세미나 이름이 detail API에서 채워져야 함');
      assert.strictEqual(sem5999.date, '2026-08-20', '세미나 일자가 startDt에서 추출되어야 함');
      assert.strictEqual(sem5999.time, '13:00~14:00', '세미나 시간이 startDt/endDt에서 추출되어야 함');
      assert.strictEqual(sem5999.nightTime, false, '13시는 주간 세미나');
      assert.strictEqual(sem5999.isAdvancedSurvey, true, 'useDepthSurvey Y -> isAdvancedSurvey true');
      assert.strictEqual(sem5999.isPointExcluded, false);
      assert.strictEqual(sem5999.currentCount, '85');
      assert.strictEqual(sem5999.totalCount, '100');
      assert.strictEqual(sem5999.pointPaid, true);
      assert.strictEqual(sem5999.point, 5000);
      assert.strictEqual(sem5999.detectedDate, '2026-08-20', 'detectedDate가 세미나 일자로 설정되어야 함');
      console.log('  ✓ [Pass] Point-only 신규 세미나(5999)에 detail API 정보 정상 반영 확인\n');

      console.log('--- Case 2: 기존 비어있던 세미나(5888) 메타데이터 보강 검증 ---');
      const sem5888 = updated.find((s) => s.seminarId === '5888');
      assert(sem5888 !== undefined);
      assert.strictEqual(sem5888.name, '고혈압 가이드라인 세미나', '기존 빈 세미나의 이름이 보강되어야 함');
      assert.strictEqual(sem5888.date, '2026-08-21', '일자가 보강되어야 함');
      assert.strictEqual(sem5888.time, '19:00~20:00');
      assert.strictEqual(sem5888.nightTime, true, '19시는 야간 세미나');
      assert.strictEqual(sem5888.isAdvancedSurvey, false);
      assert.strictEqual(sem5888.pointPaid, true);
      console.log('  ✓ [Pass] 기존 비어있던 세미나(5888) 메타데이터 보강 확인\n');

      console.log('--- Case 3: detail API 조회 실패 세미나(5777) fallback 안전성 검증 ---');
      const sem5777 = updated.find((s) => s.seminarId === '5777');
      assert(sem5777 !== undefined);
      assert.strictEqual(sem5777.name, '', '실패 시 기본값 빈 문자열 유지');
      assert.strictEqual(sem5777.pointPaid, true);
      assert.strictEqual(sem5777.point, 2000);
      console.log('  ✓ [Pass] detail API 실패 시에도 기본값으로 안전하게 세미나 추가 확인\n');

      console.log('--- Case 4: check_advanced_seminars 조회 연동 검증 ---');
      // storage에 저장된 updated 세미나 목록으로 check_advanced_seminars 실행
      seminarRepo.setAllSeminars(updated);
      const checkResult = checkAdvancedSeminarsModule.run();
      assert.strictEqual(checkResult.success, true);
      assert(
        checkResult.message.includes('당뇨병 최신 지견') && checkResult.message.includes('5999'),
        '5999 심화 세미나가 check_advanced_seminars 목록에 포함되어야 함',
      );
      assert(checkResult.message.includes('5,000P 지급됨'), '5999 심화 세미나의 포인트 지급 상태가 표기되어야 함');
      console.log('  ✓ [Pass] check_advanced_seminars에서 point-only 심화 세미나 정상 조회 확인\n');

      console.log('--- Case 5: pointChanges 이벤트 알림 발생 검증 ---');
      assert(pointChanges.some((p) => p.seminarId === '5999' && p.point === 5000));
      assert(pointChanges.some((p) => p.seminarId === '5888' && p.point === 1000));
      assert(pointChanges.some((p) => p.seminarId === '5777' && p.point === 2000));
      console.log('  ✓ [Pass] 신규 포인트 지급 변경 내역 정상 기록 확인\n');

      console.log('🎉 Point-Only 세미나 detail API 연동 테스트 모두 성공!\n');
    } finally {
      vi.restoreAllMocks();
      if (originalStoredList !== undefined) {
        seminarRepo.setAllSeminars(originalStoredList);
      }
    }
  });
});
