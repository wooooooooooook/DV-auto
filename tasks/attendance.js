const { safeGoto, sendTelegram } = require('../modules/utils');
const path = require('path');
const fs = require('fs').promises; // Use promises version for unlink

async function run({ page, context }) {
    let screenshotPath = null;
    try {
        const ATTENDANCE_PAGE = "https://www.doctorville.co.kr/event/attend";
        await safeGoto(page, ATTENDANCE_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);

        const baseScreenshotDir = path.join(__dirname, '..', 'screenshot');
        await fs.mkdir(baseScreenshotDir, { recursive: true });
        screenshotPath = path.join(baseScreenshotDir, `attendance_result.png`);

        const checkedCount = await page.locator('.tit_box button.complete', { hasText: '출석완료' }).count();
        if (checkedCount > 0) {
            const loc = page.locator('.tit_box button.complete', { hasText: '출석완료' }).first();
            if (await loc.isVisible()) {
                await page.screenshot({ path: screenshotPath, fullPage: true });
                return { success: true, message: '이미 출석체크되어있습니다.', imagePath: screenshotPath };
            }
        }
        const loc = await page.locator('.tit_box button.point_down', { hasText: '출석하기' }).first();
        if (await loc.isVisible()) {
            await loc.click();
            await page.screenshot({ path: screenshotPath, fullPage: true });
            return { success: true, message: '출석체크 완료!', imagePath: screenshotPath };
        }

        // If neither '출석완료' nor '출석하기' is found
        await page.screenshot({ path: screenshotPath, fullPage: true }); // Capture state when buttons are not found
        const html = await page.locator('.tit_box').first().innerHTML();
        console.log('tit_box innerHTML:', html);
        return { success: false, message: '출석체크 버튼을 찾지 못함!', imagePath: screenshotPath };
    } catch (e) {
        console.error('attendance task error', e && e.stack ? e.stack : e);
        // On error, still try to capture a screenshot if it's not already set
        if (!screenshotPath) {
            const baseScreenshotDir = path.join(__dirname, '..', 'screenshot');
            await fs.mkdir(baseScreenshotDir, { recursive: true });
            screenshotPath = path.join(baseScreenshotDir, `attendance_error.png`);
            await page.screenshot({ path: screenshotPath, fullPage: true }).catch(err => console.error('Failed to capture error screenshot:', err));
        }
        await sendTelegram(`❗ 출석체크 작업 오류: ${e && e.message ? e.message : String(e)}`, screenshotPath).catch(() => { });
        return { success: false, message: `출석체크 작업 오류: ${e && e.message ? e.message : String(e)}`, imagePath: screenshotPath };
    }
}

module.exports = { run };
