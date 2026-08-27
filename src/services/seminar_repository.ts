import { getDatabase } from './storage';

export type SeminarPointStatus = {
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
  processState?: number;
  cancelProcessState?: number;
  seminarCompleted?: number;
  detectedDate?: string;
  detectedAt?: string;
  urgentNotified?: boolean;
} & SeminarPointStatus;

export type SeminarDbRow = {
  seminar_id: string;
  name: string;
  url: string;
  date: string | null;
  time: string;
  current_count: string;
  total_count: string;
  night_time: number;
  is_point_excluded: number | null;
  is_advanced_survey: number;
  process_state: number | null;
  cancel_process_state: number | null;
  seminar_completed: number | null;
  point_paid: number;
  point: number | null;
  point_text: string | null;
  point_date: string | null;
  point_content: string | null;
  point_checked_at: string | null;
  detected_date: string | null;
  detected_at: string | null;
  urgent_notified?: number;
  updated_at: number;
};

export function rowToSeminarListItem(row: SeminarDbRow): SeminarListItem {
  return {
    seminarId: row.seminar_id,
    name: row.name,
    url: row.url,
    date: row.date ?? undefined,
    time: row.time,
    currentCount: row.current_count,
    totalCount: row.total_count,
    nightTime: row.night_time === 1,
    isPointExcluded:
      row.is_point_excluded === null || row.is_point_excluded === undefined ? undefined : row.is_point_excluded === 1,
    isAdvancedSurvey: row.is_advanced_survey === 1,
    processState: row.process_state ?? undefined,
    cancelProcessState: row.cancel_process_state ?? undefined,
    seminarCompleted: row.seminar_completed ?? undefined,
    pointPaid: row.point_paid === 1,
    point: row.point ?? undefined,
    pointText: row.point_text ?? undefined,
    pointDate: row.point_date ?? undefined,
    pointContent: row.point_content ?? undefined,
    pointCheckedAt: row.point_checked_at ?? undefined,
    detectedDate: row.detected_date ?? undefined,
    detectedAt: row.detected_at ?? undefined,
    urgentNotified: row.urgent_notified === 1,
  };
}

export function extractSeminarId(seminar: Pick<SeminarListItem, 'url' | 'seminarId'>): string {
  if (seminar.seminarId && String(seminar.seminarId).trim()) {
    return String(seminar.seminarId).trim();
  }
  const match = seminar.url.match(/(?:seminarId=|\/)(\d+)$/);
  if (match && match[1]) {
    return match[1];
  }
  return seminar.url;
}

/**
 * 기존 세미나 레코드와 새로운 세미나 데이터를 안전하게 병합합니다.
 * - pointPaid === true인 경우 포인트 지급 정보(point, pointText, pointDate, pointContent)를 절대 덮어쓰지 않고 보존합니다.
 * - pointCheckedAt은 최신 확인 일시로 갱신됩니다.
 * - 기타 메타데이터는 incoming에 유효한 값이 있을 때 갱신하고, 없으면 기존 값을 유지합니다.
 */
export function mergeSeminarRecord(existing: SeminarListItem | undefined, incoming: SeminarListItem): SeminarListItem {
  if (!existing) {
    return { ...incoming };
  }

  const sid = incoming.seminarId || existing.seminarId || null;
  const isPointPaidExisting = existing.pointPaid === true;
  const pointPaid = isPointPaidExisting ? true : (incoming.pointPaid ?? existing.pointPaid ?? false);

  return {
    ...existing,
    ...incoming,
    seminarId: sid,
    name: incoming.name || existing.name || '',
    url: incoming.url || existing.url || `https://m.doctorville.co.kr/cme/seminar/${sid || ''}`,
    date: incoming.date || existing.date || '',
    time: incoming.time || existing.time || '',
    currentCount: incoming.currentCount || existing.currentCount || '',
    totalCount: incoming.totalCount || existing.totalCount || '',
    nightTime: incoming.nightTime ?? existing.nightTime ?? false,
    isAdvancedSurvey: incoming.isAdvancedSurvey ?? existing.isAdvancedSurvey ?? false,
    isPointExcluded: incoming.isPointExcluded ?? existing.isPointExcluded,
    processState: incoming.processState ?? existing.processState,
    cancelProcessState: incoming.cancelProcessState ?? existing.cancelProcessState,
    seminarCompleted: incoming.seminarCompleted ?? existing.seminarCompleted,
    pointPaid,
    point: isPointPaidExisting ? existing.point : (incoming.point ?? existing.point),
    pointText: isPointPaidExisting ? existing.pointText : (incoming.pointText ?? existing.pointText),
    pointDate: isPointPaidExisting ? existing.pointDate : (incoming.pointDate ?? existing.pointDate),
    pointContent: isPointPaidExisting ? existing.pointContent : (incoming.pointContent ?? existing.pointContent),
    pointCheckedAt: incoming.pointCheckedAt || existing.pointCheckedAt,
    detectedDate: existing.detectedDate || incoming.detectedDate,
    detectedAt: existing.detectedAt || incoming.detectedAt,
    urgentNotified: incoming.urgentNotified ?? existing.urgentNotified ?? false,
  };
}

/**
 * 저장된 모든 세미나 목록을 조회합니다.
 */
export function getAllSeminars(): SeminarListItem[] {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM seminars ORDER BY date DESC, seminar_id DESC');
  const rows = stmt.all() as SeminarDbRow[];
  return rows.map(rowToSeminarListItem);
}

/**
 * ID로 특정 세미나를 조회합니다.
 */
export function getSeminarById(seminarId: string): SeminarListItem | null {
  const db = getDatabase();
  const stmt = db.prepare('SELECT * FROM seminars WHERE seminar_id = ?');
  const row = stmt.get(seminarId) as SeminarDbRow | undefined;
  return row ? rowToSeminarListItem(row) : null;
}

/**
 * 단건 세미나를 병합(merge)하여 저장합니다.
 */
export function upsertSeminar(incoming: SeminarListItem): SeminarListItem {
  const db = getDatabase();
  const sid = extractSeminarId(incoming);
  if (!sid) {
    throw new Error('upsertSeminar: seminarId or url is required.');
  }

  let resultItem: SeminarListItem = incoming;
  const now = Date.now();

  const upsertTx = db.transaction(() => {
    const existingRow = db.prepare('SELECT * FROM seminars WHERE seminar_id = ?').get(sid) as SeminarDbRow | undefined;
    const existing = existingRow ? rowToSeminarListItem(existingRow) : undefined;
    const merged = mergeSeminarRecord(existing, { ...incoming, seminarId: sid });
    resultItem = merged;

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO seminars (
        seminar_id, name, url, date, time, current_count, total_count,
        night_time, is_point_excluded, is_advanced_survey, process_state,
        cancel_process_state, seminar_completed, point_paid, point,
        point_text, point_date, point_content, point_checked_at,
        detected_date, detected_at, urgent_notified, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `);

    stmt.run(
      sid,
      merged.name,
      merged.url,
      merged.date ?? null,
      merged.time,
      merged.currentCount,
      merged.totalCount,
      merged.nightTime ? 1 : 0,
      typeof merged.isPointExcluded === 'boolean' ? (merged.isPointExcluded ? 1 : 0) : null,
      merged.isAdvancedSurvey ? 1 : 0,
      typeof merged.processState === 'number' ? merged.processState : null,
      typeof merged.cancelProcessState === 'number' ? merged.cancelProcessState : null,
      typeof merged.seminarCompleted === 'number' ? merged.seminarCompleted : null,
      merged.pointPaid ? 1 : 0,
      typeof merged.point === 'number' ? merged.point : null,
      merged.pointText ?? null,
      merged.pointDate ?? null,
      merged.pointContent ?? null,
      merged.pointCheckedAt ?? null,
      merged.detectedDate ?? null,
      merged.detectedAt ?? null,
      merged.urgentNotified ? 1 : 0,
      now,
    );
  });

  upsertTx();
  return resultItem;
}

/**
 * 여러 세미나를 단일 트랜잭션으로 일괄 병합(merge)하여 저장합니다.
 */
export function upsertSeminars(incomingList: SeminarListItem[]): SeminarListItem[] {
  if (incomingList.length === 0) return [];
  const db = getDatabase();
  const now = Date.now();
  const results: SeminarListItem[] = [];

  const batchTx = db.transaction(() => {
    const selectStmt = db.prepare('SELECT * FROM seminars WHERE seminar_id = ?');
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO seminars (
        seminar_id, name, url, date, time, current_count, total_count,
        night_time, is_point_excluded, is_advanced_survey, process_state,
        cancel_process_state, seminar_completed, point_paid, point,
        point_text, point_date, point_content, point_checked_at,
        detected_date, detected_at, urgent_notified, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?
      )
    `);

    for (const incoming of incomingList) {
      const sid = extractSeminarId(incoming);
      if (!sid) continue;

      const existingRow = selectStmt.get(sid) as SeminarDbRow | undefined;
      const existing = existingRow ? rowToSeminarListItem(existingRow) : undefined;
      const merged = mergeSeminarRecord(existing, { ...incoming, seminarId: sid });
      results.push(merged);

      insertStmt.run(
        sid,
        merged.name,
        merged.url,
        merged.date ?? null,
        merged.time,
        merged.currentCount,
        merged.totalCount,
        merged.nightTime ? 1 : 0,
        typeof merged.isPointExcluded === 'boolean' ? (merged.isPointExcluded ? 1 : 0) : null,
        merged.isAdvancedSurvey ? 1 : 0,
        typeof merged.processState === 'number' ? merged.processState : null,
        typeof merged.cancelProcessState === 'number' ? merged.cancelProcessState : null,
        typeof merged.seminarCompleted === 'number' ? merged.seminarCompleted : null,
        merged.pointPaid ? 1 : 0,
        typeof merged.point === 'number' ? merged.point : null,
        merged.pointText ?? null,
        merged.pointDate ?? null,
        merged.pointContent ?? null,
        merged.pointCheckedAt ?? null,
        merged.detectedDate ?? null,
        merged.detectedAt ?? null,
        merged.urgentNotified ? 1 : 0,
        now,
      );
    }
  });

  batchTx();
  return results;
}

/**
 * 특정 세미나를 마감 임박 알림 발송 완료(urgent_notified = 1)로 마킹합니다.
 */
export function markSeminarUrgentNotified(seminarId: string): void {
  const db = getDatabase();
  db.prepare('UPDATE seminars SET urgent_notified = 1, updated_at = ? WHERE seminar_id = ?').run(Date.now(), seminarId);
}

/**
 * 60일(retentionDays) 이상 지난 만료된 세미나를 삭제합니다.
 */
export function deleteExpiredSeminars(referenceDate: string, retentionDays: number = 60): number {
  const db = getDatabase();
  const [refYear, refMonth, refDay] = referenceDate.split('-').map(Number);
  const cutoffDate = new Date(Date.UTC(refYear, refMonth - 1, refDay - retentionDays));
  const cutoffStr = `${cutoffDate.getUTCFullYear()}-${String(cutoffDate.getUTCMonth() + 1).padStart(2, '0')}-${String(cutoffDate.getUTCDate()).padStart(2, '0')}`;

  const info = db
    .prepare(
      `
    DELETE FROM seminars 
    WHERE (date IS NOT NULL AND date != '' AND date < ?)
       OR (date IS NULL AND detected_date IS NOT NULL AND detected_date != '' AND detected_date < ?)
  `,
    )
    .run(cutoffStr, cutoffStr);

  return info.changes;
}

/**
 * 특정 기간 내 심화설문 세미나 목록을 조회합니다.
 */
export function getAdvancedSeminars(sinceDate: string, untilDate: string): SeminarListItem[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM seminars 
    WHERE is_advanced_survey = 1 
      AND (
        (date IS NOT NULL AND date >= ? AND date <= ?)
        OR (date IS NULL AND detected_date IS NOT NULL AND detected_date >= ? AND detected_date <= ?)
      )
    ORDER BY date ASC, seminar_id ASC
  `);
  const rows = stmt.all(sinceDate, untilDate, sinceDate, untilDate) as SeminarDbRow[];
  return rows.map(rowToSeminarListItem);
}

/**
 * 모든 세미나 데이터를 삭제합니다 (테스트용)
 */
export function clearSeminars(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM seminars').run();
}

/**
 * 특정 감지일자(detectedDate)에 새로 등록된 세미나 목록을 조회합니다.
 * 발견된 순서대로 정렬 (오래된 발견 -> 최근 발견)
 */
export function getSeminarsByDetectedDate(detectedDate: string): SeminarListItem[] {
  const db = getDatabase();
  const stmt = db.prepare(`
    SELECT * FROM seminars 
    WHERE detected_date = ?
    ORDER BY CASE WHEN detected_at IS NULL OR detected_at = '' THEN 1 ELSE 0 END, detected_at ASC, rowid ASC, seminar_id ASC
  `);
  const rows = stmt.all(detectedDate) as SeminarDbRow[];
  return rows.map(rowToSeminarListItem);
}

/**
 * 세미나 목록을 통째로 교체합니다 (테스트 mock 주입 및 배치 재설정용)
 */
export function setAllSeminars(seminars: SeminarListItem[]): void {
  const db = getDatabase();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM seminars').run();
    if (seminars.length > 0) {
      upsertSeminars(seminars);
    }
  });
  tx();
}
