import type { TaskContext, TaskResult } from '../types';
import { HmpClient, type HmpAttendanceWorkflowResult } from '../modules/hmp_api';
import { sendTelegram } from '../modules/utils';
import * as logger from '../services/logger';

export function formatHmpAttendanceMessage(result: HmpAttendanceWorkflowResult): string {
  const now = new Date();
  const kstDateStr = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);

  if (!result.success) {
    return ['❌ [HMP 출석체크 실패]', `📅 일시: ${kstDateStr}`, `⚠️ 사유: ${result.message}`].join('\n');
  }

  const memberName = result.userInfo?.nick || result.userInfo?.memId || '회원';
  const gradeText = result.userInfo?.gradNm ? ` [${result.userInfo.gradNm}]` : '';
  const accumulateDays =
    result.loginCount !== undefined && result.loginCount > 0 ? ` (당월 연속 출석: ${result.loginCount}일)` : '';

  let attendStatusText = '';
  if (result.attendance.status === 'SUCCESS') {
    attendStatusText = `✅ 출석 완료 (+${result.attendance.point ?? 10} 캡슐)`;
  } else if (result.attendance.status === 'ALREADY') {
    attendStatusText = 'ℹ️ 이미 오늘 출석 캡슐 수령 완료';
  } else {
    attendStatusText = `⚠️ 출석 실패 (${result.attendance.message})`;
  }

  const currentCapsules = (result.userInfo?.capsules ?? 0).toLocaleString();

  const lines = [
    '💊 [HMP 출석체크 & 캡슐 현황]',
    `👤 사용자: ${memberName}${gradeText}`,
    `📅 일시: ${kstDateStr}`,
    `📌 출석 상태: ${attendStatusText}${accumulateDays}`,
    `💰 보유 캡슐: ${currentCapsules} 캡슐`,
  ];

  return lines.join('\n');
}

export async function run(_ctx?: TaskContext): Promise<TaskResult> {
  logger.info('[HMP] 출석체크 및 캡슐 조회 태스크 시작');
  const client = new HmpClient();

  try {
    const result = await client.runAttendanceWorkflow();
    const message = formatHmpAttendanceMessage(result);

    logger.info('[HMP] 출석체크 결과:\n' + message);

    try {
      await sendTelegram(message);
    } catch (telegramErr) {
      logger.error('[HMP] 텔레그램 메시지 발송 실패:', telegramErr);
    }

    return {
      success: result.success && result.attendance.status !== 'FAILED',
      message,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('[HMP] 태스크 실행 중 예외 발생:', error);

    const failMessage = `❌ [HMP 출석체크 오류]\n⚠️ ${msg}`;
    try {
      await sendTelegram(failMessage);
    } catch (telegramErr) {
      logger.error('[HMP] 텔레그램 실패 메시지 발송 실패:', telegramErr);
    }

    return {
      success: false,
      message: failMessage,
    };
  }
}
