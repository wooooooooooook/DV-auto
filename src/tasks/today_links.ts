import type { PlaywrightRunArgs } from '../types';
import { getPointConversionAvailabilityHttp } from '../modules/utils';
import * as storage from '../services/storage';
import * as seminarRepo from '../services/seminar_repository';
import { TODAY_QUIZ_INFO_KEY, type CachedTodayQuizInfo } from './today_quiz';
import { ProcessState } from '../modules/seminar_api';

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
const POINT_CONVERSION_URL = 'https://www.doctorville.co.kr/my/point/pointUseHistoryList';
const TODAY_QUIZ_TEMP_KEY = 'today_quiz:temp_answers';
export const TODAY_LINKS_CACHE_KEY = 'today_links_cache';

export interface TodayLinksCache {
  date: string;
  message: string;
  options?: Record<string, unknown>;
  cachedAt: string;
}

function getTodayLinksCache(): TodayLinksCache | null {
  return storage.get<TodayLinksCache>(TODAY_LINKS_CACHE_KEY, null);
}

function setTodayLinksCache(cache: TodayLinksCache): void {
  storage.set(TODAY_LINKS_CACHE_KEY, cache);
}

function clearTodayLinksCache(): void {
  storage.deleteKey(TODAY_LINKS_CACHE_KEY);
}

type PointConversionInfo = {
  available?: boolean;
  availablePlannedAt?: string;
  meridiem?: string;
};

type QuizInfo = { link: string; productTitle?: string; answers?: Array<string | number> };
type SeminarData = {
  date: string;
  lunchSeminarIds: string[];
  dinnerSeminarIds: string[];
};
type SeminarTaskData = SeminarData & { allSeminarIds: string[] };
type SeminarMessageResult = SeminarData & { message: string };
type StoredNewSeminars = {
  date: string;
  seminars: Array<{
    name: string;
    url: string;
    seminarId: string | null;
    isPointExcluded?: boolean;
    isAdvancedSurvey?: boolean;
    hiddenYn?: string;
    diseaseCategoryNm?: string;
    date?: string;
    time?: string;
    currentCount?: string;
    totalCount?: string;
  }>;
};

type TempQuizAnswers = {
  date: string;
  productTitle: string;
  answers: Array<string | number>;
};
const TODAY_SEMINAR_KEY = 'today_seminars';

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function parseTargetDate(input?: string): Date {
  const now = new Date();
  if (!input) return now;

  const trimmed = input.trim().toLowerCase();
  if (trimmed === 'today' || trimmed === '오늘') {
    return now;
  }
  if (trimmed === 'tomorrow' || trimmed === '내일') {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (trimmed === 'yesterday' || trimmed === '어제') {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return d;
  }
  if (trimmed === '모레') {
    const d = new Date(now);
    d.setDate(d.getDate() + 2);
    return d;
  }

  // YYYY-MM-DD 또는 YYYY/MM/DD 또는 YYYY.MM.DD 또는 YYYYMMDD
  const ymdMatch = trimmed.match(/^(\d{4})[-/.]?(\d{1,2})[-/.]?(\d{1,2})$/);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10) - 1;
    const day = parseInt(ymdMatch[3], 10);
    return new Date(year, month, day, 12, 0, 0);
  }

  // MM-DD 또는 M/D 또는 MM.DD
  const mdMatch = trimmed.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (mdMatch) {
    const currentYear = now.getFullYear();
    const month = parseInt(mdMatch[1], 10) - 1;
    const day = parseInt(mdMatch[2], 10);
    return new Date(currentYear, month, day, 12, 0, 0);
  }

  // MMDD (4자리)
  const mmddMatch = trimmed.match(/^(\d{2})(\d{2})$/);
  if (mmddMatch) {
    const currentYear = now.getFullYear();
    const month = parseInt(mmddMatch[1], 10) - 1;
    const day = parseInt(mmddMatch[2], 10);
    return new Date(currentYear, month, day, 12, 0, 0);
  }

  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed;
  }

  return now;
}

function getTodayDateStrings(customDateInput?: string) {
  const opts = { timeZone: 'Asia/Seoul' as const };
  const targetDate = parseTargetDate(customDateInput);
  const now = new Date();

  const month = targetDate.toLocaleDateString('en-US', { month: 'numeric', ...opts });
  const day = targetDate.toLocaleDateString('en-US', { day: 'numeric', ...opts });
  const iso = targetDate.toLocaleDateString('en-CA', opts);

  const yesterday = new Date(targetDate);
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayIso = yesterday.toLocaleDateString('en-CA', opts);

  const nowIso = now.toLocaleDateString('en-CA', opts);
  const isCustomDate = Boolean(customDateInput && iso !== nowIso);

  const targetMonth = parseInt(month, 10);
  const targetDay = parseInt(day, 10);

  return {
    todayString: `${month}/${day}`,
    isoDate: iso,
    yesterdayIso,
    isCustomDate,
    targetMonth,
    targetDay,
  };
}

function getYesterdayAddedSeminars(yesterdayIso: string): StoredNewSeminars['seminars'] {
  const storedSeminars = seminarRepo.getSeminarsByDetectedDate(yesterdayIso);

  return storedSeminars
    .filter((seminar) => {
      if (!seminar.totalCount || seminar.totalCount.trim() === '') return true;
      const parsed = parseInt(seminar.totalCount.replace(/[^0-9]/g, ''), 10);
      return isNaN(parsed) || parsed >= 10;
    })
    .map((seminar) => ({
      name: seminar.name,
      url: seminar.url,
      seminarId: seminar.seminarId,
      isPointExcluded: seminar.isPointExcluded,
      isAdvancedSurvey: seminar.isAdvancedSurvey,
      hiddenYn: seminar.hiddenYn,
      diseaseCategoryNm: seminar.diseaseCategoryNm,
      date: seminar.date,
      time: seminar.time,
      currentCount: seminar.currentCount,
      totalCount: seminar.totalCount,
    }))
    .sort((a, b) => {
      if (!a.seminarId && !b.seminarId) return 0;
      if (!a.seminarId) return 1;
      if (!b.seminarId) return -1;
      return a.seminarId.localeCompare(b.seminarId, undefined, { numeric: true });
    });
}

function getTempQuizAnswers(isoDate: string, productTitle: string): Array<string | number> | null {
  const stored = storage.get<TempQuizAnswers>(TODAY_QUIZ_TEMP_KEY);
  if (!stored || stored.date !== isoDate || stored.productTitle !== productTitle) return null;
  if (!Array.isArray(stored.answers) || stored.answers.length === 0) return null;
  return stored.answers;
}

function collectQuizInfo(_page?: PlaywrightRunArgs['page']): QuizInfo | null {
  try {
    const { isoDate } = getTodayDateStrings();

    const cachedQuiz = storage.get<CachedTodayQuizInfo>(TODAY_QUIZ_INFO_KEY);
    if (cachedQuiz && cachedQuiz.date === isoDate) {
      if (!cachedQuiz.link) return null;

      const tempAnswers = cachedQuiz.productTitle ? getTempQuizAnswers(isoDate, cachedQuiz.productTitle) : null;
      return {
        link: cachedQuiz.link,
        productTitle: cachedQuiz.productTitle,
        answers: tempAnswers || cachedQuiz.answers,
      };
    }

    return null;
  } catch (_e) {
    console.error('collectQuizInfo error', _e && typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e);
    return null;
  }
}

type DateTarget = {
  todayString: string;
  isoDate: string;
  targetMonth: number;
  targetDay: number;
};

type ParsedSeminarItem = {
  title: string;
  time: string;
  seminarLink: string;
  fullUrl: string;
  seminarId: string | null;
  classAttr: string;
  isAdvancedSurvey: boolean;
  isPointExcluded?: boolean;
  hiddenYn?: string;
  diseaseCategoryNm?: string;
};

function isDateMatching(dateText: string, target: DateTarget): boolean {
  if (!dateText) return false;
  if (dateText.includes(target.todayString)) return true;
  if (dateText.includes(target.isoDate)) return true;

  // YYYY.MM.DD, YYYY-MM-DD, YYYY/MM/DD 등 연도 포함 형식
  const ymdMatch = dateText.match(/(\d{4})[^\d]+(\d{1,2})[^\d]+(\d{1,2})/);
  if (ymdMatch) {
    const m = parseInt(ymdMatch[2], 10);
    const d = parseInt(ymdMatch[3], 10);
    if (m === target.targetMonth && d === target.targetDay) return true;
  }

  // M/D, MM/DD, M.D, MM.DD, M월 D일 등 월/일 형식
  const mdMatch = dateText.match(/(\d{1,2})[^\d]+(\d{1,2})/);
  if (mdMatch) {
    const m = parseInt(mdMatch[1], 10);
    const d = parseInt(mdMatch[2], 10);
    if (m === target.targetMonth && d === target.targetDay) return true;
  }

  return false;
}

async function collectTodaySeminarMessage(
  page?: PlaywrightRunArgs['page'],
  customDateInput?: string,
): Promise<SeminarMessageResult> {
  const { todayString, isoDate, isCustomDate, targetMonth, targetDay } = getTodayDateStrings(customDateInput);
  const lunchSeminarIds: string[] = [];
  const dinnerSeminarIds: string[] = [];
  const seminarTitlePrefix = isCustomDate ? `[${todayString}]` : '오늘의';

  try {
    const dateTarget: DateTarget = { todayString, isoDate, targetMonth, targetDay };
    const storedSeminars = seminarRepo.getAllSeminars();
    const seenIds = new Set<string>();
    const seenUrls = new Set<string>();
    const parsedSeminars: ParsedSeminarItem[] = [];

    for (const stored of storedSeminars) {
      if (!stored.date || !isDateMatching(stored.date, dateTarget)) continue;
      const ps = stored.processState;
      if (ps === ProcessState.PROCESS_END || ps === ProcessState.PROCESS_COMPLETED || stored.seminarCompleted === 1) {
        continue;
      }
      const sid = stored.seminarId ? String(stored.seminarId).trim() : null;
      const fullUrl = stored.url || (sid ? `${SEMINAR_DETAIL_PAGE}${sid}` : '');
      if ((sid && seenIds.has(sid)) || (fullUrl && seenUrls.has(fullUrl))) continue;

      let nightTime = stored.nightTime ?? false;
      if (stored.time) {
        const hourMatch = stored.time.match(/(\d{1,2})\s*:/);
        if (hourMatch) {
          const hour = Number(hourMatch[1]);
          if (Number.isFinite(hour) && hour >= 16) nightTime = true;
        }
      }

      parsedSeminars.push({
        title: stored.name || '세미나',
        time: stored.time || '',
        seminarLink: fullUrl,
        fullUrl,
        seminarId: sid,
        classAttr: nightTime ? 'night_time' : '',
        isAdvancedSurvey: stored.isAdvancedSurvey ?? false,
        isPointExcluded: stored.isPointExcluded,
        hiddenYn: stored.hiddenYn,
        diseaseCategoryNm: stored.diseaseCategoryNm,
      });
      if (sid) seenIds.add(sid);
      if (fullUrl) seenUrls.add(fullUrl);
    }

    parsedSeminars.sort((a, b) => {
      const timeA = a.time || '';
      const timeB = b.time || '';
      const comp = timeA.localeCompare(timeB);
      if (comp !== 0) return comp;
      return (a.seminarId || '').localeCompare(b.seminarId || '', undefined, { numeric: true });
    });

    if (!parsedSeminars || parsedSeminars.length === 0) {
      return {
        message: `<b>${seminarTitlePrefix} 세미나:</b> 세미나가 없습니다. ☕`,
        date: isoDate,
        lunchSeminarIds: [],
        dinnerSeminarIds: [],
      };
    }

    const lunchSeminars: string[] = [];
    const dinnerSeminars: string[] = [];

    const isDinnerSeminar = (classAttr: string, time: string): boolean => {
      if (classAttr.includes('night_time')) return true;

      const hourMatch = time.match(/(\d{1,2})\s*:/);
      if (!hourMatch) return false;

      const hour = Number(hourMatch[1]);
      return Number.isFinite(hour) && hour >= 16;
    };

    for (const item of parsedSeminars) {
      const isPointExcluded = item.isPointExcluded ?? false;
      const isPrivate = item.hiddenYn === 'Y' || item.hiddenYn === 'y';
      const diseaseTag =
        isPrivate && item.diseaseCategoryNm && item.diseaseCategoryNm.trim()
          ? `[${escapeHtml(item.diseaseCategoryNm.trim())}]`
          : '';
      const privateSuffix = isPrivate ? ` 🔒<b>[비공개]${diseaseTag}</b>` : '';
      const pointExcludedSuffix = isPointExcluded ? ' 🚫<b>[포인트미지급]</b>' : '';
      const advancedSurveySuffix = item.isAdvancedSurvey ? ' 📝<b>[심화설문]</b>' : '';
      const titleDisplay = isPointExcluded ? `<s>${escapeHtml(item.title)}</s>` : escapeHtml(item.title);
      const seminarInfo = ` ${item.time}. ${titleDisplay}${privateSuffix}${pointExcludedSuffix}${advancedSurveySuffix} ${item.seminarLink}`;

      if (isDinnerSeminar(item.classAttr, item.time)) {
        dinnerSeminars.push(seminarInfo);
        if (item.seminarId) dinnerSeminarIds.push(item.seminarId);
      } else {
        lunchSeminars.push(seminarInfo);
        if (item.seminarId) lunchSeminarIds.push(item.seminarId);
      }
    }

    if (lunchSeminars.length > 0 || dinnerSeminars.length > 0) {
      let message = `<b>${seminarTitlePrefix} 세미나 리스트:</b>\n`;

      if (lunchSeminars.length > 0) {
        message += `🍴 <b>[점심 세미나]</b>\n- `;
        message += lunchSeminars.join('\n- ');
      }
      message += '\n';
      if (dinnerSeminars.length > 0) {
        message += `\n🍴 <b>[저녁 세미나]</b>\n- `;
        message += dinnerSeminars.join('\n- ');
      }
      return {
        message,
        date: isoDate,
        lunchSeminarIds: [...new Set(lunchSeminarIds)],
        dinnerSeminarIds: [...new Set(dinnerSeminarIds)],
      };
    }
    return {
      message: `<b>${seminarTitlePrefix} 세미나 리스트:</b> 세미나가 없습니다. ☕`,
      date: isoDate,
      lunchSeminarIds: [],
      dinnerSeminarIds: [],
    };
  } catch (_e) {
    const message = _e instanceof Error ? _e.message : String(_e);
    console.error(
      'collectTodaySeminarMessage error',
      _e && typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e,
    );
    return {
      message: `<b>${seminarTitlePrefix} 세미나 확인 실패:</b> ${escapeHtml(message)}`,
      date: isoDate,
      lunchSeminarIds: [],
      dinnerSeminarIds: [],
    };
  }
}

async function collectPointConversionInfo(_page?: PlaywrightRunArgs['page']): Promise<PointConversionInfo | null> {
  try {
    const httpData = await getPointConversionAvailabilityHttp();
    return httpData ?? null;
  } catch (_e) {
    console.error(
      'collectPointConversionInfo error',
      _e && typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e,
    );
    return null;
  }
}

function parsePointConversionPlannedDate(plannedAt: string | undefined): { month: number; day: number } | null {
  if (!plannedAt) return null;
  const m = plannedAt.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (!m) return null;
  const month = parseInt(m[1], 10);
  const day = parseInt(m[2], 10);
  if (!month || !day) return null;
  return { month, day };
}

function getPointConversionDiffDays(plannedAt: string | undefined, todayIsoOverride?: string): number | null {
  const planned = parsePointConversionPlannedDate(plannedAt);
  if (!planned) return null;
  const todayIso = todayIsoOverride ?? new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
  const [y, mo, d] = todayIso.split('-').map(Number);
  if (!y || !mo || !d) return null;
  const todayMs = Date.UTC(y, mo - 1, d);
  let targetYear = y;
  let targetMs = Date.UTC(targetYear, planned.month - 1, planned.day);
  if (targetMs < todayMs) {
    targetYear += 1;
    targetMs = Date.UTC(targetYear, planned.month - 1, planned.day);
  }
  return Math.round((targetMs - todayMs) / 86400000);
}

export function isPointConversionDay(info: PointConversionInfo | null | undefined, todayIsoOverride?: string): boolean {
  if (!info || info.available) return false;
  const diffDays = getPointConversionDiffDays(info.availablePlannedAt, todayIsoOverride);
  return diffDays === 0;
}

function getPointConversionDdayLabel(plannedAt: string | undefined, todayIsoOverride?: string): string {
  const diffDays = getPointConversionDiffDays(plannedAt, todayIsoOverride);
  if (diffDays === null) return '';
  if (diffDays === 0) return ' (D-Day)';
  if (diffDays > 0) return ` (D-${diffDays})`;
  return '';
}

function formatPointConversionMessage(info: PointConversionInfo | null, todayIsoOverride?: string): string {
  if (!info) return '';
  if (info.available) {
    return `💳 <b>현재 네이버페이 포인트 전환 가능합니다.</b>\n${POINT_CONVERSION_URL}`;
  }
  if (isPointConversionDay(info, todayIsoOverride)) {
    return `💳 <b>오늘 네이버페이포인트 전환 가능 예정입니다. 전환 가능 알림을 기다려주세요!</b>\n${POINT_CONVERSION_URL}`;
  }
  const plannedParts = [info.availablePlannedAt, info.meridiem].map((s) => s?.trim()).filter(Boolean);
  if (plannedParts.length > 0) {
    const dday = getPointConversionDdayLabel(info.availablePlannedAt, todayIsoOverride);
    return `💳 <b>다음 네이버페이포인트 전환가능일:</b> ${escapeHtml(plannedParts.join(' '))}${dday}`;
  }
  return '💳 <b>다음 네이버페이포인트 전환가능일:</b> 미정';
}

export type TodayLinksFormatInput = {
  quizInfo: QuizInfo | null;
  seminarMessage: SeminarMessageResult | null;
  storedNewSeminars: StoredNewSeminars['seminars'];
  pointConversionInfo: PointConversionInfo | null;
  targetDate?: string;
  isCustomDate?: boolean;
};

export type TodayLinksFormattedResult = {
  message: string;
  options: {
    parse_mode: 'HTML';
    link_preview_options?: {
      is_disabled: boolean;
    };
    reply_markup: {
      inline_keyboard: Array<Array<{ text: string; url: string }>>;
    };
  };
};

function formatTodayLinksBroadcast(input: TodayLinksFormatInput): TodayLinksFormattedResult {
  const { quizInfo, seminarMessage, storedNewSeminars, pointConversionInfo, targetDate, isCustomDate } = input;

  let message = '';
  if (isCustomDate && targetDate) {
    message += `📅 <b>[${escapeHtml(targetDate)} 링크 및 세미나]</b>\n\n`;
  }

  message += '✨ <b>출석체크:</b> https://m.doctorville.co.kr/mypage/attendance\n\n';

  let quizMessage = '오늘은 퀴즈가 없습니다. ☕';
  if (quizInfo?.link) {
    if (quizInfo.productTitle) {
      const answersText = quizInfo.answers?.map(String).join('');
      const answerNote = answersText
        ? `, 정답: <code>${escapeHtml(answersText)}</code>`
        : ' (저장된 정답이 없습니다. 댓글로 알려주세요.)';
      quizMessage = `<b>${escapeHtml(quizInfo.productTitle)}</b>${answerNote}`;
    }
    quizMessage += `\n${quizInfo.link}`;
  }
  message += `✏️ <b>오늘의 퀴즈:</b> ${quizMessage}\n`;
  if (seminarMessage?.message) {
    message += `\n📖 ${seminarMessage.message}\n`;
  }

  const visibleNewSeminars = storedNewSeminars || [];

  if (visibleNewSeminars.length > 0) {
    const newSeminarList = visibleNewSeminars
      .map((item, index) => {
        const link = item.seminarId ? `${SEMINAR_DETAIL_PAGE}${item.seminarId}` : item.url;
        const isPrivate = item.hiddenYn === 'Y' || item.hiddenYn === 'y';
        const diseaseTag =
          isPrivate && item.diseaseCategoryNm && item.diseaseCategoryNm.trim()
            ? `[${escapeHtml(item.diseaseCategoryNm.trim())}]`
            : '';
        const privateSuffix = isPrivate ? ` 🔒<b>[비공개]${diseaseTag}</b>` : '';
        const pointExcludedSuffix = item.isPointExcluded ? ' 🚫[포인트미지급]' : '';
        const advancedSurveySuffix = item.isAdvancedSurvey ? ' ✨<b>[심화설문]</b>' : '';
        const dateTimePrefix = item.date || item.time ? `[${item.date}${item.time ? ' ' + item.time : ''}] ` : '';
        const truncatedName = item.name.length > 20 ? `${item.name.slice(0, 20)}...` : item.name;
        const capacityInfo =
          item.currentCount || item.totalCount ? ` (${item.currentCount || '0'}/${item.totalCount || '0'})` : '';
        const nameDisplay = item.isPointExcluded ? `<s>${escapeHtml(truncatedName)}</s>` : escapeHtml(truncatedName);
        return `${index + 1}. ${dateTimePrefix}${nameDisplay}${capacityInfo}${privateSuffix}${pointExcludedSuffix}${advancedSurveySuffix}\n${link}`;
      })
      .join('\n');

    message += `\n🆕 <b>어제 추가된 신규 세미나</b>\n${newSeminarList}\n`;
  }

  const pointConversionMessage = formatPointConversionMessage(
    pointConversionInfo,
    isCustomDate && targetDate ? targetDate.split(' ')[0] : undefined,
  );
  if (pointConversionMessage) {
    message += `\n${pointConversionMessage}\n`;
  }

  message += `\n<blockquote>🤖 <b>닥터빌 텔레그램방에 전송된 메시지입니다.</b>
매일 오전 링크모음 발송, 세미나 시작/종료, 퀴즈 정답 알림, 지금 가입하세요!
https://t.me/+J1UGmvLA9jU4NjQ1</blockquote>\n<blockquote>✨ <b>공지봇(@DV_notice_bot)에서 나만의 개인별 맞춤 알림을 설정해보세요!</b>
• <b>링크모음 수신 시간 자유 설정</b> (00시~12시 원하는 시간 지정)
• <b>설문 마감 20분전 / 10분전 개별 알림</b>
• <b>신규 세미나 등록</b> (정원 제한 필터링 등) & <b>라이브 시작/종료</b>
• <b>세미나 정보 변경 / 포인트 지급 / 인터엠디 퀴즈 알림</b>
👉 나만의 알림 설정하기: https://t.me/DV_notice_bot</blockquote>`;

  const inlineKeyboard: Array<Array<{ text: string; url: string }>> = [];

  const actionRow: Array<{ text: string; url: string }> = [
    { text: '✨ 출석체크 바로가기', url: 'https://m.doctorville.co.kr/mypage/attendance' },
  ];
  if (quizInfo?.link) {
    actionRow.push({ text: '✏️ 오늘의 퀴즈 풀기', url: quizInfo.link });
  }
  inlineKeyboard.push(actionRow);

  // 포인트 전환 가능일(당일 전환 가능)인 경우 포인트 전환 바로가기 버튼 추가
  const pointConversionDay = pointConversionInfo?.available
    ? true
    : isPointConversionDay(pointConversionInfo, isCustomDate && targetDate ? targetDate.split(' ')[0] : undefined);
  if (pointConversionDay) {
    inlineKeyboard.push([{ text: '💳 포인트 전환하러 가기', url: POINT_CONVERSION_URL }]);
  }

  // 세미나 목록 바로가기 버튼 추가
  inlineKeyboard.push([{ text: '📋 세미나 목록 바로가기', url: SEMINAR_PAGE }]);

  // 공지봇 맞춤 알림 설정 바로가기 버튼 추가
  inlineKeyboard.push([{ text: '🔔 공지봇 맞춤 알림 설정', url: 'https://t.me/DV_notice_bot' }]);

  const options = {
    parse_mode: 'HTML' as const,
    link_preview_options: {
      is_disabled: true,
    },
    reply_markup: {
      inline_keyboard: inlineKeyboard,
    },
  };

  return { message, options };
}

async function run({ page, args }: Partial<PlaywrightRunArgs> = {}, taskOptions?: Record<string, unknown>) {
  try {
    const inputDate = (
      args?.date ||
      args?.targetDate ||
      (taskOptions?.targetDate as string) ||
      (taskOptions?.date as string)
    )?.trim();
    const { todayString, isoDate, yesterdayIso, isCustomDate } = getTodayDateStrings(inputDate);

    const quizInfo = await collectQuizInfo(page);
    const seminarMessage = await collectTodaySeminarMessage(page, inputDate);
    const pointConversionInfo = await collectPointConversionInfo(page);

    const storedNewSeminars = getYesterdayAddedSeminars(yesterdayIso);

    const { message, options } = formatTodayLinksBroadcast({
      quizInfo,
      seminarMessage,
      storedNewSeminars,
      pointConversionInfo,
      targetDate: isCustomDate ? `${isoDate} (${todayString})` : undefined,
      isCustomDate,
    });

    const newSeminarIds = storedNewSeminars.map((item) => item.seminarId).filter((id): id is string => Boolean(id));
    const allSeminarIds = seminarMessage
      ? Array.from(
          new Set([
            ...(seminarMessage.lunchSeminarIds || []),
            ...(seminarMessage.dinnerSeminarIds || []),
            ...newSeminarIds,
          ]),
        )
      : [...newSeminarIds];

    // 당일 세미나인 경우에만 storage 갱신 및 캐시 저장
    if (!isCustomDate) {
      storage.set(TODAY_SEMINAR_KEY, {
        date: seminarMessage.date,
        lunchSeminarIds: seminarMessage.lunchSeminarIds,
        dinnerSeminarIds: seminarMessage.dinnerSeminarIds,
      });
      setTodayLinksCache({
        date: seminarMessage.date,
        message,
        options,
        cachedAt: new Date().toISOString(),
      });
    }

    return {
      success: true,
      message,
      options,
      seminarData: {
        date: seminarMessage.date,
        lunchSeminarIds: seminarMessage.lunchSeminarIds,
        dinnerSeminarIds: seminarMessage.dinnerSeminarIds,
        allSeminarIds,
      } as SeminarTaskData,
    };
  } catch (_e) {
    console.error('today_links task error', _e && typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e);
    const message = _e instanceof Error ? _e.message : String(_e);
    return { success: false, message: `today_links 작업 오류: ${message}` };
  }
}

export {
  run,
  formatTodayLinksBroadcast,
  getTodayDateStrings,
  parseTargetDate,
  isDateMatching,
  collectTodaySeminarMessage,
  getYesterdayAddedSeminars,
  getTodayLinksCache,
  setTodayLinksCache,
  clearTodayLinksCache,
};
export type { SeminarData, SeminarTaskData, DateTarget, ParsedSeminarItem };
