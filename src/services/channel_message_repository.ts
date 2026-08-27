import { getDatabase } from './storage';
import { getBot } from './bot_instance';
import * as logger from './logger';

export interface ChannelMessageRecord {
  id?: number;
  channelId: string;
  messageId: number;
  date: string; // YYYY-MM-DD (Asia/Seoul)
  chunkIndex: number;
  totalChunks: number;
  text?: string | null;
  mediaType: 'text' | 'photo';
  status: 'sent' | 'edited' | 'deleted';
  createdAt: number;
  updatedAt: number;
}

export interface RawChannelMessageRow {
  id: number;
  channel_id: string;
  message_id: number;
  date: string;
  chunk_index: number;
  total_chunks: number;
  text: string | null;
  media_type: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export function getSeoulDateString(d: Date = new Date()): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
}

function mapRowToRecord(row: RawChannelMessageRow): ChannelMessageRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    messageId: row.message_id,
    date: row.date,
    chunkIndex: row.chunk_index,
    totalChunks: row.total_chunks,
    text: row.text,
    mediaType: (row.media_type as 'text' | 'photo') || 'text',
    status: (row.status as 'sent' | 'edited' | 'deleted') || 'sent',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 전송된 공지방 메시지 메타데이터를 DB에 기록합니다.
 */
export function recordChannelMessage(params: {
  channelId: string;
  messageId: number;
  date?: string;
  chunkIndex?: number;
  totalChunks?: number;
  text?: string | null;
  mediaType?: 'text' | 'photo';
  status?: 'sent' | 'edited' | 'deleted';
  createdAt?: number;
}): ChannelMessageRecord {
  const db = getDatabase();
  const now = Date.now();
  const date = params.date || getSeoulDateString();
  const chunkIndex = params.chunkIndex ?? 0;
  const totalChunks = params.totalChunks ?? 1;
  const text = params.text ?? null;
  const mediaType = params.mediaType || 'text';
  const status = params.status || 'sent';
  const createdAt = params.createdAt || now;
  const updatedAt = now;

  const stmt = db.prepare(`
    INSERT INTO channel_messages (
      channel_id, message_id, date, chunk_index, total_chunks,
      text, media_type, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    params.channelId,
    params.messageId,
    date,
    chunkIndex,
    totalChunks,
    text,
    mediaType,
    status,
    createdAt,
    updatedAt,
  );

  return {
    id: Number(result.lastInsertRowid),
    channelId: params.channelId,
    messageId: params.messageId,
    date,
    chunkIndex,
    totalChunks,
    text,
    mediaType,
    status,
    createdAt,
    updatedAt,
  };
}

/**
 * 특정 일자의 공지방 메시지 목록을 조회합니다.
 */
export function getChannelMessagesByDate(date?: string, channelId?: string): ChannelMessageRecord[] {
  const db = getDatabase();
  const targetDate = date || getSeoulDateString();
  let query = 'SELECT * FROM channel_messages WHERE date = ?';
  const params: unknown[] = [targetDate];

  if (channelId) {
    query += ' AND channel_id = ?';
    params.push(channelId);
  }

  query += ' ORDER BY created_at ASC, chunk_index ASC, id ASC';

  const rows = db.prepare(query).all(...params) as RawChannelMessageRow[];
  return rows.map(mapRowToRecord);
}

/**
 * 특정 message_id의 메시지 기록을 조회합니다.
 */
export function getChannelMessageById(messageId: number, channelId?: string): ChannelMessageRecord | null {
  const db = getDatabase();
  let query = 'SELECT * FROM channel_messages WHERE message_id = ?';
  const params: unknown[] = [messageId];

  if (channelId) {
    query += ' AND channel_id = ?';
    params.push(channelId);
  }

  query += ' ORDER BY id DESC LIMIT 1';

  const row = db.prepare(query).get(...params) as RawChannelMessageRow | undefined;
  return row ? mapRowToRecord(row) : null;
}

/**
 * 최근 전송된 공지방 메시지 목록을 조회합니다.
 */
export function getRecentChannelMessages(limit = 20, channelId?: string): ChannelMessageRecord[] {
  const db = getDatabase();
  let query = 'SELECT * FROM channel_messages';
  const params: unknown[] = [];

  if (channelId) {
    query += ' WHERE channel_id = ?';
    params.push(channelId);
  }

  query += ' ORDER BY created_at DESC, chunk_index DESC, id DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(query).all(...params) as RawChannelMessageRow[];
  return rows.map(mapRowToRecord);
}

/**
 * DB 내 메시지 상태 및 내용을 갱신합니다.
 */
export function updateChannelMessageStatus(
  messageId: number,
  status: 'sent' | 'edited' | 'deleted',
  newText?: string | null,
  channelId?: string,
): boolean {
  const db = getDatabase();
  const now = Date.now();
  let query: string;
  const params: unknown[] = [status, now];

  if (newText !== undefined) {
    query = 'UPDATE channel_messages SET status = ?, updated_at = ?, text = ? WHERE message_id = ?';
    params.splice(2, 0, newText);
    params.push(messageId);
  } else {
    query = 'UPDATE channel_messages SET status = ?, updated_at = ? WHERE message_id = ?';
    params.push(messageId);
  }

  if (channelId) {
    query += ' AND channel_id = ?';
    params.push(channelId);
  }

  const result = db.prepare(query).run(...params);
  return result.changes > 0;
}

/**
 * 텍스트가 '오늘의 링크' 메시지인지 판별합니다.
 */
export function isTodayLinksMessageText(text?: string | null): boolean {
  if (!text) return false;
  return text.includes('mypage/attendance') || (text.includes('출석체크') && text.includes('오늘의 퀴즈'));
}

/**
 * 텍스트가 '세미나 현황' 메시지인지 판별합니다.
 */
export function isSeminarStatusMessageText(text?: string | null, periodName?: string): boolean {
  if (!text) return false;
  if (isTodayLinksMessageText(text)) return false;

  if (periodName) {
    return (
      (text.includes('🔔') || text.includes('🏁')) &&
      (text.includes(`${periodName}세미나`) || text.includes(`${periodName} 세미나`))
    );
  }

  return (
    (text.includes('🔔') || text.includes('🏁')) &&
    (text.includes('점심세미나') ||
      text.includes('점심 세미나') ||
      text.includes('저녁세미나') ||
      text.includes('저녁 세미나'))
  );
}

/**
 * 텍스트가 '신규 세미나 모음' 공지 메시지인지 판별합니다.
 */
export function isNewSeminarsMessageText(text?: string | null): boolean {
  if (!text) return false;
  if (isTodayLinksMessageText(text)) return false;
  if (isSeminarStatusMessageText(text)) return false;

  return (
    text.includes('오늘 추가된 세미나 모음') ||
    text.includes('새로 추가된 세미나 모음') ||
    text.includes('신규 세미나 모음') ||
    text.includes('새로 추가된 세미나') ||
    text.includes('새로 발견된 세미나')
  );
}

/**
 * 특정 일자에 공지 채널로 전송된 '오늘의 링크' 메시지 레코드를 조회합니다.
 */
export function getTodayLinksChannelMessage(date?: string, channelId?: string): ChannelMessageRecord | null {
  const targetDate = date || getSeoulDateString();
  const targetChannelId = channelId || process.env.NOTICE_CHANNEL_ID;
  const messages = getChannelMessagesByDate(targetDate, targetChannelId).filter((m) => m.status !== 'deleted');

  const found = messages.find((m) => isTodayLinksMessageText(m.text));
  return found || null;
}

/**
 * 특정 일자에 공지 채널로 전송된 '세미나 현황' 메시지 레코드를 조회합니다.
 */
export function getSeminarStatusChannelMessage(
  periodName: string,
  date?: string,
  channelId?: string,
): ChannelMessageRecord | null {
  const targetDate = date || getSeoulDateString();
  const targetChannelId = channelId || process.env.NOTICE_CHANNEL_ID;
  const messages = getChannelMessagesByDate(targetDate, targetChannelId).filter((m) => m.status !== 'deleted');

  // 가장 최근에 전송된 해당 periodName의 세미나 현황 메시지 검색 (뒤에서부터)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isSeminarStatusMessageText(m.text, periodName)) {
      return m;
    }
  }
  return null;
}

/**
 * 특정 일자에 공지 채널로 전송된 '신규 세미나 모음' 메시지 레코드를 조회합니다.
 */
export function getNewSeminarsChannelMessage(date?: string, channelId?: string): ChannelMessageRecord | null {
  const targetDate = date || getSeoulDateString();
  const targetChannelId = channelId || process.env.NOTICE_CHANNEL_ID;
  const messages = getChannelMessagesByDate(targetDate, targetChannelId).filter((m) => m.status !== 'deleted');

  // 가장 최근에 전송된 신규 세미나 공지 메시지 검색 (뒤에서부터)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (isNewSeminarsMessageText(m.text)) {
      return m;
    }
  }
  return null;
}

export interface DiscussionThreadRecord {
  threadId: number;
  channelId: string;
  channelMessageId: number;
  createdAt: number;
}

/**
 * 토론 그룹 스레드(자동 포워딩 메시지)와 채널 공지 메시지 ID 간의 매핑을 기록합니다.
 */
export function recordDiscussionThread(threadId: number, channelId: string, channelMessageId: number): void {
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    `
    INSERT OR REPLACE INTO channel_discussion_threads (thread_id, channel_id, channel_message_id, created_at)
    VALUES (?, ?, ?, ?)
  `,
  ).run(threadId, channelId, channelMessageId, now);
}

/**
 * 토론 그룹 스레드 ID로부터 채널 공지 메시지 ID를 조회합니다.
 */
export function getChannelMessageIdByThreadId(threadId: number, channelId?: string): number | null {
  const db = getDatabase();
  let query = 'SELECT channel_message_id FROM channel_discussion_threads WHERE thread_id = ?';
  const params: unknown[] = [threadId];
  if (channelId) {
    query += ' AND channel_id = ?';
    params.push(channelId);
  }
  const row = db.prepare(query).get(...params) as { channel_message_id: number } | undefined;
  return row ? row.channel_message_id : null;
}

export interface ChannelCommentRecord {
  id?: number;
  channelId: string;
  messageId: number;
  parentMessageId: number;
  attachedToMessageId?: number | null;
  date: string;
  userId?: string | null;
  userName: string;
  text: string;
  createdAt: number;
}

export interface RawChannelCommentRow {
  id: number;
  channel_id: string;
  message_id: number;
  parent_message_id: number | null;
  attached_to_message_id: number | null;
  date: string;
  user_id: string | null;
  user_name: string;
  text: string;
  created_at: number;
}

/**
 * 1일 초과된 과거 댓글 레코드를 정리합니다 (1일 TTL).
 */
export function cleanOldChannelComments(currentDate?: string): number {
  try {
    const db = getDatabase();
    const targetDate = currentDate || getSeoulDateString();
    // 당일(targetDate) 이전 날짜의 댓글 삭제
    const result = db.prepare('DELETE FROM channel_comments WHERE date < ?').run(targetDate);
    return result.changes;
  } catch (err) {
    logger.error('과거 댓글 정리 실패:', err);
    return 0;
  }
}

/**
 * 토론 그룹에서 수신된 댓글을 기록합니다.
 */
export function recordChannelComment(params: {
  channelId?: string;
  messageId: number;
  parentMessageId: number;
  attachedToMessageId?: number | null;
  date?: string;
  userId?: string | null;
  userName: string;
  text: string;
  createdAt?: number;
}): ChannelCommentRecord {
  const db = getDatabase();
  const now = Date.now();
  const date = params.date || getSeoulDateString();
  const channelId = params.channelId || process.env.NOTICE_CHANNEL_ID || '';
  const userId = params.userId || null;
  const attachedToMessageId = params.attachedToMessageId ?? null;
  const createdAt = params.createdAt || now;

  // 1일 TTL 지난 과거 댓글 정리
  cleanOldChannelComments(date);

  const stmt = db.prepare(`
    INSERT INTO channel_comments (
      channel_id, message_id, parent_message_id, attached_to_message_id,
      date, user_id, user_name, text, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    channelId,
    params.messageId,
    params.parentMessageId,
    attachedToMessageId,
    date,
    userId,
    params.userName,
    params.text,
    createdAt,
  );

  return {
    id: Number(result.lastInsertRowid),
    channelId,
    messageId: params.messageId,
    parentMessageId: params.parentMessageId,
    attachedToMessageId,
    date,
    userId,
    userName: params.userName,
    text: params.text,
    createdAt,
  };
}

/**
 * 특정 message_id의 댓글 레코드를 조회합니다 (대댓글 원본 역추적용).
 */
export function getChannelCommentByMessageId(messageId: number, channelId?: string): ChannelCommentRecord | null {
  const db = getDatabase();
  let query = 'SELECT * FROM channel_comments WHERE message_id = ?';
  const params: unknown[] = [messageId];
  if (channelId) {
    query += ' AND channel_id = ?';
    params.push(channelId);
  }
  query += ' ORDER BY id DESC LIMIT 1';
  const row = db.prepare(query).get(...params) as RawChannelCommentRow | undefined;
  if (!row) return null;
  return {
    id: row.id,
    channelId: row.channel_id,
    messageId: row.message_id,
    parentMessageId: row.parent_message_id ?? 0,
    attachedToMessageId: row.attached_to_message_id,
    date: row.date,
    userId: row.user_id,
    userName: row.user_name,
    text: row.text,
    createdAt: row.created_at,
  };
}

/**
 * 특정 원본 공지 메시지(parentMessageId)에 달렸거나 이관된 댓글 목록을 조회합니다.
 */
export function getChannelCommentsByParentMessageId(
  parentMessageId: number,
  channelId?: string,
  limit = 10,
): ChannelCommentRecord[] {
  const db = getDatabase();
  const targetDate = getSeoulDateString();

  // 과거 댓글 정리
  cleanOldChannelComments(targetDate);

  let query = `
    SELECT * FROM channel_comments
    WHERE (parent_message_id = ? OR attached_to_message_id = ?)
  `;
  const params: unknown[] = [parentMessageId, parentMessageId];

  if (channelId) {
    query += ' AND channel_id = ?';
    params.push(channelId);
  }

  query += ' ORDER BY created_at ASC, id ASC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(query).all(...params) as RawChannelCommentRow[];

  return rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    messageId: r.message_id,
    parentMessageId: r.parent_message_id ?? 0,
    attachedToMessageId: r.attached_to_message_id,
    date: r.date,
    userId: r.user_id,
    userName: r.user_name,
    text: r.text,
    createdAt: r.created_at,
  }));
}

/**
 * 이전 공지 메시지의 댓글들을 새 공지 메시지에 연결(attached_to_message_id 갱신)합니다.
 */
export function linkCommentsToNewMessage(prevMessageId: number, newMessageId: number, channelId?: string): number {
  const db = getDatabase();
  let query = `
    UPDATE channel_comments
    SET attached_to_message_id = ?
    WHERE (parent_message_id = ? OR attached_to_message_id = ?)
  `;
  const params: unknown[] = [newMessageId, prevMessageId, prevMessageId];
  if (channelId) {
    query += ' AND channel_id = ?';
    params.push(channelId);
  }
  const result = db.prepare(query).run(...params);
  return result.changes;
}

/**
 * 특정 일자의 댓글 목록을 조회합니다 (하위 호환용).
 */
export function getChannelCommentsByDate(date?: string, limit = 10): ChannelCommentRecord[] {
  const db = getDatabase();
  const targetDate = date || getSeoulDateString();

  // 과거 댓글 정리
  cleanOldChannelComments(targetDate);

  const rows = db
    .prepare('SELECT * FROM channel_comments WHERE date = ? ORDER BY created_at ASC LIMIT ?')
    .all(targetDate, limit) as RawChannelCommentRow[];

  return rows.map((r) => ({
    id: r.id,
    channelId: r.channel_id,
    messageId: r.message_id,
    parentMessageId: r.parent_message_id ?? 0,
    attachedToMessageId: r.attached_to_message_id,
    date: r.date,
    userId: r.user_id,
    userName: r.user_name,
    text: r.text,
    createdAt: r.created_at,
  }));
}

export { publishAndReplaceChannelNotice, type PublishAndReplaceOptions } from './channel_notice_service';

/**
 * 텔레그램 공지봇을 통해 공지방 메시지를 수정하고 DB를 갱신합니다.
 */
export async function editChannelMessage(
  messageId: number,
  newText: string,
  options: {
    channelId?: string;
    parse_mode?: 'HTML' | 'MarkdownV2' | 'Markdown';
    reply_markup?: unknown;
  } = {},
): Promise<{ success: boolean; message: string }> {
  const bot = getBot('notice');
  if (!bot) {
    return { success: false, message: 'Notice 봇이 초기화되지 않았습니다.' };
  }

  const targetChannelId = options.channelId || process.env.NOTICE_CHANNEL_ID;
  if (!targetChannelId) {
    return { success: false, message: 'NOTICE_CHANNEL_ID가 설정되지 않았습니다.' };
  }

  try {
    const existing = getChannelMessageById(messageId, targetChannelId);
    const isPhoto = existing?.mediaType === 'photo';

    if (isPhoto) {
      const editOptions: Record<string, unknown> = {};
      if (options.parse_mode) editOptions.parse_mode = options.parse_mode;
      if (options.reply_markup) editOptions.reply_markup = options.reply_markup;
      await bot.telegram.editMessageCaption(targetChannelId, messageId, undefined, newText, editOptions);
    } else {
      const editOptions: Record<string, unknown> = {};
      if (options.parse_mode) editOptions.parse_mode = options.parse_mode;
      if (options.reply_markup) editOptions.reply_markup = options.reply_markup;
      await bot.telegram.editMessageText(targetChannelId, messageId, undefined, newText, editOptions);
    }

    updateChannelMessageStatus(messageId, 'edited', newText, targetChannelId);
    return { success: true, message: `메시지(ID: ${messageId}) 수정 완료` };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (errMsg.includes('message is not modified')) {
      updateChannelMessageStatus(messageId, 'edited', newText, targetChannelId);
      return { success: true, message: `메시지(ID: ${messageId}) 내용 동일 (수정 불필요)` };
    }
    logger.error(`공지방 메시지(ID: ${messageId}) 수정 실패:`, error);
    return { success: false, message: `메시지 수정 실패: ${errMsg}` };
  }
}

/**
 * 텔레그램 공지봇을 통해 공지방 메시지를 삭제하고 DB 상태를 'deleted'로 갱신합니다.
 */
export async function deleteChannelMessage(
  messageId: number,
  channelId?: string,
): Promise<{ success: boolean; message: string }> {
  const bot = getBot('notice');
  if (!bot) {
    return { success: false, message: 'Notice 봇이 초기화되지 않았습니다.' };
  }

  const targetChannelId = channelId || process.env.NOTICE_CHANNEL_ID;
  if (!targetChannelId) {
    return { success: false, message: 'NOTICE_CHANNEL_ID가 설정되지 않았습니다.' };
  }

  try {
    await bot.telegram.deleteMessage(targetChannelId, messageId);
    updateChannelMessageStatus(messageId, 'deleted', undefined, targetChannelId);
    return { success: true, message: `메시지(ID: ${messageId}) 삭제 완료` };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error(`공지방 메시지(ID: ${messageId}) 삭제 실패:`, error);
    return { success: false, message: `메시지 삭제 실패: ${errMsg}` };
  }
}

/**
 * 특정 일자의 모든 공지방 메시지를 일괄 삭제합니다.
 */
export async function deleteChannelMessagesByDate(
  date?: string,
  channelId?: string,
): Promise<{
  success: boolean;
  total: number;
  deletedCount: number;
  failedCount: number;
  details: string[];
}> {
  const targetDate = date || getSeoulDateString();
  const targetChannelId = channelId || process.env.NOTICE_CHANNEL_ID;

  const messages = getChannelMessagesByDate(targetDate, targetChannelId).filter((m) => m.status !== 'deleted');

  if (messages.length === 0) {
    return {
      success: true,
      total: 0,
      deletedCount: 0,
      failedCount: 0,
      details: [`${targetDate} 날짜에 삭제할 메시지가 없습니다.`],
    };
  }

  let deletedCount = 0;
  let failedCount = 0;
  const details: string[] = [];

  for (const msg of messages) {
    const res = await deleteChannelMessage(msg.messageId, msg.channelId);
    if (res.success) {
      deletedCount++;
      details.push(`✅ ID ${msg.messageId} 삭제 성공`);
    } else {
      failedCount++;
      details.push(`❌ ID ${msg.messageId} 삭제 실패 (${res.message})`);
    }
  }

  return {
    success: failedCount === 0,
    total: messages.length,
    deletedCount,
    failedCount,
    details,
  };
}
