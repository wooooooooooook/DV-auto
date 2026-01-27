import quizMapping from '../../data/quiz.json';
import { safeGoto, sendTelegram } from '../modules/utils';
import type { PlaywrightRunArgs } from '../types';
import { loadCheatsheet, findMatchingKeywords, findOptionByAnswer, type QuizQuestion } from './seminar_quiz';

const QUIZ_LIST_URLS = [
  'https://www.doctorville.co.kr/product/medicineList',
  'https://www.doctorville.co.kr/product/instrumentList',
];

async function parseTodayQuizQuestions(page: PlaywrightRunArgs['page']): Promise<QuizQuestion[]> {
  const questions: QuizQuestion[] = [];

  const areaSelector = '#questionArea .question_area';
  const areas = await page.locator(areaSelector).all();

  for (const area of areas) {
    const questionText = await area.locator('.txt_question').innerText().catch(() => '');
    const options: QuizQuestion['options'] = [];

    const choiceItems = await area.locator('.question_choice li').all();
    for (let i = 0; i < choiceItems.length; i++) {
      const item = choiceItems[i];
      const label = item.locator('label');
      const input = item.locator('input[type="radio"]');

      const text = await label.innerText().catch(() => '');
      const value = (await input.getAttribute('value')) || '';

      options.push({
        index: i + 1,
        text: text.trim(),
        value,
      });
    }

    if (questionText) {
      questions.push({
        questionText: questionText.trim(),
        options,
      });
    }
  }

  return questions;
}

async function findAnswersByCheatsheet(page: PlaywrightRunArgs['page']): Promise<Array<string | number> | null> {
  try {
    const cheatsheet = await loadCheatsheet();
    if (Object.keys(cheatsheet).length === 0) return null;

    const questions = await parseTodayQuizQuestions(page);
    if (questions.length === 0) return null;

    const result: Array<string | number> = [];
    for (const q of questions) {
      console.log(`[today_quiz] 매칭 시도 문제: ${q.questionText.substring(0, 30)}...`);
      const matches = findMatchingKeywords(q.questionText, cheatsheet);
      if (matches.length > 0) {
        const chosenKeyword = matches[0];
        const answerKeyword = cheatsheet[chosenKeyword];
        const option = findOptionByAnswer(q.options, answerKeyword);
        if (option) {
          console.log(`[today_quiz] 매칭 성공: ${chosenKeyword} -> ${answerKeyword} (보기 ${option.index}번)`);
          result.push(option.index);
          continue;
        }
      }
      console.warn(`[today_quiz] 문제에 대한 정답을 찾지 못했습니다: ${q.questionText.substring(0, 50)}...`);
      return null; // One failure fails the whole quiz to be safe
    }
    return result;
  } catch (e) {
    console.error('[today_quiz] 족보 매칭 중 오류', e);
    return null;
  }
}

async function findQuizHref(page: PlaywrightRunArgs['page']) {
  for (const url of QUIZ_LIST_URLS) {
    console.log(`[today_quiz] 퀴즈 목록 경로 확인: ${url}`);
    await safeGoto(page, url, { waitUntil: 'load', timeout: 30000 }, 2);

    const quizBg = page.locator('.product_list .quiz_bg').first();
    const quizBgCount = await quizBg.count();
    if (!quizBgCount) {
      console.log(`[today_quiz] 퀴즈 항목을 찾지 못했습니다. 다음 경로를 확인합니다: ${url}`);
      continue;
    }

    const href = await (async () => {
      const handle = await quizBg.elementHandle();
      if (!handle) return null;
      try {
        return await page.evaluate((el) => {
          let cur: Element | null = el;
          while (cur && cur.nodeType === 1) {
            const anchor = cur as HTMLAnchorElement;
            if (anchor.tagName === 'A' && anchor.href) return anchor.href;
            cur = cur.parentElement;
          }
          return null;
        }, handle);
      } catch (_e) {
        return null;
      }
    })();

    if (!href) {
      console.log(`[today_quiz] 퀴즈 링크를 찾지 못했습니다. 다음 경로를 확인합니다: ${url}`);
      continue;
    }

    return href;
  }

  return null;
}

async function run({ page }: PlaywrightRunArgs) {
  try {
    const href = await findQuizHref(page);

    if (!href) {
      return { success: true, message: '오늘의 퀴즈가 없습니다.' };
    }

    // Go to the quiz page
    await safeGoto(page, href, { waitUntil: 'load', timeout: 30000 }, 2);

    // Click the banner button to open the quiz popup
    const btn = page.locator('#btn_quiz_banner');
    if ((await btn.count()) > 0) {
      if (await btn.locator('.ico_finish').isVisible()) {
        const shot = 'screenshot/today_quiz_completed.png';
        try {
          await btn
            .first()
            .scrollIntoViewIfNeeded()
            .catch(() => { });
          await page.waitForTimeout(200);
          await page.screenshot({ path: shot });
        } catch (_e) {
          // ignore screenshot errors
        }
        return { success: true, message: '오늘의 퀴즈는 이미 완료되었습니다. ' + href, imagePath: shot };
      }
      await btn
        .first()
        .click()
        .catch(() => { });
    } else {
      // If there's no banner button, still check for popup
      console.debug('#btn_quiz_banner not found');
    }

    // Wait shortly for popup
    await page.waitForTimeout(800);

    const pop = page.locator('#quizLayerPop');
    const visible = await pop.isVisible().catch(() => false);
    if (!visible) {
      return { success: false, message: '퀴즈 팝업이 열리지 않았습니다. 직접 퀴즈를 풀어주세요. ' + href };
    }

    // Get product title
    const titleElem = page.locator('#product_title');
    const titleCount = await titleElem.count();
    const productTitle = titleCount ? (await titleElem.first().innerText()).trim() : '';

    if (!productTitle) {
      return { success: false, message: '제품 제목을 찾을 수 없습니다. 직접 퀴즈를 풀어주세요. ' + href };
    }

    // Load mapping from data/quiz.json, fallback to cheatsheet if missing
    const mapping = quizMapping as Record<string, Array<string | number>>;
    let answers = mapping[productTitle];

    if (!answers || !Array.isArray(answers) || answers.length === 0) {
      console.log(`[today_quiz] "${productTitle}"에 대한 정답이 quiz.json에 없습니다. 족보에서 찾기를 시도합니다.`);
      answers = await findAnswersByCheatsheet(page) || [];
    }

    if (!answers || answers.length === 0) {
      return { success: true, message: `정답이 등록되지 않았습니다. 직접 퀴즈를 풀어주세요. ${href}` };
    }

    // Select the answers based on mapping
    const quizArea = page.locator('#questionArea');

    for (let i = 0; i < answers.length; i++) {
      const val = answers[i];
      // Construct ID for the input element (e.g., answer1-3)
      const inputId = `answer${i + 1}-${val}`;
      const inputLocator = quizArea.locator(`#${inputId}`);

      // Try checking the input directly using Playwright's check()
      // force: true ensures it works even if the actual input is hidden by CSS (common in quizzes)
      if ((await inputLocator.count()) > 0) {
        await inputLocator.first().check({ force: true }).catch(async (e) => {
          console.warn(`[today_quiz] check() failed for ${inputId}, trying click on label.`, e);
          // Fallback: click the label if check fails (though check handles label clicks internally usually)
          await quizArea
            .locator(`label[for='${inputId}']`)
            .first()
            .click()
            .catch(() => { });
        });
      } else {
        // Fallback: if input ID not found, try label only
        const labelSelector = `label[for='${inputId}']`;
        if ((await quizArea.locator(labelSelector).count()) > 0) {
          await quizArea
            .locator(labelSelector)
            .first()
            .click()
            .catch(() => { });
        } else {
          return {
            success: false,
            message: `정답 선택 요소를 찾을 수 없습니다: #${inputId}  (제품: ${productTitle})\n${href}`,
          };
        }
      }
      await page.waitForTimeout(200);
    }

    // Submit using the confirmed submit button and take a screenshot if a popup appears
    // Primary submit: #answerConfirmBtn
    const confirmBtn = page.locator('#answerConfirmBtn');
    if ((await confirmBtn.count()) > 0) {
      try {
        await confirmBtn.first().click();

        // short wait for any resulting popup
        await page.waitForTimeout(500);

        const popupVisible = await page
          .locator('#modalType2')
          .isVisible()
          .catch(() => false);
        const shot = 'screenshot/today_quiz_result.png';
        try {
          await page.screenshot({ path: shot });
        } catch (_e) {
          // ignore screenshot errors
        }
        if (popupVisible) {
          return {
            success: true,
            message: `오늘의 퀴즈를 제출했습니다. (제품: ${productTitle}), ${href}`,
            imagePath: shot,
          };
        } else {
          return {
            success: true,
            message: `오늘의 퀴즈를 제출했습니다. (제품: ${productTitle}), ${href}`,
            imagePath: shot,
          };
        }
      } catch (_e) {
        // fallback to other selectors below
      }
    }
    const shot = 'screenshot/today_quiz_result.png';
    try {
      await page.screenshot({ path: shot });
    } catch (_e) {
      // ignore screenshot errors
    }
    // Fallback
    return { success: false, message: `퀴즈 제출을 실패했습니다. (제품: ${productTitle}), ${href}`, imagePath: shot };
  } catch (_e) {
    console.error('today_quiz task error', _e && typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e);
    const message = _e instanceof Error ? _e.message : String(_e);
    await sendTelegram(`❗ 오늘의 퀴즈 작업 오류: ${message}`).catch(() => { });
    return { success: false, message: `오늘의 퀴즈 작업 오류: ${message}` };
  }
}

export { run };
