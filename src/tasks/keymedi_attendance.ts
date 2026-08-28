import type { TaskContext, TaskResult } from '../types';
import { KeymediClient, type KeymediAttendanceWorkflowResult } from '../modules/keymedi_api';
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

  // 1. 참여 가능 설문
  const availableSurveys = result.surveys?.availableSurveys || [];
  let surveySectionText = '';
  if (availableSurveys.length > 0) {
    const totalSurveyPoints = availableSurveys.reduce((sum, s) => sum + (s.gift_point || 0), 0);
    const surveyLines = availableSurveys.map((s) => {
      let deadlineStr = '';
      if (s.end_at) {
        const parts = s.end_at.split(' ')[0].split('-');
        if (parts.length === 3) {
          deadlineStr = ` (~${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)})`;
        }
      }
      return `  • [${s.gift_point}P] ${s.title}${deadlineStr}\n    https://www.keymedi.com/survey/list/${s.idx}`;
    });

    surveySectionText = [
      `📝 참여가능 설문: ${availableSurveys.length}건 (최대 ${totalSurveyPoints.toLocaleString()}P)`,
      ...surveyLines,
    ].join('\n');
  } else {
    surveySectionText = '📝 참여가능 설문: 없음 (0건)';
  }

  // 2. 참여 가능 투표
  const availableVotes = result.votes?.availableVotes || [];
  let voteSectionText = '';
  if (availableVotes.length > 0) {
    const totalVotePoints = availableVotes.reduce((sum, v) => sum + (v.gift_point || 0), 0);
    const voteLines = availableVotes.map((v) => {
      let deadlineStr = '';
      if (v.end_at) {
        const parts = v.end_at.split(' ')[0].split('-');
        if (parts.length === 3) {
          deadlineStr = ` (~${parseInt(parts[1], 10)}/${parseInt(parts[2], 10)})`;
        }
      }
      return `  • [${v.gift_point}P] ${v.title}${deadlineStr}\n    https://www.keymedi.com/survey/vote/${v.idx}`;
    });

    voteSectionText = [
      `🗳️ 참여가능 투표: ${availableVotes.length}건 (최대 ${totalVotePoints.toLocaleString()}P)`,
      ...voteLines,
    ].join('\n');
  } else {
    voteSectionText = '🗳️ 참여가능 투표: 없음 (0건)';
  }

  const lines = [
    '📋 [키메디 출석체크 & 포인트 현황]',
    `📅 일시: ${kstDateStr}`,
    `👤 회원: ${memberName}${memberUid}`,
    `📌 출석: ${attendStatusText}`,
    `💰 보유 포인트: ${result.totalPoint.toLocaleString()} P${accumulateDays}`,
    surveySectionText,
    voteSectionText,
  ];

  return lines.join('\n');
}

export async function run(ctx?: TaskContext): Promise<TaskResult> {
  const client = new KeymediClient();
  const uid = ctx?.args?.uid;
  const password = ctx?.args?.password;

  try {
    logger.info('keymedi_attendance task: Starting workflow (login -> attendance -> points -> surveys -> votes)...');
    const result = await client.executeAttendanceAndPoints(uid, password);
    const message = formatKeymediAttendanceMessage(result);

    return {
      success: result.success && result.attendance.status !== 'FAILED',
      message,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('keymedi_attendance task error:', err);
    const failMessage = `❌ [키메디 출석체크 오류]\n사유: ${errorMsg}`;

    return {
      success: false,
      message: failMessage,
    };
  }
}
