import type { BrowserContext } from 'playwright';
import * as storage from '../services/storage';
import { searchSeminarPoints } from './check_seminar_point';
import { NEW_SEMINAR_HISTORY_KEY } from './apply_seminar';

interface AdvancedSeminarResult {
  date: string; // seminar date (YYYY-MM-DD) or detectedDate fallback
  found: boolean;
  point?: number;
  pointText?: string;
}

/**
 * 지난 2주(14일) 동안 진행된 심화 세미나들의 포인트 지급 여부를 조회합니다.
 * @param context Playwright 브라우저 컨텍스트
 */
export async function checkAdvancedSeminars(context: BrowserContext): Promise<AdvancedSeminarResult[]> {
  const today = new Date();
  const past = new Date();
  past.setDate(past.getDate() - 60); // 60일로 확장 (개최일 기준 보관 기간과 맞춤)

  // YYYY-MM-DD 형태 저장/비교용
  const fmt = (d: Date) => d.toISOString().split('T')[0];
  const todayStr = fmt(today);
  const pastStr = fmt(past);

  const history = storage.get<any[]>(NEW_SEMINAR_HISTORY_KEY, []) || [];
  const advancedEntries = history.filter((e) => {
    const sem = e.seminar ?? {};
    if (!sem.isAdvancedSurvey) return false;
    const seminarDate = sem.date || e.detectedDate;
    if (!seminarDate) return false;
    // Compare strings YYYY-MM-DD
    return seminarDate >= pastStr && seminarDate <= todayStr;
  });

  // 세미나 ID 수집
  const seminarInfos: { date: string; id: string }[] = [];
  for (const entry of advancedEntries) {
    const sem = entry.seminar;
    const seminarDate = sem.date || entry.detectedDate;
    const seminarId = sem.seminarId || (sem.url && sem.url.match(/(\d+)$/)?.[1]) || '';
    if (seminarId) {
      seminarInfos.push({ date: seminarDate, id: seminarId });
    } else {
      // ID가 없는 경우
      seminarInfos.push({ date: seminarDate, id: '' });
    }
  }

  // 일괄 검색 (한 번 로그인 후 반복 검색)
  const validIds = seminarInfos.filter((s) => s.id).map((s) => s.id);
  const resultsMap = await searchSeminarPoints(context, validIds, 60);

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

  // 정렬: 최신 날짜부터
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
