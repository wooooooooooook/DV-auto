import type { TaskContext, TaskResult } from '../types';
import * as intermdQuizTaskModule from './intermd_quiz';
import * as keymediAttendanceTaskModule from './keymedi_attendance';
import * as hmpAttendanceTaskModule from './hmp_attendance';
import * as medigateApplyTaskModule from './medigate_apply_symposium';
import * as logger from '../services/logger';
import * as utils from '../modules/utils';

export interface EtcDailyQuestsResults {
  intermd: { ok: boolean; error: string | null };
  keymedi: { ok: boolean; error: string | null; point?: number };
  hmp: { ok: boolean; error: string | null; capsules?: number };
  medigate: { ok: boolean; error: string | null; point?: number };
}

/**
 * 기타일일퀘스트 통합 태스크:
 * 인터엠디 오늘의 퀴즈 -> 키메디 출석체크 -> HMP 출석체크 -> 메디게이트 심포지움 자동 신청을 순차적으로 실행합니다.
 */
export async function run(ctx?: TaskContext): Promise<TaskResult> {
  logger.info('[기타일일퀘스트] 인터엠디, 키메디, HMP, 메디게이트 순차 실행 시작');

  const results: EtcDailyQuestsResults = {
    intermd: { ok: false, error: null },
    keymedi: { ok: false, error: null },
    hmp: { ok: false, error: null },
    medigate: { ok: false, error: null },
  };

  // 1. 인터엠디 오늘의 퀴즈
  try {
    logger.info('[기타일일퀘스트] 1/4 인터엠디 오늘의 퀴즈 시작');
    const intermdRes = await intermdQuizTaskModule.run(ctx);
    results.intermd.ok = intermdRes.success !== false;
    if (intermdRes?.message && !intermdRes.silent) {
      await utils
        .sendTelegram(intermdRes.message)
        .catch((e) => logger.error('[기타일일퀘스트] 인터엠디 텔레그램 발송 실패:', e));
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    results.intermd.error = errMsg;
    logger.error('[기타일일퀘스트] 인터엠디 실행 중 예외 발생:', err);
    await utils
      .sendTelegram(`❌ [기타일일퀘스트 - 인터엠디 오늘의 퀴즈 오류]\n사유: ${errMsg}`)
      .catch((e) => logger.error('[기타일일퀘스트] 인터엠디 오류 텔레그램 발송 실패:', e));
  }

  // 2. 키메디 출석체크 & 포인트 현황
  try {
    logger.info('[기타일일퀘스트] 2/4 키메디 출석체크 시작');
    const keymediRes = await keymediAttendanceTaskModule.run(ctx);
    results.keymedi.ok = keymediRes.success !== false;
    if (typeof keymediRes.options?.totalPoint === 'number') {
      results.keymedi.point = keymediRes.options.totalPoint as number;
    }
    if (keymediRes?.message) {
      await utils
        .sendTelegram(keymediRes.message)
        .catch((e) => logger.error('[기타일일퀘스트] 키메디 텔레그램 발송 실패:', e));
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    results.keymedi.error = errMsg;
    logger.error('[기타일일퀘스트] 키메디 실행 중 예외 발생:', err);
    await utils
      .sendTelegram(`❌ [기타일일퀘스트 - 키메디 출석체크 오류]\n사유: ${errMsg}`)
      .catch((e) => logger.error('[기타일일퀘스트] 키메디 오류 텔레그램 발송 실패:', e));
  }

  // 3. HMP 출석체크 & 캡슐 현황
  try {
    logger.info('[기타일일퀘스트] 3/4 HMP 출석체크 시작');
    const hmpRes = await hmpAttendanceTaskModule.run(ctx);
    results.hmp.ok = hmpRes.success !== false;
    if (typeof hmpRes.options?.capsules === 'number') {
      results.hmp.capsules = hmpRes.options.capsules as number;
    }
    if (hmpRes?.message) {
      await utils
        .sendTelegram(hmpRes.message)
        .catch((e) => logger.error('[기타일일퀘스트] HMP 텔레그램 발송 실패:', e));
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    results.hmp.error = errMsg;
    logger.error('[기타일일퀘스트] HMP 실행 중 예외 발생:', err);
    await utils
      .sendTelegram(`❌ [기타일일퀘스트 - HMP 출석체크 오류]\n사유: ${errMsg}`)
      .catch((e) => logger.error('[기타일일퀘스트] HMP 오류 텔레그램 발송 실패:', e));
  }

  // 4. 메디게이트 심포지움 자동 신청 & 포인트 현황
  try {
    logger.info('[기타일일퀘스트] 4/4 메디게이트 심포지움 자동 신청 시작');
    const medigateRes = await medigateApplyTaskModule.run(ctx);
    results.medigate.ok = medigateRes.success !== false;
    if (typeof medigateRes.options?.usablePoint === 'number') {
      results.medigate.point = medigateRes.options.usablePoint as number;
    }
    if (medigateRes?.message && !medigateRes.silent) {
      await utils
        .sendTelegram(medigateRes.message)
        .catch((e) => logger.error('[기타일일퀘스트] 메디게이트 텔레그램 발송 실패:', e));
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    results.medigate.error = errMsg;
    logger.error('[기타일일퀘스트] 메디게이트 실행 중 예외 발생:', err);
    await utils
      .sendTelegram(`❌ [기타일일퀘스트 - 메디게이트 자동 신청 오류]\n사유: ${errMsg}`)
      .catch((e) => logger.error('[기타일일퀘스트] 메디게이트 오류 텔레그램 발송 실패:', e));
  }

  const allSuccess = results.intermd.ok && results.keymedi.ok && results.hmp.ok && results.medigate.ok;

  const intermdStatus = results.intermd.ok ? '인터엠디: ✅ 성공' : '인터엠디: ❌ 실패';
  const keymediStatus = results.keymedi.ok
    ? `키메디: ✅ 성공${results.keymedi.point !== undefined ? ` (${results.keymedi.point.toLocaleString()}P)` : ''}`
    : '키메디: ❌ 실패';
  const hmpStatus = results.hmp.ok
    ? `HMP: ✅ 성공${results.hmp.capsules !== undefined ? ` (${results.hmp.capsules.toLocaleString()} 캡슐)` : ''}`
    : 'HMP: ❌ 실패';
  const medigateStatus = results.medigate.ok
    ? `메디게이트: ✅ 성공${results.medigate.point !== undefined ? ` (${results.medigate.point.toLocaleString()}P)` : ''}`
    : '메디게이트: ❌ 실패';

  const statusSummary = [intermdStatus, keymediStatus, hmpStatus, medigateStatus].join(' | ');

  const summaryMsg = allSuccess
    ? `🏁 기타 일일 퀘스트(인터엠디, 키메디, HMP, 메디게이트)가 모두 성공적으로 완료되었습니다.\n(${statusSummary})`
    : `⚠️ 기타 일일 퀘스트 중 일부 작업이 실패했습니다.\n(${statusSummary})`;

  logger.info(`[기타일일퀘스트] 순차 실행 종료 (allSuccess: ${allSuccess})`);

  return {
    success: allSuccess,
    message: summaryMsg,
    options: {
      results,
    },
  };
}
