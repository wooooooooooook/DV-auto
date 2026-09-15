import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as etcDailyQuestsTask from '../src/tasks/etc_daily_quests';
import * as intermdQuizTaskModule from '../src/tasks/intermd_quiz';
import * as keymediAttendanceTaskModule from '../src/tasks/keymedi_attendance';
import * as hmpAttendanceTaskModule from '../src/tasks/hmp_attendance';
import * as medigateApplyTaskModule from '../src/tasks/medigate_apply_symposium';
import * as utils from '../src/modules/utils';

describe('기타일일퀘스트 (etc_daily_quests) 통합 태스크 테스트', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('인터엠디 -> 키메디 -> HMP -> 메디게이트 태스크가 순차적으로 실행되고 모든 텔레그램 메시지가 전송되어야 한다', async () => {
    const executionOrder: string[] = [];

    const intermdSpy = vi.spyOn(intermdQuizTaskModule, 'run').mockImplementation(async () => {
      executionOrder.push('intermd');
      return { success: true, message: '📋 [인터엠디 오늘의 퀴즈 완료]' };
    });

    const keymediSpy = vi.spyOn(keymediAttendanceTaskModule, 'run').mockImplementation(async () => {
      executionOrder.push('keymedi');
      return { success: true, message: '🔑 [키메디 출석체크 성공]' };
    });

    const hmpSpy = vi.spyOn(hmpAttendanceTaskModule, 'run').mockImplementation(async () => {
      executionOrder.push('hmp');
      return { success: true, message: '💊 [HMP 출석체크 성공]' };
    });

    const medigateSpy = vi.spyOn(medigateApplyTaskModule, 'run').mockImplementation(async () => {
      executionOrder.push('medigate');
      return { success: true, message: '🩺 [메디게이트 심포지움 신청 성공]', silent: false };
    });

    const telegramSpy = vi.spyOn(utils, 'sendTelegram').mockResolvedValue(true);

    const result = await etcDailyQuestsTask.run();

    // 순차 실행 순서 검증
    expect(executionOrder).toEqual(['intermd', 'keymedi', 'hmp', 'medigate']);
    expect(intermdSpy).toHaveBeenCalledTimes(1);
    expect(keymediSpy).toHaveBeenCalledTimes(1);
    expect(hmpSpy).toHaveBeenCalledTimes(1);
    expect(medigateSpy).toHaveBeenCalledTimes(1);

    // 각 태스크의 텔레그램 메시지 발송 검증
    expect(telegramSpy).toHaveBeenCalledTimes(4);
    expect(telegramSpy).toHaveBeenNthCalledWith(1, '📋 [인터엠디 오늘의 퀴즈 완료]');
    expect(telegramSpy).toHaveBeenNthCalledWith(2, '🔑 [키메디 출석체크 성공]');
    expect(telegramSpy).toHaveBeenNthCalledWith(3, '💊 [HMP 출석체크 성공]');
    expect(telegramSpy).toHaveBeenNthCalledWith(4, '🩺 [메디게이트 심포지움 신청 성공]');

    // 전체 성공 판정 및 결과 메시지 검증
    expect(result.success).toBe(true);
    expect(result.message).toContain(
      '기타 일일 퀘스트(인터엠디, 키메디, HMP, 메디게이트)가 모두 성공적으로 완료되었습니다.',
    );
    expect(result.message).toContain('인터엠디: ✅ 성공');
    expect(result.message).toContain('키메디: ✅ 성공');
    expect(result.message).toContain('HMP: ✅ 성공');
    expect(result.message).toContain('메디게이트: ✅ 성공');
  });

  it('인터엠디 태스크에서 예외가 발생하더라도 나머지 태스크는 계속 정상 실행되어야 한다', async () => {
    const intermdSpy = vi.spyOn(intermdQuizTaskModule, 'run').mockRejectedValue(new Error('인터엠디 로그인 실패'));

    const keymediSpy = vi.spyOn(keymediAttendanceTaskModule, 'run').mockResolvedValue({
      success: true,
      message: '🔑 [키메디 출석체크 성공]',
    });

    const hmpSpy = vi.spyOn(hmpAttendanceTaskModule, 'run').mockResolvedValue({
      success: true,
      message: '💊 [HMP 출석체크 성공]',
    });

    const medigateSpy = vi.spyOn(medigateApplyTaskModule, 'run').mockResolvedValue({
      success: true,
      message: '🩺 [메디게이트 심포지움 신청 성공]',
    });

    const telegramSpy = vi.spyOn(utils, 'sendTelegram').mockResolvedValue(true);

    const result = await etcDailyQuestsTask.run();

    expect(intermdSpy).toHaveBeenCalledTimes(1);
    expect(keymediSpy).toHaveBeenCalledTimes(1);
    expect(hmpSpy).toHaveBeenCalledTimes(1);
    expect(medigateSpy).toHaveBeenCalledTimes(1);

    // 인터엠디 오류 알림 + 키메디 알림 + HMP 알림 + 메디게이트 알림 발송 검증
    expect(telegramSpy).toHaveBeenCalledTimes(4);
    expect(telegramSpy).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('❌ [기타일일퀘스트 - 인터엠디 오늘의 퀴즈 오류]\n사유: 인터엠디 로그인 실패'),
    );
    expect(telegramSpy).toHaveBeenNthCalledWith(2, '🔑 [키메디 출석체크 성공]');
    expect(telegramSpy).toHaveBeenNthCalledWith(3, '💊 [HMP 출석체크 성공]');
    expect(telegramSpy).toHaveBeenNthCalledWith(4, '🩺 [메디게이트 심포지움 신청 성공]');

    expect(result.success).toBe(false);
    expect(result.message).toContain('기타 일일 퀘스트 중 일부 작업이 실패했습니다.');
    expect(result.message).toContain('인터엠디: ❌ 실패');
    expect(result.message).toContain('키메디: ✅ 성공');
    expect(result.message).toContain('HMP: ✅ 성공');
    expect(result.message).toContain('메디게이트: ✅ 성공');
  });

  it('인터엠디 및 메디게이트가 silent: true일 경우 해당 텔레그램 발송을 생략해야 한다', async () => {
    vi.spyOn(intermdQuizTaskModule, 'run').mockResolvedValue({
      success: true,
      message: 'ℹ️ [인터엠디 오늘의 퀴즈] 오늘 출제된 퀴즈가 없습니다.',
      silent: true,
    });

    vi.spyOn(keymediAttendanceTaskModule, 'run').mockResolvedValue({
      success: true,
      message: '🔑 [키메디 출석체크]',
    });

    vi.spyOn(hmpAttendanceTaskModule, 'run').mockResolvedValue({
      success: true,
      message: '💊 [HMP 출석체크]',
    });

    vi.spyOn(medigateApplyTaskModule, 'run').mockResolvedValue({
      success: true,
      message: '🩺 [메디게이트 신규 없음]',
      silent: true,
    });

    const telegramSpy = vi.spyOn(utils, 'sendTelegram').mockResolvedValue(true);

    const result = await etcDailyQuestsTask.run();

    expect(result.success).toBe(true);
    // 키메디, HMP만 발송되고 인터엠디와 메디게이트는 silent로 인해 생략됨
    expect(telegramSpy).toHaveBeenCalledTimes(2);
    expect(telegramSpy).toHaveBeenNthCalledWith(1, '🔑 [키메디 출석체크]');
    expect(telegramSpy).toHaveBeenNthCalledWith(2, '💊 [HMP 출석체크]');
  });

  it('각 태스크의 포인트/캡슐 정보가 정상 집계되어 최종 요약 메시지에 포함되어야 한다', async () => {
    vi.spyOn(intermdQuizTaskModule, 'run').mockResolvedValue({
      success: true,
      message: '📋 [인터엠디 퀴즈]',
    });

    vi.spyOn(keymediAttendanceTaskModule, 'run').mockResolvedValue({
      success: true,
      message: '🔑 [키메디 출석체크]',
      options: { totalPoint: 5200 },
    });

    vi.spyOn(hmpAttendanceTaskModule, 'run').mockResolvedValue({
      success: true,
      message: '💊 [HMP 출석체크]',
      options: { capsules: 350 },
    });

    vi.spyOn(medigateApplyTaskModule, 'run').mockResolvedValue({
      success: true,
      message: '🩺 [메디게이트]',
      options: { usablePoint: 1000 },
    });

    vi.spyOn(utils, 'sendTelegram').mockResolvedValue(true);

    const result = await etcDailyQuestsTask.run();

    expect(result.success).toBe(true);
    expect(result.message).toContain('인터엠디: ✅ 성공');
    expect(result.message).toContain('키메디: ✅ 성공 (5,200P)');
    expect(result.message).toContain('HMP: ✅ 성공 (350 캡슐)');
    expect(result.message).toContain('메디게이트: ✅ 성공 (1,000P)');

    const opts = result.options as { results: etcDailyQuestsTask.EtcDailyQuestsResults };
    expect(opts.results.intermd.ok).toBe(true);
    expect(opts.results.keymedi.point).toBe(5200);
    expect(opts.results.hmp.capsules).toBe(350);
    expect(opts.results.medigate.point).toBe(1000);
  });
});
