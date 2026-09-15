import type { TaskContext, TaskResult } from '../types';
import { MedigateClient, type MedigateWatchResult, type MedigateWatchWorkflowResult } from '../modules/medigate_api';
import * as logger from '../services/logger';
import { markSymposiumWatchedToday } from '../services/medigate_monitor_service';

/**
 * 텔레그램 전송용 메디게이트 심포지움 시청 결과 메시지 포맷팅
 */
export function formatMedigateWatchMessage(result: MedigateWatchResult | MedigateWatchWorkflowResult): string {
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

  // 단일 시청 결과인 경우
  if ('webinarIdx' in result) {
    if (!result.success) {
      return [
        '❌ [메디게이트 심포지움 시청 실패]',
        `📅 일시: ${kstDateStr}`,
        `📌 심포지움: [${result.webinarIdx}] ${result.subject}`,
        `⚠️ 사유: ${result.message}`,
      ].join('\n');
    }

    const lines: string[] = [
      '🩺 [메디게이트 심포지움 시청 완료]',
      `📅 일시: ${kstDateStr}`,
      `📌 심포지움: [${result.webinarIdx}] ${result.subject}`,
      `⏱️ 시청 시간: ${result.durationMinutes}분 (Heartbeat ${result.heartbeatCount}회 전송)`,
      `📡 플랫폼: ${result.platform}`,
    ];

    if (result.surveyUrl) {
      lines.push(`📝 설문 링크: ${result.surveyUrl}`);
    }

    return lines.join('\n');
  }

  // 일괄 워크플로우 결과인 경우
  if (!result.success && result.totalOnAir === 0 && result.results.length === 0) {
    return ['❌ [메디게이트 심포지움 시청 실패]', `📅 일시: ${kstDateStr}`, `⚠️ 사유: ${result.message}`].join('\n');
  }

  const userText = result.userName ? `${result.userName}님 (${result.userId || ''})` : '';

  const lines: string[] = [
    '🩺 [메디게이트 On-Air 심포지움 자동 시청]',
    `📅 일시: ${kstDateStr}`,
    userText ? `👤 계정: ${userText}` : '',
  ].filter(Boolean);

  lines.push(
    `📊 현황: On-Air 진행 중 ${result.totalOnAir}개 (시청 완료 ${result.watchedCount}건 / 실패 ${result.failedCount}건)`,
  );

  if (result.results.length === 0) {
    lines.push('');
    lines.push('ℹ️ 현재 방송 진행 중인(On-Air) 심포지움이 없습니다.');
    return lines.join('\n');
  }

  for (const item of result.results) {
    lines.push('');
    if (item.success) {
      lines.push(`✅ [${item.webinarIdx}] ${item.subject}`);
      lines.push(`   • 시청: ${item.durationMinutes}분 (Heartbeat ${item.heartbeatCount}회)`);
      if (item.surveyUrl) {
        lines.push(`   • 설문: ${item.surveyUrl}`);
      }
    } else {
      lines.push(`⚠️ [${item.webinarIdx}] ${item.subject}: ${item.message}`);
    }
  }

  return lines.join('\n');
}

import { sendTelegram } from '../modules/utils';

/**
 * 메디게이트 심포지움 시청 태스크 실행기
 */
export async function run(ctx?: TaskContext): Promise<TaskResult> {
  const client = new MedigateClient();
  const options = ctx?.args || {};

  const targetIdx = options.webinarIdx || options.idx || options.id;
  const durationMinutes = options.duration ? parseInt(String(options.duration), 10) : 20;
  const intervalSeconds = options.interval ? parseInt(String(options.interval), 10) : 120;
  const silentIfNoLive = options.silentIfNoLive === 'true';

  logger.info('[Medigate Task] 심포지움 시청 태스크 시작', {
    targetIdx,
    durationMinutes,
    intervalSeconds,
  });

  // 시작 알림 콜백
  const handleStart = async (info: { webinarIdx: number; subject: string; durationMinutes: number }) => {
    const startMsg = [
      '🩺 [메디게이트 심포지움 시청 시작]',
      `📌 [${info.webinarIdx}] ${info.subject}`,
      `⏱️ 목표 시청 시간: ${info.durationMinutes}분 (5분 간격 진행 보고)`,
    ].join('\n');
    await sendTelegram(startMsg).catch(() => {});
  };

  // 5분 주기 진행 알림 콜백
  const handleProgress = async (info: {
    webinarIdx: number;
    subject: string;
    elapsedMinutes: number;
    durationMinutes: number;
    heartbeatCount: number;
  }) => {
    const progressMsg = [
      '🩺 [메디게이트 심포지움 시청 진행 중]',
      `📌 [${info.webinarIdx}] ${info.subject}`,
      `⏱️ ${info.elapsedMinutes}/${info.durationMinutes}분 시청 중 (Heartbeat ${info.heartbeatCount}회 전송)`,
    ].join('\n');
    await sendTelegram(progressMsg).catch(() => {});
  };

  if (targetIdx) {
    const webinarIdx = parseInt(String(targetIdx), 10);
    const result = await client.watchSymposiumLive(webinarIdx, {
      durationMinutes,
      intervalSeconds,
      onStart: handleStart,
      onProgress: handleProgress,
    });

    const formattedMsg = formatMedigateWatchMessage(result);
    if (result.success) {
      markSymposiumWatchedToday(result.webinarIdx, {
        subject: result.subject,
        watchedAt: result.endedAt,
        durationMinutes: result.durationMinutes,
        heartbeatCount: result.heartbeatCount,
        success: true,
        surveyUrl: result.surveyUrl,
      });
    }

    return {
      success: result.success,
      message: formattedMsg,
      options: {
        webinarIdx: result.webinarIdx,
        durationMinutes: result.durationMinutes,
        heartbeatCount: result.heartbeatCount,
        surveyUrl: result.surveyUrl,
      },
      silent: false,
    };
  }

  // 전체 On-Air 심포지움 자동 시청
  const result = await client.watchAllOnAirSymposiums({
    durationMinutes,
    intervalSeconds,
    onStart: handleStart,
    onProgress: handleProgress,
  });

  for (const item of result.results) {
    if (item.success) {
      markSymposiumWatchedToday(item.webinarIdx, {
        subject: item.subject,
        watchedAt: item.endedAt,
        durationMinutes: item.durationMinutes,
        heartbeatCount: item.heartbeatCount,
        success: true,
        surveyUrl: item.surveyUrl,
      });
    }
  }

  const formattedMsg = formatMedigateWatchMessage(result);
  const shouldNotify = !silentIfNoLive || result.totalOnAir > 0 || !result.success;

  return {
    success: result.success,
    message: formattedMsg,
    options: {
      totalOnAir: result.totalOnAir,
      watchedCount: result.watchedCount,
      failedCount: result.failedCount,
      shouldNotify,
    },
    silent: !shouldNotify,
  };
}
