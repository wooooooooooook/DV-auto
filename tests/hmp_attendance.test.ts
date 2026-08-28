import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HmpClient, type HmpAttendanceWorkflowResult } from '../src/modules/hmp_api';
import { formatHmpAttendanceMessage, run as runHmpAttendance } from '../src/tasks/hmp_attendance';

describe('HMP Attendance & Capsules Workflow Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('출석 완료 및 캡슐 보유 현황 메시지 포맷팅 테스트 (성공 시)', () => {
    const mockResult: HmpAttendanceWorkflowResult = {
      success: true,
      userInfo: {
        memId: 'test_user',
        nick: '닥터홍',
        gradNm: '전공의',
        remanGradPnt: 120,
        capsules: 5010,
        chrPnt: 5010,
        usePnt: 0,
      },
      attendance: {
        status: 'SUCCESS',
        point: 10,
        message: '출석 캡슐 받기 완료 (+10 캡슐)',
      },
      loginCount: 5,
    };

    const formatted = formatHmpAttendanceMessage(mockResult);

    expect(formatted).toContain('💊 [HMP 출석체크 & 캡슐 현황]');
    expect(formatted).toContain('닥터홍 [전공의]');
    expect(formatted).toContain('✅ 출석 완료 (+10 캡슐) (당월 연속 출석: 5일)');
    expect(formatted).toContain('5,010 캡슐');
  });

  it('이미 오늘 출석한 경우 메시지 포맷팅 테스트', () => {
    const mockResult: HmpAttendanceWorkflowResult = {
      success: true,
      userInfo: {
        memId: 'test_user',
        nick: '김의사',
        gradNm: '인턴',
        capsules: 5010,
      },
      attendance: {
        status: 'ALREADY',
        message: '오늘 이미 출석 캡슐을 수령했습니다.',
      },
      loginCount: 1,
    };

    const formatted = formatHmpAttendanceMessage(mockResult);

    expect(formatted).toContain('ℹ️ 이미 오늘 출석 캡슐 수령 완료 (당월 연속 출석: 1일)');
    expect(formatted).toContain('5,010 캡슐');
  });

  it('출석체크 실패 시 에러 메시지 포맷팅 테스트', () => {
    const mockResult: HmpAttendanceWorkflowResult = {
      success: false,
      message: '네트워크 연결 오류',
      attendance: {
        status: 'FAILED',
        message: '네트워크 연결 오류',
      },
    };

    const formatted = formatHmpAttendanceMessage(mockResult);

    expect(formatted).toContain('❌ [HMP 출석체크 실패]');
    expect(formatted).toContain('네트워크 연결 오류');
  });

  it('HmpClient API 워크플로우 정상 실행 (성공 케이스 목 테스트)', async () => {
    const client = new HmpClient();

    // Mock login
    vi.spyOn(client, 'login').mockResolvedValue(true);

    // Mock getAttendanceInfo (미출석 상태)
    vi.spyOn(client, 'getAttendanceInfo').mockResolvedValue({
      cntntCd: '09',
      cntntSeq: '6712',
      pointTitle: '출석 체크 룰렛 이벤트',
      bizGbn: '009',
      loginCount: 3,
      isAlreadyAttended: false,
    });

    // Mock submitAttendance
    vi.spyOn(client, 'submitAttendance').mockResolvedValue({
      status: 'SUCCESS',
      point: 10,
      message: '출석 캡슐 받기 완료 (+10 캡슐)',
    });

    // Mock getUserInfo
    vi.spyOn(client, 'getUserInfo').mockResolvedValue({
      memId: 'nubiz',
      nick: 'woooook',
      gradNm: '인턴',
      capsules: 5010,
    });

    const result = await client.runAttendanceWorkflow('user', 'pass');

    expect(result.success).toBe(true);
    expect(result.attendance.status).toBe('SUCCESS');
    expect(result.attendance.point).toBe(10);
    expect(result.userInfo?.capsules).toBe(5010);
    expect(result.loginCount).toBe(3);
  });

  it('HmpClient API 워크플로우 이미 출석된 경우 (중복 요청 방지)', async () => {
    const client = new HmpClient();

    vi.spyOn(client, 'login').mockResolvedValue(true);

    // 이미 출석 완료 상태
    vi.spyOn(client, 'getAttendanceInfo').mockResolvedValue({
      cntntCd: '09',
      cntntSeq: '6712',
      pointTitle: '출석 체크 룰렛 이벤트',
      bizGbn: '009',
      loginCount: 3,
      isAlreadyAttended: true,
    });

    const submitSpy = vi.spyOn(client, 'submitAttendance');

    vi.spyOn(client, 'getUserInfo').mockResolvedValue({
      memId: 'nubiz',
      nick: 'woooook',
      gradNm: '인턴',
      capsules: 5010,
    });

    const result = await client.runAttendanceWorkflow('user', 'pass');

    expect(result.success).toBe(true);
    expect(result.attendance.status).toBe('ALREADY');
    expect(submitSpy).not.toHaveBeenCalled();
    expect(result.userInfo?.capsules).toBe(5010);
  });

  it('run 태스크 실행 시 정상 결과 반환 검증', async () => {
    vi.spyOn(HmpClient.prototype, 'runAttendanceWorkflow').mockResolvedValue({
      success: true,
      userInfo: {
        memId: 'test_user',
        nick: '테스터',
        gradNm: '전문의',
        capsules: 6000,
      },
      attendance: {
        status: 'SUCCESS',
        point: 10,
        message: '출석 캡슐 받기 완료 (+10 캡슐)',
      },
      loginCount: 10,
    });

    const taskResult = await runHmpAttendance();

    expect(taskResult.success).toBe(true);
    expect(taskResult.message).toContain('💊 [HMP 출석체크 & 캡슐 현황]');
    expect(taskResult.message).toContain('테스터 [전문의]');
  });
});
