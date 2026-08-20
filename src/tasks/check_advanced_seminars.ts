import type { BrowserContext } from 'playwright';
import * as storage from '../services/storage';
import { searchSeminarPoints } from './check_seminar_point';
import { NEW_SEMINAR_HISTORY_KEY } from './apply_seminar';

const SEMINAR_LIST_KEY = 'apply_seminar:seminar_list';
const LOOKBACK_DAYS = 14;
const POINT_SEARCH_DAYS = 60;

interface AdvancedSeminarResult {
  date: string;
  name: string;
  id: string;
  isAdvancedSurvey: boolean;
  found: boolean;
  point?: number;
  pointText?: string;
}

type SeminarRecord = {
  name?: string;
  url: string;
  date?: string;
  seminarId?: string | null;
  isAdvancedSurvey?: boolean;
};

type HistoryEntry = {
  detectedDate?: string;
  seminar?: SeminarRecord;
};

function getKstDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function getDateDaysAgo(todayStr: string, days: number): string {
  const [year, month, day] = todayStr.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day - days));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function normalizeSeminarDate(value: string | undefined, referenceDate: string): string | null {
  if (!value) return null;

  const isoMatch = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }

  const mdMatch = value.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!mdMatch) return null;

  const month = Number(mdMatch[1]);
  const day = Number(mdMatch[2]);
  const reference = new Date(`${referenceDate}T00:00:00+09:00`);
  if (!Number.isFinite(month) || !Number.isFinite(day) || Number.isNaN(reference.getTime())) return null;

  let year = reference.getFullYear();
  const referenceMonth = reference.getMonth() + 1;
  if (month - referenceMonth > 6) year -= 1;
  else if (referenceMonth - month > 6) year += 1;

  const normalized = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${normalized}T00:00:00+09:00`);
  if (Number.isNaN(parsed.getTime()) || parsed.getMonth() + 1 !== month || parsed.getDate() !== day) return null;
  return normalized;
}

function getSeminarId(seminar: SeminarRecord): string {
  return seminar.seminarId || seminar.url.match(/(?:seminarId=|\/)(\d+)$/)?.[1] || '';
}

function collectSeminars(todayStr: string, pastStr: string, history: HistoryEntry[], currentSeminars: SeminarRecord[]) {
  const candidates = new Map<string, { date: string; seminar: SeminarRecord }>();
  const add = (seminar: SeminarRecord, detectedDate?: string) => {
    const date = normalizeSeminarDate(seminar.date, detectedDate || todayStr);
    if (!date || date < pastStr || date > todayStr) return;
    const id = getSeminarId(seminar);
    const key = id || seminar.url;
    if (key) candidates.set(key, { date, seminar });
  };
  for (const seminar of currentSeminars) add(seminar, todayStr);
  for (const entry of history) if (entry.seminar) add(entry.seminar, entry.detectedDate || todayStr);
  return candidates;
}

export async function checkAdvancedSeminars(context: BrowserContext): Promise<AdvancedSeminarResult[]> {
  const todayStr = getKstDate();
  const pastStr = getDateDaysAgo(todayStr, LOOKBACK_DAYS);
  const history = storage.get<HistoryEntry[]>(NEW_SEMINAR_HISTORY_KEY, []) || [];
  const currentSeminars = storage.get<SeminarRecord[]>(SEMINAR_LIST_KEY, []) || [];
  const candidates = collectSeminars(todayStr, pastStr, history, currentSeminars);

  const seminarInfos = Array.from(candidates.values()).map(({ date, seminar }) => ({
    date,
    id: getSeminarId(seminar),
    name: seminar.name || '세미나',
    isAdvancedSurvey: !!seminar.isAdvancedSurvey,
  }));

  const advancedInfos = seminarInfos.filter((s) => s.isAdvancedSurvey && s.id);
  const resultsMap = await searchSeminarPoints(context, advancedInfos.map((s) => s.id), POINT_SEARCH_DAYS);

  return seminarInfos
    .filter((s) => s.isAdvancedSurvey)
    .map((info) => {
      const pointRes = info.id ? resultsMap.get(info.id) || { found: false } : { found: false };
      return {
        date: info.date,
        name: info.name,
        id: info.id,
        isAdvancedSurvey: true,
        found: pointRes.found,
        point: pointRes.point,
        pointText: pointRes.pointText,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

export async function run({ context }: { context: BrowserContext }): Promise<{ success: boolean; message: string }> {
  try {
    const todayStr = getKstDate();
    const pastStr = getDateDaysAgo(todayStr, LOOKBACK_DAYS);
    const history = storage.get<HistoryEntry[]>(NEW_SEMINAR_HISTORY_KEY, []) || [];
    const currentSeminars = storage.get<SeminarRecord[]>(SEMINAR_LIST_KEY, []) || [];
    const candidates = collectSeminars(todayStr, pastStr, history, currentSeminars);
    const all = Array.from(candidates.values()).sort((a, b) => (a.date < b.date ? 1 : -1));
    const advanced = await checkAdvancedSeminars(context);
    const advancedMap = new Map(advanced.map((r) => [r.id || r.name, r]));

    if (all.length === 0) {
      return {
        success: true,
        message: `최근 2주(${pastStr} ~ ${todayStr}) 세미나 기록이 없습니다.\n\n디버그: 저장된 현재 세미나 ${currentSeminars.length}건, 히스토리 ${history.length}건`,
      };
    }

    const lines = all.map(({ date, seminar }) => {
      const id = getSeminarId(seminar);
      const advancedResult = advancedMap.get(id);
      const marker = seminar.isAdvancedSurvey ? ' ⭐ 심화설문' : '';
      const point = advancedResult
        ? advancedResult.found
          ? ` → ${advancedResult.pointText ?? `${advancedResult.point ?? 0}P`}`
          : ' → ❌ 미지급'
        : '';
      return `${date} | ${seminar.name || '세미나'}${marker}${point}`;
    });

    return {
      success: true,
      message: `🗓️ 최근 2주 전체 세미나 ${lines.length}건 (${pastStr} ~ ${todayStr})\n\n${lines.join('\n')}\n\n⭐ 심화설문 ${advanced.length}건`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, message: `심화 세미나 포인트 조회 오류: ${msg}` };
  }
}
