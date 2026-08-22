import type { Page, BrowserContext } from 'playwright';
import { checkLoginStatus, safeGoto, saveCookies, saveLocalStorage, sendTelegram } from '../modules/utils';

const LOGIN_URL = 'https://mims-account.mcircle.co.kr/login?cb=https://www.doctorville.co.kr/mims/directLogin';
const TARGET_PAGE = 'https://www.doctorville.co.kr/main';

async function run({ page, context }: { page: Page; context: BrowserContext }) {
  const { DV_USER, DV_PASS } = process.env;

  try {
    // 1. 실제 로그인 페이지 이동
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

    // 2. 단일 checkLoginStatus()를 통한 로그인 성공 여부 검증
    const status = await checkLoginStatus(page);

    if (status !== 'LOGGED_IN') {
      const shot = 'screenshot/login_failed.png';
      await page.screenshot({ path: shot }).catch(() => {});
      await sendTelegram(`🔴 로그인 실패 (스크린샷: ${shot})`, shot).catch((err) =>
        console.error('Failed to send Telegram message:', err),
      );
      return { success: false, message: `로그인 실패 (스크린샷: ${shot})`, imagePath: shot };
    }

    // main 이동 실패는 로그인 판단과 무관
    try {
      await safeGoto(page, TARGET_PAGE, { waitUntil: 'load', timeout: 30000 }, 2);
      await page.screenshot({ path: 'screenshot/login_success.png' }).catch(() => {});
    } catch (navErr) {
      console.warn('main 페이지 이동 실패 (로그인 성공 상태 유지):', (navErr as Error).message);
    }

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
