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
const SEMINAR_LIST_KEY = 'apply_seminar:seminar_list';
const NEW_SEMINAR_KEY = 'apply_seminar:new_seminars';
export const NEW_SEMINAR_HISTORY_KEY = 'apply_seminar:new_seminars_history';
const NEW_SEMINAR_HISTORY_RETENTION_DAYS = 60;

type SeminarPointStatus = {
  pointPaid?: boolean;
  point?: number;
  pointText?: string;
  pointDate?: string;
  pointContent?: string;
  pointCheckedAt?: string;
};
type SeminarListItem = {
  name: string;
  url: string;
  date?: string;
  time?: string;
  currentCount?: string;
  totalCount?: string;
  isPointExcluded?: boolean;
  isAdvancedSurvey?: boolean;
} & SeminarPointStatus;
type StoredNewSeminars = { date: string; seminars: Array<SeminarListItem & { seminarId: string | null }> };
type NewSeminarHistoryEntry = {
  detectedDate: string;
  detectedAt: string;
  seminar: SeminarListItem & { seminarId: string | null };
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
  } else return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function appendNewSeminarsToHistory(
  items: Array<SeminarListItem & { seminarId: string | null }>,
  detectedDate: string,
): void {
  if (!items.length) return;
  const history = storage.get<NewSeminarHistoryEntry[]>(NEW_SEMINAR_HISTORY_KEY, []) || [];
  const existingUrls = new Set(history.map((entry) => entry.seminar.url));
  const detectedAt = new Date().toISOString();
  for (const seminar of items) {
    if (existingUrls.has(seminar.url)) continue;
    history.push({ detectedDate, detectedAt, seminar });
    existingUrls.add(seminar.url);
  }
  const todayMs = Date.parse(`${detectedDate}T00:00:00+09:00`);
  const retentionMs = NEW_SEMINAR_HISTORY_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const retained = history.filter((entry) => {
    const normalizedDate = normalizeSeminarDate(entry.seminar.date, entry.detectedDate || detectedDate);
    const referenceDate = normalizedDate || entry.detectedDate;
    const entryMs = referenceDate ? Date.parse(`${referenceDate}T00:00:00+09:00`) : NaN;
    return Number.isNaN(entryMs) || Number.isNaN(todayMs) || todayMs - entryMs <= retentionMs;
  });
  storage.set(NEW_SEMINAR_HISTORY_KEY, retained);
}

async function refreshAdvancedPointStatus(
  context: PlaywrightRunArgs['context'],
): Promise<Map<string, SeminarPointStatus>> {
  const history = storage.get<NewSeminarHistoryEntry[]>(NEW_SEMINAR_HISTORY_KEY, []) || [];
  const targets = history
    .map((entry) => entry.seminar)
    .filter(
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
    if (!result?.found) continue;
    statuses.set(seminar.url, {
      pointPaid: result.type === '적립',
      point: result.point,
      pointText: result.pointText,
      pointDate: result.date,
      pointContent: result.content,
      pointCheckedAt: checkedAt,
    });
  }
  return statuses;
}

function updateStoredPointStatuses(statuses: Map<string, SeminarPointStatus>): void {
  if (!statuses.size) return;
  const history = storage.get<NewSeminarHistoryEntry[]>(NEW_SEMINAR_HISTORY_KEY, []) || [];
  storage.set(
    NEW_SEMINAR_HISTORY_KEY,
    history.map((entry) => ({ ...entry, seminar: { ...entry.seminar, ...(statuses.get(entry.seminar.url) || {}) } })),
  );
  const storedSeminars = storage.get<SeminarListItem[]>(SEMINAR_LIST_KEY, []) || [];
  storage.set(
    SEMINAR_LIST_KEY,
    storedSeminars.map((item) => ({ ...item, ...(statuses.get(item.url) || {}) })),
  );
  const storedNew = storage.get<StoredNewSeminars>(NEW_SEMINAR_KEY);
  if (storedNew)
    storage.set(NEW_SEMINAR_KEY, {
      ...storedNew,
      seminars: storedNew.seminars.map((item) => ({ ...item, ...(statuses.get(item.url) || {}) })),
    });
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
    const currentSeminars = await page.locator('.list_cont').evaluateAll((nodes) => {
      const results: Array<{
        url: string;
        name: string;
        date: string;
        time: string;
        currentCount: string;
        totalCount: string;
        isAdvancedSurvey: boolean;
      }> = [];
      nodes.forEach((node) => {
        const date = node.querySelector('.seminar_day .date')?.textContent?.trim() || '';
        node.querySelectorAll('a.list_detail').forEach((link) => {
          const href = link.getAttribute('href') || '';
          if (!href) return;
          const title =
            link.querySelector('.list_tit .tit')?.textContent?.trim() || link.textContent?.trim() || '세미나';
          const time = link.querySelector('.txt_num.time')?.textContent?.replace(/\n/g, '').trim() || '';
          const personNode = link.querySelector('.person');
          const currentCount = personNode?.querySelector('.txt_num')?.textContent?.trim() || '';
          const totalCount = personNode?.querySelector('.total .txt_num')?.textContent?.replace(/\//g, '').trim() || '';
          results.push({
            url: href,
            name: title,
            date,
            time,
            currentCount,
            totalCount,
            isAdvancedSurvey: !!link.querySelector('.ic_survey'),
          });
        });
      });
      return results;
    });
    const normalizedCurrentSeminars: SeminarListItem[] = currentSeminars.map((item) => ({
      name: item.name,
      url: new URL(item.url, SEMINAR_PAGE).toString(),
      date: item.date,
      time: item.time,
      currentCount: item.currentCount,
      totalCount: item.totalCount,
      isAdvancedSurvey: item.isAdvancedSurvey,
    }));
    const storedSeminars = storage.get<SeminarListItem[]>(SEMINAR_LIST_KEY, []) || [];
    let newlyAddedCount = 0;
    let newlyAddedWithFlags: Array<SeminarListItem & { seminarId: string | null }> = [];
    if (storedSeminars.length > 0) {
      const storedUrls = new Set(storedSeminars.map((item) => item.url));
      const newlyAdded = normalizedCurrentSeminars.filter((item) => !storedUrls.has(item.url));
      newlyAddedCount = newlyAdded.length;
      if (newlyAdded.length > 0) {
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
        const newSeminarMessage = newlyAdded
          .map((item) => {
            const matched = newlyAddedWithFlags.find((flagged) => flagged.url === item.url);
            const pointExcludedSuffix = matched?.isPointExcluded ? ' [포인트미지급]' : '';
            const advancedSurveySuffix = item.isAdvancedSurvey ? ' [심화설문]' : '';
            const dateTimePrefix = item.date || item.time ? `[${item.date}${item.time ? ' ' + item.time : ''}] ` : '';
            const capacityInfo =
              item.currentCount && item.totalCount ? `(${item.currentCount}/${item.totalCount}) ` : '';
            return `${dateTimePrefix}${pointExcludedSuffix}${advancedSurveySuffix}${item.name}${capacityInfo}\n${item.url}`;
          })
          .join('\n\n');
        const noticeMessage = `🆕 새로 추가된 세미나 ${newlyAdded.length}건 발견\n\n${newSeminarMessage}`;
        if (notifyNewSeminarsToTelegram) await sendTelegram(noticeMessage);
        if (notifyNewSeminarsToChannel) await sendNotificationToChannel(noticeMessage);
        const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
        const storedNew = storage.get<StoredNewSeminars>(NEW_SEMINAR_KEY);
        const baseSeminars = storedNew?.date === todayIso ? storedNew.seminars : [];
        const merged = [...baseSeminars];
        const existingUrls = new Set(baseSeminars.map((item) => item.url));
        for (const item of newlyAddedWithFlags)
          if (!existingUrls.has(item.url)) {
            merged.push(item);
            existingUrls.add(item.url);
          }
        storage.set(NEW_SEMINAR_KEY, { date: todayIso, seminars: merged });
        appendNewSeminarsToHistory(newlyAddedWithFlags, todayIso);
      }
    }
    const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const historyItems: Array<SeminarListItem & { seminarId: string | null }> = normalizedCurrentSeminars.map(
      (item) => {
        const stored = storedSeminars.find((s) => s.url === item.url);
        const newlyAdded = newlyAddedWithFlags.find((n) => n.url === item.url);
        return {
          ...item,
          seminarId: getSeminarIdFromUrl(item.url),
          isPointExcluded: stored?.isPointExcluded ?? newlyAdded?.isPointExcluded,
          pointPaid: stored?.pointPaid,
          point: stored?.point,
          pointText: stored?.pointText,
          pointDate: stored?.pointDate,
          pointContent: stored?.pointContent,
          pointCheckedAt: stored?.pointCheckedAt,
        };
      },
    );
    appendNewSeminarsToHistory(historyItems, todayIso);
    const finalSeminarsToStore: SeminarListItem[] = normalizedCurrentSeminars.map((item) => {
      const stored = storedSeminars.find((s) => s.url === item.url);
      const newlyAdded = newlyAddedWithFlags.find((n) => n.url === item.url);
      return {
        ...item,
        isPointExcluded: stored?.isPointExcluded ?? newlyAdded?.isPointExcluded,
        isAdvancedSurvey: item.isAdvancedSurvey,
        pointPaid: stored?.pointPaid,
        point: stored?.point,
        pointText: stored?.pointText,
        pointDate: stored?.pointDate,
        pointContent: stored?.pointContent,
        pointCheckedAt: stored?.pointCheckedAt,
      };
    });
    storage.set(SEMINAR_LIST_KEY, finalSeminarsToStore);
    if (checkAdvancedPointStatus) {
      const statuses = await refreshAdvancedPointStatus(context);
      updateStoredPointStatuses(statuses);
      if (statuses.size > 0) console.log(`advanced seminar point status updated from history: ${statuses.size}`);
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
    if (options.silentIfNoNew && newlyAddedCount === 0) result.silent = true;
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
      await fs.mkdir(baseScreenshotDir, { recursive: true }).catch(() => {});
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
