import { getDatabase } from './storage';
import { getBot } from './bot_instance';
import { splitTelegramMessage, TELEGRAM_SAFE_MESSAGE_LENGTH } from '../modules/telegram_splitter';
import { sleep } from '../modules/utils';
import * as logger from './logger';
import type { SeminarListItem } from '../tasks/apply_seminar';

export type SubscriptionTopic =
  | 'today_links'
  | 'intermd_quiz'
  | 'new_seminar'
  | 'seminar_changes'
  | 'seminar_live'
  | 'point_conversion';

export type NewSeminarFilter = 'all' | 'limit_5000' | 'limit_3000' | 'urgent_1000' | 'off';

export const TODAY_LINKS_AVAILABLE_TIMES = [
  '00:02',
  '01:00',
  '02:00',
  '03:00',
  '04:00',
  '05:00',
  '06:00',
  '07:00',
  '08:00',
  '09:00',
  '10:00',
  '11:00',
  '12:00',
] as const;

export type TodayLinksTime = (typeof TODAY_LINKS_AVAILABLE_TIMES)[number];

export interface SubscriptionRecord {
  chatId: number;
  todayLinks: boolean;
  todayLinksTime: string;
  todayLinksSentDate: string | null;
  newSeminar: NewSeminarFilter;
  intermdQuiz: boolean;
  seminarChanges: boolean;
  seminarLive: boolean;
  pointConversion: boolean;
  createdAt: number;
  updatedAt: number;
}

const seoulDateString = (): string => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

export function parseCapacityNumbers(item: { currentCount?: string; totalCount?: string }): {
  current: number;
  total: number;
  remaining: number;
} {
  const total = parseInt(String(item.totalCount || '').replace(/[^0-9]/g, ''), 10);
  const current = parseInt(String(item.currentCount || '').replace(/[^0-9]/g, ''), 10);
  const safeTotal = Number.isNaN(total) ? 0 : total;
  const safeCurrent = Number.isNaN(current) ? 0 : current;
  const remaining = Math.max(0, safeTotal - safeCurrent);
  return { current: safeCurrent, total: safeTotal, remaining };
}

export function matchesNewSeminarFilter(
  filter: NewSeminarFilter,
  seminar: { currentCount?: string; totalCount?: string },
): boolean {
  if (filter === 'off') return false;
  if (filter === 'all') return true;

  const { total, remaining } = parseCapacityNumbers(seminar);
  if (total <= 0) return true; // 정원 정보 미표기 시 기본 전달

  if (filter === 'limit_5000') {
    return total <= 5000;
  }
  if (filter === 'limit_3000') {
    return total <= 3000;
  }
  if (filter === 'urgent_1000') {
    return remaining <= 1000;
  }
  return true;
}

export function getSubscription(chatId: number): SubscriptionRecord {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM subscriptions WHERE chat_id = ?').get(chatId) as any;
  if (!row) {
    return {
      chatId,
      todayLinks: false,
      todayLinksTime: '09:00',
      todayLinksSentDate: null,
      newSeminar: 'off',
      intermdQuiz: false,
      seminarChanges: false,
      seminarLive: false,
      pointConversion: false,
      createdAt: 0,
      updatedAt: 0,
    };
  }

  return {
    chatId: row.chat_id,
    todayLinks: row.today_links === 1,
    todayLinksTime: row.today_links_time || '09:00',
    todayLinksSentDate: row.today_links_sent_date || null,
    newSeminar: (row.new_seminar as NewSeminarFilter) || 'off',
    intermdQuiz: row.intermd_quiz === 1,
    seminarChanges: row.seminar_changes === 1,
    seminarLive: row.seminar_live === 1,
    pointConversion: row.point_conversion === 1,
    createdAt: row.created_at || 0,
    updatedAt: row.updated_at || 0,
  };
}

export function updateSubscription(
  chatId: number,
  updates: Partial<Omit<SubscriptionRecord, 'chatId' | 'createdAt' | 'updatedAt'>>,
): SubscriptionRecord {
  const db = getDatabase();
  const existing = getSubscription(chatId);
  const now = Date.now();

  const next: SubscriptionRecord = {
    ...existing,
    ...updates,
    updatedAt: now,
  };
  if (existing.createdAt === 0) {
    next.createdAt = now;
  }

  db.prepare(
    `
    INSERT INTO subscriptions (
      chat_id, today_links, today_links_time, today_links_sent_date,
      new_seminar, intermd_quiz, seminar_changes, seminar_live, point_conversion,
      created_at, updated_at
    ) VALUES (
      @chatId, @todayLinks, @todayLinksTime, @todayLinksSentDate,
      @newSeminar, @intermdQuiz, @seminarChanges, @seminarLive, @pointConversion,
      @createdAt, @updatedAt
    )
    ON CONFLICT(chat_id) DO UPDATE SET
      today_links = excluded.today_links,
      today_links_time = excluded.today_links_time,
      today_links_sent_date = excluded.today_links_sent_date,
      new_seminar = excluded.new_seminar,
      intermd_quiz = excluded.intermd_quiz,
      seminar_changes = excluded.seminar_changes,
      seminar_live = excluded.seminar_live,
      point_conversion = excluded.point_conversion,
      updated_at = excluded.updated_at
  `,
  ).run({
    chatId,
    todayLinks: next.todayLinks ? 1 : 0,
    todayLinksTime: next.todayLinksTime,
    todayLinksSentDate: next.todayLinksSentDate,
    newSeminar: next.newSeminar,
    intermdQuiz: next.intermdQuiz ? 1 : 0,
    seminarChanges: next.seminarChanges ? 1 : 0,
    seminarLive: next.seminarLive ? 1 : 0,
    pointConversion: next.pointConversion ? 1 : 0,
    createdAt: next.createdAt,
    updatedAt: next.updatedAt,
  });

  return next;
}

export function toggleTopic(
  chatId: number,
  topic: 'today_links' | 'intermd_quiz' | 'seminar_changes' | 'seminar_live' | 'point_conversion',
): SubscriptionRecord {
  const current = getSubscription(chatId);
  switch (topic) {
    case 'today_links':
      return updateSubscription(chatId, { todayLinks: !current.todayLinks });
    case 'intermd_quiz':
      return updateSubscription(chatId, { intermdQuiz: !current.intermdQuiz });
    case 'seminar_changes':
      return updateSubscription(chatId, { seminarChanges: !current.seminarChanges });
    case 'seminar_live':
      return updateSubscription(chatId, { seminarLive: !current.seminarLive });
    case 'point_conversion':
      return updateSubscription(chatId, { pointConversion: !current.pointConversion });
  }
}

export function setNewSeminarFilter(chatId: number, filter: NewSeminarFilter): SubscriptionRecord {
  return updateSubscription(chatId, { newSeminar: filter });
}

export function setTodayLinksTime(chatId: number, time: string): SubscriptionRecord {
  return updateSubscription(chatId, { todayLinksTime: time, todayLinks: true });
}

export function setAllTopics(chatId: number, enable: boolean): SubscriptionRecord {
  return updateSubscription(chatId, {
    todayLinks: enable,
    newSeminar: enable ? 'all' : 'off',
    intermdQuiz: enable,
    seminarChanges: enable,
    seminarLive: enable,
    pointConversion: enable,
  });
}

export function removeSubscriberCompletely(chatId: number): void {
  const db = getDatabase();
  db.prepare('DELETE FROM subscriptions WHERE chat_id = ?').run(chatId);
}

export function getSubscribersForTopic(topic: SubscriptionTopic): number[] {
  const db = getDatabase();
  let query = '';
  switch (topic) {
    case 'today_links':
      query = 'SELECT chat_id FROM subscriptions WHERE today_links = 1';
      break;
    case 'new_seminar':
      query = "SELECT chat_id FROM subscriptions WHERE new_seminar != 'off'";
      break;
    case 'intermd_quiz':
      query = 'SELECT chat_id FROM subscriptions WHERE intermd_quiz = 1';
      break;
    case 'seminar_changes':
      query = 'SELECT chat_id FROM subscriptions WHERE seminar_changes = 1';
      break;
    case 'seminar_live':
      query = 'SELECT chat_id FROM subscriptions WHERE seminar_live = 1';
      break;
    case 'point_conversion':
      query = 'SELECT chat_id FROM subscriptions WHERE point_conversion = 1';
      break;
  }
  const rows = db.prepare(query).all() as Array<{ chat_id: number }>;
  return rows.map((r) => r.chat_id);
}

export function getTodayLinksSubscribersForTime(timeStr: string, dateStr: string = seoulDateString()): number[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
    SELECT chat_id FROM subscriptions
    WHERE today_links = 1
      AND today_links_time = ?
      AND (today_links_sent_date IS NULL OR today_links_sent_date != ?)
  `,
    )
    .all(timeStr, dateStr) as Array<{ chat_id: number }>;
  return rows.map((r) => r.chat_id);
}

export function markTodayLinksSent(chatIds: number[], dateStr: string = seoulDateString()): void {
  if (chatIds.length === 0) return;
  const db = getDatabase();
  const now = Date.now();
  const stmt = db.prepare(`
    UPDATE subscriptions
    SET today_links_sent_date = ?, updated_at = ?
    WHERE chat_id = ?
  `);
  const tx = db.transaction(() => {
    for (const id of chatIds) {
      stmt.run(dateStr, now, id);
    }
  });
  tx();
}

/**
 * 특정 토픽을 구독 중인 사용자들에게 공지봇을 통해 메시지를 전송합니다.
 */
export async function sendToTopicSubscribers(
  topic: SubscriptionTopic,
  message: string,
  options?: Record<string, unknown>,
): Promise<{ successCount: number; failCount: number }> {
  const subscribers = getSubscribersForTopic(topic);
  if (subscribers.length === 0) {
    return { successCount: 0, failCount: 0 };
  }

  const bot = getBot('notice');
  if (!bot) {
    logger.warn(`[subscription_service] 공지봇(noticeBot)이 초기화되지 않아 [${topic}] 알림을 발송할 수 없습니다.`);
    return { successCount: 0, failCount: subscribers.length };
  }

  let successCount = 0;
  let failCount = 0;
  const invalidChatIds: number[] = [];

  for (const chatId of subscribers) {
    try {
      const chunks = splitTelegramMessage(message, { maxLength: TELEGRAM_SAFE_MESSAGE_LENGTH });
      for (let i = 0; i < chunks.length; i++) {
        await bot.telegram.sendMessage(chatId, chunks[i], options as any);
        if (i < chunks.length - 1) {
          await sleep(100);
        }
      }
      successCount++;
    } catch (error) {
      failCount++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[subscription_service] [${topic}] chatId(${chatId}) 발송 실패:`, errorMessage);

      const lower = errorMessage.toLowerCase();
      if (
        lower.includes('forbidden') ||
        lower.includes('blocked') ||
        lower.includes('chat not found') ||
        lower.includes('deactivated')
      ) {
        invalidChatIds.push(chatId);
      }
    }
  }

  if (invalidChatIds.length > 0) {
    for (const invalidId of invalidChatIds) {
      removeSubscriberCompletely(invalidId);
    }
    logger.info(
      `[subscription_service] 유효하지 않은 구독자 ${invalidChatIds.length}명 자동 구독 해제 완료:`,
      invalidChatIds,
    );
  }

  return { successCount, failCount };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * 단일 신규 세미나 알림 메시지 빌더 (구독자 개인별 개별 전송용)
 */
export function buildSingleNewSeminarMessage(item: SeminarListItem): {
  text: string;
  options: Record<string, unknown>;
} {
  const tags: string[] = [];
  if (item.date || item.time) {
    tags.push(`[${item.date || ''}${item.date && item.time ? ' ' : ''}${item.time || ''}]`);
  }
  if (item.isPointExcluded) {
    tags.push('[포인트미지급]');
  }
  if (item.isAdvancedSurvey) {
    tags.push('[심화설문]');
  }

  const tagPrefix = tags.length > 0 ? `${tags.join(' ')} ` : '';
  const capacityInfo = item.currentCount && item.totalCount ? ` (${item.currentCount}/${item.totalCount})` : '';
  const targetUrl = item.url || (item.seminarId ? `https://m.doctorville.co.kr/cme/seminar/${item.seminarId}` : '');

  const text = `🆕 <b>[신규 세미나 등록]</b>\n\n${tagPrefix}<b>${escapeHtml(item.name || '세미나')}</b>${capacityInfo}\n${targetUrl}`;

  return {
    text,
    options: {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    },
  };
}

/**
 * 신규 세미나 등록 시 각 구독자의 조건(all, limit_5000, limit_3000, urgent_1000)에 맞춰 개인별 맞춤 알림을 개별 세미나 단위로 발송합니다.
 */
export async function sendNewSeminarToSubscribers(
  seminars: SeminarListItem[],
  newlyAddedIds?: string[] | Set<string>,
  buildSingleMessageFn?: (seminar: SeminarListItem) => { text: string; options?: Record<string, unknown> },
): Promise<{ successCount: number; failCount: number }> {
  const db = getDatabase();
  const rows = db.prepare("SELECT * FROM subscriptions WHERE new_seminar != 'off'").all() as Array<any>;

  if (rows.length === 0) {
    return { successCount: 0, failCount: 0 };
  }

  const bot = getBot('notice');
  if (!bot) {
    logger.warn('[subscription_service] 공지봇(noticeBot)이 초기화되지 않아 신규 세미나 알림을 발송할 수 없습니다.');
    return { successCount: 0, failCount: rows.length };
  }

  const newIdSet =
    newlyAddedIds instanceof Set
      ? newlyAddedIds
      : new Set(newlyAddedIds ? newlyAddedIds.map((id) => String(id).trim()) : []);

  const targetSeminars =
    newIdSet.size > 0 ? seminars.filter((s) => newIdSet.has(s.seminarId || '') || newIdSet.has(s.url || '')) : seminars;

  let successCount = 0;
  let failCount = 0;
  const invalidChatIds: number[] = [];

  for (const row of rows) {
    const chatId = row.chat_id;
    const filter = row.new_seminar as NewSeminarFilter;

    const matchedSeminars = targetSeminars.filter((s) => matchesNewSeminarFilter(filter, s));
    if (matchedSeminars.length === 0) {
      continue;
    }

    try {
      for (const seminar of matchedSeminars) {
        const messageContent = buildSingleMessageFn
          ? buildSingleMessageFn(seminar)
          : buildSingleNewSeminarMessage(seminar);

        const chunks = splitTelegramMessage(messageContent.text, { maxLength: TELEGRAM_SAFE_MESSAGE_LENGTH });
        for (let i = 0; i < chunks.length; i++) {
          await bot.telegram.sendMessage(chatId, chunks[i], messageContent.options as any);
          if (i < chunks.length - 1) {
            await sleep(100);
          }
        }
        await sleep(100);
      }
      successCount++;
    } catch (error) {
      failCount++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[subscription_service] [new_seminar] chatId(${chatId}) 발송 실패:`, errorMessage);

      const lower = errorMessage.toLowerCase();
      if (
        lower.includes('forbidden') ||
        lower.includes('blocked') ||
        lower.includes('chat not found') ||
        lower.includes('deactivated')
      ) {
        invalidChatIds.push(chatId);
      }
    }
  }

  if (invalidChatIds.length > 0) {
    for (const invalidId of invalidChatIds) {
      removeSubscriberCompletely(invalidId);
    }
    logger.info(
      `[subscription_service] 유효하지 않은 구독자 ${invalidChatIds.length}명 자동 구독 해제 완료:`,
      invalidChatIds,
    );
  }

  return { successCount, failCount };
}

/**
 * 마감 임박(신청 가능 1,000명 이하)으로 새롭게 진입한 세미나 목록을 urgent_1000 (및 all) 구독자들에게 발송합니다.
 */
export async function sendUrgentSeminarsToSubscribers(
  urgentSeminars: SeminarListItem[],
): Promise<{ successCount: number; failCount: number }> {
  if (urgentSeminars.length === 0) return { successCount: 0, failCount: 0 };

  const db = getDatabase();
  const rows = db.prepare("SELECT chat_id FROM subscriptions WHERE new_seminar = 'urgent_1000'").all() as Array<{
    chat_id: number;
  }>;

  if (rows.length === 0) {
    return { successCount: 0, failCount: 0 };
  }

  const bot = getBot('notice');
  if (!bot) {
    logger.warn('[subscription_service] 공지봇(noticeBot)이 초기화되지 않아 마감 임박 알림을 발송할 수 없습니다.');
    return { successCount: 0, failCount: rows.length };
  }

  const formattedItems: string[] = [];
  for (let i = 0; i < urgentSeminars.length; i++) {
    const s = urgentSeminars[i];
    const { current, total, remaining } = parseCapacityNumbers(s);
    const dateStr = s.date || s.time ? `[${s.date || ''}${s.date && s.time ? ' ' : ''}${s.time || ''}] ` : '';
    const capInfo = total > 0 ? ` (${current}/${total}) ⚡ 잔여 ${remaining}명` : '';
    formattedItems.push(`${i + 1}. ${dateStr}<b>${s.name}</b>${capInfo}\n${s.url}`);
  }

  const messageText = [
    '⚡ <b>[세미나 마감 임박 알림 (잔여 1,000명 이하)]</b>',
    '',
    '신청 가능 잔여 인원이 1,000명 이하로 남은 세미나입니다. 서둘러 신청하세요!',
    '',
    formattedItems.join('\n\n'),
  ].join('\n');

  let successCount = 0;
  let failCount = 0;
  const invalidChatIds: number[] = [];

  for (const row of rows) {
    const chatId = row.chat_id;
    try {
      const chunks = splitTelegramMessage(messageText, { maxLength: TELEGRAM_SAFE_MESSAGE_LENGTH });
      for (let i = 0; i < chunks.length; i++) {
        await bot.telegram.sendMessage(chatId, chunks[i], {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        } as any);
        if (i < chunks.length - 1) {
          await sleep(100);
        }
      }
      successCount++;
    } catch (error) {
      failCount++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[subscription_service] [urgent_seminar] chatId(${chatId}) 발송 실패:`, errorMessage);

      const lower = errorMessage.toLowerCase();
      if (
        lower.includes('forbidden') ||
        lower.includes('blocked') ||
        lower.includes('chat not found') ||
        lower.includes('deactivated')
      ) {
        invalidChatIds.push(chatId);
      }
    }
  }

  if (invalidChatIds.length > 0) {
    for (const invalidId of invalidChatIds) {
      removeSubscriberCompletely(invalidId);
    }
  }

  return { successCount, failCount };
}

/**
 * 특정 시간(HH:mm)에 오늘의 링크 알림을 수신하기로 한 구독자들에게 맞춤 발송합니다.
 */
export async function sendHourlyTodayLinksToSubscribers(
  targetTime?: string,
  targetDate: string = seoulDateString(),
): Promise<{ successCount: number; failCount: number }> {
  let timeStr = targetTime;
  if (!timeStr) {
    const nowKST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const h = String(nowKST.getHours()).padStart(2, '0');
    const m = String(nowKST.getMinutes()).padStart(2, '0');
    timeStr = `${h}:${m}`;
  }

  const subscribers = getTodayLinksSubscribersForTime(timeStr, targetDate);
  if (subscribers.length === 0) {
    return { successCount: 0, failCount: 0 };
  }

  const bot = getBot('notice');
  if (!bot) {
    logger.warn(
      '[subscription_service] 공지봇(noticeBot)이 초기화되지 않아 오늘의 링크 맞춤 알림을 발송할 수 없습니다.',
    );
    return { successCount: 0, failCount: subscribers.length };
  }

  let messageText = '';
  let messageOptions: Record<string, unknown> = {};

  try {
    const { getTodayLinksCache } = await import('../tasks/today_links');
    const cache = getTodayLinksCache();
    if (cache && cache.message) {
      messageText = cache.message;
      messageOptions = cache.options ?? {};
    } else {
      const todayLinksModule = await import('../tasks/today_links');
      const res = await todayLinksModule.run({});
      if (res && res.message) {
        messageText = res.message;
        messageOptions = res.options ?? {};
      }
    }
  } catch (err) {
    logger.error('[subscription_service] 오늘의 링크 데이터 생성 실패:', err);
    return { successCount: 0, failCount: subscribers.length };
  }

  if (!messageText) {
    logger.warn('[subscription_service] 발송할 오늘의 링크 메시지가 없습니다.');
    return { successCount: 0, failCount: subscribers.length };
  }

  let successCount = 0;
  let failCount = 0;
  const sentChatIds: number[] = [];
  const invalidChatIds: number[] = [];

  for (const chatId of subscribers) {
    try {
      const chunks = splitTelegramMessage(messageText, { maxLength: TELEGRAM_SAFE_MESSAGE_LENGTH });
      for (let i = 0; i < chunks.length; i++) {
        await bot.telegram.sendMessage(chatId, chunks[i], messageOptions as any);
        if (i < chunks.length - 1) {
          await sleep(100);
        }
      }
      sentChatIds.push(chatId);
      successCount++;
    } catch (error) {
      failCount++;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`[subscription_service] [today_links] chatId(${chatId}) 발송 실패:`, errorMessage);

      const lower = errorMessage.toLowerCase();
      if (
        lower.includes('forbidden') ||
        lower.includes('blocked') ||
        lower.includes('chat not found') ||
        lower.includes('deactivated')
      ) {
        invalidChatIds.push(chatId);
      }
    }
  }

  if (sentChatIds.length > 0) {
    markTodayLinksSent(sentChatIds, targetDate);
  }

  if (invalidChatIds.length > 0) {
    for (const invalidId of invalidChatIds) {
      removeSubscriberCompletely(invalidId);
    }
    logger.info(
      `[subscription_service] 유효하지 않은 구독자 ${invalidChatIds.length}명 자동 구독 해제 완료:`,
      invalidChatIds,
    );
  }

  return { successCount, failCount };
}

// --- UI Rendering Helpers ---

export function getNewSeminarFilterLabel(filter: NewSeminarFilter): string {
  switch (filter) {
    case 'all':
      return '📢 전체 알림';
    case 'limit_5000':
      return '👥 정원 5,000명 이하';
    case 'limit_3000':
      return '👥 정원 3,000명 이하';
    case 'urgent_1000':
      return '⚡ 마감 임박 (잔여 1,000명 이하)';
    case 'off':
      return '🔴 알림 끔 (OFF)';
  }
}

export function buildMainMenu(chatId: number): { text: string; replyMarkup: any } {
  const sub = getSubscription(chatId);

  const text = [
    '🔔 <b>공지봇 맞춤 알림 구독 설정</b>',
    '',
    '현재 설정된 구독 항목 현황입니다.',
    '버튼을 눌러 각 항목의 <b>ON/OFF</b> 및 <b>상세 조건</b>을 설정하세요.',
    '',
    '📋 <b>[구독 현황]</b>',
    `• 🔗 <b>오늘의 링크</b>: ${sub.todayLinks ? `🟢 ON (수신 시간: ${sub.todayLinksTime})` : '🔴 OFF'}`,
    `• 🆕 <b>신규 세미나</b>: ${sub.newSeminar === 'off' ? '🔴 OFF' : `🟢 ${getNewSeminarFilterLabel(sub.newSeminar)}`}`,
    `• ❓ <b>인터엠디 퀴즈</b>: ${sub.intermdQuiz ? '🟢 ON' : '🔴 OFF'}`,
    `• 🔄 <b>세미나 정보 변경/심화</b>: ${sub.seminarChanges ? '🟢 ON' : '🔴 OFF'}`,
    `• 🔴 <b>세미나 라이브/퀴즈</b>: ${sub.seminarLive ? '🟢 ON' : '🔴 OFF'}`,
    `• 💰 <b>네페 포인트 전환</b>: ${sub.pointConversion ? '🟢 ON' : '🔴 OFF'}`,
  ].join('\n');

  const inlineKeyboard = [
    [
      {
        text: `🔗 오늘의 링크: ${sub.todayLinks ? 'ON 🟢' : 'OFF 🔴'}`,
        callback_data: 'sub:toggle:today_links',
      },
    ],
    [
      {
        text: `⏰ 오늘의 링크 시간 (${sub.todayLinksTime}) ⚙️`,
        callback_data: 'sub:menu:today_links_time',
      },
    ],
    [
      {
        text: `🆕 신규 세미나: ${sub.newSeminar === 'off' ? 'OFF 🔴' : getNewSeminarFilterLabel(sub.newSeminar)} ⚙️`,
        callback_data: 'sub:menu:new_seminar',
      },
    ],
    [
      {
        text: `❓ 인터엠디 퀴즈: ${sub.intermdQuiz ? 'ON 🟢' : 'OFF 🔴'}`,
        callback_data: 'sub:toggle:intermd_quiz',
      },
    ],
    [
      {
        text: `🔄 세미나 정보 변경: ${sub.seminarChanges ? 'ON 🟢' : 'OFF 🔴'}`,
        callback_data: 'sub:toggle:seminar_changes',
      },
    ],
    [
      {
        text: `🔴 세미나 라이브/퀴즈: ${sub.seminarLive ? 'ON 🟢' : 'OFF 🔴'}`,
        callback_data: 'sub:toggle:seminar_live',
      },
    ],
    [
      {
        text: `💰 네페 포인트 전환: ${sub.pointConversion ? 'ON 🟢' : 'OFF 🔴'}`,
        callback_data: 'sub:toggle:point_conversion',
      },
    ],
    [
      { text: '🔄 전체 켜기', callback_data: 'sub:all_on' },
      { text: '⏹ 전체 끄기', callback_data: 'sub:all_off' },
    ],
    [{ text: '❌ 닫기', callback_data: 'sub:close' }],
  ];

  return {
    text,
    replyMarkup: {
      inline_keyboard: inlineKeyboard,
    },
  };
}

export function buildTodayLinksTimeMenu(chatId: number): { text: string; replyMarkup: any } {
  const sub = getSubscription(chatId);

  const text = [
    '⏰ <b>오늘의 링크 알림 수신 시간 설정</b>',
    '',
    '매일 희망하시는 시간에 오늘의 세미나/퀴즈 링크 모음을 전송해 드립니다.',
    `• 현재 설정된 시간: <b>${sub.todayLinksTime}</b> (${sub.todayLinks ? '🟢 구독 중' : '🔴 구독 OFF'})`,
    '',
    '희망하시는 수신 시간을 아래에서 선택해주세요:',
  ].join('\n');

  const buttons: Array<{ text: string; callback_data: string }> = [];
  for (const time of TODAY_LINKS_AVAILABLE_TIMES) {
    const isSelected = sub.todayLinksTime === time;
    buttons.push({
      text: `${time} ${isSelected ? '✅' : ''}`.trim(),
      callback_data: `sub:set_time:${time}`,
    });
  }

  // 3개씩 행 분할
  const keyboardRows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let i = 0; i < buttons.length; i += 3) {
    keyboardRows.push(buttons.slice(i, i + 3));
  }

  keyboardRows.push([{ text: '◀ 메인 설정으로 돌아가기', callback_data: 'sub:menu:main' }]);

  return {
    text,
    replyMarkup: {
      inline_keyboard: keyboardRows,
    },
  };
}

export function buildNewSeminarMenu(chatId: number): { text: string; replyMarkup: any } {
  const sub = getSubscription(chatId);

  const text = [
    '🆕 <b>신규 세미나 등록 알림 설정</b>',
    '',
    '새로운 세미나가 등록/오픈되었을 때의 알림 수신 조건을 선택하세요.',
    `• 현재 설정: <b>${getNewSeminarFilterLabel(sub.newSeminar)}</b>`,
    '',
    '원하시는 알림 옵션을 선택해주세요:',
  ].join('\n');

  const options: Array<{ filter: NewSeminarFilter; label: string }> = [
    { filter: 'all', label: '📢 전체 알림 (모든 신규 세미나)' },
    { filter: 'limit_5000', label: '👥 정원 5,000명 이하 세미나만' },
    { filter: 'limit_3000', label: '👥 정원 3,000명 이하 세미나만' },
    { filter: 'urgent_1000', label: '⚡ 마감 임박 (잔여 1,000명 이하만)' },
    { filter: 'off', label: '🔴 알림 끔 (OFF)' },
  ];

  const keyboardRows = options.map((opt) => {
    const isSelected = sub.newSeminar === opt.filter;
    return [
      {
        text: `${opt.label} ${isSelected ? '✅' : ''}`.trim(),
        callback_data: `sub:set_new_seminar:${opt.filter}`,
      },
    ];
  });

  keyboardRows.push([{ text: '◀ 메인 설정으로 돌아가기', callback_data: 'sub:menu:main' }]);

  return {
    text,
    replyMarkup: {
      inline_keyboard: keyboardRows,
    },
  };
}
