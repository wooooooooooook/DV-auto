import type { TaskContext, TaskResult } from '../types';
import { HmpClient, type HmpAttendanceWorkflowResult } from '../modules/hmp_api';
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

  const currentCapsules =
    result.userInfo?.capsules !== undefined ? `${result.userInfo.capsules.toLocaleString()} 캡슐` : '조회 실패';

  const lines = [
    '💊 [HMP 출석체크 & 캡슐 현황]',
    `👤 사용자: ${memberName}${gradeText}`,
    `📅 일시: ${kstDateStr}`,
    `📌 출석 상태: ${attendStatusText}${accumulateDays}`,
  ];

  // 출석은 성공했지만 후속 조회/처리가 실패한 경우. 실패로 뭉뚱그리면 실제 완료된 작업을 놓친다.
  if (result.degradedReason) {
    lines.push(`⚠️ 일부 처리 실패 (출석 결과에는 영향 없음): ${result.degradedReason}`);
  }

  if (result.roulette && result.roulette.spins.length > 0) {
    const rouletteLines: string[] = [];
    for (const spin of result.roulette.spins) {
      if (spin.success) {
        const giftText =
          spin.prizeType === 'PRODUCT' ? (spin.giftiShowSent ? ' (기프티쇼 발송 완료)' : ' (기프티쇼 발송 대기)') : '';
        rouletteLines.push(`  • 연속 ${spin.stepDays}일 룰렛 당첨: ${spin.prizeName}${giftText}`);
      } else {
        rouletteLines.push(`  • 연속 ${spin.stepDays}일 룰렛 실패: ${spin.message}`);
      }
    }
    lines.push(`🎰 룰렛 결과:\n${rouletteLines.join('\n')}`);
  }

  lines.push(`💰 보유 캡슐: ${currentCapsules}`);

  return lines.join('\n');
}

export async function run(_ctx?: TaskContext): Promise<TaskResult> {
  logger.info('[HMP] 출석체크 및 캡슐 조회 태스크 시작');
  const client = new HmpClient();

  try {
    const result = await client.runAttendanceWorkflow();
    const message = formatHmpAttendanceMessage(result);

    logger.info('[HMP] 출석체크 결과:\n' + message);

    return {
      success: result.success && result.attendance.status !== 'FAILED',
      message,
      options: {
        capsules: result.userInfo?.capsules,
        roulette: result.roulette,
      },
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error('[HMP] 태스크 실행 중 예외 발생:', error);

    const failMessage = `❌ [HMP 출석체크 오류]\n⚠️ ${msg}`;

    return {
      success: false,
      message: failMessage,
    };
  }
}
