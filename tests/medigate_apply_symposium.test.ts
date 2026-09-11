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

    const msgWithPoint = formatMedigateApplyMessage({
      ...mockResult,
      pointSummary: {
        usablePoint: 5000,
        usableMgPoint: 3000,
        usableResearchPoint: 2000,
        expiringPoint: 0,
      },
    });
    expect(msgWithPoint).toContain('💰 보유 포인트: 5,000 P (MG: 3,000P / 리서치: 2,000P)');
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

  it('MedigateClient 포인트 조회 메서드 단위 테스트', async () => {
    const client = new MedigateClient({
      accessToken: 'test-token',
      user: {
        uId: 'testuser',
        uName: '테스터',
      },
    });

    vi.spyOn(
      client as unknown as { authenticatedRequest: (...args: unknown[]) => Promise<unknown> },
      'authenticatedRequest',
    ).mockImplementation(async (...args: unknown[]) => {
      const path = args[0] as string;
      if (path === 'w/point/mg/summary') {
        return {
          status: 200,
          data: {
            code: 200,
            data: {
              usablePoint: 5000,
              usableMgPoint: 3000,
              usableResearchPoint: 2000,
              expiringPoint: 0,
            },
          },
        };
      }
      if (path === 'w/point/mg/grant') {
        return {
          status: 200,
          data: {
            code: 200,
            data: {
              totalItems: 1,
              totalPages: 1,
              items: [
                {
                  grantDate: '2026-09-10',
                  title: '심포지움 설문 참여',
                  point: 1000,
                },
              ],
            },
          },
        };
      }
      if (path === 'w/point/mg/flow_chart') {
        return {
          status: 200,
          data: {
            code: 200,
            data: {
              items: [
                {
                  yyyymm: '2026.09',
                  grantPoint: 1000,
                  usedPoint: 0,
                },
              ],
            },
          },
        };
      }
      return { status: 404 };
    });

    const summary = await client.getPointSummary();
    expect(summary).not.toBeNull();
    expect(summary?.usablePoint).toBe(5000);
    expect(summary?.usableMgPoint).toBe(3000);
    expect(summary?.usableResearchPoint).toBe(2000);

    const grants = await client.getPointGrantHistory(2026, 1, 20);
    expect(grants).not.toBeNull();
    expect(grants?.totalItems).toBe(1);
    expect(grants?.items[0]?.point).toBe(1000);

    const flowChart = await client.getPointFlowChart();
    expect(flowChart).toHaveLength(1);
    expect(flowChart[0]?.yyyymm).toBe('2026.09');
  });
});
