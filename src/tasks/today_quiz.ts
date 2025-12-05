import quizMapping from '../../data/quiz.json';
import { safeGoto, sendTelegram } from '../modules/utils';
import type { PlaywrightRunArgs } from '../types';

const QUIZ_LIST_URLS = [
  'https://www.doctorville.co.kr/product/medicineList',
  'https://www.doctorville.co.kr/product/instrumentList',
];

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
            .catch(() => {});
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
        .catch(() => {});
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

    // Load mapping from data/quiz.json
    const mapping = quizMapping as Record<string, Array<string | number>>;
    const answers = mapping[productTitle];
    if (!answers || !Array.isArray(answers) || answers.length === 0) {
      return { success: true, message: `정답이 등록되지 않았습니다. 직접 퀴즈를 풀어주세요. ${href}` };
    }

    // Click the labels based on mapping
    for (let i = 0; i < answers.length; i++) {
      const val = answers[i];
      const selector = `label[for='answer${i + 1}-${val}']`;
      const cnt = await page.locator(selector).count();
      if (cnt) {
        await page
          .locator(selector)
          .first()
          .click()
          .catch(() => {});
        await page.waitForTimeout(200);
      } else {
        return {
          success: false,
          message: `정답 선택 요소를 찾을 수 없습니다: ${selector}  (제품: ${productTitle})\n${href}`,
        };
      }
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
    await sendTelegram(`❗ 오늘의 퀴즈 작업 오류: ${message}`).catch(() => {});
    return { success: false, message: `오늘의 퀴즈 작업 오류: ${message}` };
  }
}

export { run };
