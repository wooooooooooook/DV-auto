import { type Context } from 'telegraf';
import * as logger from '../logger';
import { replyWithSplit, escapeHtml } from '../../modules/utils';
import * as seminarRepo from '../seminar_repository';
import { clearCache as clearAdvancedSeminarsCache } from '../../tasks/check_advanced_seminars';

function getKstToday(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export interface ParsePointCommandResult {
  seminarId: string;
  pointPaid: boolean;
  point?: number;
  note?: string;
}

export function parseSeminarPointArgs(text: string): ParsePointCommandResult | { error: string } {
  // 명령어 및 봇 멘션 제거 (예: /set_seminar_point@bot ... -> ...)
  const body = text.replace(/^\/\S+\s*/, '').trim();
  if (!body) {
    return {
      error:
        '사용법: /set_seminar_point <세미나번호> [paid|unpaid|지급|미지급] [포인트금액] [내용]\n\n' +
        '💡 상태를 생략하면 기본적으로 "지급 완료"로 처리됩니다.\n' +
        '예시:\n' +
        '• /set_seminar_point 5517 (기본값: 지급 완료)\n' +
        '• /set_seminar_point 5517 3000 (3,000P 지급 완료)\n' +
        '• /set_seminar_point 5517 paid 3000 설문포인트\n' +
        '• /set_seminar_point 5517 unpaid (미지급으로 변경)\n' +
        '• /set_seminar_point 5517 미지급',
    };
  }

  const tokens = body.split(/\s+/);
  const seminarId = tokens[0];
  if (!/^\d{4,6}$/.test(seminarId)) {
    return {
      error: `유효하지 않은 세미나 번호입니다: "${seminarId}". 4~6자리 숫자를 입력해주세요.`,
    };
  }

  // 기본값: paid = true (명시적으로 unpaid를 지정하지 않는 한 true)
  let pointPaid = true;
  let point: number | undefined;
  const remainingTokens: string[] = [];

  const unpaidKeywords = new Set(['unpaid', '미지급', 'false', '취소', '0', 'no']);
  const paidKeywords = new Set(['paid', '지급', '지급됨', 'true', '1', 'yes']);

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i];
    const lower = token.toLowerCase();

    if (unpaidKeywords.has(lower)) {
      pointPaid = false;
      continue;
    }
    if (paidKeywords.has(lower)) {
      pointPaid = true;
      continue;
    }

    // 숫자 포인트인지 확인 (예: 3000, 3000P, 3,000, 3,000P)
    const matchPoint = token.match(/^(\d{1,3}(?:,\d{3})*|\d+)[pP원]?$/);
    if (matchPoint && point === undefined) {
      const rawNum = parseInt(matchPoint[1].replace(/,/g, ''), 10);
      if (!Number.isNaN(rawNum)) {
        point = rawNum;
        continue;
      }
    }

    remainingTokens.push(token);
  }

  const note = remainingTokens.length > 0 ? remainingTokens.join(' ') : undefined;

  return {
    seminarId,
    pointPaid,
    point,
    note,
  };
}

export const createSeminarPointHandler = () => async (ctx: Context) => {
  logger.info('User requested manual seminar point update', { from: ctx.from?.username });
  try {
    const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const parsed = parseSeminarPointArgs(messageText);

    if ('error' in parsed) {
      return replyWithSplit(ctx, parsed.error);
    }

    const { seminarId, pointPaid, point, note } = parsed;
    const existing = seminarRepo.getSeminarById(seminarId);

    const todayStr = getKstToday();
    const finalPoint = point !== undefined ? point : (existing?.point ?? undefined);
    const pointText = finalPoint !== undefined ? `${finalPoint.toLocaleString()}P` : (existing?.pointText ?? undefined);
    const pointContent = note || (existing?.pointContent ?? (pointPaid ? '수동 지급 처리' : undefined));
    const pointDate = pointPaid ? existing?.pointDate || todayStr : undefined;

    const updated = await seminarRepo.updateSeminarPointStatus(seminarId, {
      pointPaid,
      point: pointPaid ? finalPoint : null,
      pointText: pointPaid ? pointText : null,
      pointDate: pointPaid ? pointDate : null,
      pointContent: pointPaid ? pointContent : null,
    });

    try {
      clearAdvancedSeminarsCache();
    } catch {
      // ignore
    }

    const nameStr = updated.name ? escapeHtml(updated.name) : '(세미나명 없음)';
    const dateStr = updated.date ? `${escapeHtml(updated.date)} ${escapeHtml(updated.time || '')}`.trim() : '';

    let replyMessage = `✅ <b>세미나 [${escapeHtml(seminarId)}] 포인트 상태 수동 갱신 완료</b>\n\n`;
    replyMessage += `• <b>세미나명:</b> ${nameStr}\n`;
    if (dateStr) {
      replyMessage += `• <b>일시:</b> ${dateStr}\n`;
    }

    if (pointPaid) {
      replyMessage += `• <b>지급상태:</b> 🟢 지급 완료${pointText ? ` (${escapeHtml(pointText)})` : ''}\n`;
      if (pointDate) {
        replyMessage += `• <b>지급일자:</b> ${escapeHtml(pointDate)}\n`;
      }
      if (pointContent) {
        replyMessage += `• <b>적립내용:</b> ${escapeHtml(pointContent)}\n`;
      }
    } else {
      replyMessage += `• <b>지급상태:</b> 🔴 미지급 (포인트 정보 초기화됨)\n`;
    }

    replyMessage += `\n💡 <i><code>/check_advanced_seminars</code> 및 <code>/seminar_detail ${escapeHtml(seminarId)}</code> 에 반영됩니다.</i>`;

    await replyWithSplit(ctx, replyMessage, { parse_mode: 'HTML' });
    logger.info(`[admin] Updated seminar ${seminarId} point status to ${pointPaid ? 'paid' : 'unpaid'}`);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('createSeminarPointHandler error', e);
    await replyWithSplit(ctx, `세미나 포인트 상태 갱신 실패: ${message}`);
  }
};
