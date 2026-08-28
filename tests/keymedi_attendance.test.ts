import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeymediClient, type KeymediAttendanceWorkflowResult } from '../src/modules/keymedi_api';
import { formatKeymediAttendanceMessage, run as runKeymediAttendance } from '../src/tasks/keymedi_attendance';
import * as utils from '../src/modules/utils';

describe('Keymedi Attendance & Points Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('출석 완료 및 포인트 현황 메시지 포맷팅 테스트 (신규 출석 성공)', () => {
    const mockResult: KeymediAttendanceWorkflowResult = {
      success: true,
      member: {
        idx: 84460,
        uid: 'nubiz',
        name: '김영욱',
      },
      attendance: {
        status: 'SUCCESS',
        point: 100,
        message: '출석 성공 (+100P)',
      },
      calendar: {
        current_date: '2026-08-28',
        count_attendance: 2,
        attendance: [
          { point: 100, day: 27, accumulate: 1 },
          { point: 100, day: 28, accumulate: 2 },
        ],
      },
      pointBalance: 2200,
      totalPoint: 2200,
      message: '출석 성공 (+100P)',
    };

    const formatted = formatKeymediAttendanceMessage(mockResult);
    expect(formatted).toContain('📋 [키메디 출석체크 & 포인트 현황]');
    expect(formatted).toContain('👤 회원: 김영욱 (nubiz)');
    expect(formatted).toContain('📌 출석: ✅ 출석 완료 (+100P)');
    expect(formatted).toContain('💰 보유 포인트: 2,200 P (당월 누적 출석: 2일)');
  });

  it('출석 완료 및 포인트 현황 메시지 포맷팅 테스트 (이미 오늘 출석 완료)', () => {
    const mockResult: KeymediAttendanceWorkflowResult = {
      success: true,
      member: {
        idx: 84460,
        uid: 'nubiz',
        name: '김영욱',
      },
      attendance: {
        status: 'ALREADY',
        message: '이미 오늘 출석체크가 완료되었습니다.',
      },
      calendar: {
        current_date: '2026-08-28',
        count_attendance: 5,
        attendance: [],
      },
      pointBalance: 3500,
      totalPoint: 3500,
      message: '이미 오늘 출석체크가 완료되었습니다.',
    };

    const formatted = formatKeymediAttendanceMessage(mockResult);
    expect(formatted).toContain('📌 출석: ℹ️ 이미 오늘 출석 완료');
    expect(formatted).toContain('💰 보유 포인트: 3,500 P (당월 누적 출석: 5일)');
  });

  it('로그인 또는 출석 실패 시 메시지 포맷팅 테스트', () => {
    const mockResult: KeymediAttendanceWorkflowResult = {
      success: false,
      attendance: {
        status: 'FAILED',
        message: '아이디 또는 비밀번호를 다시 확인해주세요.',
      },
      pointBalance: 0,
      totalPoint: 0,
      message: '키메디 로그인에 실패했습니다 (아이디 또는 비밀번호를 다시 확인해주세요.)',
    };

    const formatted = formatKeymediAttendanceMessage(mockResult);
    expect(formatted).toContain('❌ [키메디 출석체크 실패]');
    expect(formatted).toContain('⚠️ 사유: 키메디 로그인에 실패했습니다');
  });

  it('KeymediClient API 모킹 테스트 및 executeAttendanceAndPoints 흐름 검증', async () => {
    const client = new KeymediClient();

    // Mock client methods
    vi.spyOn(client, 'login').mockResolvedValue({
      success: true,
      code: 0,
      message: 'ok',
      accessToken: 'mock_token',
      member: { idx: 123, uid: 'testuser', name: '홍길동' },
    });

    vi.spyOn(client, 'addAttendance').mockResolvedValue({
      status: 'SUCCESS',
      point: 100,
      message: '출석 성공 (+100P)',
      rawCode: 0,
    });

    vi.spyOn(client, 'getMyInfo').mockResolvedValue({
      idx: 123,
      uid: 'testuser',
      name: '홍길동',
      point_balance: 1500,
      total_point: 1500,
    });

    vi.spyOn(client, 'getAttendanceCalendar').mockResolvedValue({
      current_date: '2026-08-28',
      count_attendance: 1,
      attendance: [{ point: 100, day: 28, accumulate: 1 }],
    });

    const result = await client.executeAttendanceAndPoints('testuser', 'password');
    expect(result.success).toBe(true);
    expect(result.member?.name).toBe('홍길동');
    expect(result.attendance.status).toBe('SUCCESS');
    expect(result.totalPoint).toBe(1500);
    expect(result.calendar?.count_attendance).toBe(1);
  });

  it('runKeymediAttendance task 실행 및 sendTelegram 호출 검증', async () => {
    const sendTelegramSpy = vi.spyOn(utils, 'sendTelegram').mockResolvedValue(true);

    // Mock executeAttendanceAndPoints on prototype
    vi.spyOn(KeymediClient.prototype, 'executeAttendanceAndPoints').mockResolvedValue({
      success: true,
      member: { idx: 123, uid: 'nubiz', name: '김영욱' },
      attendance: {
        status: 'SUCCESS',
        point: 100,
        message: '출석 성공 (+100P)',
      },
      calendar: {
        current_date: '2026-08-28',
        count_attendance: 2,
        attendance: [],
      },
      pointBalance: 2200,
      totalPoint: 2200,
      message: '출석 성공 (+100P)',
    });

    const taskResult = await runKeymediAttendance();
    expect(taskResult.success).toBe(true);
    expect(taskResult.message).toContain('📋 [키메디 출석체크 & 포인트 현황]');
    expect(sendTelegramSpy).toHaveBeenCalledTimes(1);
    expect(sendTelegramSpy).toHaveBeenCalledWith(expect.stringContaining('김영욱 (nubiz)'));
  });
});
