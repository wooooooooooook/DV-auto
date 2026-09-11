import type { TaskContext, TaskResult } from '../types';
import * as keymediAttendanceTaskModule from './keymedi_attendance';
import * as hmpAttendanceTaskModule from './hmp_attendance';
import * as medigateApplyTaskModule from './medigate_apply_symposium';
import * as logger from '../services/logger';
import * as utils from '../modules/utils';

export interface EtcDailyQuestsResults {
  keymedi: { ok: boolean; error: string | null };
  hmp: { ok: boolean; error: string | null };
  medigate: { ok: boolean; error: string | null };
}

/**
 * 기타일일퀘스트 통합 태스크:
 * 키메디 출석체크 -> HMP 출석체크 -> 메디게이트 심포지움 자동 신청을 순차적으로 실행합니다.
 */
export async function run(ctx?: TaskContext): Promise<TaskResult> {
  logger.info('[기타일일퀘스트] 키메디, HMP, 메디게이트 순차 실행 시작');

  const results: EtcDailyQuestsResults = {
    keymedi: { ok: false, error: null },
    hmp: { ok: false, error: null },
    medigate: { ok: false, error: null },
  };

  // 1. 키메디 출석체크 & 포인트 현황
  try {
    logger.info('[기타일일퀘스트] 1/3 키메디 출석체크 시작');
    const keymediRes = await keymediAttendanceTaskModule.run(ctx);
    results.keymedi.ok = keymediRes.success !== false;
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

  // 2. HMP 출석체크 & 캡슐 현황
  try {
    logger.info('[기타일일퀘스트] 2/3 HMP 출석체크 시작');
    const hmpRes = await hmpAttendanceTaskModule.run(ctx);
    results.hmp.ok = hmpRes.success !== false;
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

  // 3. 메디게이트 심포지움 자동 신청
  try {
    logger.info('[기타일일퀘스트] 3/3 메디게이트 심포지움 자동 신청 시작');
    const medigateRes = await medigateApplyTaskModule.run(ctx);
    results.medigate.ok = medigateRes.success !== false;
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

  const allSuccess = results.keymedi.ok && results.hmp.ok && results.medigate.ok;
  const statusSummary = [
    `키메디: ${results.keymedi.ok ? '✅ 성공' : '❌ 실패'}`,
    `HMP: ${results.hmp.ok ? '✅ 성공' : '❌ 실패'}`,
    `메디게이트: ${results.medigate.ok ? '✅ 성공' : '❌ 실패'}`,
  ].join(' | ');

  const summaryMsg = allSuccess
    ? `🏁 기타 일일 퀘스트(키메디, HMP, 메디게이트)가 모두 성공적으로 완료되었습니다.\n(${statusSummary})`
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
