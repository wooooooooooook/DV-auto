import path from 'path';
import fs from 'fs/promises';
import type { TaskContext, TaskResult } from '../types';
import {
  safeGoto,
  sendNotificationToChannel,
  sendTelegram,
  getSeminarIdFromUrl,
  isSurveyPointExcludedSeminarHttp,
  ensureLoggedIn,
} from '../modules/utils';
import { httpGet } from '../modules/http_client';
import { parseSeminarListHtml, parseCompletionCountHtml } from '../modules/html_parser';
import {
  fetchMainFutureSeminars,
  fetchSeminarDetail,
  convertApiItemToRawSeminar,
  convertApiItemToSeminarListItem,
  parseSeminarDateTime,
  checkIsAdvancedSurvey,
  checkIsPointExcluded,
  ProcessState,
  type ProcessStateType,
} from '../modules/seminar_api';
import { searchSeminarPoints } from './check_seminar_point';
import * as storage from '../services/storage';
import * as logger from '../services/logger';
import { sendSeminarChangesToSubscribers } from '../services/seminar_subscribers';

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
const SEMINAR_DETAIL_SSR_PAGE = 'https://www.doctorville.co.kr/seminar/seminarDetail?seminarId=';
export const SEMINAR_LIST_KEY = 'apply_seminar:seminar_list';
const LEGACY_NEW_SEMINAR_KEY = 'apply_seminar:new_seminars';
const LEGACY_HISTORY_KEY = 'apply_seminar:new_seminars_history';
const SEMINAR_RETENTION_DAYS = 60;

type SeminarPointStatus = {
  pointPaid?: boolean;
  point?: number;
  pointText?: string;
  pointDate?: string;
  pointContent?: string;
  pointCheckedAt?: string;
};

export type SeminarListItem = {
  seminarId: string | null;
  name: string;
  url: string;
  date?: string;
  time: string;
  currentCount: string;
  totalCount: string;
  nightTime: boolean;
  isPointExcluded?: boolean;
  isAdvancedSurvey: boolean;
  processState?: number;
  cancelProcessState?: number;
  seminarCompleted?: number;
  detectedDate?: string;
  detectedAt?: string;
} & SeminarPointStatus;

export type SeminarFieldChange = {
  field: string;
  label: string;
  oldValue: string | number | boolean;
  newValue: string | number | boolean;
};

export type SeminarInfoChange = {
  seminarId: string;
  name: string;
  changes: SeminarFieldChange[];
};

export type SeminarPointChange = {
  seminarId: string;
  name: string;
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
  hasIcoApply?: boolean;
  processState?: number;
  cancelProcessState?: number;
  seminarCompleted?: number;
};

const MEANINGFUL_FIELDS: Array<{
  key: keyof SeminarListItem;
  label: string;
}> = [
  { key: 'name', label: '세미나명' },
  { key: 'date', label: '날짜' },
  { key: 'time', label: '시간' },
  { key: 'totalCount', label: '총원' },
  { key: 'nightTime', label: '야간세미나' },
  { key: 'isPointExcluded', label: '포인트미지급' },
  { key: 'isAdvancedSurvey', label: '심화설문' },
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
    };
  });
}

function seminarKey(seminar: Pick<SeminarListItem, 'url' | 'seminarId'>): string {
  return seminar.seminarId || seminar.url;
}

export function mergeSeminar(existing: SeminarListItem | undefined, incoming: SeminarListItem): SeminarListItem {
  if (!existing) return incoming;
  return {
    ...existing,
    ...incoming,
    name: incoming.name || existing.name || '',
    url:
      incoming.url ||
      existing.url ||
      `https://m.doctorville.co.kr/cme/seminar/${incoming.seminarId || existing.seminarId || ''}`,
    date: incoming.date || existing.date || '',
    time: incoming.time || existing.time || '',
    currentCount: incoming.currentCount || existing.currentCount || '',
    totalCount: incoming.totalCount || existing.totalCount || '',
    nightTime: incoming.nightTime ?? existing.nightTime ?? false,
    isAdvancedSurvey: incoming.isAdvancedSurvey ?? existing.isAdvancedSurvey ?? false,
    isPointExcluded: incoming.isPointExcluded ?? existing.isPointExcluded,
    processState: incoming.processState ?? existing.processState,
    cancelProcessState: incoming.cancelProcessState ?? existing.cancelProcessState,
    seminarCompleted: incoming.seminarCompleted ?? existing.seminarCompleted,
    pointPaid: existing.pointPaid === true ? true : (incoming.pointPaid ?? existing.pointPaid),
    point: existing.pointPaid === true ? existing.point : (incoming.point ?? existing.point),
    pointText: existing.pointPaid === true ? existing.pointText : (incoming.pointText ?? existing.pointText),
    pointDate: existing.pointPaid === true ? existing.pointDate : (incoming.pointDate ?? existing.pointDate),
    pointContent:
      existing.pointPaid === true ? existing.pointContent : (incoming.pointContent ?? existing.pointContent),
    pointCheckedAt: existing.pointCheckedAt || incoming.pointCheckedAt,
    detectedDate: incoming.detectedDate || existing.detectedDate,
    detectedAt: incoming.detectedAt || existing.detectedAt,
  };
}

function migrateLegacySeminarStorage(referenceDate: string): SeminarListItem[] {
  const current = storage.get<SeminarListItem[]>(SEMINAR_LIST_KEY, []) || [];
  const merged = new Map<string, SeminarListItem>();
  for (const seminar of current) merged.set(seminarKey(seminar), seminar);

  const legacyHistory = storage.get<LegacyHistoryEntry[]>(LEGACY_HISTORY_KEY, []) || [];
  for (const entry of legacyHistory) {
    if (!entry.seminar) continue;
    const seminar = {
      ...entry.seminar,
      detectedDate: entry.seminar.detectedDate ?? entry.detectedDate,
      detectedAt: entry.seminar.detectedAt ?? entry.detectedAt,
    };
    const key = seminarKey(seminar);
    merged.set(key, mergeSeminar(merged.get(key), seminar));
  }

  const legacyNew = storage.get<LegacyNewSeminars>(LEGACY_NEW_SEMINAR_KEY);
  for (const seminar of legacyNew?.seminars || []) {
    const key = seminarKey(seminar);
    merged.set(
      key,
      mergeSeminar(merged.get(key), {
        ...seminar,
        detectedDate: seminar.detectedDate ?? legacyNew?.date,
      }),
    );
  }

  const todayMs = Date.parse(`${referenceDate}T00:00:00+09:00`);
  const retentionMs = SEMINAR_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const retained = [...merged.values()].filter((seminar) => {
    const reference = normalizeSeminarDate(seminar.date, seminar.detectedDate || referenceDate) || seminar.detectedDate;
    if (!reference) return true;
    const dateMs = Date.parse(`${reference}T00:00:00+09:00`);
    return Number.isNaN(dateMs) || Number.isNaN(todayMs) || todayMs - dateMs <= retentionMs;
  });

  storage.set(SEMINAR_LIST_KEY, retained);
  storage.deleteKey(LEGACY_NEW_SEMINAR_KEY);
  storage.deleteKey(LEGACY_HISTORY_KEY);
  return retained;
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
    const isPointExcluded = detailRes.isPointExcluded ?? checkIsPointExcluded(d.survey);
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
      detectedDate: detectedDate || '',
    };
  } catch (err) {
    logger.warn(`Failed to fetch seminar detail for ID ${seminarId}:`, err);
    return {};
  }
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

  const updatedSeminars: SeminarListItem[] = [];
  for (const seminar of seminars) {
    const id = seminar.seminarId || getSeminarIdFromUrl(seminar.url);
    let currentItem = { ...seminar };

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
    }

    if (currentItem.pointPaid === true) {
      updatedSeminars.push(currentItem);
      continue;
    }

    if (id && parsedPoints.has(id)) {
      const pointResult = parsedPoints.get(id)!;
      if (pointResult.found && pointResult.type === '적립') {
        pointChanges.push({
          seminarId: id,
          name: currentItem.name,
          point: pointResult.point,
          pointText: pointResult.pointText,
          pointDate: pointResult.date,
          pointContent: pointResult.content,
        });

        updatedSeminars.push({
          ...currentItem,
          pointPaid: true,
          point: pointResult.point,
          pointDate: pointResult.date,
          pointText: pointResult.pointText,
          pointContent: pointResult.content,
          pointCheckedAt: checkedAt,
        });
        continue;
      }
    }

    updatedSeminars.push({
      ...currentItem,
      pointPaid: false,
      pointCheckedAt: checkedAt,
    });
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
      updatedSeminars.push(newItem);

      pointChanges.push({
        seminarId: id,
        name: newItem.name,
        point: pointResult.point,
        pointText: pointResult.pointText,
        pointDate: pointResult.date,
        pointContent: pointResult.content,
      });
    }
  }

  storage.set(SEMINAR_LIST_KEY, updatedSeminars);
  return { seminars: updatedSeminars, pointChanges };
}

export type ApplySeminarOptions = {
  checkAdvancedPointStatus?: boolean;
  notifyNewSeminarsToChannel?: boolean;
  notifyNewSeminarsToTelegram?: boolean;
  silentIfNoNew?: boolean;
  _checkAdvancedPointStatus?: boolean;
};

async function run(ctx: TaskContext = {}, options: ApplySeminarOptions = {}): Promise<TaskResult> {
  const { notifyNewSeminarsToChannel = false, notifyNewSeminarsToTelegram = true } = options;

  let currentSeminars: RawSeminarData[] = [];
  let normalizedCurrentSeminars: SeminarListItem[] = [];
  const referenceDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  let mainHtmlBody = '';

  try {
    const apiRes = await fetchMainFutureSeminars();
    if (apiRes.success) {
      currentSeminars = apiRes.items.map(convertApiItemToRawSeminar);
      normalizedCurrentSeminars = apiRes.items.map((item) => convertApiItemToSeminarListItem(item, referenceDate));
    } else {
      if (apiRes.isAuthExpired) {
        const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
        await sendTelegram(msg).catch(() => {});
        return { success: false, message: msg };
      }
      console.warn('fetchMainFutureSeminars 실패, HTML 파싱 fallback 시도:', apiRes.errorMessage);
      const mainRes = await httpGet(SEMINAR_PAGE);
      if (mainRes.resultType === 'AUTH_EXPIRED') {
        const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
        await sendTelegram(msg).catch(() => {});
        return { success: false, message: msg };
      }
      if (mainRes.status !== 200 || !mainRes.body) {
        throw new Error(apiRes.errorMessage || `HTTP GET ${SEMINAR_PAGE} failed with status ${mainRes.status}`);
      }
      mainHtmlBody = mainRes.body;
      currentSeminars = parseSeminarListHtml(mainRes.body);
      normalizedCurrentSeminars = normalizeParsedSeminars(currentSeminars, referenceDate);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('apply_seminar HTTP pre-check error:', message);
    await sendTelegram(`❗ 세미나 신청 작업 오류: ${message}`).catch(() => {});
    return { success: false, message: `세미나 신청 작업 오류: ${message}` };
  }

  const storedSeminars = migrateLegacySeminarStorage(referenceDate);

  const { seminars, newlyAdded, infoChanges } = refreshStoredSeminarList(
    normalizedCurrentSeminars,
    storedSeminars,
    referenceDate,
  );

  if (newlyAdded.length === 0) {
    storage.set(SEMINAR_LIST_KEY, seminars);
  } else {
    const newlyAddedWithFlags: SeminarListItem[] = [];
    for (const item of newlyAdded) {
      const seminarId = getSeminarIdFromUrl(item.url);
      let isPointExcluded = item.isPointExcluded;

      // isPointExcluded 가 미정인 경우 detail API 우선 조회
      if (typeof isPointExcluded !== 'boolean') {
        if (seminarId) {
          const detailRes = await fetchSeminarDetail(seminarId);
          if (detailRes.isAuthExpired) {
            const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
            await sendTelegram(msg).catch(() => {});
            return { success: false, message: msg };
          }
          if (detailRes.success) {
            isPointExcluded = detailRes.isPointExcluded;
          }
        }

        // detail API 실패 시 HTML fallback
        if (typeof isPointExcluded !== 'boolean') {
          const link = seminarId ? `${SEMINAR_DETAIL_SSR_PAGE}${seminarId}` : item.url;
          const pointExRes = await isSurveyPointExcludedSeminarHttp(link);
          if (pointExRes.status === 'auth_expired') {
            const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
            await sendTelegram(msg).catch(() => {});
            return { success: false, message: msg };
          }
          isPointExcluded = pointExRes.status === 'success' ? pointExRes.excluded : undefined;
        }
      }
      newlyAddedWithFlags.push({ ...item, seminarId, isPointExcluded });
    }

    const flaggedByKey = new Map(newlyAddedWithFlags.map((item) => [seminarKey(item), item]));
    const updatedSeminars = seminars.map((seminar) =>
      flaggedByKey.has(seminarKey(seminar)) ? mergeSeminar(seminar, flaggedByKey.get(seminarKey(seminar))!) : seminar,
    );
    storage.set(SEMINAR_LIST_KEY, updatedSeminars);

    const newSeminarMessage = newlyAddedWithFlags
      .map((item) => {
        const pointExcludedSuffix = item.isPointExcluded ? ' [포인트미지급]' : '';
        const advancedSurveySuffix = item.isAdvancedSurvey ? ' [심화설문]' : '';
        const dateTimePrefix = item.date || item.time ? `[${item.date}${item.time ? ' ' + item.time : ''}] ` : '';
        const capacityInfo = item.currentCount && item.totalCount ? `(${item.currentCount}/${item.totalCount}) ` : '';
        return `${dateTimePrefix}${pointExcludedSuffix}${advancedSurveySuffix}${item.name}${capacityInfo}\n${item.url}`;
      })
      .join('\n\n');
    const noticeMessage = `🆕 새로 추가된 세미나 ${newlyAddedWithFlags.length}건 발견\n\n${newSeminarMessage}`;
    if (notifyNewSeminarsToTelegram) await sendTelegram(noticeMessage);
    if (notifyNewSeminarsToChannel) await sendNotificationToChannel(noticeMessage);
  }

  const finalSeminars = storage.get<SeminarListItem[]>(SEMINAR_LIST_KEY, []) || [];
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
    // HTML fallback 경로: .ico_completion 파싱
    const completionCount = mainHtmlBody ? parseCompletionCountHtml(mainHtmlBody) : appliedCount;

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

  let page = ctx.page;
  let context = ctx.context;
  let createdBrowser: import('playwright').Browser | null = null;
  let screenshotPath: string | null = null;

  try {
    if (!page) {
      const { chromium } = await import('playwright');
      const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';
      createdBrowser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
      context = await createdBrowser.newContext();
      page = await context.newPage();
    }

    await ensureLoggedIn({ page, context: context ?? page.context() });

    // 각 신청 대상 세미나의 상세페이지로 직접 진입하여 신청
    for (const seminarId of targetSeminarIds) {
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

    // 신청 결과 확인: 각 대상에 대해 detail API 재조회로 개별 확인
    let successCount = 0;
    let failCount = 0;
    for (const seminarId of targetSeminarIds) {
      try {
        const detailRes = await fetchSeminarDetail(seminarId);
        if (detailRes.success && detailRes.rawResponse?.seminarDetail) {
          const ps = Number(detailRes.rawResponse.seminarDetail.processState);
          if (isAppliedSeminar(ps)) {
            successCount++;
          } else {
            failCount++;
          }
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }

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

    const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
    await fs.mkdir(baseScreenshotDir, { recursive: true });
    screenshotPath = path.join(baseScreenshotDir, 'apply_seminar_result.png');
    await page.screenshot({ path: screenshotPath, fullPage: false });
    message += `\n${SEMINAR_DETAIL_PAGE}`;
    const result: TaskResult = { success: true, message, imagePath: screenshotPath };
    if (options.silentIfNoNew && newlyAdded.length === 0) result.silent = true;
    return result;
  } catch (error) {
    console.error(
      'seminar task error',
      error && typeof error === 'object' && 'stack' in error ? (error as Error).stack : error,
    );
    if (page && !screenshotPath) {
      const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
      await fs.mkdir(baseScreenshotDir, { recursive: true });
      screenshotPath = path.join(baseScreenshotDir, 'apply_seminar_error.png');
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    }
    const message = error instanceof Error ? error.message : String(error);
    await sendTelegram(`❗ 세미나 신청 작업 오류: ${message}`, screenshotPath).catch(() => {});
    return { success: false, message: `세미나 신청 작업 오류: ${message}`, imagePath: screenshotPath };
  } finally {
    if (createdBrowser) {
      await createdBrowser.close().catch(() => {});
    }
  }
}

export { run };
export const applySeminarTask = { name: 'apply_seminar', description: '세미나 신청 및 목록 저장', run, runHttpOnly };
export const applySeminarTaskStandalone = { name: 'apply_seminar', description: '세미나 신청 및 목록 저장', run };
export const applySeminarExtraTask = {
  name: 'apply_seminar_extra',
  description: '세미나 목록 갱신 및 심화 세미나 포인트 확인',
  schedule: '*/10 6-23 * * *',
  options: { notifyNewSeminarsToTelegram: false, silentIfNoNew: true, checkAdvancedPointStatus: true },
  run: (_args: unknown, options?: ApplySeminarOptions) =>
    runHttpOnly({
      notifyNewSeminarsToTelegram: false,
      silentIfNoNew: true,
      checkAdvancedPointStatus: true,
      ...options,
    }),
};

export async function runHttpOnly(options: ApplySeminarOptions = {}): Promise<TaskResult> {
  const { notifyNewSeminarsToChannel = false, notifyNewSeminarsToTelegram = true, silentIfNoNew = true } = options;

  try {
    let currentSeminars: RawSeminarData[] = [];
    let normalizedCurrentSeminars: SeminarListItem[] = [];
    const referenceDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    let mainHtmlBody = '';

    const apiRes = await fetchMainFutureSeminars();
    if (apiRes.success) {
      currentSeminars = apiRes.items.map(convertApiItemToRawSeminar);
      normalizedCurrentSeminars = apiRes.items.map((item) => convertApiItemToSeminarListItem(item, referenceDate));
    } else {
      if (apiRes.isAuthExpired) {
        const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
        await sendTelegram(msg).catch(() => {});
        return { success: false, message: msg };
      }
      console.warn('runHttpOnly: fetchMainFutureSeminars 실패, HTML 파싱 fallback 시도:', apiRes.errorMessage);
      const mainRes = await httpGet(SEMINAR_PAGE);
      if (mainRes.resultType === 'AUTH_EXPIRED') {
        const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
        await sendTelegram(msg).catch(() => {});
        return { success: false, message: msg };
      }
      if (mainRes.status !== 200 || !mainRes.body) {
        throw new Error(apiRes.errorMessage || `HTTP GET ${SEMINAR_PAGE} failed with status ${mainRes.status}`);
      }
      mainHtmlBody = mainRes.body;
      currentSeminars = parseSeminarListHtml(mainRes.body);
      normalizedCurrentSeminars = normalizeParsedSeminars(currentSeminars, referenceDate);
    }

    const storedSeminars = migrateLegacySeminarStorage(referenceDate);

    const { seminars, newlyAdded, infoChanges } = refreshStoredSeminarList(
      normalizedCurrentSeminars,
      storedSeminars,
      referenceDate,
    );

    if (newlyAdded.length === 0) {
      storage.set(SEMINAR_LIST_KEY, seminars);
    } else {
      const newlyAddedWithFlags: SeminarListItem[] = [];
      for (const item of newlyAdded) {
        const seminarId = getSeminarIdFromUrl(item.url);
        let isPointExcluded = item.isPointExcluded;

        if (typeof isPointExcluded !== 'boolean') {
          if (seminarId) {
            const detailRes = await fetchSeminarDetail(seminarId);
            if (detailRes.isAuthExpired) {
              const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
              await sendTelegram(msg).catch(() => {});
              return { success: false, message: msg };
            }
            if (detailRes.success) {
              isPointExcluded = detailRes.isPointExcluded;
            }
          }

          if (typeof isPointExcluded !== 'boolean') {
            const link = seminarId ? `${SEMINAR_DETAIL_SSR_PAGE}${seminarId}` : item.url;
            const pointExRes = await isSurveyPointExcludedSeminarHttp(link);
            if (pointExRes.status === 'auth_expired') {
              const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
              await sendTelegram(msg).catch(() => {});
              return { success: false, message: msg };
            }
            isPointExcluded = pointExRes.status === 'success' ? pointExRes.excluded : undefined;
          }
        }
        newlyAddedWithFlags.push({ ...item, seminarId, isPointExcluded });
      }

      const flaggedByKey = new Map(newlyAddedWithFlags.map((item) => [seminarKey(item), item]));
      const updatedSeminars = seminars.map((seminar) =>
        flaggedByKey.has(seminarKey(seminar)) ? mergeSeminar(seminar, flaggedByKey.get(seminarKey(seminar))!) : seminar,
      );
      storage.set(SEMINAR_LIST_KEY, updatedSeminars);

      const newSeminarMessage = newlyAddedWithFlags
        .map((item) => {
          const pointExcludedSuffix = item.isPointExcluded ? ' [포인트미지급]' : '';
          const advancedSurveySuffix = item.isAdvancedSurvey ? ' [심화설문]' : '';
          const dateTimePrefix = item.date || item.time ? `[${item.date}${item.time ? ' ' + item.time : ''}] ` : '';
          const capacityInfo = item.currentCount && item.totalCount ? `(${item.currentCount}/${item.totalCount}) ` : '';
          return `${dateTimePrefix}${pointExcludedSuffix}${advancedSurveySuffix}${item.name}${capacityInfo}\n${item.url}`;
        })
        .join('\n\n');
      const noticeMessage = `🆕 새로 추가된 세미나 ${newlyAddedWithFlags.length}건 발견\n\n${newSeminarMessage}`;
      if (notifyNewSeminarsToTelegram) await sendTelegram(noticeMessage);
      if (notifyNewSeminarsToChannel) await sendNotificationToChannel(noticeMessage);
    }

    const finalSeminars = storage.get<SeminarListItem[]>(SEMINAR_LIST_KEY, []) || [];
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
