import type { SeminarListItem } from '../services/seminar_repository';
import * as seminarRepo from '../services/seminar_repository';
import * as channelRepo from '../services/channel_message_repository';
import * as logger from '../services/logger';
import { getSeminarIdFromUrl, truncateSeminarName, formatPrivateSeminarTag } from '../modules/utils';
import { DEFAULT_NOTICE_OPTIONS, formatRecentCommentsSection } from '../services/channel_notice_service';

export { truncateSeminarName, formatPrivateSeminarTag };

export type SeminarFieldChange = {
  field: string;
  label: string;
  oldValue: string | number | boolean;
  newValue: string | number | boolean;
};

export type SeminarInfoChange = {
  seminarId: string;
  name: string;
  date?: string;
  url?: string;
  changes: SeminarFieldChange[];
};

export type SeminarPointChange = {
  seminarId: string;
  name: string;
  date?: string;
  url?: string;
  point?: number;
  pointText?: string;
  pointDate?: string;
  pointContent?: string;
};

export const MEANINGFUL_FIELDS: Array<{
  key: keyof SeminarListItem;
  label: string;
}> = [
  { key: 'date', label: '날짜' },
  { key: 'time', label: '시간' },
  { key: 'totalCount', label: '총원' },
  { key: 'isPointExcluded', label: '포인트미지급' },
  { key: 'isAdvancedSurvey', label: '심화설문' },
  { key: 'hiddenYn', label: '비공개' },
];

export const BOOLEAN_FIELDS = new Set<keyof SeminarListItem>(['isPointExcluded', 'isAdvancedSurvey']);

export function getSeminarInfoChanges(existing: SeminarListItem, incoming: SeminarListItem): SeminarFieldChange[] {
  const changes: SeminarFieldChange[] = [];
  for (const { key, label } of MEANINGFUL_FIELDS) {
    const oldVal = existing[key];
    const newVal = incoming[key];

    if (newVal === undefined && oldVal !== undefined) continue;

    // 기존 값이 undefined(또는 빈 문자열)였던 경우:
    // 이전에 상세 정보를 조회하지 못해 미확인 상태였다가 처음으로 값이 채워진 것이므로
    // "세미나 정보 변경" 알림 대상이 아님 (기존 값이 유효하게 존재했던 경우에만 변경 감지)
    if (oldVal === undefined || oldVal === '') continue;

    if (key === 'hiddenYn') {
      // 레거시 호환: 기존 DB 데이터에 hiddenYn이 마이그레이션되지 않았거나 'N'인 경우에도,
      // 기존 세미나의 isClosed가 true였다면 과거에 비공개로 취급되었던 세미나이므로 기존 비공개로 인정하여 알림 오발송 방지
      const oldIsPrivate = oldVal === 'Y' || oldVal === 'y' || existing.isClosed === true;
      const newIsPrivate = newVal === 'Y' || newVal === 'y';
      if (oldIsPrivate !== newIsPrivate) {
        changes.push({
          field: key,
          label,
          oldValue: oldIsPrivate,
          newValue: newIsPrivate,
        });
      }
      continue;
    }

    if (BOOLEAN_FIELDS.has(key)) {
      if (oldVal !== newVal) {
        changes.push({
          field: key,
          label,
          oldValue: oldVal as boolean,
          newValue: newVal as boolean,
        });
      }
      continue;
    }

    if (oldVal !== newVal) {
      changes.push({
        field: key,
        label,
        oldValue: (oldVal ?? '') as string | number | boolean,
        newValue: (newVal ?? '') as string | number | boolean,
      });
    }
  }
  return changes;
}

export function formatSeminarChangeNotification(
  infoChanges: SeminarInfoChange[],
  pointChanges: SeminarPointChange[],
): string | null {
  if (infoChanges.length === 0 && pointChanges.length === 0) {
    return null;
  }

  const sections: string[] = ['🔔 세미나 정보 변경 감지'];

  if (pointChanges.length > 0) {
    sections.push('[포인트 지급]');
    for (const p of pointChanges) {
      const lines: string[] = [];
      lines.push(p.name || '세미나');
      lines.push(`seminarId: ${p.seminarId}`);
      if (p.date) {
        lines.push(`날짜: ${p.date}`);
      }
      if (p.pointText || p.point !== undefined) {
        lines.push(`포인트: ${p.pointText || `${p.point}P`}`);
      }
      if (p.pointDate) {
        lines.push(`지급일: ${p.pointDate}`);
      }
      const targetUrl = p.url || (p.seminarId ? `https://m.doctorville.co.kr/cme/seminar/${p.seminarId}` : '');
      if (targetUrl) {
        lines.push(targetUrl);
      }
      sections.push(lines.join('\n'));
    }
  }

  if (infoChanges.length > 0) {
    if (pointChanges.length > 0) sections.push('');
    sections.push('[정보 변경]');
    for (const info of infoChanges) {
      const lines: string[] = [];
      lines.push(info.name || '세미나');
      lines.push(`seminarId: ${info.seminarId}`);
      if (info.date) {
        lines.push(`날짜: ${info.date}`);
      }
      for (const ch of info.changes) {
        lines.push(`${ch.label}: ${ch.oldValue} → ${ch.newValue}`);
      }
      const targetUrl = info.url || (info.seminarId ? `https://m.doctorville.co.kr/cme/seminar/${info.seminarId}` : '');
      if (targetUrl) {
        lines.push(targetUrl);
      }
      sections.push(lines.join('\n'));
    }
  }

  return sections.join('\n\n');
}

/**
 * 신규 세미나 모음 채널 공지 메시지 빌더
 * - 헤더: 🆕 오늘 추가된 세미나 모음 (누적 ${count}건)
 * - 정원 10명 미만 세미나는 표시에서 제외
 * - 세미나명: 20글자 초과 시 truncation
 * - 이번 회차 신규 세미나(newlyAddedIds)는 '✨ 방금 추가됨' 구분선(━ ✨ 방금 추가됨 ━━━━━)으로 감싸 강조
 * - 토론방 이전 댓글 섹션(최대 5개) 첨부
 * - link_preview_options: { is_disabled: true }
 */
export function buildNewSeminarsNoticeMessage(
  seminars: SeminarListItem[],
  newlyAddedIds?: string[] | Set<string>,
  comments: Array<{ userName: string; text: string }> = [],
): { text: string; options: Record<string, unknown> } {
  // 정원 10명 미만인 세미나는 공지 목록에서 제외하고, 발견 순서(detectedAt 오름차순)대로 정렬
  const visibleSeminars = seminars
    .filter((item) => {
      if (!item.totalCount || item.totalCount.trim() === '') return true;
      const parsed = parseInt(item.totalCount.replace(/[^0-9]/g, ''), 10);
      return isNaN(parsed) || parsed >= 10;
    })
    .sort((a, b) => {
      if (a.detectedAt && b.detectedAt) {
        return a.detectedAt.localeCompare(b.detectedAt);
      }
      return 0;
    });

  let text = `🆕 오늘 추가된 세미나 모음 (누적 ${visibleSeminars.length}건)\n\n`;

  const newIdSet =
    newlyAddedIds instanceof Set
      ? newlyAddedIds
      : new Set(newlyAddedIds ? newlyAddedIds.map((id) => String(id).trim()) : []);

  const formattedItems: string[] = [];

  for (let i = 0; i < visibleSeminars.length; i++) {
    const item = visibleSeminars[i];
    const sid = item.seminarId || getSeminarIdFromUrl(item.url) || '';
    const isHighlighted = newIdSet.has(sid);

    const tags: string[] = [];
    if (item.date || item.time) {
      tags.push(`[${item.date || ''}${item.date && item.time ? ' ' : ''}${item.time || ''}]`);
    }
    if (item.hiddenYn === 'Y' || item.hiddenYn === 'y') {
      tags.push('[비공개]');
      if (item.diseaseCategoryNm && item.diseaseCategoryNm.trim()) {
        tags.push(`[${item.diseaseCategoryNm.trim()}]`);
      }
    }
    if (item.isPointExcluded) {
      tags.push('[포인트미지급]');
    }
    if (item.isAdvancedSurvey) {
      tags.push('[심화설문]');
    }

    const prefix = tags.length > 0 ? `${tags.join(' ')} ` : '';
    const capacityInfo = item.currentCount && item.totalCount ? ` (${item.currentCount}/${item.totalCount})` : '';
    const truncatedName = truncateSeminarName(item.name || '세미나');

    const itemText = `${i + 1}. ${prefix}${truncatedName}${capacityInfo}\n${item.url}`;

    if (isHighlighted) {
      formattedItems.push(`━ ✨ 방금 추가됨 ━━━━━\n${itemText}\n━━━━━━━━━━━━━━━━`);
    } else {
      formattedItems.push(itemText);
    }
  }

  text += formattedItems.join('\n\n');

  // 이전 댓글 섹션 첨부 (최근 최대 5개)
  text += formatRecentCommentsSection(comments);

  return { text, options: DEFAULT_NOTICE_OPTIONS };
}

/**
 * 신규 세미나 모음 통합 메시지를 채널에 발송하고 이전 메시지를 안전하게 삭제/교체합니다.
 * - 댓글 보존: 기존 메시지에 연결된 댓글 조회 후 새 메시지 본문에 첨부
 * - 안전 가드: 댓글 확보 실패 또는 새 메시지 발송 실패 시 기존 메시지 유지
 */
export async function publishNewSeminarsNotice(
  seminars: SeminarListItem[],
  prevMessageId: number | null,
  newlyAddedIds?: string[] | Set<string>,
  comments?: Array<{ userName: string; text: string }>,
  _date?: string,
  channelId?: string,
): Promise<number | null> {
  const visibleSeminars = seminars.filter((item) => {
    if (!item.totalCount || item.totalCount.trim() === '') return true;
    const parsed = parseInt(item.totalCount.replace(/[^0-9]/g, ''), 10);
    return isNaN(parsed) || parsed >= 10;
  });

  if (visibleSeminars.length === 0) return prevMessageId;

  const result = await channelRepo.publishAndReplaceChannelNotice({
    channelId,
    prevMessageId,
    buildMessageFn: (commentsToAttach) =>
      buildNewSeminarsNoticeMessage(visibleSeminars, newlyAddedIds, commentsToAttach),
    customComments: comments,
    logPrefix: 'apply_seminar',
  });

  return result.newMessageId;
}

/**
 * 기존 공지 메시지 본문에서 '━ ✨ 방금 추가됨 ━━━━━'으로 감싸진 강조 블록의 세미나 ID 목록을 추출합니다.
 */
export function extractHighlightedSeminarIds(messageText?: string | null): string[] {
  if (!messageText) return [];
  const highlightedIds: string[] = [];
  const regex = /━ ✨ 방금 추가됨 ━━━━━([\s\S]*?)━━━━━━━━━━━━━━━━/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(messageText)) !== null) {
    const blockContent = match[1];
    const urlMatch = blockContent.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      const sid = getSeminarIdFromUrl(urlMatch[0]);
      if (sid) {
        highlightedIds.push(sid);
      }
    }
  }
  return highlightedIds;
}

/**
 * 오늘 발견된 세미나 누적 공지를 동기화합니다.
 * - newlyAdded.length > 0: 새 메시지 발행 및 이전 메시지 교체 (이번 회차 신규 세미나 강조)
 * - newlyAdded.length === 0: 기존 메시지가 있을 경우, 기존 강조 표시를 보존한 채 최신 세미나 목록/정원 정보로 메시지 인플레이스 수정 (editChannelMessage)
 */
export async function syncNewSeminarsNotice(
  referenceDate: string,
  newlyAdded: SeminarListItem[] = [],
  channelId?: string,
): Promise<number | null> {
  const targetChannelId = channelId || process.env.NOTICE_CHANNEL_ID;
  const prevMsg = channelRepo.getNewSeminarsChannelMessage(referenceDate, targetChannelId);
  const todayNewSeminars = seminarRepo.getSeminarsByDetectedDate(referenceDate);

  if (newlyAdded.length > 0) {
    const targetSeminars = todayNewSeminars.length > 0 ? todayNewSeminars : newlyAdded;
    const newlyAddedIds = newlyAdded.map((s) => s.seminarId || getSeminarIdFromUrl(s.url)).filter(Boolean) as string[];
    return await publishNewSeminarsNotice(
      targetSeminars,
      prevMsg ? prevMsg.messageId : null,
      newlyAddedIds,
      undefined,
      referenceDate,
      targetChannelId,
    );
  }

  // 신규 세미나가 없지만 오늘 기존 공지 메시지가 전송되어 있는 경우: 인플레이스 수정
  if (prevMsg && todayNewSeminars.length > 0) {
    const prevText = prevMsg.text || '';
    const highlightedIds = extractHighlightedSeminarIds(prevText);
    const commentRecords = channelRepo.getChannelCommentsByParentMessageId(prevMsg.messageId, targetChannelId);
    const comments = commentRecords.map((r) => ({ userName: r.userName, text: r.text }));

    const { text: newText } = buildNewSeminarsNoticeMessage(todayNewSeminars, highlightedIds, comments);

    if (newText.trim() !== prevText.trim()) {
      logger.info(`[apply_seminar] 오늘 발견된 세미나 누적 공지 정원/정보 수정 (Message ID: ${prevMsg.messageId})`);
      await channelRepo.editChannelMessage(prevMsg.messageId, newText, { channelId: targetChannelId });
    }
    return prevMsg.messageId;
  }

  return prevMsg ? prevMsg.messageId : null;
}
