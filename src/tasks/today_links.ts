import quizMapping from '../../data/quiz.json';
import type { PlaywrightRunArgs } from '../types';
import { safeGoto, getSeminarIdFromUrl } from '../modules/utils';
import * as storage from '../services/storage';

const QUIZ_LIST_URLS = [
  'https://www.doctorville.co.kr/product/medicineList',
  'https://www.doctorville.co.kr/product/instrumentList',
];
const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const BASE_URL = 'https://www.doctorville.co.kr/';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';

type QuizInfo = { link: string; productTitle?: string; answers?: Array<string | number> };
type SeminarData = {
  date: string;
  lunchSeminarIds: string[];
  dinnerSeminarIds: string[];
};
type SeminarTaskData = SeminarData & { allSeminarIds: string[] };
type SeminarMessageResult = SeminarData & { message: string };
const TODAY_SEMINAR_KEY = 'today_seminars';

function getTodayDateStrings() {
  const opts = { timeZone: 'Asia/Seoul' as const };
  const now = new Date();
  const month = now.toLocaleDateString('en-US', { month: 'numeric', ...opts });
  const day = now.toLocaleDateString('en-US', { day: 'numeric', ...opts });
  const iso = now.toLocaleDateString('en-CA', opts);
  return { todayString: `${month}/${day}`, isoDate: iso };
}

async function findQuizHref(page: PlaywrightRunArgs['page']): Promise<string | null> {
  for (const url of QUIZ_LIST_URLS) {
    console.log(`[today_links] 퀴즈 목록 확인: ${url}`);
    await safeGoto(page, url, { waitUntil: 'load', timeout: 30000 }, 1);

    const quizBg = page.locator('.product_list .quiz_bg').first();
    const quizBgCount = await quizBg.count();
    if (!quizBgCount) {
      console.log(`[today_links] 퀴즈 항목을 찾지 못했습니다. 다음 경로를 확인합니다: ${url}`);
      continue;
    }

    const handle = await quizBg.elementHandle();
    if (!handle) continue;

    const href = await page
      .evaluate((el) => {
        let cur: Element | null = el;
        while (cur && cur.nodeType === 1) {
          const anchor = cur as HTMLAnchorElement;
          if (anchor.tagName === 'A' && anchor.href) return anchor.href;
          cur = cur.parentElement;
        }
        return null;
      }, handle)
      .catch(() => null);

    if (!href) {
      console.log(`[today_links] 퀴즈 링크를 찾지 못했습니다. 다음 경로를 확인합니다: ${url}`);
      continue;
    }

    return href;
  }

  return null;
}

async function collectQuizInfo(page: PlaywrightRunArgs['page']): Promise<QuizInfo | null> {
  try {
    const href = await findQuizHref(page);

    if (!href) return null;

    await safeGoto(page, href, { waitUntil: 'load', timeout: 30000 }, 1);

    const titleElem = page.locator('#product_title');
    const productTitle =
      (await titleElem.count()) > 0
        ? (
            await titleElem
              .first()
              .innerText()
              .catch(() => '')
          ).trim()
        : '';
    const mapping = quizMapping as Record<string, Array<string | number>>;
    const answers = productTitle && mapping[productTitle];

    return {
      link: href,
      productTitle: productTitle || undefined,
      answers: Array.isArray(answers) && answers.length > 0 ? answers : undefined,
    };
  } catch (_e) {
    console.error('collectQuizInfo error', _e && typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e);
    return null;
  }
}

async function collectTodaySeminarMessage(page: PlaywrightRunArgs['page']): Promise<SeminarMessageResult> {
  const { todayString, isoDate } = getTodayDateStrings();
  const lunchSeminarIds: string[] = [];
  const dinnerSeminarIds: string[] = [];

  try {
    await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

    const listConts = await page.locator('.list_cont');
    const count = await listConts.count();

    const lunchSeminars: string[] = [];
    const dinnerSeminars: string[] = [];

    for (let i = 0; i < count; i++) {
      const container = listConts.nth(i);
      const seminarDay = await container
        .locator('.seminar_day .date')
        .innerText()
        .catch(() => '');
      if (seminarDay !== todayString) continue;

      const seminarDetails = await container.locator('.list_detail');
      const dcount = await seminarDetails.count();

      for (let j = 0; j < dcount; j++) {
        const detail = seminarDetails.nth(j);
        const timeElem = detail.locator('.txt_num.time').first();
        const timeRaw = await timeElem.innerText();
        const time = timeRaw.replace(/\n/g, '').trim();
        const title = await detail.locator('.list_tit .tit').innerText();
        const classAttr = (await timeElem.getAttribute('class')) || '';
        const href = await detail.getAttribute('href');
        if (!href) continue;
        const fullUrl = new URL(href, BASE_URL).toString();
        const seminarId = getSeminarIdFromUrl(fullUrl);
        const seminarLink = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : fullUrl;
        const seminarInfo = ` ${time}. ${title} ${seminarLink}`;

        // If the time element has the `night_time` class treat as dinner, otherwise lunch
        if (classAttr.includes('night_time')) {
          dinnerSeminars.push(seminarInfo);
          if (seminarId) dinnerSeminarIds.push(seminarId);
        } else {
          lunchSeminars.push(seminarInfo);
          if (seminarId) lunchSeminarIds.push(seminarId);
        }
      }
    }

    if (lunchSeminars.length > 0 || dinnerSeminars.length > 0) {
      let message = `오늘의 세미나 리스트:\n`;

      if (lunchSeminars.length > 0) {
        message += `\n🍴[점심 세미나]\n`;
        message += lunchSeminars.join('\n');
      }
      if (dinnerSeminars.length > 0) {
        message += `\n🍴[저녁 세미나]\n`;
        message += dinnerSeminars.join('\n');
      }
      return {
        message,
        date: isoDate,
        lunchSeminarIds: [...new Set(lunchSeminarIds)],
        dinnerSeminarIds: [...new Set(dinnerSeminarIds)],
      };
    }
    return {
      message: '오늘의 세미나 리스트: 오늘은 세미나가 없습니다.',
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
      message: `오늘의 세미나 확인 실패: ${message}`,
      date: isoDate,
      lunchSeminarIds: [],
      dinnerSeminarIds: [],
    };
  }
}

async function run({ page }: PlaywrightRunArgs) {
  try {
    const quizInfo = await collectQuizInfo(page);
    const seminarMessage = await collectTodaySeminarMessage(page);

    const options: Record<string, unknown> = {};

    let message = '✨ 출석체크: https://m.doctorville.co.kr/mypage/attendance\n';

    let quizMessage = '오늘은 퀴즈가 없습니다.';
    if (quizInfo?.link) {
      if (quizInfo.productTitle) {
        const answersText = quizInfo.answers?.map(String).join('');
        const answerNote = answersText ? `, 정답: ${answersText}` : ' (저장된 정답이 없습니다. 댓글로 알려주세요.)';
        quizMessage = `${quizInfo.productTitle}${answerNote}`;
      }
      quizMessage += `\n${quizInfo.link}`;
    }
    message += `✏️ 오늘의 퀴즈:${quizMessage}\n`;

    if (seminarMessage?.message) {
      message += `\n📖${seminarMessage.message}`;
    }

    message += '\n\n🤖텔레그램 봇이 자동으로 전송한 메시지입니다.\nhttps://t.me/+J1UGmvLA9jU4NjQ1';

    const allSeminarIds = seminarMessage
      ? Array.from(new Set([...(seminarMessage.lunchSeminarIds || []), ...(seminarMessage.dinnerSeminarIds || [])]))
      : [];

    storage.set(TODAY_SEMINAR_KEY, {
      date: seminarMessage.date,
      lunchSeminarIds: seminarMessage.lunchSeminarIds,
      dinnerSeminarIds: seminarMessage.dinnerSeminarIds,
    });

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

export { run };
export type { SeminarData, SeminarTaskData };
