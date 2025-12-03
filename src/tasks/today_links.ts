import quizMapping from '../../data/quiz.json';
import type { PlaywrightRunArgs } from '../types';
import { safeGoto, getSeminarIdFromUrl } from '../modules/utils';

const QUIZ_LIST_URL = 'https://www.doctorville.co.kr/product/medicineList';
const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const BASE_URL = 'https://www.doctorville.co.kr/';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';

type QuizInfo = { link: string; productTitle?: string; answers?: Array<string | number> };

async function collectQuizInfo(page: PlaywrightRunArgs['page']): Promise<QuizInfo | null> {
  try {
    await safeGoto(page, QUIZ_LIST_URL, { waitUntil: 'load', timeout: 30000 }, 1);
    const quizBgCount = await page.locator('.quiz_bg').count();
    if (!quizBgCount) return null;

    const quizBg = page.locator('.product_list .quiz_bg').first();
    const handle = await quizBg.elementHandle();
    if (!handle) return null;
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

    if (!href) return null;

    await safeGoto(page, href, { waitUntil: 'load', timeout: 30000 }, 1);

    const titleElem = page.locator('#product_title');
    const productTitle =
      (await titleElem.count()) > 0 ? (await titleElem.first().innerText().catch(() => '')).trim() : '';
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

async function collectTodaySeminarMessage(page: PlaywrightRunArgs['page']): Promise<string> {
  try {
    await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

    const listConts = await page.locator('.list_cont');
    const count = await listConts.count();

    const now = new Date();
    const month = now.toLocaleDateString('en-US', { month: 'numeric', timeZone: 'Asia/Seoul' });
    const day = now.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'Asia/Seoul' });
    const todayString = `${month}/${day}`;

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
        } else {
          lunchSeminars.push(seminarInfo);
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
      return message;
    }
    return '오늘의 세미나 리스트: 오늘은 세미나가 없습니다.';
  } catch (_e) {
    const message = _e instanceof Error ? _e.message : String(_e);
    console.error(
      'collectTodaySeminarMessage error',
      _e && typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e,
    );
    return `오늘의 세미나 확인 실패: ${message}`;
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
      quizMessage = quizInfo.link;
      if (quizInfo.productTitle) {
        const answersText = quizInfo.answers?.map(String).join('');
        const answerNote = answersText ? `, 정답 정보: ${answersText}` : ' (저장된 정답이 없습니다. 댓글로 알려주세요.)';
        quizMessage += `\n${quizInfo.productTitle}${answerNote}`;
      }
    }
    message += `✨ 오늘의 퀴즈 링크:${quizMessage}\n`;

    if (seminarMessage) {
      message += `\n${seminarMessage}`;
    }

    return { success: true, message, options };
  } catch (_e) {
    console.error('today_links task error', _e && typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e);
    const message = _e instanceof Error ? _e.message : String(_e);
    return { success: false, message: `today_links 작업 오류: ${message}` };
  }
}

export { run };
