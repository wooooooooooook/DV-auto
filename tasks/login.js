const { safeGoto, saveCookies, loadCookies, saveLocalStorage, loadLocalStorage, sendTelegramHttps } = require('../modules/utils');

async function run({ page, context, env }) {
    const { LOGIN_URL, TARGET_PAGE, DV_USER, DV_PASS } = env;

    // Navigate to login
    await safeGoto(page, LOGIN_URL, { waitUntil: 'load', timeout: 30000 }, 2);
    try {
        await page.screenshot({ path: 'screenshot/login_try.png', fullPage: true });
        const alreadyLoggedIn = await page.locator('text=로그아웃').count();
        if (!alreadyLoggedIn) {
            await page.fill('input#identifier', DV_USER).catch(() => { });
            await page.fill('input#password', DV_PASS).catch(() => { });
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'load', timeout: 15000 }).catch(() => { }),
                page.click('button:text("로그인")').catch(() => { })
            ]);
        } else {
            await sendTelegramHttps('✅ 로그인 성공했습니다. (이미 로그인 됨)').catch(err => console.error('Failed to send Telegram message:', err));
            await safeGoto(page, TARGET_PAGE, { waitUntil: 'load', timeout: 30000 }, 2);
            await page.screenshot({ path: 'screenshot/login_success.png', fullPage: true });
            await saveCookies(context);
            await saveLocalStorage(page).catch(() => { });
            return true;
        }

        const loginSuccess = (await page.locator('text=로그아웃').count()) || (await page.url()).includes('dashboard');
        if (!loginSuccess) {
            const shot = 'screenshot/login_failed.png';
            await page.screenshot({ path: shot, fullPage: true }).catch(() => { });
            await sendTelegramHttps(`🔴 로그인 실패 (스크린샷: ${shot})`).catch(err => console.error('Failed to send Telegram message:', err));
            return false;
        }
        await safeGoto(page, TARGET_PAGE, { waitUntil: 'load', timeout: 30000 }, 2);
        await page.screenshot({ path: 'screenshot/login_success.png', fullPage: true });
        await saveCookies(context);
        await saveLocalStorage(page).catch(() => { });
        await sendTelegramHttps('✅ 로그인 성공했습니다.').catch(err => console.error('Failed to send Telegram message:', err));
        return true;
    } catch (e) {
        console.error('login task error', e && e.stack ? e.stack : e);
        await sendTelegramHttps(`❗ 로그인 작업 중 오류: ${e && e.message ? e.message : String(e)}`).catch(err => console.error('Failed to send Telegram message:', err));
        return false;
    }
}

module.exports = { run };
