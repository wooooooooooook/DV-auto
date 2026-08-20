import * as storage from '../services/storage';
import { NEW_SEMINAR_HISTORY_KEY } from './apply_seminar';

const LOOKBACK_DAYS = 14;
const SEMINAR_LIST_KEY = 'apply_seminar:seminar_list';

type SeminarRecord = { name?: string; url: string; date?: string; seminarId?: string | null; isAdvancedSurvey?: boolean; pointPaid?: boolean; point?: number; pointText?: string; pointDate?: string; pointContent?: string; pointCheckedAt?: string };
type HistoryEntry = { detectedDate?: string; detectedAt?: string; seminar?: SeminarRecord };

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
    const [refYear, refMonth] = referenceDate.split('-').map(Number); year = refYear;
    if (month - refMonth > 6) year--; else if (refMonth - month > 6) year++;
  } else return null;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
function getSeminarId(seminar: SeminarRecord): string | null {
  return seminar.seminarId || seminar.url.match(/(?:seminarId=|\/)(\d+)$/)?.[1] || null;
}

export function run(): { success: boolean; message: string } {
  try {
    const todayStr = getKstDate(); const pastStr = getDateDaysAgo(todayStr, LOOKBACK_DAYS);
    const history = storage.get<HistoryEntry[]>(NEW_SEMINAR_HISTORY_KEY, []) || [];
    const seminarList = storage.get<SeminarRecord[]>(SEMINAR_LIST_KEY, []) || [];
    const currentById = new Map<string, SeminarRecord>();
    for (const seminar of seminarList) { const id = getSeminarId(seminar); if (id) currentById.set(id, seminar); }

    const advanced: Array<{ date: string; seminar: SeminarRecord; source: string }> = [];
    const debug: string[] = [];
    for (const entry of history) {
      const stored = entry.seminar;
      if (!stored) { debug.push('SKIP: history entry에 seminar 없음'); continue; }
      const seminarId = getSeminarId(stored);
      const current = seminarId ? currentById.get(seminarId) : undefined;
      const normalizedDate = normalizeSeminarDate(stored.date, entry.detectedDate || todayStr);
      const isAdvanced = stored.isAdvancedSurvey === true || current?.isAdvancedSurvey === true;
      if (debug.length < 20) debug.push(`${stored.name || '(이름없음)'} | id=${seminarId ?? 'NULL'} | rawDate=${stored.date ?? 'NULL'} -> ${normalizedDate ?? 'NULL'} | storedAdvanced=${String(stored.isAdvancedSurvey)} | currentAdvanced=${String(current?.isAdvancedSurvey)}`);
      if (!seminarId || !normalizedDate || normalizedDate < pastStr || normalizedDate > todayStr || !isAdvanced) continue;
      advanced.push({ date: normalizedDate, source: stored.isAdvancedSurvey === true ? 'history' : 'seminar_list', seminar: { ...stored, seminarId, isAdvancedSurvey: true } });
    }

    advanced.sort((a, b) => b.date.localeCompare(a.date));
    if (!advanced.length) {
      const sample = debug.length ? `\n\n[history 디버그]\n${debug.join('\n')}` : '\n\n[history 디버그] history가 비어 있습니다.';
      return { success: true, message: `최근 2주(${pastStr} ~ ${todayStr}) 심화설문 세미나가 없습니다.${sample}` };
    }

    const unique = new Map<string, (typeof advanced)[number]>(); for (const item of advanced) unique.set(item.seminar.seminarId!, item);
    const lines = Array.from(unique.values()).map(({ date, seminar, source }) => {
      const pointStatus = seminar.pointPaid === true ? ` → ✅ ${seminar.pointText ?? `${seminar.point ?? 0}P`} 지급됨` : seminar.pointCheckedAt ? ' → ❌ 미지급' : ' → ⏳ 조회 대기';
      return `${date} | ${seminar.name || '세미나'} | ID: ${seminar.seminarId} | 판별: ${source}${pointStatus}`;
    });
    return { success: true, message: `⭐ 최근 2주 심화설문 ${unique.size}건 (${pastStr} ~ ${todayStr})\n\n${lines.join('\n')}` };
  } catch (e) { return { success: false, message: `심화 세미나 포인트 조회 오류: ${e instanceof Error ? e.message : String(e)}` }; }
}
export async function checkAdvancedSeminars(): Promise<{ success: boolean; message: string }> { return run(); }
