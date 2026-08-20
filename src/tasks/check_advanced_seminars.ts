import * as storage from '../services/storage';
import { NEW_SEMINAR_HISTORY_KEY } from './apply_seminar';

const SEMINAR_LIST_KEY = 'apply_seminar:seminar_list';
const LOOKBACK_DAYS = 14;

type SeminarRecord = {
  name?: string;
  url: string;
  date?: string;
  seminarId?: string | null;
  isAdvancedSurvey?: boolean;
  pointPaid?: boolean;
  point?: number;
  pointText?: string;
  pointDate?: string;
  pointContent?: string;
  pointCheckedAt?: string;
};
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
  let year: number; let month: number; let day: number;
  if (iso) { year = Number(iso[1]); month = Number(iso[2]); day = Number(iso[3]); }
  else if (md || korean) {
    month = Number((md || korean)![1]); day = Number((md || korean)![2]);
    const [refYear, refMonth] = referenceDate.split('-').map(Number);
    year = refYear;
    if (month - refMonth > 6) year--; else if (refMonth - month > 6) year++;
  } else return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function collectRecentSeminars(todayStr: string, pastStr: string): Array<{ date: string; seminar: SeminarRecord }> {
  const history = storage.get<HistoryEntry[]>(NEW_SEMINAR_HISTORY_KEY, []) || [];
  const currentSeminars = storage.get<SeminarRecord[]>(SEMINAR_LIST_KEY, []) || [];
  const candidates = new Map<string, { date: string; seminar: SeminarRecord }>();
  const add = (seminar: SeminarRecord, detectedDate?: string) => {
    const date = normalizeSeminarDate(seminar.date, detectedDate || todayStr);
    if (!date || date < pastStr || date > todayStr) return;
    const key = seminar.seminarId || seminar.url;
    if (key) candidates.set(key, { date, seminar });
  };
  for (const seminar of currentSeminars) add(seminar, todayStr);
  for (const entry of history) if (entry.seminar) add(entry.seminar, entry.detectedDate || todayStr);
  return Array.from(candidates.values()).sort((a, b) => b.date.localeCompare(a.date));
}

export function run(): { success: boolean; message: string } {
  try {
    const todayStr = getKstDate();
    const pastStr = getDateDaysAgo(todayStr, LOOKBACK_DAYS);
    const all = collectRecentSeminars(todayStr, pastStr);
    if (all.length === 0) return { success: true, message: `최근 2주(${pastStr} ~ ${todayStr}) 세미나 기록이 없습니다.` };

    const advanced = all.filter(({ seminar }) => seminar.isAdvancedSurvey);
    const lines = all.map(({ date, seminar }) => {
      if (!seminar.isAdvancedSurvey) return `${date} | ${seminar.name || '세미나'}`;
      const pointStatus = seminar.pointPaid === true
        ? ` → ✅ ${seminar.pointText ?? `${seminar.point ?? 0}P`} 지급됨`
        : seminar.pointCheckedAt
          ? ' → ❌ 미지급'
          : ' → ⏳ 조회 대기';
      return `${date} | ${seminar.name || '세미나'} ⭐ 심화설문${pointStatus}`;
    });
    return { success: true, message: `🗓️ 최근 2주 전체 세미나 ${lines.length}건 (${pastStr} ~ ${todayStr})\n\n${lines.join('\n')}\n\n⭐ 심화설문 ${advanced.length}건` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, message: `심화 세미나 포인트 조회 오류: ${msg}` };
  }
}

export async function checkAdvancedSeminars(): Promise<{ success: boolean; message: string }> { return run(); }
