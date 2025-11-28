const { safeGoto, sendTelegram } = require('../modules/utils');

async function run({ page, context, env }) {
    // Placeholder: implement attendance check logic here
    try {
        // Example: go to main page and try to click attendance button
        const ATTENDANCE_PAGE = env.ATTENDANCE_PAGE || "https://www.doctorville.co.kr/event/attend";
        await safeGoto(page, ATTENDANCE_PAGE, { waitUntil: 'load', timeout: 30000 }, 1);
        const checkedCount = await page.locator('.tit_box button.complete', { hasText: '출석완료' }).count();
        if (checkedCount > 0) {
            const loc = page.locator('.tit_box button.complete', { hasText: '출석완료' }).first();
            if (await loc.isVisible()) {
                await sendTelegram('✅ 이미 출석체크되어있습니다.').catch(() => { });
                return true;
            }
        }
        const loc = await page.locator('.tit_box button.point_down', { hasText: '출석하기' }).first();
        if (await loc.isVisible()) {
            loc.click();
            await sendTelegram('✅ 출석체크 완료!').catch(() => { });
            return true;
        }
        await page.screenshot({ path: 'screenshot/dbg_tit_box.png', fullPage: true });
        const html = await page.locator('.tit_box').first().innerHTML();
        console.log('tit_box innerHTML:', html);
        await sendTelegram('❗ 출석체-크 버튼을 찾지 못함!').catch(() => { });
        return true;
    } catch (e) {
        console.error('attendance task error', e && e.stack ? e.stack : e);
        await sendTelegram(`❗ 출석체크 작업 오류: ${e && e.message ? e.message : String(e)}`).catch(() => { });
        return false;
    }
}

module.exports = { run };
