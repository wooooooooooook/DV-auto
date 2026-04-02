import type { Page, BrowserContext } from 'playwright';
import { safeGoto, saveCookies, saveLocalStorage, sendTelegram } from '../modules/utils';

const LOGIN_URL = 'https://mims-account.mcircle.co.kr/login?cb=https://www.doctorville.co.kr/mims/directLogin';
const TARGET_PAGE = 'https://www.doctorville.co.kr/main';
const CHECK_INFO_URL = 'https://m.doctorville.co.kr/mypage/info';

async function run({ page, context }: { page: Page; context: BrowserContext }) {
  const { DV_USER, DV_PASS } = process.env;

  try {
    // 1. 이미 로그인 상태인지 확인
    await safeGoto(page, CHECK_INFO_URL, { waitUntil: 'load', timeout: 30000 }, 2);
    // 리디렉션을 기다리기 위해 잠시 대기
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const currentUrl = page.url();
    const needsLogin = currentUrl.includes('/member/login');

    if (!needsLogin) {
      // 이미 로그인되어 있음
      await safeGoto(page, TARGET_PAGE, { waitUntil: 'load', timeout: 30000 }, 2);
      await page.screenshot({ path: 'screenshot/login_success.png' }).catch(() => {});
      await saveCookies(context);
      await saveLocalStorage(page).catch(() => {});
      return { success: true, message: '로그인 성공했습니다. (이미 로그인 됨)' };
    }

    // 2. 로그인이 필요한 경우
    await safeGoto(page, LOGIN_URL, { waitUntil: 'load', timeout: 30000 }, 2);
    await page.screenshot({ path: 'screenshot/login_try.png' }).catch(() => {});

    if (DV_USER && DV_PASS) {
      await page.fill('input#identifier', DV_USER).catch(() => {});
      await page.fill('input#password', DV_PASS).catch(() => {});
    }

    const loginPageUrl = page.url();
    await Promise.all([
      page.waitForURL((url) => url.toString() !== loginPageUrl, { waitUntil: 'load', timeout: 15000 }).catch(() => {}),
      page.click('button:text("로그인")').catch(() => {}),
    ]);

    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(300);

    // 3. 로그인 성공 여부 확인
    await safeGoto(page, CHECK_INFO_URL, { waitUntil: 'load', timeout: 30000 }, 2);
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

    const checkUrlAfterLogin = page.url();
    const loginSuccess = !checkUrlAfterLogin.includes('/member/login');

    if (!loginSuccess) {
      const shot = 'screenshot/login_failed.png';
      await page.screenshot({ path: shot }).catch(() => {});
      await sendTelegram(`🔴 로그인 실패 (스크린샷: ${shot})`, shot).catch((err) =>
        console.error('Failed to send Telegram message:', err),
      );
      return { success: false, message: `로그인 실패 (스크린샷: ${shot})`, imagePath: shot };
    }

    await safeGoto(page, TARGET_PAGE, { waitUntil: 'load', timeout: 30000 }, 2);
    await page.screenshot({ path: 'screenshot/login_success.png' }).catch(() => {});
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
