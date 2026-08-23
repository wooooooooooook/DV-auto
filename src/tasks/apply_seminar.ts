import path from 'path';
import fs from 'fs/promises';
import type { PlaywrightRunArgs, TaskResult } from '../types';
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
import { searchSeminarPoints } from './check_seminar_point';
import * as storage from '../services/storage';

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
const _SEMINAR_DETAIL_HTTP_PAGE = 'https://www.doctorville.co.kr/seminar/seminarDetail?seminarId=';
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
  url: string;
  name: string;
  date: string;
  time: string;
  currentCount: string;
  totalCount: string;
  nightTime: boolean;
  isAdvancedSurvey: boolean;
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

export function getSeminarInfoChanges(existing: SeminarListItem, incoming: SeminarListItem): SeminarFieldChange[] {
  const changes: SeminarFieldChange[] = [];
  for (const { key, label } of MEANINGFUL_FIELDS) {
    const oldVal = existing[key];
    const newVal = incoming[key];

    // If incoming value is undefined and existing had a value, only treat as change if explicitly defined
    // For boolean flags like isPointExcluded, undefined in incoming might mean not fetched yet
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

function refreshStoredSeminarList(
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

  storage.set(SEMINAR_LIST_KEY, seminars);
  return { seminars, newlyAdded, infoChanges };
}

export async function refreshSeminarPointStatus(
  context: PlaywrightRunArgs['context'],
  seminars: SeminarListItem[],
): Promise<{ seminars: SeminarListItem[]; pointChanges: SeminarPointChange[] }> {
  if (!context) return { seminars, pointChanges: [] };

  const searchRes = await searchSeminarPoints(context, [], 60);
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

  const updatedSeminars = seminars.map((seminar) => {
    if (seminar.pointPaid === true) {
      return seminar;
    }

    const id = seminar.seminarId || getSeminarIdFromUrl(seminar.url);
    if (id && parsedPoints.has(id)) {
      const pointResult = parsedPoints.get(id)!;
      if (pointResult.found && pointResult.type === '적립') {
        pointChanges.push({
          seminarId: id,
          name: seminar.name,
          point: pointResult.point,
          pointText: pointResult.pointText,
          pointDate: pointResult.date,
          pointContent: pointResult.content,
        });

        return {
          ...seminar,
          pointPaid: true,
          point: pointResult.point,
          pointDate: pointResult.date,
          pointText: pointResult.pointText,
          pointContent: pointResult.content,
          pointCheckedAt: checkedAt,
        };
      }
    }

    return {
      ...seminar,
      pointPaid: false,
      pointCheckedAt: checkedAt,
    };
  });

  for (const [id, pointResult] of parsedPoints) {
    if (!pointResult.found || pointResult.type !== '적립') continue;

    const exists = updatedSeminars.some((item) => (item.seminarId || getSeminarIdFromUrl(item.url)) === id);
    if (!exists) {
      const newItem: SeminarListItem = {
        seminarId: id,
        name: '',
        url: `https://m.doctorville.co.kr/cme/seminar/${id}`,
        date: '',
        time: '',
        currentCount: '',
        totalCount: '',
        nightTime: false,
        isAdvancedSurvey: false,
        isPointExcluded: false,
        pointPaid: true,
        point: pointResult.point,
        pointDate: pointResult.date,
        pointText: pointResult.pointText,
        pointContent: pointResult.content,
        pointCheckedAt: checkedAt,
        detectedDate: '',
        detectedAt: '',
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

async function run({ page, context }: PlaywrightRunArgs, options: ApplySeminarOptions = {}): Promise<TaskResult> {
  let screenshotPath: string | null = null;
  const {
    notifyNewSeminarsToChannel = false,
    notifyNewSeminarsToTelegram = true,
    _checkAdvancedPointStatus = false,
  } = options;

  try {
    await ensureLoggedIn({ page, context: context ?? page.context() });

    await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 }, 1);
    const totalSeminarLinks = page.locator('a.list_detail');
    const totalSeminarsAvailable = await totalSeminarLinks.count();
    const closedCount = await page.locator('.ico_finish').count();
    const applyLocator = page.locator('a:has(.ico_apply)');
    const items = await applyLocator.evaluateAll((nodes) =>
      nodes.map((n) => ({ href: n.getAttribute('href'), text: (n.textContent || '').trim() })),
    );
    const attemptedApplyCount = items.length;

    for (const item of items) {
      await safeGoto(page, item.href, { waitUntil: 'load', timeout: 30000 }, 1);
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

    await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 }, 1);

    const currentSeminars: RawSeminarData[] = await page.locator('.list_cont').evaluateAll((nodes) => {
      const results: RawSeminarData[] = [];
      nodes.forEach((node) => {
        const date = node.querySelector('.seminar_day .date')?.textContent?.trim() || '';
        node.querySelectorAll('a.list_detail').forEach((link) => {
          const href = link.getAttribute('href') || '';
          if (!href) return;
          const name =
            link.querySelector('.list_tit .tit')?.textContent?.trim() || link.textContent?.trim() || '세미나';
          const timeNode = link.querySelector('.txt_num.time');
          const time = timeNode?.textContent?.replace(/\n/g, '').trim() || '';
          const nightTime = timeNode ? timeNode.classList.contains('night_time') : false;
          const personNode = link.querySelector('.person');
          const currentCount = personNode?.querySelector('.txt_num')?.textContent?.trim() || '';
          const totalCount = personNode?.querySelector('.total .txt_num')?.textContent?.replace(/\//g, '').trim() || '';
          results.push({
            url: href,
            name,
            date,
            time,
            currentCount,
            totalCount,
            nightTime,
            isAdvancedSurvey: !!link.querySelector('.ic_survey'),
          });
        });
      });
      return results;
    });

    const referenceDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const normalizedCurrentSeminars = normalizeParsedSeminars(currentSeminars, referenceDate);
    const storedSeminars = migrateLegacySeminarStorage(referenceDate);
    const { seminars, newlyAdded, infoChanges } = refreshStoredSeminarList(
      normalizedCurrentSeminars,
      storedSeminars,
      referenceDate,
    );

    if (newlyAdded.length > 0) {
      const newlyAddedWithFlags: SeminarListItem[] = [];
      for (const item of newlyAdded) {
        const seminarId = getSeminarIdFromUrl(item.url);
        const link = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : item.url;
        const pointExRes = await isSurveyPointExcludedSeminarHttp(link);
        const isPointExcluded = pointExRes.status === 'success' ? pointExRes.excluded : item.isPointExcluded;
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
    const activeContext = context ?? page.context();
    let pointChanges: SeminarPointChange[] = [];
    if (activeContext) {
      const pointStatusResult = await refreshSeminarPointStatus(activeContext, finalSeminars);
      pointChanges = pointStatusResult.pointChanges;
    }

    // Send adminbot notification if there are meaningful seminar info changes or new point payments
    const changeNotificationText = formatSeminarChangeNotification(infoChanges, pointChanges);
    if (changeNotificationText) {
      await sendTelegram(changeNotificationText).catch(() => {});
    }

    const appliedCount = await page.locator('a:has(.ico_completion)').count();
    let message = `✅ ${appliedCount}개 세미나 신청 완료! (${appliedCount}/${totalSeminarsAvailable})`;
    const failedToApplyCount = attemptedApplyCount - appliedCount;
    if (failedToApplyCount > 0) message += `\n (${failedToApplyCount}개는 마감 등의 사유로 신청 실패)`;
    if (closedCount > 0) message += `\n ${closedCount}개는 신청 마감되어 신청하지 못했습니다.`;

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
    if (!screenshotPath) {
      const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
      await fs.mkdir(baseScreenshotDir, { recursive: true });
      screenshotPath = path.join(baseScreenshotDir, 'apply_seminar_error.png');
      await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => {});
    }
    const message = error instanceof Error ? error.message : String(error);
    await sendTelegram(`❗ 세미나 신청 작업 오류: ${message}`, screenshotPath).catch(() => {});
    return { success: false, message: `세미나 신청 작업 오류: ${message}`, imagePath: screenshotPath };
  }
}

export { run };
export const applySeminarTask = { name: 'apply_seminar', description: '세미나 신청 및 목록 저장', run };
export const applySeminarTaskStandalone = { name: 'apply_seminar', description: '세미나 신청 및 목록 저장', run };
export const applySeminarExtraTask = {
  name: 'apply_seminar_extra',
  description: '세미나 목록 갱신 및 심화 세미나 포인트 확인',
  schedule: '*/10 6-23 * * *',
  options: { notifyNewSeminarsToTelegram: false, silentIfNoNew: true, checkAdvancedPointStatus: true },
  run: (_args: unknown, options?: ApplySeminarOptions) =>
    runHttpOnly(options || { notifyNewSeminarsToTelegram: false, silentIfNoNew: true, checkAdvancedPointStatus: true }),
};

export async function runHttpOnly(options: ApplySeminarOptions = {}): Promise<TaskResult> {
  const { notifyNewSeminarsToChannel = false, notifyNewSeminarsToTelegram = true } = options;

  try {
    await ensureLoggedIn();

    const mainRes = await httpGet(SEMINAR_PAGE);
    if (mainRes.status !== 200 || !mainRes.body) {
      throw new Error(`HTTP GET ${SEMINAR_PAGE} failed with status ${mainRes.status}`);
    }

    const currentSeminars = parseSeminarListHtml(mainRes.body);
    const referenceDate = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const normalizedCurrentSeminars = normalizeParsedSeminars(currentSeminars, referenceDate);
    const storedSeminars = migrateLegacySeminarStorage(referenceDate);

    const { seminars, newlyAdded, infoChanges } = refreshStoredSeminarList(
      normalizedCurrentSeminars,
      storedSeminars,
      referenceDate,
    );

    if (newlyAdded.length > 0) {
      const newlyAddedWithFlags: SeminarListItem[] = [];
      for (const item of newlyAdded) {
        const seminarId = getSeminarIdFromUrl(item.url);
        const link = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : item.url;
        const pointExRes = await isSurveyPointExcludedSeminarHttp(link);
        const isPointExcluded = pointExRes.status === 'success' ? pointExRes.excluded : item.isPointExcluded;
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
    }

    const completionCount = parseCompletionCountHtml(mainRes.body);
    const totalSeminarsAvailable = currentSeminars.length;
    const message = `✅ ${completionCount}개 세미나 신청 완료! (${completionCount}/${totalSeminarsAvailable})`;

    const result: TaskResult = { success: true, message };
    if (options.silentIfNoNew && newlyAdded.length === 0) result.silent = true;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('apply_seminar_extra HTTP error:', message);
    await sendTelegram(`❗ 세미나 목록 갱신 작업 오류: ${message}`).catch(() => {});
    return { success: false, message: `세미나 목록 갱신 작업 오류: ${message}` };
  }
}
