import type { TaskContext, TaskResult } from '../types';
import { KeymediClient, type KeymediAttendanceWorkflowResult } from '../modules/keymedi_api';
import { sendTelegram } from '../modules/utils';
import * as logger from '../services/logger';

export function formatKeymediAttendanceMessage(result: KeymediAttendanceWorkflowResult): string {
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
    return ['❌ [키메디 출석체크 실패]', `📅 일시: ${kstDateStr}`, `⚠️ 사유: ${result.message}`].join('\n');
  }

  const memberName = result.member?.name || '회원';
  const memberUid = result.member?.uid ? ` (${result.member.uid})` : '';
  const accumulateDays = result.calendar?.count_attendance
    ? ` (당월 누적 출석: ${result.calendar.count_attendance}일)`
    : '';

  let attendStatusText = '';
  if (result.attendance.status === 'SUCCESS') {
    attendStatusText = `✅ 출석 완료 (+${result.attendance.point ?? 100}P)`;
  } else if (result.attendance.status === 'ALREADY') {
    attendStatusText = 'ℹ️ 이미 오늘 출석 완료';
  } else {
    attendStatusText = `⚠️ 출석 실패 (${result.attendance.message})`;
  }

  const lines = [
    '📋 [키메디 출석체크 & 포인트 현황]',
    `📅 일시: ${kstDateStr}`,
    `👤 회원: ${memberName}${memberUid}`,
    `📌 출석: ${attendStatusText}`,
    `💰 보유 포인트: ${result.totalPoint.toLocaleString()} P${accumulateDays}`,
  ];

  return lines.join('\n');
}

export async function run(ctx?: TaskContext): Promise<TaskResult> {
  const client = new KeymediClient();
  const uid = ctx?.args?.uid;
  const password = ctx?.args?.password;

  try {
    logger.info('keymedi_attendance task: Starting workflow (login -> attendance -> points)...');
    const result = await client.executeAttendanceAndPoints(uid, password);
    const message = formatKeymediAttendanceMessage(result);

    // 텔레그램 관리자봇으로 전송
    await sendTelegram(message).catch((err) => {
      logger.error('Failed to send Telegram message for keymedi_attendance:', err);
    });

    return {
      success: result.success && result.attendance.status !== 'FAILED',
      message,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('keymedi_attendance task error:', err);
    const failMessage = `❌ [키메디 출석체크 오류]\n사유: ${errorMsg}`;

    await sendTelegram(failMessage).catch(() => {});

    return {
      success: false,
      message: failMessage,
    };
  }
}
