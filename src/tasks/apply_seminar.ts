import path from 'path';
import fs from 'fs/promises';
import type { PlaywrightRunArgs, TaskResult } from '../types';
import {
  safeGoto,
  sendNotificationToChannel,
  sendTelegram,
  getSeminarIdFromUrl,
  isSurveyPointExcludedSeminar,
  ensureLoggedIn,
} from '../modules/utils';
import { searchSeminarPoints } from './check_seminar_point';
import * as storage from '../services/storage';

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
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

type SeminarListItem = {
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

type LegacyHistoryEntry = {
  detectedDate?: string;
  detectedAt?: string;
  seminar?: SeminarListItem;
};

type LegacyNewSeminars = {
  date?: string;
  seminars?: SeminarListItem[];
};

type RawSeminarData = {
  url: string;
  name: string;
  date: string;
  time: string;
  currentCount: string;
  totalCount: string;
  nightTime: boolean;
  isAdvancedSurvey: boolean;
};

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

function mergeSeminar(existing: SeminarListItem | undefined, incoming: SeminarListItem): SeminarListItem {
  return {
    ...existing,
    ...incoming,
    isPointExcluded: incoming.isPointExcluded ?? existing?.isPointExcluded,
    pointPaid: incoming.pointPaid ?? existing?.pointPaid,
    point: incoming.point ?? existing?.point,
    pointText: incoming.pointText ?? existing?.pointText,
    pointDate: incoming.pointDate ?? existing?.pointDate,
    pointContent: incoming.pointContent ?? existing?.pointContent,
    pointCheckedAt: incoming.pointCheckedAt ?? existing?.pointCheckedAt,
    detectedDate: incoming.detectedDate ?? existing?.detectedDate,
    detectedAt: incoming.detectedAt ?? existing?.detectedAt,
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
): { seminars: SeminarListItem[]; newlyAdded: SeminarListItem[] } {
  const storedByKey = new Map(stored.map((seminar) => [seminarKey(seminar), seminar]));
  const newlyAdded = current.filter((seminar) => !storedByKey.has(seminarKey(seminar)));
  const now = new Date().toISOString();

  for (const seminar of current) {
    const key = seminarKey(seminar);
    const existing = storedByKey.get(key);
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
  return { seminars, newlyAdded };
}

async function refreshAdvancedPointStatus(
  context: PlaywrightRunArgs['context'],
  seminars: SeminarListItem[],
): Promise<Map<string, SeminarPointStatus>> {
  const targets = seminars.filter(
    (seminar) =>
      seminar.isAdvancedSurvey && !seminar.pointPaid && !seminar.isPointExcluded && getSeminarIdFromUrl(seminar.url),
  );
  if (!targets.length) return new Map();

  const ids = [
    ...new Set(targets.map((seminar) => getSeminarIdFromUrl(seminar.url)).filter((id): id is string => !!id)),
  ];
  const results = await searchSeminarPoints(context, ids, 60);
  const statuses = new Map<string, SeminarPointStatus>();
  const checkedAt = new Date().toISOString();

  for (const seminar of targets) {
    const id = getSeminarIdFromUrl(seminar.url);
    if (!id) continue;
    const result = results.get(id);
    statuses.set(seminarKey(seminar), {
      pointPaid: result?.found === true && result.type === '적립',
      point: result?.point,
      pointText: result?.pointText,
      pointDate: result?.date,
      pointContent: result?.content,
      pointCheckedAt: checkedAt,
    });
  }
  return statuses;
}

function updateStoredPointStatuses(statuses: Map<string, SeminarPointStatus>): void {
  if (!statuses.size) return;
  const seminars = storage.get<SeminarListItem[]>(SEMINAR_LIST_KEY, []) || [];
  storage.set(
    SEMINAR_LIST_KEY,
    seminars.map((seminar) => ({
      ...seminar,
      ...(statuses.get(seminarKey(seminar)) || {}),
    })),
  );
}

type ApplySeminarOptions = {
  notifyNewSeminarsToChannel?: boolean;
  notifyNewSeminarsToTelegram?: boolean;
  silentIfNoNew?: boolean;
  checkAdvancedPointStatus?: boolean;
};

async function run({ page, context }: PlaywrightRunArgs, options: ApplySeminarOptions = {}): Promise<TaskResult> {
  let screenshotPath: string | null = null;
  const {
    notifyNewSeminarsToChannel = false,
    notifyNewSeminarsToTelegram = true,
    checkAdvancedPointStatus = false,
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
      } catch {}
      try {
        const nextTerms = page.locator('.agg_next_terms');
        if (await nextTerms.isVisible({ timeout: 1000 })) {
          await nextTerms.click();
          await page.waitForSelector('#terms_confirm', { timeout: 2000 });
          await page.click('#terms_confirm');
        }
      } catch {}
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
    const { seminars, newlyAdded } = refreshStoredSeminarList(normalizedCurrentSeminars, storedSeminars, referenceDate);

    if (newlyAdded.length > 0) {
      const newlyAddedWithFlags: SeminarListItem[] = [];
      for (const item of newlyAdded) {
        const seminarId = getSeminarIdFromUrl(item.url);
        const link = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : item.url;
        let isPointExcluded = await isSurveyPointExcludedSeminar(page.context(), link);
        if (!isPointExcluded) {
          await page.waitForTimeout(800);
          isPointExcluded = await isSurveyPointExcludedSeminar(page.context(), link);
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
    if (checkAdvancedPointStatus) {
      const statuses = await refreshAdvancedPointStatus(context, finalSeminars);
      updateStoredPointStatuses(statuses);
      if (statuses.size > 0) console.log(`advanced seminar point status updated: ${statuses.size}`);
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
  run,
};
