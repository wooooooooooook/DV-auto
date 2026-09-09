import { type Context } from 'telegraf';
import * as logger from '../logger';
import { replyWithSplit, escapeHtml } from '../../modules/utils';
import { extractSeminarIds } from '../../tasks/seminar_detail';
import * as seminarRepo from '../seminar_repository';

export const createSeminarDeleteHandler = () => async (ctx: Context) => {
  logger.info('User requested seminar delete', { from: ctx.from?.username });
  try {
    const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
    const seminarIds = extractSeminarIds(messageText);

    if (seminarIds.length === 0) {
      return replyWithSplit(
        ctx,
        '사용법: /delete_seminar <세미나번호> [세미나번호...]\n예: /delete_seminar 5566\n   또는 /delete_seminar 5566 5567',
      );
    }

    const MAX_SEMINAR_IDS_PER_REQUEST = 20;
    if (seminarIds.length > MAX_SEMINAR_IDS_PER_REQUEST) {
      return replyWithSplit(ctx, '⚠️ 세미나 번호는 한 번에 최대 20개까지만 삭제할 수 있습니다.');
    }

    const results: string[] = [];
    let deletedCount = 0;

    for (const sid of seminarIds) {
      const existing = seminarRepo.getSeminarById(sid);
      const isDeleted = seminarRepo.deleteSeminar(sid);

      if (isDeleted) {
        deletedCount++;
        const nameStr = existing?.name ? ` - ${escapeHtml(existing.name)}` : '';
        const dateStr = existing?.date ? ` (${escapeHtml(existing.date)})` : '';
        results.push(`• <code>${escapeHtml(sid)}</code>${nameStr}${dateStr}: 삭제 완료 🗑️`);
        logger.info(`[admin] Deleted seminar ${sid} from database`);
      } else {
        results.push(`• <code>${escapeHtml(sid)}</code>: DB에 존재하지 않음 ⚠️`);
      }
    }

    let replyMessage = `<b>세미나 DB 삭제 결과 (총 ${deletedCount}/${seminarIds.length}개 삭제)</b>\n\n${results.join('\n')}`;
    if (deletedCount > 0) {
      replyMessage += `\n\n💡 <i>삭제된 세미나를 <code>/seminar_detail &lt;ID&gt;</code> 로 다시 조회하면 신규 세미나로 감지되어 공지/알림 및 자동 신청이 실행됩니다.</i>`;
    }

    await replyWithSplit(ctx, replyMessage, { parse_mode: 'HTML' });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.error('createSeminarDeleteHandler error', e);
    await replyWithSplit(ctx, `세미나 삭제 실패: ${message}`);
  }
};
