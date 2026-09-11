import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MedigateClient, type MedigateApplyWorkflowResult } from '../src/modules/medigate_api';
import { formatMedigateApplyMessage, run as runMedigateApply } from '../src/tasks/medigate_apply_symposium';

describe('Medigate Apply Symposium Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('메디게이트 심포지움 신청 결과 메시지 포맷팅 테스트 - 신규 신청 건이 있는 경우', () => {
    const mockResult: MedigateApplyWorkflowResult = {
      success: true,
      message: '심포지움 신청 작업 완료',
      userName: '김영욱',
      userId: 'nubiz',
      totalFound: 10,
      targetCount: 3,
      appliedCount: 2,
      alreadyCount: 1,
      failedCount: 0,
      results: [
        {
          webinarIdx: 4941,
          subject: 'Xeljanz in AS: Expanding Treatment Options in Clinical Practice',
          dateDesc: '2026.09.14 (월) 18:00 ~ 20:50',
          success: true,
          alreadyApplied: false,
          message: '신청이 성공적으로 완료되었습니다.',
        },
        {
          webinarIdx: 5029,
          subject: '환절기 꼭 챙겨야 하는 폐렴구균백신 PCV21 중심으로',
          dateDesc: '2026.09.20 (일) 10:00 ~ 12:00',
          success: true,
          alreadyApplied: false,
          message: '신청이 성공적으로 완료되었습니다.',
        },
        {
          webinarIdx: 5030,
          subject: 'LIVE LIGHTER with Wegovy®',
          dateDesc: '2026.09.25 (금) 19:00 ~ 21:00',
          success: true,
          alreadyApplied: true,
          message: '이미 신청됨',
        },
      ],
    };

    const msg = formatMedigateApplyMessage(mockResult);
    expect(msg).toContain('🩺 [메디게이트 웹 심포지움 자동 신청]');
    expect(msg).toContain('김영욱님 (nubiz)');
    expect(msg).toContain('전체 10개 중 신청가능 3개 (신규 신청 2건 / 기신청 1건 / 실패 0건)');
    expect(msg).toContain('✅ [신규 신청 완료: 2건]');
    expect(msg).toContain('Xeljanz in AS: Expanding Treatment Options in Clinical Practice');
    expect(msg).toContain('https://new.medigate.net/symposium/4941');
  });

  it('메디게이트 심포지움 신청 결과 메시지 포맷팅 테스트 - 모두 기신청된 경우', () => {
    const mockResult: MedigateApplyWorkflowResult = {
      success: true,
      message: '심포지움 신청 작업 완료',
      userName: '김영욱',
      userId: 'nubiz',
      totalFound: 5,
      targetCount: 2,
      appliedCount: 0,
      alreadyCount: 2,
      failedCount: 0,
      results: [
        {
          webinarIdx: 4941,
          subject: 'Xeljanz in AS',
          success: true,
          alreadyApplied: true,
          message: '이미 신청됨',
        },
      ],
    };

    const msg = formatMedigateApplyMessage(mockResult);
    expect(msg).toContain('ℹ️ 모든 신청 가능한 심포지움이 이미 신청 완료된 상태입니다.');
  });

  it('메디게이트 심포지움 신청 결과 메시지 포맷팅 테스트 - 로그인 실패인 경우', () => {
    const mockResult: MedigateApplyWorkflowResult = {
      success: false,
      message: '아이디 또는 비밀번호가 올바르지 않습니다.',
      totalFound: 0,
      targetCount: 0,
      appliedCount: 0,
      alreadyCount: 0,
      failedCount: 0,
      results: [],
    };

    const msg = formatMedigateApplyMessage(mockResult);
    expect(msg).toContain('❌ [메디게이트 심포지움 자동 신청 실패]');
    expect(msg).toContain('아이디 또는 비밀번호가 올바르지 않습니다.');
  });

  it('run 태스크 실행 테스트 - client.applyAllAvailableSymposiums 연동', async () => {
    vi.spyOn(MedigateClient.prototype, 'applyAllAvailableSymposiums').mockResolvedValueOnce({
      success: true,
      message: '작업 완료',
      userName: '테스터',
      userId: 'testuser',
      totalFound: 5,
      targetCount: 2,
      appliedCount: 1,
      alreadyCount: 1,
      failedCount: 0,
      results: [
        {
          webinarIdx: 4941,
          subject: '테스트 심포지움',
          success: true,
          alreadyApplied: false,
          message: '성공',
        },
      ],
    });

    const res = await runMedigateApply();
    expect(res.success).toBe(true);
    expect(res.message).toContain('테스트 심포지움');
    expect(res.options?.appliedCount).toBe(1);
    expect(res.silent).toBe(false);
  });
});
