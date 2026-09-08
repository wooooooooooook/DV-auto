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
  ProcessState,
} from '../modules/seminar_api';
import * as storage from '../services/storage';
import * as logger from '../services/logger';
import * as seminarRepo from '../services/seminar_repository';
import { sendSeminarChangesToSubscribers } from '../services/seminar_subscribers';
import {
  sendNewSeminarToSubscribers,
  sendUrgentSeminarsToSubscribers,
  parseCapacityNumbers,
} from '../services/subscription_service';
import { checkAndTriggerSeminarMonitors } from '../services/seminar_monitor_trigger';

import {
  syncNewSeminarsNotice,
  getSeminarInfoChanges,
  formatSeminarChangeNotification,
  type SeminarInfoChange,
} from './apply_seminar_notice';
import { discoverMissingGapSeminars } from '../services/seminar_gap_service';
import { refreshSeminarPointStatus } from '../services/seminar_point_sync';
import type { SeminarListItem } from '../services/seminar_repository';
import { enrichSeminarsWithDetail, isPastSeminar, isUncompletedSeminar } from '../services/seminar_sync_service';

export const mergeSeminar = seminarRepo.mergeSeminarRecord;

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
export const SEMINAR_LIST_KEY = 'apply_seminar:seminar_list';
const LEGACY_NEW_SEMINAR_KEY = 'apply_seminar:new_seminars';
const LEGACY_HISTORY_KEY = 'apply_seminar:new_seminars_history';
const SEMINAR_RETENTION_DAYS = 60;

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

/**
 * 세미나 목록의 processState 상태 분포 문자열 생성
 */
export function formatProcessStateDistribution(
  seminars: Array<{ processState?: number | string | null }>,
  label?: string,
): string {
  const counts = {
    ENTER: 0,
    APPLY: 0,
    CANCEL: 0,
    PREPARING: 0,
    EXCESS: 0,
    STARTED: 0,
    END: 0,
    COMPLETED: 0,
    unknown: 0,
  };

  for (const s of seminars) {
    const ps = s.processState !== undefined && s.processState !== null ? Number(s.processState) : undefined;
    switch (ps) {
      case ProcessState.PROCESS_ENTER:
        counts.ENTER++;
        break;
      case ProcessState.PROCESS_APPLY:
        counts.APPLY++;
        break;
      case ProcessState.PROCESS_CANCEL:
        counts.CANCEL++;
        break;
      case ProcessState.PROCESS_PREPARING:
        counts.PREPARING++;
        break;
      case ProcessState.PROCESS_EXCESS:
        counts.EXCESS++;
        break;
      case ProcessState.PROCESS_STARTED:
        counts.STARTED++;
        break;
      case ProcessState.PROCESS_END:
        counts.END++;
        break;
      case ProcessState.PROCESS_COMPLETED:
        counts.COMPLETED++;
        break;
      default:
        counts.unknown++;
        break;
    }
  }

  const prefix = label ? `[sync_seminars] processState (${label}):` : `[sync_seminars] processState:`;
  return `${prefix} total=${seminars.length} ENTER=${counts.ENTER} APPLY=${counts.APPLY} CANCEL=${counts.CANCEL} PREPARING=${counts.PREPARING} EXCESS=${counts.EXCESS} STARTED=${counts.STARTED} END=${counts.END} COMPLETED=${counts.COMPLETED} unknown=${counts.unknown}`;
}

/**
 * 세미나 목록의 processState 상태 분포를 로그로 출력 (단일 목록 또는 total/future 분리 지원)
 */
export function logProcessStateDistribution(
  seminars: Array<{ processState?: number | string | null }>,
  label?: string,
): void;
export function logProcessStateDistribution(
  totalSeminars: Array<{ processState?: number | string | null }>,
  futureSeminars: Array<{ processState?: number | string | null }>,
): void;
export function logProcessStateDistribution(
  seminars: Array<{ processState?: number | string | null }>,
  labelOrFuture?: string | Array<{ processState?: number | string | null }>,
): void {
  if (Array.isArray(labelOrFuture)) {
    console.log(formatProcessStateDistribution(seminars, 'total'));
    console.log(formatProcessStateDistribution(labelOrFuture, 'future'));
  } else {
    console.log(formatProcessStateDistribution(seminars, labelOrFuture));
  }
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

export function isSeminarRecordChanged(existing: SeminarListItem, incoming: SeminarListItem): boolean {
  const checkKeys: Array<keyof SeminarListItem> = [
    'name',
    'date',
    'time',
    'currentCount',
    'totalCount',
    'nightTime',
    'isPointExcluded',
    'isAdvancedSurvey',
    'processState',
    'cancelProcessState',
    'seminarCompleted',
    'hiddenYn',
    'diseaseCategoryNm',
    'isClosed',
  ];

  for (const key of checkKeys) {
    const newVal = incoming[key];
    if (newVal === undefined) continue;
    const oldVal = existing[key];

    if (key === 'hiddenYn') {
      const oldHidden = oldVal === 'Y' || oldVal === 'y';
      const newHidden = newVal === 'Y' || newVal === 'y';
      if (oldHidden !== newHidden) return true;
      continue;
    }

    if (key === 'isClosed' || key === 'isAdvancedSurvey' || key === 'nightTime') {
      const oldBool = Boolean(oldVal);
      const newBool = Boolean(newVal);
      if (oldBool !== newBool) return true;
      continue;
    }

    if (key === 'isPointExcluded') {
      if (oldVal !== undefined && newVal !== undefined && oldVal !== newVal) {
        return true;
      }
      continue;
    }

    if (oldVal !== newVal) {
      return true;
    }
  }
  return false;
}

export function refreshStoredSeminarList(
  current: SeminarListItem[],
  stored: SeminarListItem[],
  referenceDate: string,
): {
  seminars: SeminarListItem[];
  newlyAdded: SeminarListItem[];
  infoChanges: SeminarInfoChange[];
  updatedSeminars: SeminarListItem[];
} {
  const storedByKey = new Map(stored.map((seminar) => [seminarKey(seminar), seminar]));
  const newlyAdded = current.filter((seminar) => !storedByKey.has(seminarKey(seminar)));
  const infoChanges: SeminarInfoChange[] = [];
  const updatedSeminars: SeminarListItem[] = [];
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
          date: seminar.date || existing.date,
          url:
            seminar.url ||
            existing.url ||
            (seminar.seminarId ? `https://m.doctorville.co.kr/cme/seminar/${seminar.seminarId}` : ''),
          changes: fieldChanges,
        });
      }
    }

    const merged = mergeSeminar(existing, {
      ...seminar,
      detectedDate: existing?.detectedDate ?? referenceDate,
      detectedAt: existing?.detectedAt ?? now,
    });

    storedByKey.set(key, merged);

    // 신규 추가이거나 기존 레코드 대비 새로운 변경사항이 유입된 경우에만 DB 갱신 대상에 포함
    if (!existing || isSeminarRecordChanged(existing, seminar)) {
      updatedSeminars.push(merged);
    }
  }

  const todayMs = Date.parse(`${referenceDate}T00:00:00+09:00`);
  const retentionMs = SEMINAR_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const seminars = [...storedByKey.values()].filter((seminar) => {
    const reference = normalizeSeminarDate(seminar.date, seminar.detectedDate || referenceDate) || seminar.detectedDate;
    if (!reference) return true;
    const dateMs = Date.parse(`${reference}T00:00:00+09:00`);
    return Number.isNaN(dateMs) || Number.isNaN(todayMs) || todayMs - dateMs <= retentionMs;
  });

  return { seminars, newlyAdded, infoChanges, updatedSeminars };
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

export type ApplySeminarOptions = {
  context?: import('playwright').BrowserContext;
  taskContext?: TaskContext;
  checkAdvancedPointStatus?: boolean;
  notifyNewSeminarsToChannel?: boolean;
  notifyNewSeminarsToTelegram?: boolean;
  silentIfNoNew?: boolean;
  forceEnrich?: boolean;
  _checkAdvancedPointStatus?: boolean;
};

export type SyncSeminarsResult = TaskResult & {
  currentSeminars?: RawSeminarData[];
  normalizedCurrentSeminars?: SeminarListItem[];
  finalSeminars?: SeminarListItem[];
  newlyAdded?: SeminarListItem[];
  hasApplyTarget?: boolean;
};

export async function syncSeminars(options: ApplySeminarOptions = {}): Promise<SyncSeminarsResult> {
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

    let storedSeminars = migrateLegacySeminarStorage(referenceDate);

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

    // 예정된 비공개 세미나(DB 저장분)는 메인 API에 노출되지 않으므로 매 실행마다 detail API로 최신 상태 갱신
    const currentIdSet = new Set(
      normalizedCurrentSeminars.map((s) => s.seminarId || getSeminarIdFromUrl(s.url)).filter(Boolean),
    );
    const pendingPrivateSeminars = storedSeminars.filter((s) => {
      if (s.hiddenYn !== 'Y') return false;
      const sid = s.seminarId || getSeminarIdFromUrl(s.url);
      if (!sid || currentIdSet.has(sid)) return false;
      // 이미 종료된 세미나는 제외
      const ps = s.processState;
      if (ps === ProcessState.PROCESS_END || ps === ProcessState.PROCESS_COMPLETED) return false;
      if (s.seminarCompleted === 1) return false;
      return true;
    });

    let enrichedSeminars = normalizedCurrentSeminars;
    const allDeletedSeminarIds: string[] = [];

    if (pendingPrivateSeminars.length > 0) {
      const {
        seminars: refreshedPrivate,
        isAuthExpired: privateAuthExpired,
        deletedSeminarIds: privateDeletedIds,
      } = await enrichSeminarsWithDetail(pendingPrivateSeminars);
      if (privateDeletedIds && privateDeletedIds.length > 0) {
        allDeletedSeminarIds.push(...privateDeletedIds);
      }
      if (privateAuthExpired) {
        const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
        await sendTelegram(msg).catch(() => {});
        return { success: false, message: msg };
      }
      normalizedCurrentSeminars.push(...refreshedPrivate);
      currentSeminars.push(...refreshedPrivate.map(convertSeminarListItemToRawSeminar));
    }

    // 1시간에 1번(또는 forceEnrich=true)만 전체 세미나 상세(detail) API를 조회하여 최신 메타데이터 갱신
    // 단, 저장소에 없는 신규 세미나가 처음 발견된 경우 해당 신규 세미나는 즉시 enrich하여 포인트미지급 등 메타데이터 보강
    const storedIdSet = new Set(storedSeminars.map((s) => s.seminarId || getSeminarIdFromUrl(s.url)).filter(Boolean));
    const gapIdSet = new Set(gapSeminars.map((s) => s.seminarId || getSeminarIdFromUrl(s.url)).filter(Boolean));
    const newlyDiscovered = normalizedCurrentSeminars.filter((s) => {
      const sid = s.seminarId || getSeminarIdFromUrl(s.url);
      return sid && !storedIdSet.has(sid) && !gapIdSet.has(sid);
    });

    if (shouldRunEnrich(options.forceEnrich)) {
      const nowMs = Date.now();
      const pastUncompleted = storedSeminars.filter((s) => isPastSeminar(s, nowMs) && isUncompletedSeminar(s));
      const targetsToEnrich = [...normalizedCurrentSeminars];
      const targetIdSet = new Set(
        targetsToEnrich.map((s) => s.seminarId || getSeminarIdFromUrl(s.url)).filter(Boolean),
      );
      for (const p of pastUncompleted) {
        const pid = p.seminarId || getSeminarIdFromUrl(p.url);
        if (pid && !targetIdSet.has(pid)) {
          targetsToEnrich.push(p);
          targetIdSet.add(pid);
        }
      }

      const {
        seminars: resSeminars,
        isAuthExpired: detailAuthExpired,
        deletedSeminarIds,
      } = await enrichSeminarsWithDetail(targetsToEnrich);
      if (deletedSeminarIds && deletedSeminarIds.length > 0) {
        allDeletedSeminarIds.push(...deletedSeminarIds);
      }
      if (detailAuthExpired) {
        const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
        await sendTelegram(msg).catch(() => {});
        return { success: false, message: msg };
      }

      const currentEnrichedIdSet = new Set(
        normalizedCurrentSeminars.map((s) => s.seminarId || getSeminarIdFromUrl(s.url)).filter(Boolean),
      );
      const pastUpdated = resSeminars.filter((s) => {
        const sid = s.seminarId || getSeminarIdFromUrl(s.url);
        return sid && !currentEnrichedIdSet.has(sid);
      });
      if (pastUpdated.length > 0) {
        seminarRepo.upsertSeminars(pastUpdated);
      }

      enrichedSeminars = resSeminars.filter((s) => {
        const sid = s.seminarId || getSeminarIdFromUrl(s.url);
        return sid && currentEnrichedIdSet.has(sid);
      });
      recordEnrichTime();
    } else if (newlyDiscovered.length > 0) {
      const {
        seminars: resNewlyEnriched,
        isAuthExpired: detailAuthExpired,
        deletedSeminarIds,
      } = await enrichSeminarsWithDetail(newlyDiscovered);
      if (deletedSeminarIds && deletedSeminarIds.length > 0) {
        allDeletedSeminarIds.push(...deletedSeminarIds);
      }
      if (detailAuthExpired) {
        const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
        await sendTelegram(msg).catch(() => {});
        return { success: false, message: msg };
      }
      const newlyMap = new Map(resNewlyEnriched.map((s) => [s.seminarId || getSeminarIdFromUrl(s.url), s]));
      enrichedSeminars = normalizedCurrentSeminars
        .filter((s) => {
          const sid = s.seminarId || getSeminarIdFromUrl(s.url);
          return !sid || !deletedSeminarIds.includes(sid);
        })
        .map((s) => {
          const sid = s.seminarId || getSeminarIdFromUrl(s.url);
          return (sid ? newlyMap.get(sid) : undefined) || s;
        });
    }

    if (allDeletedSeminarIds.length > 0) {
      const deletedSet = new Set(allDeletedSeminarIds);
      seminarRepo.deleteSeminars(allDeletedSeminarIds);
      storedSeminars = storedSeminars.filter((s) => !deletedSet.has(s.seminarId || getSeminarIdFromUrl(s.url) || ''));
      enrichedSeminars = enrichedSeminars.filter(
        (s) => !deletedSet.has(s.seminarId || getSeminarIdFromUrl(s.url) || ''),
      );
    }

    const { newlyAdded, infoChanges, updatedSeminars } = refreshStoredSeminarList(
      enrichedSeminars,
      storedSeminars,
      referenceDate,
    );

    if (updatedSeminars.length > 0) {
      seminarRepo.upsertSeminars(updatedSeminars);
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
    const pointStatusResult = await refreshSeminarPointStatus(options.context, finalSeminars);
    const pointChanges = pointStatusResult.pointChanges;

    const changeNotificationText = formatSeminarChangeNotification(infoChanges, pointChanges);
    if (changeNotificationText) {
      await sendTelegram(changeNotificationText).catch(() => {});
      await sendSeminarChangesToSubscribers(changeNotificationText).catch(() => {});
    }

    // 10분 실행 1회당 processState 상태 분포 출력 (total 및 future 목록 분리 로깅)
    logProcessStateDistribution(finalSeminars, enrichedSeminars);

    const hasApplyTarget = currentSeminars.some(
      (s) => !isAppliedSeminar(s.processState) && s.processState === ProcessState.PROCESS_APPLY,
    );

    const syncResult: SyncSeminarsResult = {
      success: true,
      currentSeminars,
      normalizedCurrentSeminars: enrichedSeminars,
      finalSeminars,
      newlyAdded,
      hasApplyTarget,
    };

    const totalSeminarsAvailable = currentSeminars.length;
    const message = `🔄 세미나 목록 갱신 완료 (${totalSeminarsAvailable}개)`;

    await checkAndTriggerSeminarMonitors(finalSeminars, { targetDate: referenceDate }).catch((err) => {
      logger.error('checkAndTriggerSeminarMonitors error in syncSeminars:', err);
    });

    syncResult.message = message;
    if (silentIfNoNew && newlyAdded.length === 0) syncResult.silent = true;
    return syncResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('sync_seminars HTTP error:', message);
    await sendTelegram(`❗ 세미나 목록 갱신 작업 오류: ${message}`).catch(() => {});
    return { success: false, message: `세미나 목록 갱신 작업 오류: ${message}` };
  }
}

export async function applySeminars(
  ctx: TaskContext = {},
  options: ApplySeminarOptions = {},
  syncedData?: SyncSeminarsResult,
): Promise<TaskResult> {
  // 이미 syncSeminars()를 거쳐 넘어온 데이터가 없으면 1회 동기화 실행
  const sync =
    syncedData ||
    (await syncSeminars({
      ...options,
      notifyNewSeminarsToTelegram: false,
      context: ctx.context,
    }));

  if (!sync.success) {
    return sync;
  }

  const currentSeminars = sync.currentSeminars || [];
  const newlyAdded = sync.newlyAdded || [];
  const referenceDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

  // API processState 기반: 미신청 && PROCESS_APPLY 세미나만 신청 대상
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
    // 1단계: HTTP API로 세미나 신청 시도 (동시 2개 청크로 병렬 신청 및 fetchSeminarDetail 재조회 검증)
    const confirmedAppliedIds = new Set<string>();
    const concurrency = 2;
    let isAuthExpired = false;

    for (let i = 0; i < targetSeminarIds.length; i += concurrency) {
      if (isAuthExpired) break;
      const chunk = targetSeminarIds.slice(i, i + concurrency);

      await Promise.all(
        chunk.map(async (seminarId) => {
          if (isAuthExpired) return;
          try {
            const applyRes = await applySeminarWithTerms(seminarId);
            if (applyRes.isAuthExpired) {
              isAuthExpired = true;
              return;
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
            console.warn(
              `[apply_seminar] seminarId ${seminarId} API 신청 중 예외 발생, Playwright 폴백 대상에 추가:`,
              err,
            );
          }
        }),
      );
    }

    if (isAuthExpired) {
      const msg = '🔒 세션이 만료되었습니다. 로그인이 필요합니다.';
      await sendTelegram(msg).catch(() => {});
      return { success: false, message: msg };
    }

    // 2단계: API로 신청 완료(isAppliedSeminar=true)가 확정되지 않은 세미나에 대해 Playwright 브라우저 폴백 실행
    // 단, 비공개 세미나는 API 신청 실패 시 브라우저 폴백을 수행하지 않고 패스
    const fallbackTargets = targetSeminarIds.filter((id) => {
      if (confirmedAppliedIds.has(id)) return false;

      const item = currentSeminars.find((s) => (s.seminarId || getSeminarIdFromUrl(s.url)) === id);
      const isPrivate =
        (item && (item.hiddenYn === 'Y' || item.hiddenYn === 'y')) ||
        Boolean(seminarRepo.getSeminarById(id)?.hiddenYn === 'Y');

      if (isPrivate) {
        console.log(
          `[apply_seminar] seminarId ${id}는 비공개 세미나이므로 API 신청 실패 시 Playwright 폴백을 패스합니다.`,
        );
        return false;
      }
      return true;
    });

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

    await checkAndTriggerSeminarMonitors(sync.finalSeminars || [], { targetDate: referenceDate }).catch((err) => {
      logger.error('checkAndTriggerSeminarMonitors error in applySeminars:', err);
    });

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

export const applySeminarsTask = {
  name: 'apply_seminars',
  description: '세미나 신청 및 목록 저장',
  run: applySeminars,
};

export const syncSeminarsTask = {
  name: 'sync_seminars',
  description: '세미나 목록 갱신 및 심화 세미나 포인트 확인',
  schedule: '*/10 6-23 * * *',
  options: {
    notifyNewSeminarsToTelegram: false,
    notifyNewSeminarsToChannel: true,
    silentIfNoNew: true,
    checkAdvancedPointStatus: true,
  },
  run: async (ctx: TaskContext = {}, options?: ApplySeminarOptions) => {
    const opts = {
      notifyNewSeminarsToTelegram: false,
      notifyNewSeminarsToChannel: true,
      silentIfNoNew: true,
      checkAdvancedPointStatus: true,
      ...options,
    };
    const syncResult = await syncSeminars(opts);
    if (!syncResult.success) {
      return syncResult;
    }
    if (syncResult.hasApplyTarget) {
      return applySeminars(ctx, { ...opts, notifyNewSeminarsToTelegram: false, silentIfNoNew: true }, syncResult);
    }
    return syncResult;
  },
};
