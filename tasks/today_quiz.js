const { safeGoto, sendTelegram } = require('../modules/utils');
const path = require('path');

const QUIZ_LIST_URL = 'https://www.doctorville.co.kr/product/medicineList';

async function run({ page, context }) {
    try {
        await safeGoto(page, QUIZ_LIST_URL, { waitUntil: 'load', timeout: 30000 }, 2);

        // Find the first .quiz_bg element
        const quizBgCount = await page.locator('.quiz_bg').count();
        if (!quizBgCount) {
            return { success: true, message: '오늘의 퀴즈가 없습니다.' };
        }

        const quizBg = page.locator('.product_list .quiz_bg').first();

        // Get nearest anchor href by traversing up from the element
        const href = await (async () => {
            const handle = await quizBg.elementHandle();
            if (!handle) return null;
            try {
                return await page.evaluate(el => {
                    let cur = el;
                    while (cur && cur.nodeType === 1) {
                        if (cur.tagName === 'A' && cur.href) return cur.href;
                        cur = cur.parentElement;
                    }
                    return null;
                }, handle);
            } catch (e) {
                return null;
            }
        })();

        if (!href) {
            return { success: true, message: '오늘의 퀴즈가 없습니다.' };
        }

        // Go to the quiz page
        await safeGoto(page, href, { waitUntil: 'load', timeout: 30000 }, 2);

        // Click the banner button to open the quiz popup
        const btn = page.locator('#btn_quiz_banner');
        if ((await btn.count()) > 0) {
            if (await page.locator('#btn_quiz_banner .ico_finish').count() > 0) {
                return { success: true, message: '오늘의 퀴즈는 이미 완료되었습니다. ' + href };
            }
            await btn.first().click().catch(() => { });
        } else {
            // If there's no banner button, still check for popup
            console.debug('#btn_quiz_banner not found');
        }

        // Wait shortly for popup
        await page.waitForTimeout(800);

        const pop = page.locator('#quizLayerPop');
        const visible = await pop.isVisible().catch(() => false);
        if (!visible) {
            return { success: false, message: '퀴즈 팝업이 열리지 않았습니다. 수동 확인이 필요합니다. ' + href };
        }

        // Get product title
        const titleElem = page.locator('#product_title');
        const titleCount = await titleElem.count();
        const productTitle = titleCount ? (await titleElem.first().innerText()).trim() : '';

        if (!productTitle) {
            return { success: false, message: '제품 제목을 찾을 수 없습니다. 수동 확인: ' + href };
        }

        // Load mapping from data/quiz.json
        let mapping = {};
        try {
            mapping = require(path.join(__dirname, '..', 'data', 'quiz.json'));
        } catch (e) {
            mapping = {};
        }

        const answers = mapping[productTitle];
        if (!answers || !Array.isArray(answers) || answers.length === 0) {
            return { success: true, message: `정답이 등록되지 않았습니다. 직접 풀어주세요. ${href}` };
        }

        // Click the labels based on mapping
        for (let i = 0; i < answers.length; i++) {
            const val = answers[i];
            const selector = `label[for='answer${i + 1}-${val}']`;
            const cnt = await page.locator(selector).count();
            if (cnt) {
                await page.locator(selector).first().click().catch(() => { });
                await page.waitForTimeout(200);
            } else {
                return { success: false, message: `정답 선택 요소를 찾을 수 없습니다: ${selector}  (제품: ${productTitle})\n${href}` };
            }
        }

        // Submit using the confirmed submit button and take a screenshot if a popup appears
        let submitted = false;

        // Primary submit: #answerConfirmBtn
        const confirmBtn = page.locator('#answerConfirmBtn');
        if ((await confirmBtn.count()) > 0) {
            try {
                await confirmBtn.first().click();
                submitted = true;

                // short wait for any resulting popup
                await page.waitForTimeout(500);

                const popupVisible = await page.locator('#modalType2').isVisible().catch(() => false);
                if (popupVisible) {
                    const shot = 'screenshot/today_quiz_result.png';
                    try {
                        await page.screenshot({ path: shot, fullPage: true });
                    } catch (e) {
                        // ignore screenshot errors
                    }
                    return { success: true, message: `오늘의 퀴즈 제출 후 팝업이 표시되었습니다. (제품: ${productTitle}), ${href}`, imagePath: shot };
                } else {
                    return { success: true, message: `오늘의 퀴즈를 제출했습니다. (제품: ${productTitle}), ${href}` };
                }
            } catch (e) {
                // fallback to other selectors below
                submitted = false;
            }
        }

        // Fallback
        return { success: false, message: `퀴즈 제출을 실패했습니다. (제품: ${productTitle}), ${href}` };
    } catch (e) {
        console.error('today_quiz task error', e && e.stack ? e.stack : e);
        await sendTelegram(`❗ 오늘의 퀴즈 작업 오류: ${e && e.message ? e.message : String(e)}`).catch(() => { });
        return { success: false, message: `오늘의 퀴즈 작업 오류: ${e && e.message ? e.message : String(e)}` };
    }
}

module.exports = { run };
