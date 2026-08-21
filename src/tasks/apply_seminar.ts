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
import { searchSeminarPoints, type SeminarPointResult } from './check_seminar_point';
import * as storage from '../services/storage';

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
export const SEMINAR_LIST_KEY = 'apply_seminar:seminar_list';
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

const LEGACY_NEW_SEMINAR_KEY = 'apply_seminar:new_seminars';
const LEGACY_HISTORY_KEY = 'apply_seminar:new_seminars_history';

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
  } else return null;
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

/**
 * 1회성 legacy 키(`apply_seminar:new_seminars`, `apply_seminar:new_seminars_history`)를
 * seminar_list로 흡수하고 legacy 키를 삭제한다. 이후 run 흐름에서는
 * SEMINAR_LIST_KEY만 사용한다.
 */
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

  storage.set(SEMINAR_LIST_KEY, [...merged.values()]);
  storage.deleteKey(LEGACY_NEW_SEMINAR_KEY);
  storage.deleteKey(LEGACY_HISTORY_KEY);
  return [...merged.values()];
}

/**
 * 포인트 지급 테이블을 조회하여 seminar_list에 반영한다.
 * - 기존 searchSeminarPoints()를 재사용 (별도 파서 생성 금지)
 * - 조회 성공(success===true)일 때만 pointCheckedAt/pointPaid 갱신
 *   실패 시에는 기존 포인트 상태를 유지하고 로그만 남김
 * - pointPaid === true인 세미나는 재조회하지 않음 (기존 정보 보존)
 * - pointPaid가 없거나 false인 세미나는 테이블과 대조하여 업데이트
 * - 테이블에만 있는 세미나는 새 항목으로 추가하되 detectedDate/detectedAt 미부여
 */
async function refreshPointStatusFromTable(
  context: PlaywrightRunArgs['context'],
  currentSeminars: SeminarListItem[],
): Promise<SeminarListItem[]> {
  const storedSeminars = storage.get<SeminarListItem[]>(SEMINAR_LIST_KEY, []) || [];
  const storedByKey = new Map(storedSeminars.map((s) => [seminarKey(s), s]));
  const currentByKey = new Map(currentSeminars.map((s) => [seminarKey(s), s]));

  // 기존 searchSeminarPoints 재사용: 전체 테이블 파싱 결과(allParsed) 활용
  // seminarIds는 빈 배열로 호출해도 allParsed는 전체 적립 내역을 반환하므로,
  // currentSeminars의 seminarId만으로 호출하면 충분
  const idsForQuery = [...new Set(currentSeminars.map((s) => s.seminarId).filter((id): id is string => !!id))];
  const tableResult = await searchSeminarPoints(context, idsForQuery, 90);
  if (!tableResult.success) {
    console.error(
      `[refreshPointStatus] point table query failed: ${tableResult.error} — skip point merge, keep existing storage`,
    );
    // 실패 시 merge 없이 현재 목록만 보존 (기존 storage 유지)
    // 단, currentSeminars 자체의 신규 세미나 탐지는 유지하되 포인트 필드는 건드리지 않음
    const fallback = new Map<string, SeminarListItem>();
    for (const [key, s] of storedByKey) fallback.set(key, s);
    for (const [key, current] of currentByKey) {
      if (!fallback.has(key)) fallback.set(key, current);
      else {
        // 포인트-only가 아닌 일반 병합: 메타데이터는 보완하되 포인트는 보존
        const base = fallback.get(key)!;
        if (base.pointPaid === true) {
          const patched = {
            ...base,
            name: current.name || base.name,
            date: current.date || base.date,
            time: current.time || base.time,
            currentCount: current.currentCount || base.currentCount,
            totalCount: current.totalCount || base.totalCount,
            nightTime: current.nightTime,
            isAdvancedSurvey: current.isAdvancedSurvey || base.isAdvancedSurvey,
          };
          fallback.set(key, patched);
        } else {
          fallback.set(key, {
            ...base,
            ...current,
            pointPaid: base.pointPaid,
            point: base.point,
            pointText: base.pointText,
            pointDate: base.pointDate,
            pointContent: base.pointContent,
            pointCheckedAt: base.pointCheckedAt,
          });
        }
      }
    }
    const todayMs2 = Date.parse(`${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })}T00:00:00+09:00`);
    const retentionMs2 = SEMINAR_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const finalFallback = [...fallback.values()].filter((seminar) => {
      const reference = normalizeSeminarDate(seminar.date, seminar.detectedDate || '') || seminar.detectedDate;
      if (!reference) return true;
      const dateMs = Date.parse(`${reference}T00:00:00+09:00`);
      return Number.isNaN(dateMs) || Number.isNaN(todayMs2) || todayMs2 - dateMs <= retentionMs2;
    });
    storage.set(SEMINAR_LIST_KEY, finalFallback);
    return finalFallback;
  }
  const allParsed = tableResult.allParsed;

  const checkedAt = new Date().toISOString();
  const updatedSeminars = new Map<string, SeminarListItem>();

  // 1) 기존 저장된 세미나들 중 pointPaid === true인 것들은 그대로 보존
  for (const [key, seminar] of storedByKey) {
    if (seminar.pointPaid === true) {
      updatedSeminars.set(key, seminar);
      continue;
    }
    updatedSeminars.set(key, { ...seminar });
  }

  // 2) 현재 세미나 목록과 포인트 테이블 대조하여 업데이트
  for (const [key, current] of currentByKey) {
    const existing = updatedSeminars.get(key);
    const pointInfo = allParsed.get(current.seminarId || '');

    let merged: SeminarListItem;
    if (pointInfo) {
      if (existing?.pointPaid === true) {
        const base = updatedSeminars.get(key)!;
        const patched = {
          ...base,
          name: current.name || base.name,
          date: current.date || base.date,
          time: current.time || base.time,
          currentCount: current.currentCount || base.currentCount,
          totalCount: current.totalCount || base.totalCount,
          nightTime: current.nightTime,
          isAdvancedSurvey: current.isAdvancedSurvey || base.isAdvancedSurvey,
        };
        updatedSeminars.set(key, patched);
        continue;
      }
      merged = {
        ...(existing || {}),
        ...current,
        pointPaid: true,
        point: pointInfo.point,
        pointText: pointInfo.pointText,
        pointDate: pointInfo.date,
        pointContent: pointInfo.content,
        pointCheckedAt: checkedAt,
        detectedDate: existing?.detectedDate ?? current.detectedDate,
        detectedAt: existing?.detectedAt ?? current.detectedAt,
      };
    } else if (existing) {
      if (existing.pointPaid === true) {
        const base = updatedSeminars.get(key)!;
        const patched = {
          ...base,
          name: current.name || base.name,
          date: current.date || base.date,
          time: current.time || base.time,
          currentCount: current.currentCount || base.currentCount,
          totalCount: current.totalCount || base.totalCount,
          nightTime: current.nightTime,
          isAdvancedSurvey: current.isAdvancedSurvey || base.isAdvancedSurvey,
        };
        updatedSeminars.set(key, patched);
        continue;
      }
      merged = {
        ...(existing || {}),
        ...current,
        pointPaid: false,
        pointCheckedAt: checkedAt,
        detectedDate: existing.detectedDate ?? current.detectedDate,
        detectedAt: existing.detectedAt ?? current.detectedAt,
      };
    } else {
      merged = {
        ...current,
        pointPaid: false,
        pointCheckedAt: checkedAt,
      };
    }
    updatedSeminars.set(key, merged);
  }

  // 3) 포인트 테이블에만 있고 seminar_list에 없는 세미나들 -> 새 항목 생성
  for (const [seminarId, pointInfo] of allParsed) {
    let foundKey: string | null = null;
    for (const [key, s] of currentByKey) {
      if (s.seminarId === seminarId) {
        foundKey = key;
        break;
      }
    }
    if (!foundKey) {
      for (const [key, s] of storedByKey) {
        if (s.seminarId === seminarId) {
          foundKey = key;
          break;
        }
      }
    }

    if (!foundKey) {
      const url = `${SEMINAR_DETAIL_PAGE}${seminarId}`;
      const newItem: SeminarListItem = {
        seminarId,
        name: pointInfo.content || `세미나 ${seminarId}`,
        url,
        date: undefined,
        time: '',
        currentCount: '',
        totalCount: '',
        nightTime: false,
        isPointExcluded: false,
        isAdvancedSurvey: false,
        pointPaid: true,
        point: pointInfo.point,
        pointText: pointInfo.pointText,
        pointDate: pointInfo.date,
        pointContent: pointInfo.content,
        pointCheckedAt: checkedAt,
      };
      const key = seminarKey(newItem);
      updatedSeminars.set(key, newItem);
      console.log(`[refreshPointStatus] added point-only seminar: ${seminarId}`);
    }
  }

  // 4) Retention 적용 (60일 지난 세미나 제거)
  const todayMs = Date.parse(`${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' })}T00:00:00+09:00`);
  const retentionMs = SEMINAR_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const finalSeminars = [...updatedSeminars.values()].filter((seminar) => {
    const reference = normalizeSeminarDate(seminar.date, seminar.detectedDate || '') || seminar.detectedDate;
    if (!reference) return true;
    const dateMs = Date.parse(`${reference}T00:00:00+09:00`);
    return Number.isNaN(dateMs) || Number.isNaN(todayMs) || todayMs - dateMs <= retentionMs;
  });

  storage.set(SEMINAR_LIST_KEY, finalSeminars);
  return finalSeminars;
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

    // 1회성 legacy 키 마이그레이션: seminar_list로 흡수 후 legacy 키 삭제
    const storedSeminars = migrateLegacySeminarStorage(referenceDate);
    const storedByUrl = new Map(storedSeminars.map((s) => [s.url, s]));

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

        const flaggedByUrl = new Map(newlyAddedWithFlags.map((item) => [item.url, item]));
        for (const item of normalizedCurrentSeminars) {
          if (flaggedByUrl.has(item.url)) {
            Object.assign(item, flaggedByUrl.get(item.url));
          }
        }
      }
    }

    // 포인트 지급 테이블 조회 및 병합 (핵심 로직)
    const finalSeminars = await refreshPointStatusFromTable(context ?? page.context(), normalizedCurrentSeminars);

    if (newlyAddedWithFlags.length > 0) {
      const flaggedByUrl = new Map(newlyAddedWithFlags.map((item) => [item.url, item]));
      for (const seminar of finalSeminars) {
        const flagged = flaggedByUrl.get(seminar.url);
        if (flagged) {
          seminar.isPointExcluded = flagged.isPointExcluded;
          seminar.seminarId = flagged.seminarId;
        }
      }
      storage.set(SEMINAR_LIST_KEY, finalSeminars);
    }

    if (checkAdvancedPointStatus) {
      console.log('point status already refreshed in main flow');
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
  description: '세미나 목록 갱신 및 포인트 지급 확인',
  schedule: '*/10 6-23 * * *',
  options: { notifyNewSeminarsToTelegram: false, silentIfNoNew: true, checkAdvancedPointStatus: true },
  run,
};
