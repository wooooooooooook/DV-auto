import type { BrowserContext } from 'playwright';
import * as storage from '../services/storage';
import { searchSeminarPoints } from './check_seminar_point';
import { NEW_SEMINAR_HISTORY_KEY } from './apply_seminar';

const SEMINAR_LIST_KEY = 'apply_seminar:seminar_list';
const LOOKBACK_DAYS = 14;
const POINT_SEARCH_DAYS = 60;

type SeminarRecord = { name?: string; url: string; date?: string; seminarId?: string | null; isAdvancedSurvey?: boolean };
type HistoryEntry = { detectedDate?: string; seminar?: SeminarRecord };

function getKstDate(): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
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
  const text = value.trim();
  const iso = text.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  const md = text.match(/^(\d{1,2})\s*[-/.]\s*(\d{1,2})/);
  const korean = text.match(/^(\d{1,2})월\s*(\d{1,2})일?/);
  let year: number, month: number, day: number;
  if (iso) {
    year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]);
  } else if (md || korean) {
    month = Number((md || korean)![1]); day = Number((md || korean)![2]);
    const ref = new Date(`${referenceDate}T00:00:00+09:00`);
    year = ref.getFullYear();
    const refMonth = ref.getMonth() + 1;
    if (month - refMonth > 6) year--; else if (refMonth - month > 6) year++;
  } else return null;
  const normalized = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${normalized}T00:00:00+09:00`);
  if (Number.isNaN(parsed.getTime()) || parsed.getMonth() + 1 !== month || parsed.getDate() !== day) return null;
  return normalized;
}

function getSeminarId(seminar: SeminarRecord): string {
  return seminar.seminarId || seminar.url.match(/(?:seminarId=|\/)(\d+)(?:[?#].*)?$/)?.[1] || '';
}

export async function run({ context }: { context: BrowserContext }): Promise<{ success: boolean; message: string }> {
  try {
    const todayStr = getKstDate();
    const pastStr = getDateDaysAgo(todayStr, LOOKBACK_DAYS);
    const history = storage.get<HistoryEntry[]>(NEW_SEMINAR_HISTORY_KEY, []) || [];
    const currentSeminars = storage.get<SeminarRecord[]>(SEMINAR_LIST_KEY, []) || [];
    const candidates = new Map<string, { date: string; seminar: SeminarRecord }>();
    const rawSamples: string[] = [];

    const add = (seminar: SeminarRecord, detectedDate?: string) => {
      const rawDate = seminar.date || detectedDate;
      const date = normalizeSeminarDate(rawDate, detectedDate || todayStr);
      if (rawSamples.length < 10) rawSamples.push(`${seminar.name || '세미나'}: raw=${JSON.stringify(rawDate)} -> ${date}`);
      if (!date || date < pastStr || date > todayStr) return;
      const id = getSeminarId(seminar);
      const key = id || seminar.url;
      if (key) candidates.set(key, { date, seminar });
    };

    for (const seminar of currentSeminars) add(seminar, todayStr);
    for (const entry of history) if (entry.seminar) add(entry.seminar, entry.detectedDate || todayStr);

    const all = Array.from(candidates.values()).sort((a, b) => b.date.localeCompare(a.date));
    const advancedCandidates = all.filter(({ seminar }) => seminar.isAdvancedSurvey && getSeminarId(seminar));
    const pointMap = await searchSeminarPoints(context, advancedCandidates.map(({ seminar }) => getSeminarId(seminar)), POINT_SEARCH_DAYS);

    if (all.length === 0) {
      return { success: true, message: `최근 2주(${pastStr} ~ ${todayStr}) 세미나 기록이 없습니다.\n\n디버그: 저장된 현재 세미나 ${currentSeminars.length}건, 히스토리 ${history.length}건\n날짜 샘플:\n${rawSamples.join('\n')}` };
    }

    const lines = all.map(({ date, seminar }) => {
      const id = getSeminarId(seminar);
      const result = id ? pointMap.get(id) : undefined;
      const point = seminar.isAdvancedSurvey ? (result?.found ? ` → ${result.pointText ?? `${result.point ?? 0}P`}` : ' → ❌ 미지급') : '';
      return `${date} | ${seminar.name || '세미나'}${seminar.isAdvancedSurvey ? ' ⭐ 심화설문' : ''}${point}`;
    });

    return { success: true, message: `🗓️ 최근 2주 전체 세미나 ${lines.length}건 (${pastStr} ~ ${todayStr})\n\n${lines.join('\n')}\n\n⭐ 심화설문 ${advancedCandidates.length}건` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, message: `심화 세미나 포인트 조회 오류: ${msg}` };
  }
}

export async function checkAdvancedSeminars(context: BrowserContext) {
  return run({ context });
}
