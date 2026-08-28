import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KeymediClient, type KeymediAttendanceWorkflowResult } from '../src/modules/keymedi_api';
import { formatKeymediAttendanceMessage, run as runKeymediAttendance } from '../src/tasks/keymedi_attendance';

describe('Keymedi Attendance & Points & Surveys & Votes Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('출석 완료, 포인트 현황, 설문 및 투표 링크 메시지 포맷팅 테스트 (설문 및 투표 존재 시)', () => {
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
      surveys: {
        topInfo: { possible_cnt: 1, acquire_point: 50, bookmark_cnt: 0, success_cnt: 0 },
        availableSurveys: [
          {
            idx: 282,
            title: 'Mounjaro 얼마나 활용하고 계신가요?',
            gift_point: 50,
            vote_status: 'open',
            people_closed_status: false,
            end_at: '2026-12-31 23:59:00',
          },
        ],
      },
      votes: {
        availableVotes: [
          {
            idx: 101,
            title: '주간 투표 테스트',
            gift_point: 50,
            vote_status: 'open',
            end_at: '2026-09-30 23:59:00',
          },
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
    expect(formatted).toContain('📝 참여가능 설문: 1건 (최대 50P)');
    expect(formatted).toContain('• [50P] Mounjaro 얼마나 활용하고 계신가요? (~12/31)');
    expect(formatted).toContain('https://www.keymedi.com/survey/list/282');
    expect(formatted).toContain('🗳️ 참여가능 투표: 1건 (최대 50P)');
    expect(formatted).toContain('• [50P] 주간 투표 테스트 (~9/30)');
    expect(formatted).toContain('https://www.keymedi.com/survey/vote/101');
  });

  it('참여 가능 설문/투표가 없을 때 포맷팅 테스트', () => {
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
      surveys: {
        topInfo: { possible_cnt: 0, acquire_point: 0, bookmark_cnt: 0, success_cnt: 0 },
        availableSurveys: [],
      },
      votes: {
        availableVotes: [],
      },
      pointBalance: 3500,
      totalPoint: 3500,
      message: '이미 오늘 출석체크가 완료되었습니다.',
    };

    const formatted = formatKeymediAttendanceMessage(mockResult);
    expect(formatted).toContain('📌 출석: ℹ️ 이미 오늘 출석 완료');
    expect(formatted).toContain('💰 보유 포인트: 3,500 P (당월 누적 출석: 5일)');
    expect(formatted).toContain('📝 참여가능 설문: 없음 (0건)');
    expect(formatted).toContain('🗳️ 참여가능 투표: 없음 (0건)');
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
    client.member = {
      idx: 123,
      uid: 'testuser',
      name: '홍길동',
      type_info: { DO: { main_medical_part: '영상의학과' } },
    };

    // Mock client methods
    vi.spyOn(client, 'login').mockResolvedValue({
      success: true,
      code: 0,
      message: 'ok',
      accessToken: 'mock_token',
      member: {
        idx: 123,
        uid: 'testuser',
        name: '홍길동',
        type_info: { DO: { main_medical_part: '영상의학과' } },
      },
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
      type_info: { DO: { main_medical_part: '영상의학과' } },
    });

    vi.spyOn(client, 'getAttendanceCalendar').mockResolvedValue({
      current_date: '2026-08-28',
      count_attendance: 1,
      attendance: [{ point: 100, day: 28, accumulate: 1 }],
    });

    vi.spyOn(client, 'getSurveyTopInfo').mockResolvedValue({
      possible_cnt: 1,
      acquire_point: 100,
      bookmark_cnt: 0,
      success_cnt: 0,
    });

    vi.spyOn(client, 'getSurveyList').mockResolvedValue([
      {
        idx: 1,
        title: '테스트 설문',
        gift_point: 100,
        vote_status: 'open',
        people_closed_status: false,
        end_at: '2026-09-30 23:59:00',
        medical_part: null,
      },
    ]);

    vi.spyOn(client, 'getVoteList').mockResolvedValue([
      {
        idx: 10,
        title: '테스트 투표',
        gift_point: 50,
        vote_status: 'open',
        end_at: '2026-09-30 23:59:00',
        medical_part: null,
      },
    ]);

    const result = await client.executeAttendanceAndPoints('testuser', 'password');
    expect(result.success).toBe(true);
    expect(result.member?.name).toBe('홍길동');
    expect(result.attendance.status).toBe('SUCCESS');
    expect(result.totalPoint).toBe(1500);
    expect(result.calendar?.count_attendance).toBe(1);
    expect(result.surveys?.availableSurveys.length).toBe(1);
    expect(result.surveys?.availableSurveys[0].title).toBe('테스트 설문');
    expect(result.votes?.availableVotes.length).toBe(1);
    expect(result.votes?.availableVotes[0].title).toBe('테스트 투표');
  });

  it('runKeymediAttendance task 실행 및 결과 반환 검증', async () => {
    vi.spyOn(KeymediClient.prototype, 'executeAttendanceAndPoints').mockResolvedValue({
      success: true,
      member: { idx: 123, uid: 'nubiz', name: '김영욱' },
      attendance: { status: 'SUCCESS', point: 100, message: '출석 성공 (+100P)' },
      calendar: {
        current_date: '2026-08-28',
        count_attendance: 2,
        attendance: [
          { point: 100, day: 27, accumulate: 1 },
          { point: 100, day: 28, accumulate: 2 },
        ],
      },
      surveys: {
        topInfo: { possible_cnt: 1, acquire_point: 50, bookmark_cnt: 0, success_cnt: 0 },
        availableSurveys: [
          {
            idx: 282,
            title: '테스트 설문',
            gift_point: 50,
            vote_status: 'NOT_VOTE',
            people_closed_status: false,
            medical_part: '내과',
            end_at: '2026-09-30 23:59:59',
          },
        ],
      },
      votes: {
        availableVotes: [],
      },
      pointBalance: 2200,
      totalPoint: 2200,
      message: '출석 성공 (+100P)',
    });

    const taskResult = await runKeymediAttendance();
    expect(taskResult.success).toBe(true);
    expect(taskResult.message).toContain('📋 [키메디 출석체크 & 포인트 현황]');
    expect(taskResult.message).toContain('📝 참여가능 설문: 1건 (최대 50P)');
    expect(taskResult.message).toContain('https://www.keymedi.com/survey/list/282');
    expect(taskResult.message).toContain('🗳️ 참여가능 투표: 없음 (0건)');
  });
});
