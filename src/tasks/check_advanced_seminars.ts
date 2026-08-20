import type { BrowserContext } from 'playwright';
import * as storage from '../services/storage';
import { searchSeminarPoints } from './check_seminar_point';
import { NEW_SEMINAR_HISTORY_KEY } from './apply_seminar';

const SEMINAR_LIST_KEY = 'apply_seminar:seminar_list';
const LOOKBACK_DAYS = 14;
const POINT_SEARCH_DAYS = 60;

interface AdvancedSeminarResult {
  date: string; // seminar date (YYYY-MM-DD)
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

/**
 * 세미나 목록에서 사용하는 M/D 날짜를 YYYY-MM-DD로 정규화합니다.
 * 이미 ISO 날짜인 경우 그대로 사용합니다.
 */
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

  // 연말/연초의 월 rollover를 고려합니다.
  if (month - referenceMonth > 6) year -= 1;
  else if (referenceMonth - month > 6) year += 1;

  const normalized = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${normalized}T00:00:00+09:00`);
  if (Number.isNaN(parsed.getTime()) || parsed.getMonth() + 1 !== month || parsed.getDate() !== day) return null;
  return normalized;
}

function getSeminarId(seminar: SeminarRecord): string {
  return seminar.seminarId || (seminar.url && seminar.url.match(/(?:seminarId=|\/)(\d+)$/)?.[1]) || '';
}

/**
 * 지난 2주간 진행된 심화 세미나들의 포인트 지급 여부를 조회합니다.
 * 현재 세미나 목록과 60일 보관 히스토리를 함께 사용하므로,
 * 기능 추가 이전에 이미 저장된 세미나도 조회할 수 있습니다.
 * @param context Playwright 브라우저 컨텍스트
 */
export async function checkAdvancedSeminars(context: BrowserContext): Promise<AdvancedSeminarResult[]> {
  const today = new Date();
  const todayStr = today.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  const past = new Date(`${todayStr}T00:00:00+09:00`);
  past.setDate(past.getDate() - LOOKBACK_DAYS);
  const pastStr = past.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

  const history = storage.get<HistoryEntry[]>(NEW_SEMINAR_HISTORY_KEY, []) || [];
  const currentSeminars = storage.get<SeminarRecord[]>(SEMINAR_LIST_KEY, []) || [];

  // 현재 목록을 우선 사용하고, 과거에 페이지에서 사라진 세미나는 history로 보완합니다.
  const candidates = new Map<string, { date: string; seminar: SeminarRecord }>();

  const addCandidate = (seminar: SeminarRecord, detectedDate?: string) => {
    if (!seminar.isAdvancedSurvey) return;
    const normalizedDate = normalizeSeminarDate(seminar.date, detectedDate || todayStr);
    if (!normalizedDate || normalizedDate < pastStr || normalizedDate > todayStr) return;
    const id = getSeminarId(seminar);
    const key = id || seminar.url;
    if (!key) return;
    candidates.set(key, { date: normalizedDate, seminar });
  };

  for (const seminar of currentSeminars) addCandidate(seminar, todayStr);
  for (const entry of history) {
    if (entry.seminar) addCandidate(entry.seminar, entry.detectedDate || todayStr);
  }

  const seminarInfos = Array.from(candidates.values()).map(({ date, seminar }) => ({
    date,
    id: getSeminarId(seminar),
  }));

  const validIds = seminarInfos.filter((s) => s.id).map((s) => s.id);
  const resultsMap = await searchSeminarPoints(context, validIds, POINT_SEARCH_DAYS);

  const results: AdvancedSeminarResult[] = [];
  for (const info of seminarInfos) {
    if (!info.id) {
      results.push({ date: info.date, found: false });
      continue;
    }
    const pointRes = resultsMap.get(info.id) || { found: false };
    results.push({
      date: info.date,
      found: pointRes.found,
      point: pointRes.point,
      pointText: pointRes.pointText,
    });
  }

  results.sort((a, b) => (a.date < b.date ? 1 : -1));
  return results;
}

/**
 * 텔레그램 명령어용 래퍼 Task
 */
export async function run({ context }: { context: BrowserContext }): Promise<{ success: boolean; message: string }> {
  try {
    const res = await checkAdvancedSeminars(context);
    if (res.length === 0) {
      return { success: true, message: '최근 2주간 심화 세미나가 기록되지 않았습니다.' };
    }
    const lines = res.map((r) => {
      const status = r.found ? `✅ ${r.pointText ?? r.point?.toString() + 'P'}` : '❌ 미지급';
      return `${r.date}: ${status}`;
    });
    return { success: true, message: `🗓️ 최근 2주 심화 세미나 포인트 현황\n${lines.join('\n')}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { success: false, message: `심화 세미나 포인트 조회 오류: ${msg}` };
  }
}
