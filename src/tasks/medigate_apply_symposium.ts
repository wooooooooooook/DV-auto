import type { TaskContext, TaskResult } from '../types';
import { MedigateClient, type MedigateApplyWorkflowResult } from '../modules/medigate_api';
import * as logger from '../services/logger';

/**
 * 텔레그램 전송용 메디게이트 심포지움 신청 결과 메시지 포맷팅
 */
export function formatMedigateApplyMessage(result: MedigateApplyWorkflowResult): string {
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
    return ['❌ [메디게이트 심포지움 자동 신청 실패]', `📅 일시: ${kstDateStr}`, `⚠️ 사유: ${result.message}`].join(
      '\n',
    );
  }

  const userText = result.userName ? `${result.userName}님 (${result.userId || ''})` : '';

  const lines: string[] = [
    '🩺 [메디게이트 웹 심포지움 자동 신청]',
    `📅 일시: ${kstDateStr}`,
    userText ? `👤 계정: ${userText}` : '',
    `📊 현황: 전체 ${result.totalFound}개 중 신청가능 ${result.targetCount}개 (신규 신청 ${result.appliedCount}건 / 기신청 ${result.alreadyCount}건 / 실패 ${result.failedCount}건)`,
  ].filter(Boolean);

  // 새로 신청된 심포지움 목록
  const newlyApplied = result.results.filter((r) => r.success && !r.alreadyApplied);
  if (newlyApplied.length > 0) {
    lines.push('');
    lines.push(`✅ [신규 신청 완료: ${newlyApplied.length}건]`);
    for (const item of newlyApplied) {
      const dateText = item.dateDesc ? ` (${item.dateDesc})` : '';
      lines.push(`  • ${item.subject}${dateText}`);
      lines.push(`    https://new.medigate.net/symposium/${item.webinarIdx}`);
    }
  }

  // 실패한 항목
  const failed = result.results.filter((r) => !r.success);
  if (failed.length > 0) {
    lines.push('');
    lines.push(`⚠️ [신청 실패: ${failed.length}건]`);
    for (const item of failed) {
      lines.push(`  • [${item.webinarIdx}] ${item.subject}: ${item.message}`);
    }
  }

  if (newlyApplied.length === 0 && failed.length === 0) {
    lines.push('');
    lines.push('ℹ️ 모든 신청 가능한 심포지움이 이미 신청 완료된 상태입니다.');
  }

  return lines.join('\n');
}

/**
 * 메디게이트 심포지움 자동 신청 태스크 실행기
 */
export async function run(ctx?: TaskContext): Promise<TaskResult> {
  const client = new MedigateClient();
  const options = ctx?.args || {};

  logger.info('[Medigate Task] 심포지움 자동 신청 태스크 시작');
  const result = await client.applyAllAvailableSymposiums();

  const formattedMsg = formatMedigateApplyMessage(result);

  const silentIfNoNew = options.silentIfNoNew === 'true';
  const shouldNotify = !silentIfNoNew || result.appliedCount > 0 || !result.success;

  return {
    success: result.success,
    message: formattedMsg,
    options: {
      appliedCount: result.appliedCount,
      alreadyCount: result.alreadyCount,
      failedCount: result.failedCount,
      targetCount: result.targetCount,
      shouldNotify,
    },
    silent: !shouldNotify,
  };
}
