import type { Page, BrowserContext } from 'playwright';
import { safeGoto, saveCookies, saveLocalStorage, sendTelegram } from '../modules/utils';

const LOGIN_URL = 'https://mims-account.mcircle.co.kr/login?cb=https://www.doctorville.co.kr/mims/directLogin';
const TARGET_PAGE = 'https://www.doctorville.co.kr/main';

async function run({ page, context }: { page: Page; context: BrowserContext }) {
  const { DV_USER, DV_PASS } = process.env;

  // Navigate to login
  await safeGoto(page, LOGIN_URL, { waitUntil: 'load', timeout: 30000 }, 2);
  try {
    await page.screenshot({ path: 'screenshot/login_try.png' });
    const alreadyLoggedIn = await page.locator('text=로그아웃').count();
    if (!alreadyLoggedIn) {
      await page.fill('input#identifier', DV_USER).catch(() => {});
      await page.fill('input#password', DV_PASS).catch(() => {});
      const currentUrl = page.url();
      await Promise.all([
        page.waitForURL((url) => url.toString() !== currentUrl, { waitUntil: 'load', timeout: 15000 }).catch(() => {}),
        page.click('button:text("로그인")').catch(() => {}),
      ]);
    } else {
      await safeGoto(page, TARGET_PAGE, { waitUntil: 'load', timeout: 30000 }, 2);
      await page.screenshot({ path: 'screenshot/login_success.png' });
      await saveCookies(context);
      await saveLocalStorage(page).catch(() => {});
      return { success: true, message: '로그인 성공했습니다. (이미 로그인 됨)' };
    }

    const loginSuccess = (await page.locator('text=로그아웃').count()) || (await page.url()).includes('dashboard');
    if (!loginSuccess) {
      const shot = 'screenshot/login_failed.png';
      await page.screenshot({ path: shot }).catch(() => {});
      await sendTelegram(`🔴 로그인 실패 (스크린샷: ${shot})`).catch((err) =>
        console.error('Failed to send Telegram message:', err),
      );
      return { success: false, message: `로그인 실패 (스크린샷: ${shot})`, imagePath: shot };
    }
    await safeGoto(page, TARGET_PAGE, { waitUntil: 'load', timeout: 30000 }, 2);
    await page.screenshot({ path: 'screenshot/login_success.png' });
    await saveCookies(context);
    await saveLocalStorage(page).catch(() => {});
    return { success: true, message: '로그인 성공했습니다.' };
  } catch (error) {
    console.error(
      'login task error',
      error && typeof error === 'object' && 'stack' in error ? (error as Error).stack : error,
    );
    const message = error instanceof Error ? error.message : String(error);
    await sendTelegram(`❗ 로그인 작업 중 오류: ${message}`).catch((err) =>
      console.error('Failed to send Telegram message:', err),
    );
    return { success: false, message: `로그인 작업 중 오류: ${message}` };
  }
}

export { run };
