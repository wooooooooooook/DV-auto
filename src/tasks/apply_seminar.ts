import path from 'path';
import fs from 'fs/promises';
import type { TaskContext, TaskResult } from '../types';
import { safeGoto, sendTelegram, getSeminarIdFromUrl, ensureLoggedIn } from '../modules/utils';
import {
  fetchMainFutureSeminars,
  fetchSeminarDetail,
  applySeminarWithTerms,
  convertApiItemToRawSeminar,
  convertApiItemToSeminarListItem,
  parseSeminarDateTime,
  checkIsAdvancedSurvey,
  checkIsPointExcluded,
  ProcessState,
} from '../modules/seminar_api';
import { searchSeminarPoints } from './check_seminar_point';
import * as storage from '../services/storage';
import * as logger from '../services/logger';
import * as seminarRepo from '../services/seminar_repository';
import { sendSeminarChangesToSubscribers } from '../services/seminar_subscribers';
import {
  sendNewSeminarToSubscribers,
  sendUrgentSeminarsToSubscribers,
  parseCapacityNumbers,
} from '../services/subscription_service';
import * as channelRepo from '../services/channel_message_repository';

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
export const SEMINAR_LIST_KEY = 'apply_seminar:seminar_list';
const LEGACY_NEW_SEMINAR_KEY = 'apply_seminar:new_seminars';
const LEGACY_HISTORY_KEY = 'apply_seminar:new_seminars_history';
const SEMINAR_RETENTION_DAYS = 60;

export type { SeminarListItem, SeminarPointStatus } from '../services/seminar_repository';
import type { SeminarListItem } from '../services/seminar_repository';

export const mergeSeminar = seminarRepo.mergeSeminarRecord;

export type SeminarFieldChange = {
  field: string;
  label: string;
  oldValue: string | number | boolean;
  newValue: string | number | boolean;
};

export type SeminarInfoChange = {
  seminarId: string;
  name: string;
  url?: string;
  changes: SeminarFieldChange[];
};

export type SeminarPointChange = {
  seminarId: string;
  name: string;
  url?: string;
  point?: number;
  pointText?: string;
  pointDate?: string;
  pointContent?: string;
};

type LegacyHistoryEntry = {
  detectedDate?: string;
  detectedAt?: string;
  seminar?: SeminarListItem;
};

type LegacyNewSeminars = {
  date?: string;
  seminars?: SeminarListItem[];
};

export type RawSeminarData = {
  seminarId?: string | null;
  url: string;
  name: string;
  date: string;
  time: string;
  currentCount: string;
  totalCount: string;
  nightTime: boolean;
  isAdvancedSurvey: boolean;
  isPointExcluded?: boolean;
  hasIcoApply?: boolean;
  processState?: number;
  cancelProcessState?: number;
  seminarCompleted?: number;
  isClosed?: boolean;
  hiddenYn?: string;
  diseaseCategoryNm?: string;
};

const MEANINGFUL_FIELDS: Array<{
  key: keyof SeminarListItem;
  label: string;
}> = [
  { key: 'date', label: '날짜' },
  { key: 'time', label: '시간' },
  { key: 'totalCount', label: '총원' },
  { key: 'isPointExcluded', label: '포인트미지급' },
  { key: 'isAdvancedSurvey', label: '심화설문' },
  { key: 'diseaseCategoryNm', label: '질환분류' },
  { key: 'isClosed', label: '비공개' },
];

/**
 * processState 기반 신청 완료 여부 판정
 * PROCESS_CANCEL(3) = 이미 신청 완료 (취소 가능 상태)
 * PROCESS_ENTER(1) = 입장 가능 (신청 완료)
 * PROCESS_STARTED(6), PROCESS_END(7), PROCESS_COMPLETED(8) = 이미 진행/종료
 */
export function isAppliedSeminar(processState?: number): boolean {
  if (processState === undefined) return false;
  return (
    [
      ProcessState.PROCESS_CANCEL,
      ProcessState.PROCESS_ENTER,
      ProcessState.PROCESS_STARTED,
      ProcessState.PROCESS_END,
      ProcessState.PROCESS_COMPLETED,
    ] as number[]
  ).includes(processState);
}

export function getSeminarInfoChanges(existing: SeminarListItem, incoming: SeminarListItem): SeminarFieldChange[] {
  const changes: SeminarFieldChange[] = [];
  for (const { key, label } of MEANINGFUL_FIELDS) {
    const oldVal = existing[key];
    const newVal = incoming[key];

    if (newVal === undefined && oldVal !== undefined) continue;

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

function normalizeSeminarDate(value: string | undefined, referenceDate: string): string | null {
  if (!value) return null;
  const text = value.trim();
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  const md = text.match(/^(\d{1,2})\s*[-/.]\s*(\d{1,2})/);
  const korean = text.match(/^(\d{1,2})월\s*(\d{1,2})일?/);
  let year: number;
  let month: number;
  let day: number;
  if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else if (md || korean) {
    month = Number((md || korean)![1]);
    day = Number((md || korean)![2]);
    const [refYear, refMonth] = referenceDate.split('-').map(Number);
    if (!Number.isFinite(refYear) || !Number.isFinite(refMonth)) return null;
    year = refYear;
    if (month - refMonth > 6) year--;
    else if (refMonth - month > 6) year++;
  } else {
    return null;
  }
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function normalizeParsedSeminars(raw: RawSeminarData[], referenceDate: string): SeminarListItem[] {
  return raw.map((item) => {
    const url = new URL(item.url, SEMINAR_PAGE).toString();
    return {
      seminarId: getSeminarIdFromUrl(url),
      url,
      name: item.name,
      date: normalizeSeminarDate(item.date, referenceDate) ?? item.date,
      time: item.time,
      currentCount: item.currentCount,
      totalCount: item.totalCount,
      nightTime: item.nightTime,
      isAdvancedSurvey: item.isAdvancedSurvey,
      isPointExcluded: item.isPointExcluded,
    };
  });
}

function seminarKey(seminar: Pick<SeminarListItem, 'url' | 'seminarId'>): string {
  return seminar.seminarId || seminar.url;
}

function migrateLegacySeminarStorage(referenceDate: string): SeminarListItem[] {
  const legacyHistory = storage.get<LegacyHistoryEntry[]>(LEGACY_HISTORY_KEY, []) || [];
  const legacyNew = storage.get<LegacyNewSeminars>(LEGACY_NEW_SEMINAR_KEY);

  if (legacyHistory.length > 0 || legacyNew?.seminars?.length) {
    const toUpsert: SeminarListItem[] = [];

    for (const entry of legacyHistory) {
      if (!entry.seminar) continue;
      toUpsert.push({
        ...entry.seminar,
        detectedDate: entry.seminar.detectedDate ?? entry.detectedDate,
        detectedAt: entry.seminar.detectedAt ?? entry.detectedAt,
      });
    }

    for (const seminar of legacyNew?.seminars || []) {
      toUpsert.push({
        ...seminar,
        detectedDate: seminar.detectedDate ?? legacyNew?.date,
      });
    }

    if (toUpsert.length > 0) {
      seminarRepo.upsertSeminars(toUpsert);
    }
    storage.deleteKey(LEGACY_NEW_SEMINAR_KEY);
    storage.deleteKey(LEGACY_HISTORY_KEY);
  }

  seminarRepo.deleteExpiredSeminars(referenceDate, SEMINAR_RETENTION_DAYS);
  return seminarRepo.getAllSeminars();
}

export function refreshStoredSeminarList(
  current: SeminarListItem[],
  stored: SeminarListItem[],
  referenceDate: string,
): { seminars: SeminarListItem[]; newlyAdded: SeminarListItem[]; infoChanges: SeminarInfoChange[] } {
  const storedByKey = new Map(stored.map((seminar) => [seminarKey(seminar), seminar]));
  const newlyAdded = current.filter((seminar) => !storedByKey.has(seminarKey(seminar)));
  const infoChanges: SeminarInfoChange[] = [];
  const now = new Date().toISOString();

  for (const seminar of current) {
    const key = seminarKey(seminar);
    const existing = storedByKey.get(key);

    if (existing) {
      const fieldChanges = getSeminarInfoChanges(existing, seminar);
      if (fieldChanges.length > 0) {
        infoChanges.push({
          seminarId: existing.seminarId || seminar.seminarId || '',
          name: seminar.name || existing.name || '',
          url:
            seminar.url ||
            existing.url ||
            (seminar.seminarId ? `https://m.doctorville.co.kr/cme/seminar/${seminar.seminarId}` : ''),
          changes: fieldChanges,
        });
      }
    }

    storedByKey.set(
      key,
      mergeSeminar(existing, {
        ...seminar,
        detectedDate: existing?.detectedDate ?? referenceDate,
        detectedAt: existing?.detectedAt ?? now,
      }),
    );
  }

  const todayMs = Date.parse(`${referenceDate}T00:00:00+09:00`);
  const retentionMs = SEMINAR_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const seminars = [...storedByKey.values()].filter((seminar) => {
    const reference = normalizeSeminarDate(seminar.date, seminar.detectedDate || referenceDate) || seminar.detectedDate;
    if (!reference) return true;
    const dateMs = Date.parse(`${reference}T00:00:00+09:00`);
    return Number.isNaN(dateMs) || Number.isNaN(todayMs) || todayMs - dateMs <= retentionMs;
  });

  return { seminars, newlyAdded, infoChanges };
}

/**
 * 세미나명 20글자 truncation 포맷터 (20글자 초과 시 20글자 + '...')
 */
export function truncateSeminarName(name: string, maxLen = 20): string {
  const trimmed = (name || '').trim();
  if (trimmed.length > maxLen) {
    return `${trimmed.slice(0, maxLen)}...`;
  }
  return trimmed;
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
    if (item.isClosed || item.hiddenYn === 'Y') {
      tags.push('[비공개]');
    }
    if (item.diseaseCategoryNm && item.diseaseCategoryNm.trim()) {
      tags.push(`[${item.diseaseCategoryNm.trim()}]`);
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
      formattedItems.push(`━ ✨ 방금 추가됨 ━━━━━\n${itemText}\n━━━━━━━━━━━━━━━━━━━━━`);
    } else {
      formattedItems.push(itemText);
    }
  }

  text += formattedItems.join('\n\n');

  // 이전 댓글 섹션 첨부 (최근 최대 5개)
  if (comments.length > 0) {
    text += `\n\n💬 [이전 댓글]\n`;
    const recentComments = comments.slice(-5);
    for (const c of recentComments) {
      const cleanText = c.text.replace(/\n/g, ' ').slice(0, 100);
      text += `• ${c.userName}: ${cleanText}\n`;
    }
  }

  const options: Record<string, unknown> = {
    link_preview_options: {
      is_disabled: true,
    },
  };

  return { text, options };
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
  const regex = /━ ✨ 방금 추가됨 ━━━━━([\s\S]*?)━━━━━━━━━━━━━━━━━━━━━/g;
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

async function fetchAndPopulateSeminarInfo(
  seminarId: string,
  fallbackDate?: string,
): Promise<Partial<SeminarListItem>> {
  try {
    const detailRes = await fetchSeminarDetail(seminarId);
    if (!detailRes.success || !detailRes.rawResponse?.seminarDetail) {
      return {};
    }
    const d = detailRes.rawResponse.seminarDetail;
    const startDt = typeof d.startDt === 'string' ? d.startDt : undefined;
    const endDt = typeof d.endDt === 'string' ? d.endDt : undefined;
    const { date, time, nightTime } = parseSeminarDateTime(startDt, endDt);
    const isAdvancedSurvey = checkIsAdvancedSurvey(d.useDepthSurvey);
    const isPointExcluded = detailRes.isPointExcluded ?? checkIsPointExcluded(d.intro);
    const processStateNum = d.processState !== undefined ? Number(d.processState) : undefined;
    const cancelProcessStateNum = d.cancelProcessState !== undefined ? Number(d.cancelProcessState) : undefined;
    const seminarCompletedNum =
      d.seminarCompleted !== undefined
        ? typeof d.seminarCompleted === 'boolean'
          ? d.seminarCompleted
            ? 1
            : 0
          : Number(d.seminarCompleted)
        : undefined;

    let detectedDate = date;
    if (!detectedDate && typeof d.createDt === 'string') {
      detectedDate = d.createDt.split(' ')[0] || '';
    }
    if (!detectedDate && fallbackDate) {
      detectedDate = fallbackDate;
    }

    const hiddenYn = typeof d.hiddenYn === 'string' ? d.hiddenYn : undefined;
    const isClosed = hiddenYn === 'Y' || hiddenYn === 'y';
    const diseaseCategoryNm = typeof d.diseaseCategoryNm === 'string' ? d.diseaseCategoryNm : undefined;

    return {
      name: typeof d.seminarNm === 'string' ? d.seminarNm : '',
      date,
      time,
      nightTime,
      currentCount: d.applyCnt !== undefined && d.applyCnt !== null ? String(d.applyCnt) : '',
      totalCount: d.maxPeopleCnt !== undefined && d.maxPeopleCnt !== null ? String(d.maxPeopleCnt) : '',
      isAdvancedSurvey,
      isPointExcluded,
      processState: processStateNum,
      cancelProcessState: cancelProcessStateNum,
      seminarCompleted: seminarCompletedNum,
      isClosed,
      hiddenYn,
      diseaseCategoryNm,
      detectedDate: detectedDate || '',
    };
  } catch (err) {
    logger.warn(`Failed to fetch seminar detail for ID ${seminarId}:`, err);
    return {};
  }
}

export const LAST_ENRICH_TIMESTAMP_KEY = 'apply_seminar:last_enrich_timestamp';
export const ENRICH_INTERVAL_MS = 60 * 60 * 1000;

export function shouldRunEnrich(forceEnrich?: boolean): boolean {
  if (forceEnrich) return true;
  const lastTime = storage.get<number>(LAST_ENRICH_TIMESTAMP_KEY, 0);
  return Date.now() - lastTime >= ENRICH_INTERVAL_MS;
}

export function recordEnrichTime(): void {
  storage.set(LAST_ENRICH_TIMESTAMP_KEY, Date.now());
}

/**
 * 모든 세미나의 상세(detail) API를 조회하여 isPointExcluded 및 최신 메타데이터 갱신
 * - 과부하 방지를 위해 Concurrency 2 및 요청 간 150ms 딜레이 적용
 */
export async function enrichSeminarsWithDetail(
  seminars: SeminarListItem[],
  concurrency = 2,
  delayMs = 150,
): Promise<{ seminars: SeminarListItem[]; isAuthExpired: boolean }> {
  let isAuthExpired = false;
  const enriched: SeminarListItem[] = [];

  for (let i = 0; i < seminars.length; i += concurrency) {
    if (isAuthExpired) break;
    const chunk = seminars.slice(i, i + concurrency);

    const chunkResults = await Promise.all(
      chunk.map(async (item) => {
        if (isAuthExpired) return item;
        const seminarId = item.seminarId || getSeminarIdFromUrl(item.url);
        if (!seminarId) return item;

        try {
          const detailRes = await fetchSeminarDetail(seminarId);
          if (detailRes.isAuthExpired) {
            isAuthExpired = true;
            return item;
          }

          if (detailRes.success && detailRes.rawResponse?.seminarDetail) {
            const d = detailRes.rawResponse.seminarDetail;
            const isPointExcluded = detailRes.isPointExcluded ?? checkIsPointExcluded(d.intro);
            const isAdvancedSurvey = checkIsAdvancedSurvey(d.useDepthSurvey);
            const processStateNum = d.processState !== undefined ? Number(d.processState) : item.processState;
            const cancelProcessStateNum =
              d.cancelProcessState !== undefined ? Number(d.cancelProcessState) : item.cancelProcessState;
            const seminarCompletedNum =
              d.seminarCompleted !== undefined
                ? typeof d.seminarCompleted === 'boolean'
                  ? d.seminarCompleted
                    ? 1
                    : 0
                  : Number(d.seminarCompleted)
                : item.seminarCompleted;
            const hiddenYn = typeof d.hiddenYn === 'string' ? d.hiddenYn : item.hiddenYn;
            const isClosed = hiddenYn === 'Y' || hiddenYn === 'y' || item.isClosed;
            const diseaseCategoryNm =
              typeof d.diseaseCategoryNm === 'string' ? d.diseaseCategoryNm : item.diseaseCategoryNm;

            return {
              ...item,
              name: typeof d.seminarNm === 'string' && d.seminarNm ? d.seminarNm : item.name,
              currentCount: d.applyCnt !== undefined && d.applyCnt !== null ? String(d.applyCnt) : item.currentCount,
              totalCount:
                d.maxPeopleCnt !== undefined && d.maxPeopleCnt !== null ? String(d.maxPeopleCnt) : item.totalCount,
              isAdvancedSurvey,
              isPointExcluded,
              processState: processStateNum,
              cancelProcessState: cancelProcessStateNum,
              seminarCompleted: seminarCompletedNum,
              isClosed,
              hiddenYn,
              diseaseCategoryNm,
            };
          }
        } catch (err) {
          logger.warn(`enrichSeminarsWithDetail: ID ${seminarId} 상세 조회 실패`, err);
        }
        return item;
      }),
    );

    enriched.push(...chunkResults);

    if (i + concurrency < seminars.length && delayMs > 0 && !isAuthExpired) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (enriched.length < seminars.length) {
    enriched.push(...seminars.slice(enriched.length));
  }

  return { seminars: enriched, isAuthExpired };
}

export function convertSeminarListItemToRawSeminar(item: SeminarListItem): RawSeminarData {
  return {
    seminarId: item.seminarId,
    url: item.url,
    name: item.name,
    date: item.date || '',
    time: item.time,
    currentCount: item.currentCount,
    totalCount: item.totalCount,
    nightTime: item.nightTime,
    isAdvancedSurvey: item.isAdvancedSurvey,
    isPointExcluded: item.isPointExcluded,
    hasIcoApply: item.processState === ProcessState.PROCESS_APPLY,
    processState: item.processState,
    cancelProcessState: item.cancelProcessState,
    seminarCompleted: item.seminarCompleted,
    isClosed: item.isClosed,
    hiddenYn: item.hiddenYn,
    diseaseCategoryNm: item.diseaseCategoryNm,
  };
}

export const CHECKED_GAP_SEMINAR_IDS_KEY = 'apply_seminar:checked_gap_ids';

/**
 * mainFuture API 결과 목록(currentSeminars) 내의 세미나 ID 불연속(Gap)을 탐색하여 누락된 비공개 세미나를 발굴합니다.
 * - mainFuture API 목록의 ID들을 오름차순 정렬하여 최소 ID ~ 최대 ID 사이에서 누락된 정수 ID(Gap) 추출
 * - 이미 DB에 저장되어 있거나(storedSeminars) 확인 완료된 캐시(checkedGapIds)는 제외
 * - 누락된 각 ID에 대해 fetchSeminarDetail을 호출하여 상세 정보 조회
 * - 정원(maxPeopleCnt)이 100명 이상인 세미나만 비공개 세미나([비공개])로 등록 및 반환
 * - 정원이 100명 미만이거나 조회 실패/존재하지 않는 ID는 CHECKED_GAP_SEMINAR_IDS_KEY에 기록하여 중복 호출 방지
 */
export async function discoverMissingGapSeminars(
  currentSeminars: SeminarListItem[] = [],
  storedSeminars: SeminarListItem[] = [],
  referenceDate: string = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }),
  options: { maxCheckRange?: number; concurrency?: number; delayMs?: number } = {},
): Promise<{ gapSeminars: SeminarListItem[]; isAuthExpired: boolean }> {
  const { maxCheckRange = 50, concurrency = 2, delayMs = 150 } = options;

  // 1. mainFuture API 결과(currentSeminars)의 숫자 seminarId 목록 추출
  const mainFutureNumericIds: number[] = [];
  for (const s of currentSeminars) {
    const rawId = s.seminarId || getSeminarIdFromUrl(s.url);
    if (rawId) {
      const num = parseInt(String(rawId).replace(/[^0-9]/g, ''), 10);
      if (!Number.isNaN(num) && num > 0) {
        mainFutureNumericIds.push(num);
      }
    }
  }

  // mainFuture 결과에 2개 이상의 ID가 있어야 그 사이의 불연속(Gap)을 판별할 수 있음
  if (mainFutureNumericIds.length < 2) {
    return { gapSeminars: [], isAuthExpired: false };
  }

  const sortedMainFutureIds = Array.from(new Set(mainFutureNumericIds)).sort((a, b) => a - b);
  const minMainFutureId = sortedMainFutureIds[0];
  const maxMainFutureId = sortedMainFutureIds[sortedMainFutureIds.length - 1];
  const minCheckId = Math.max(minMainFutureId, maxMainFutureId - maxCheckRange);

  const mainFutureIdSet = new Set<number>(sortedMainFutureIds);

  // 2. 이미 DB에 저장된 ID 목록 및 확인 완료된 무효 ID 캐시 조회
  const storedIdSet = new Set<number>();
  for (const s of storedSeminars) {
    const rawId = s.seminarId || getSeminarIdFromUrl(s.url);
    if (rawId) {
      const num = parseInt(String(rawId).replace(/[^0-9]/g, ''), 10);
      if (!Number.isNaN(num) && num > 0) {
        storedIdSet.add(num);
      }
    }
  }

  const checkedGapIdsList = storage.get<number[]>(CHECKED_GAP_SEMINAR_IDS_KEY, []) || [];
  const checkedGapSet = new Set<number>(checkedGapIdsList);

  // 3. mainFuture 목록에서 빠져 있고, 아직 DB나 캐시에 없는 누락된 갭 ID 추출 (minCheckId ~ maxMainFutureId 사이)
  const missingGapIds: number[] = [];
  for (let id = minCheckId; id < maxMainFutureId; id++) {
    if (!mainFutureIdSet.has(id) && !storedIdSet.has(id) && !checkedGapSet.has(id)) {
      missingGapIds.push(id);
    }
  }

  if (missingGapIds.length === 0) {
    return { gapSeminars: [], isAuthExpired: false };
  }

  let isAuthExpired = false;
  const discoveredGapSeminars: SeminarListItem[] = [];
  const newlyCheckedIds: number[] = [];
  const nowIso = new Date().toISOString();

  // 4. Concurrency 기반으로 누락된 ID 상세 조회
  for (let i = 0; i < missingGapIds.length; i += concurrency) {
    if (isAuthExpired) break;
    const chunk = missingGapIds.slice(i, i + concurrency);

    await Promise.all(
      chunk.map(async (gapId) => {
        if (isAuthExpired) return;
        const sid = String(gapId);
        try {
          const detailRes = await fetchSeminarDetail(sid);
          if (detailRes.isAuthExpired) {
            isAuthExpired = true;
            return;
          }

          if (detailRes.success && detailRes.rawResponse?.seminarDetail) {
            const d = detailRes.rawResponse.seminarDetail;
            const maxPeopleCnt =
              d.maxPeopleCnt !== undefined && d.maxPeopleCnt !== null
                ? parseInt(String(d.maxPeopleCnt).replace(/[^0-9]/g, ''), 10)
                : 0;

            // 정원이 100명 이상인 경우에만 비공개 세미나로 등록
            if (!Number.isNaN(maxPeopleCnt) && maxPeopleCnt >= 100) {
              const startDt = typeof d.startDt === 'string' ? d.startDt : undefined;
              const endDt = typeof d.endDt === 'string' ? d.endDt : undefined;
              const { date, time, nightTime } = parseSeminarDateTime(startDt, endDt);
              const isAdvancedSurvey = checkIsAdvancedSurvey(d.useDepthSurvey);
              const isPointExcluded = detailRes.isPointExcluded ?? checkIsPointExcluded(d.intro);
              const processStateNum = d.processState !== undefined ? Number(d.processState) : undefined;
              const cancelProcessStateNum =
                d.cancelProcessState !== undefined ? Number(d.cancelProcessState) : undefined;
              const seminarCompletedNum =
                d.seminarCompleted !== undefined
                  ? typeof d.seminarCompleted === 'boolean'
                    ? d.seminarCompleted
                      ? 1
                      : 0
                    : Number(d.seminarCompleted)
                  : undefined;
              const hiddenYn = typeof d.hiddenYn === 'string' ? d.hiddenYn : 'Y';
              const diseaseCategoryNm = typeof d.diseaseCategoryNm === 'string' ? d.diseaseCategoryNm : undefined;

              const newItem: SeminarListItem = {
                seminarId: sid,
                name: typeof d.seminarNm === 'string' && d.seminarNm ? d.seminarNm : '비공개 세미나',
                url: `https://m.doctorville.co.kr/cme/seminar/${sid}`,
                date,
                time,
                nightTime,
                currentCount: d.applyCnt !== undefined && d.applyCnt !== null ? String(d.applyCnt) : '',
                totalCount: String(maxPeopleCnt),
                isAdvancedSurvey,
                isPointExcluded,
                processState: processStateNum,
                cancelProcessState: cancelProcessStateNum,
                seminarCompleted: seminarCompletedNum,
                isClosed: true,
                hiddenYn,
                diseaseCategoryNm,
                detectedDate: referenceDate,
                detectedAt: nowIso,
              };

              discoveredGapSeminars.push(newItem);
              return;
            }
          }

          // 유효하지 않거나 정원 100명 미만인 경우 캐싱 목록에 추가
          newlyCheckedIds.push(gapId);
        } catch (err) {
          logger.warn(`discoverMissingGapSeminars: ID ${sid} 조회 실패`, err);
          newlyCheckedIds.push(gapId);
        }
      }),
    );

    if (i + concurrency < missingGapIds.length && delayMs > 0 && !isAuthExpired) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // 5. 새로 검사된 gapId 캐시 갱신 (최근 최대 500개 보관)
  if (newlyCheckedIds.length > 0) {
    const updatedCheckedList = Array.from(new Set([...checkedGapIdsList, ...newlyCheckedIds])).slice(-500);
    storage.set(CHECKED_GAP_SEMINAR_IDS_KEY, updatedCheckedList);
  }

  return { gapSeminars: discoveredGapSeminars, isAuthExpired };
}

export async function refreshSeminarPointStatus(
  _context?: TaskContext['context'],
  seminars: SeminarListItem[] = [],
): Promise<{ seminars: SeminarListItem[]; pointChanges: SeminarPointChange[] }> {
  const searchRes = await searchSeminarPoints(undefined, [], 60);
  if (!searchRes.success) {
    console.warn(
      'refreshSeminarPointStatus: point history query failed, keeping seminar_list status intact:',
      searchRes.error,
    );
    return { seminars, pointChanges: [] };
  }
  const parsedPoints = searchRes.points;
  const checkedAt = new Date().toISOString();
  const pointChanges: SeminarPointChange[] = [];

  const changedSeminars: SeminarListItem[] = [];

  const updatedSeminars: SeminarListItem[] = [];
  for (const seminar of seminars) {
    const id = seminar.seminarId || getSeminarIdFromUrl(seminar.url);
    let currentItem = { ...seminar };
    let hasChanged = false;

    // 만약 기존 세미나 메타데이터(이름 또는 일자)가 비어 있는 경우, detail API로 정보 채우기
    if (id && (!currentItem.name || !currentItem.date)) {
      const extra = await fetchAndPopulateSeminarInfo(id, currentItem.detectedDate || currentItem.date);
      currentItem = {
        ...currentItem,
        name: extra.name || currentItem.name || '',
        date: extra.date || currentItem.date || '',
        time: extra.time || currentItem.time || '',
        nightTime: extra.nightTime ?? currentItem.nightTime ?? false,
        currentCount: extra.currentCount || currentItem.currentCount || '',
        totalCount: extra.totalCount || currentItem.totalCount || '',
        isAdvancedSurvey: extra.isAdvancedSurvey ?? currentItem.isAdvancedSurvey ?? false,
        isPointExcluded: extra.isPointExcluded ?? currentItem.isPointExcluded,
        processState: extra.processState ?? currentItem.processState,
        cancelProcessState: extra.cancelProcessState ?? currentItem.cancelProcessState,
        seminarCompleted: extra.seminarCompleted ?? currentItem.seminarCompleted,
        detectedDate: extra.detectedDate || currentItem.detectedDate || '',
      };
      hasChanged = true;
    }

    if (currentItem.pointPaid === true) {
      if (hasChanged) {
        changedSeminars.push(currentItem);
      }
      updatedSeminars.push(currentItem);
      continue;
    }

    if (id && parsedPoints.has(id)) {
      const pointResult = parsedPoints.get(id)!;
      if (pointResult.found && pointResult.type === '적립') {
        pointChanges.push({
          seminarId: id,
          name: currentItem.name,
          url: id ? `https://m.doctorville.co.kr/cme/seminar/${id}` : currentItem.url,
          point: pointResult.point,
          pointText: pointResult.pointText,
          pointDate: pointResult.date,
          pointContent: pointResult.content,
        });

        const updatedItem: SeminarListItem = {
          ...currentItem,
          pointPaid: true,
          point: pointResult.point,
          pointDate: pointResult.date,
          pointText: pointResult.pointText,
          pointContent: pointResult.content,
          pointCheckedAt: checkedAt,
        };
        changedSeminars.push(updatedItem);
        updatedSeminars.push(updatedItem);
        continue;
      }
    }

    const updatedItem: SeminarListItem = {
      ...currentItem,
      pointPaid: false,
      pointCheckedAt: checkedAt,
    };
    changedSeminars.push(updatedItem);
    updatedSeminars.push(updatedItem);
  }

  for (const [id, pointResult] of parsedPoints) {
    if (!pointResult.found || pointResult.type !== '적립') continue;

    const exists = updatedSeminars.some((item) => (item.seminarId || getSeminarIdFromUrl(item.url)) === id);
    if (!exists) {
      // 포인트 목록에서만 신규 발견된 경우: seminar detail API로 세미나 메타데이터 채우기
      const detailInfo = await fetchAndPopulateSeminarInfo(id, pointResult.date);

      const newItem: SeminarListItem = {
        seminarId: id,
        name: detailInfo.name || '',
        url: `https://m.doctorville.co.kr/cme/seminar/${id}`,
        date: detailInfo.date || '',
        time: detailInfo.time || '',
        currentCount: detailInfo.currentCount || '',
        totalCount: detailInfo.totalCount || '',
        nightTime: detailInfo.nightTime ?? false,
        isAdvancedSurvey: detailInfo.isAdvancedSurvey ?? false,
        isPointExcluded: detailInfo.isPointExcluded ?? false,
        processState: detailInfo.processState,
        cancelProcessState: detailInfo.cancelProcessState,
        seminarCompleted: detailInfo.seminarCompleted,
        pointPaid: true,
        point: pointResult.point,
        pointDate: pointResult.date,
        pointText: pointResult.pointText,
        pointContent: pointResult.content,
        pointCheckedAt: checkedAt,
        detectedDate: detailInfo.detectedDate || '',
        detectedAt: checkedAt,
      };
      changedSeminars.push(newItem);
      updatedSeminars.push(newItem);

      pointChanges.push({
        seminarId: id,
        name: newItem.name,
        url: newItem.url || `https://m.doctorville.co.kr/cme/seminar/${id}`,
        point: pointResult.point,
        pointText: pointResult.pointText,
        pointDate: pointResult.date,
        pointContent: pointResult.content,
      });
    }
  }

  if (changedSeminars.length > 0) {
    seminarRepo.upsertSeminars(changedSeminars);
  }
  return { seminars: updatedSeminars, pointChanges };
}

export type ApplySeminarOptions = {
  checkAdvancedPointStatus?: boolean;
  notifyNewSeminarsToChannel?: boolean;
  notifyNewSeminarsToTelegram?: boolean;
  silentIfNoNew?: boolean;
  forceEnrich?: boolean;
  _checkAdvancedPointStatus?: boolean;
};

async function run(ctx: TaskContext = {}, options: ApplySeminarOptions = {}): Promise<TaskResult> {
  const { notifyNewSeminarsToChannel = true, notifyNewSeminarsToTelegram: _notifyNewSeminarsToTelegram = true } =
    options;

  let currentSeminars: RawSeminarData[] = [];
  let normalizedCurrentSeminars: SeminarListItem[] = [];
  const referenceDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

  try {
    const apiRes = await fetchMainFutureSeminars();
    if (!apiRes.success) {
      if (apiRes.isAuthExpired) {
        const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
        await sendTelegram(msg).catch(() => {});
        return { success: false, message: msg };
      }
      throw new Error(apiRes.errorMessage || 'fetchMainFutureSeminars 실패');
    }
    currentSeminars = apiRes.items.map(convertApiItemToRawSeminar);
    normalizedCurrentSeminars = apiRes.items.map((item) => convertApiItemToSeminarListItem(item, referenceDate));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('apply_seminar HTTP pre-check error:', message);
    await sendTelegram(`❗ 세미나 신청 작업 오류: ${message}`).catch(() => {});
    return { success: false, message: `세미나 신청 작업 오류: ${message}` };
  }

  const storedSeminars = migrateLegacySeminarStorage(referenceDate);

  // 최근 세미나 ID 불연속(Gap) 탐색으로 정원 100명 이상 비공개 세미나 발굴
  const { gapSeminars, isAuthExpired: gapAuthExpired } = await discoverMissingGapSeminars(
    normalizedCurrentSeminars,
    storedSeminars,
    referenceDate,
  );
  if (gapAuthExpired) {
    const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
    await sendTelegram(msg).catch(() => {});
    return { success: false, message: msg };
  }
  if (gapSeminars.length > 0) {
    normalizedCurrentSeminars.push(...gapSeminars);
    currentSeminars.push(...gapSeminars.map(convertSeminarListItemToRawSeminar));
  }

  // 1시간에 1번(또는 forceEnrich=true)만 상세(detail) API를 조회하여 최신 메타데이터 갱신
  let enrichedSeminars = normalizedCurrentSeminars;
  if (shouldRunEnrich(options.forceEnrich)) {
    const { seminars: resSeminars, isAuthExpired: detailAuthExpired } =
      await enrichSeminarsWithDetail(normalizedCurrentSeminars);
    if (detailAuthExpired) {
      const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
      await sendTelegram(msg).catch(() => {});
      return { success: false, message: msg };
    }
    enrichedSeminars = resSeminars;
    recordEnrichTime();
  }

  const { seminars, newlyAdded, infoChanges } = refreshStoredSeminarList(
    enrichedSeminars,
    storedSeminars,
    referenceDate,
  );

  if (seminars.length > 0) {
    seminarRepo.upsertSeminars(seminars);
  }

  if (notifyNewSeminarsToChannel) {
    await syncNewSeminarsNotice(referenceDate, newlyAdded);
  }

  if (newlyAdded.length > 0) {
    await sendNewSeminarToSubscribers(
      newlyAdded,
      newlyAdded.map((s) => s.seminarId || getSeminarIdFromUrl(s.url)).filter(Boolean) as string[],
    ).catch(() => {});
  }

  // 마감 임박(잔여 1,000명 이하) 진입 세미나 감지 및 알림 발송
  const newUrgentSeminars: SeminarListItem[] = [];
  for (const s of enrichedSeminars) {
    const sid = s.seminarId || getSeminarIdFromUrl(s.url);
    if (!sid) continue;
    const { total, remaining } = parseCapacityNumbers(s);
    if (total > 0 && remaining <= 1000) {
      const stored = storedSeminars.find((item) => (item.seminarId || getSeminarIdFromUrl(item.url)) === sid);
      if (!stored?.urgentNotified) {
        newUrgentSeminars.push(s);
      }
    }
  }

  if (newUrgentSeminars.length > 0) {
    await sendUrgentSeminarsToSubscribers(newUrgentSeminars).catch(() => {});
    for (const u of newUrgentSeminars) {
      const sid = u.seminarId || getSeminarIdFromUrl(u.url);
      if (sid) {
        seminarRepo.markSeminarUrgentNotified(sid);
      }
    }
  }

  const finalSeminars = seminarRepo.getAllSeminars();
  const pointStatusResult = await refreshSeminarPointStatus(ctx.context, finalSeminars);
  const pointChanges = pointStatusResult.pointChanges;

  const changeNotificationText = formatSeminarChangeNotification(infoChanges, pointChanges);
  if (changeNotificationText) {
    await sendTelegram(changeNotificationText).catch(() => {});
    await sendSeminarChangesToSubscribers(changeNotificationText).catch(() => {});
  }

  // API processState 기반: 미신청 && PROCESS_APPLY 세미나만 Playwright 대상
  const applyTargets = currentSeminars.filter(
    (s) => !isAppliedSeminar(s.processState) && s.processState === ProcessState.PROCESS_APPLY,
  );
  const hasApplyTarget = applyTargets.length > 0;

  const totalSeminarsAvailable = currentSeminars.length;

  if (!hasApplyTarget) {
    // API 경로: processState 기반으로 정확한 신청 완료 건수 계산
    const appliedCount = currentSeminars.filter((s) => isAppliedSeminar(s.processState)).length;
    const completionCount = appliedCount;

    const unappliedCount = totalSeminarsAvailable - completionCount;
    let message: string;
    if (unappliedCount <= 0) {
      message = `✅ ${completionCount}개 세미나 신청 완료! (${completionCount}/${totalSeminarsAvailable})`;
    } else {
      const excessCount = currentSeminars.filter((s) => s.processState === ProcessState.PROCESS_EXCESS).length;
      message = `✅ ${completionCount}개 세미나 신청 완료 (${completionCount}/${totalSeminarsAvailable})`;
      if (excessCount > 0) {
        message += `\n⚠️ ${excessCount}개 정원 초과로 신청 불가`;
      }
      const otherUnapplied = unappliedCount - excessCount;
      if (otherUnapplied > 0) {
        message += `\n📋 ${otherUnapplied}개 미신청 (대기 중/신청 필요)`;
      }
    }

    const result: TaskResult = { success: true, message };
    if (options.silentIfNoNew && newlyAdded.length === 0) result.silent = true;
    return result;
  }

  // applyTargets에서 seminarId 추출 (상세페이지 직접 진입용)
  const targetSeminarIds: string[] = [];
  const invalidTargets: RawSeminarData[] = [];

  for (const target of applyTargets) {
    const id = target.seminarId || getSeminarIdFromUrl(target.url);
    if (id) {
      targetSeminarIds.push(id);
    } else {
      invalidTargets.push(target);
    }
  }

  if (invalidTargets.length > 0 || targetSeminarIds.length === 0) {
    const failedNames = invalidTargets.map((t) => t.name || t.url).join(', ');
    const errorMessage = `신청 대상 세미나 ID(seminarId) 추출 실패 (${invalidTargets.length}건: ${failedNames})`;
    console.error('apply_seminar seminarId extraction error:', errorMessage);
    await sendTelegram(`❗ 세미나 신청 작업 오류: ${errorMessage}`).catch(() => {});
    return { success: false, message: `세미나 신청 작업 오류: ${errorMessage}` };
  }

  try {
    // 1단계: HTTP API로 세미나 신청 시도 (약관 처리 및 fetchSeminarDetail 재조회 검증 포함)
    const confirmedAppliedIds = new Set<string>();
    for (const seminarId of targetSeminarIds) {
      try {
        const applyRes = await applySeminarWithTerms(seminarId);
        if (applyRes.isAuthExpired) {
          const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
          await sendTelegram(msg).catch(() => {});
          return { success: false, message: msg };
        }
        if (applyRes.success && isAppliedSeminar(applyRes.processState)) {
          confirmedAppliedIds.add(seminarId);
        } else {
          console.warn(
            `[apply_seminar] seminarId ${seminarId} API 신청 실패 (상태 미확정), Playwright 폴백 대상에 추가:`,
            applyRes.errorMessage,
          );
        }
      } catch (err) {
        console.warn(`[apply_seminar] seminarId ${seminarId} API 신청 중 예외 발생, Playwright 폴백 대상에 추가:`, err);
      }
    }

    // 2단계: API로 신청 완료(isAppliedSeminar=true)가 확정되지 않은 세미나에 대해 Playwright 브라우저 폴백 실행
    const fallbackTargets = targetSeminarIds.filter((id) => !confirmedAppliedIds.has(id));

    let page = ctx.page;
    let context = ctx.context;
    let createdBrowser: import('playwright').Browser | null = null;
    let screenshotPath: string | null = null;

    if (fallbackTargets.length > 0) {
      console.log(
        `[apply_seminar] ${fallbackTargets.length}개 세미나에 대해 Playwright 폴백 실행: ${fallbackTargets.join(', ')}`,
      );
      await sendTelegram(
        `⚠️ [세미나 신청] API 신청 미완료(${fallbackTargets.length}건)로 인해 Playwright 브라우저 폴백을 실행합니다.\n대상 세미나 ID: ${fallbackTargets.join(', ')}`,
      ).catch(() => {});
      try {
        if (!page) {
          const { chromium } = await import('playwright');
          const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';
          createdBrowser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
          context = await createdBrowser.newContext();
          page = await context.newPage();
        }

        await ensureLoggedIn({ page, context: context ?? page.context() });

        for (const seminarId of fallbackTargets) {
          const detailUrl = `${SEMINAR_DETAIL_PAGE}${seminarId}`;
          await safeGoto(page, detailUrl, { waitUntil: 'load', timeout: 30000 }, 1);
          await page.click('a#applyLiveSeminarMemberBtn', { timeout: 5000 }).catch(() => {});
          try {
            await page.waitForSelector('.agg_confirm', { timeout: 2000 });
            await page.click('.agg_confirm').catch(() => {});
            await page.waitForSelector('#seminarAgree', { timeout: 2000 });
            await page.click('#seminarAgree').catch(() => {});
          } catch (_e) {
            /* ignore */
          }
          try {
            const nextTerms = page.locator('.agg_next_terms');
            if (await nextTerms.isVisible({ timeout: 1000 })) {
              await nextTerms.click();
              await page.waitForSelector('#terms_confirm', { timeout: 2000 });
              await page.click('#terms_confirm');
            }
          } catch (_e) {
            /* ignore */
          }
          await page.waitForTimeout(500);
        }

        // 폴백 실행 후 재확인
        for (const seminarId of fallbackTargets) {
          try {
            const detailRes = await fetchSeminarDetail(seminarId);
            if (detailRes.success && detailRes.rawResponse && typeof detailRes.rawResponse === 'object') {
              const rawDetail = detailRes.rawResponse as { seminarDetail?: { processState?: number | string } };
              const ps = Number(rawDetail.seminarDetail?.processState);
              if (isAppliedSeminar(ps)) {
                confirmedAppliedIds.add(seminarId);
              }
            }
          } catch {
            /* ignore */
          }
        }

        const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
        await fs.mkdir(baseScreenshotDir, { recursive: true });
        screenshotPath = path.join(baseScreenshotDir, 'apply_seminar_result.png');
        await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
      } catch (error) {
        console.error(
          'seminar task playwright fallback error',
          error && typeof error === 'object' && 'stack' in error ? (error as Error).stack : error,
        );
        if (page && !screenshotPath) {
          const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
          await fs.mkdir(baseScreenshotDir, { recursive: true });
          screenshotPath = path.join(baseScreenshotDir, 'apply_seminar_error.png');
          await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
        }
      } finally {
        if (createdBrowser) {
          await createdBrowser.close().catch(() => {});
        }
      }
    }

    const successCount = confirmedAppliedIds.size;
    const failCount = targetSeminarIds.length - successCount;

    // 기존 이미 신청된 세미나 수
    const previouslyApplied = currentSeminars.filter((s) => isAppliedSeminar(s.processState)).length;
    const totalApplied = previouslyApplied + successCount;

    let message = `✅ ${totalApplied}개 세미나 신청 완료! (${totalApplied}/${totalSeminarsAvailable})`;
    if (failCount > 0) {
      message += `\n (${failCount}개는 마감 등의 사유로 신청 실패)`;
    }
    const excessCount = currentSeminars.filter((s) => s.processState === ProcessState.PROCESS_EXCESS).length;
    if (excessCount > 0) {
      message += `\n⚠️ ${excessCount}개 정원 초과로 신청 불가`;
    }

    message += `\n${SEMINAR_DETAIL_PAGE}`;
    const result: TaskResult = {
      success: true,
      message,
      ...(screenshotPath ? { imagePath: screenshotPath } : {}),
    };
    if (options.silentIfNoNew && newlyAdded.length === 0) result.silent = true;
    return result;
  } catch (error) {
    console.error(
      'seminar task error',
      error && typeof error === 'object' && 'stack' in error ? (error as Error).stack : error,
    );
    const message = error instanceof Error ? error.message : String(error);
    await sendTelegram(`❗ 세미나 신청 작업 오류: ${message}`).catch(() => {});
    return { success: false, message: `세미나 신청 작업 오류: ${message}` };
  }
}

export { run };
export const applySeminarTask = { name: 'apply_seminar', description: '세미나 신청 및 목록 저장', run, runHttpOnly };
export const applySeminarTaskStandalone = { name: 'apply_seminar', description: '세미나 신청 및 목록 저장', run };
export const applySeminarExtraTask = {
  name: 'apply_seminar_extra',
  description: '세미나 목록 갱신 및 심화 세미나 포인트 확인',
  schedule: '*/10 6-23 * * *',
  options: {
    notifyNewSeminarsToTelegram: false,
    notifyNewSeminarsToChannel: true,
    silentIfNoNew: true,
    checkAdvancedPointStatus: true,
  },
  run: (_args: unknown, options?: ApplySeminarOptions) =>
    runHttpOnly({
      notifyNewSeminarsToTelegram: false,
      notifyNewSeminarsToChannel: true,
      silentIfNoNew: true,
      checkAdvancedPointStatus: true,
      ...options,
    }),
};

export async function runHttpOnly(options: ApplySeminarOptions = {}): Promise<TaskResult> {
  const {
    notifyNewSeminarsToChannel = true,
    notifyNewSeminarsToTelegram: _notifyNewSeminarsToTelegram = true,
    silentIfNoNew = true,
  } = options;

  try {
    let currentSeminars: RawSeminarData[] = [];
    let normalizedCurrentSeminars: SeminarListItem[] = [];
    const referenceDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

    const apiRes = await fetchMainFutureSeminars();
    if (!apiRes.success) {
      if (apiRes.isAuthExpired) {
        const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
        await sendTelegram(msg).catch(() => {});
        return { success: false, message: msg };
      }
      throw new Error(apiRes.errorMessage || 'fetchMainFutureSeminars 실패');
    }
    currentSeminars = apiRes.items.map(convertApiItemToRawSeminar);
    normalizedCurrentSeminars = apiRes.items.map((item) => convertApiItemToSeminarListItem(item, referenceDate));

    const storedSeminars = migrateLegacySeminarStorage(referenceDate);

    // 최근 세미나 ID 불연속(Gap) 탐색으로 정원 100명 이상 비공개 세미나 발굴
    const { gapSeminars, isAuthExpired: gapAuthExpired } = await discoverMissingGapSeminars(
      normalizedCurrentSeminars,
      storedSeminars,
      referenceDate,
    );
    if (gapAuthExpired) {
      const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
      await sendTelegram(msg).catch(() => {});
      return { success: false, message: msg };
    }
    if (gapSeminars.length > 0) {
      normalizedCurrentSeminars.push(...gapSeminars);
      currentSeminars.push(...gapSeminars.map(convertSeminarListItemToRawSeminar));
    }

    // 1시간에 1번(또는 forceEnrich=true)만 상세(detail) API를 조회하여 최신 메타데이터 갱신
    let enrichedSeminars = normalizedCurrentSeminars;
    if (shouldRunEnrich(options.forceEnrich)) {
      const { seminars: resSeminars, isAuthExpired: detailAuthExpired } =
        await enrichSeminarsWithDetail(normalizedCurrentSeminars);
      if (detailAuthExpired) {
        const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
        await sendTelegram(msg).catch(() => {});
        return { success: false, message: msg };
      }
      enrichedSeminars = resSeminars;
      recordEnrichTime();
    }

    const { seminars, newlyAdded, infoChanges } = refreshStoredSeminarList(
      enrichedSeminars,
      storedSeminars,
      referenceDate,
    );

    if (seminars.length > 0) {
      seminarRepo.upsertSeminars(seminars);
    }

    if (notifyNewSeminarsToChannel) {
      await syncNewSeminarsNotice(referenceDate, newlyAdded);
    }

    if (newlyAdded.length > 0) {
      await sendNewSeminarToSubscribers(
        newlyAdded,
        newlyAdded.map((s) => s.seminarId || getSeminarIdFromUrl(s.url)).filter(Boolean) as string[],
      ).catch(() => {});
    }

    // 마감 임박(잔여 1,000명 이하) 진입 세미나 감지 및 알림 발송
    const newUrgentSeminars: SeminarListItem[] = [];
    for (const s of enrichedSeminars) {
      const sid = s.seminarId || getSeminarIdFromUrl(s.url);
      if (!sid) continue;
      const { total, remaining } = parseCapacityNumbers(s);
      if (total > 0 && remaining <= 1000) {
        const stored = storedSeminars.find((item) => (item.seminarId || getSeminarIdFromUrl(item.url)) === sid);
        if (!stored?.urgentNotified) {
          newUrgentSeminars.push(s);
        }
      }
    }

    if (newUrgentSeminars.length > 0) {
      await sendUrgentSeminarsToSubscribers(newUrgentSeminars).catch(() => {});
      for (const u of newUrgentSeminars) {
        const sid = u.seminarId || getSeminarIdFromUrl(u.url);
        if (sid) {
          seminarRepo.markSeminarUrgentNotified(sid);
        }
      }
    }

    const finalSeminars = seminarRepo.getAllSeminars();
    const pointStatusResult = await refreshSeminarPointStatus(undefined, finalSeminars);
    const pointChanges = pointStatusResult.pointChanges;

    const changeNotificationText = formatSeminarChangeNotification(infoChanges, pointChanges);
    if (changeNotificationText) {
      await sendTelegram(changeNotificationText).catch(() => {});
      await sendSeminarChangesToSubscribers(changeNotificationText).catch(() => {});
    }

    // 신청 가능한 세미나가 있으면 Playwright 전체 실행으로 위임 (processState 기반)
    const hasApplyTarget = currentSeminars.some(
      (s) => !isAppliedSeminar(s.processState) && s.processState === ProcessState.PROCESS_APPLY,
    );
    if (hasApplyTarget) {
      // run()은 자체적으로 저장소 갱신·알림·포인트 동기화를 모두 수행하므로
      // 여기까지 한 작업은 버리고 run() 결과만 반환
      return run({}, { ...options, notifyNewSeminarsToTelegram: false, silentIfNoNew: true });
    }

    const totalSeminarsAvailable = currentSeminars.length;
    const message = `🔄 세미나 목록 갱신 완료 (${totalSeminarsAvailable}개)`;

    const result: TaskResult = { success: true, message };
    if (silentIfNoNew && newlyAdded.length === 0) result.silent = true;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('apply_seminar_extra HTTP error:', message);
    await sendTelegram(`❗ 세미나 목록 갱신 작업 오류: ${message}`).catch(() => {});
    return { success: false, message: `세미나 목록 갱신 작업 오류: ${message}` };
  }
}
