import fs from 'fs';
import path from 'path';
import type { Telegraf } from 'telegraf';
import type { BrowserContext, Page } from 'playwright';
import { getBot } from '../services/bot_instance';
import { httpGet, httpGetJson } from './http_client';
import { parseLoginStatusHtml, hasSurveyPointExcludedNoticeHtml } from './html_parser';

const COOKIE_FILE = path.join(process.cwd(), 'cookies.json');
const LOCALSTORAGE_FILE = path.join(process.cwd(), 'localstorage.json');
type SendMessageOptions = Parameters<Telegraf['telegram']['sendMessage']>[2];
type SendPhotoOptions = Parameters<Telegraf['telegram']['sendPhoto']>[2];

function escapeMarkdownV2(text: string): string {
  if (!text) return '';
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function maskToken(token?: string | null): string {
  if (!token) return '';
  return token.length > 10 ? `${token.slice(0, 6)}...${token.slice(-4)}` : token;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTelegram(
  text: string,
  imagePath: string | null = null,
  options: SendMessageOptions | SendPhotoOptions = {},
): Promise<boolean> {
  const bot = getBot('admin');
  if (!bot) {
    console.error('Admin bot is not initialized. Cannot send message. Check TELEGRAM_BOT_TOKEN.');
    return false;
  }

  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!CHAT_ID) {
    console.error('TELEGRAM_CHAT_ID is not set.');
    return false;
  }

  try {
    if (imagePath) {
      const photoOptions: SendPhotoOptions = { caption: text, ...(options as SendPhotoOptions) };
      await bot.telegram.sendPhoto(CHAT_ID, { source: imagePath }, photoOptions);
    } else {
      await bot.telegram.sendMessage(CHAT_ID, text, options as SendMessageOptions);
    }
    return true;
  } catch (error) {
    console.error('Failed to send Telegram message:', error);
    try {
      const message = error instanceof Error ? error.message : String(error);
      await bot.telegram.sendMessage(CHAT_ID, `Failed to send a complex Telegram message. Error: ${message}`);
    } catch (nestedError) {
      console.error('Failed to send the failure notification as well:', nestedError);
    }
    return false;
  }
}

async function sendNotificationToChannel(
  text: string,
  imagePath: string | null = null,
  options: SendMessageOptions | SendPhotoOptions = {},
): Promise<number | null> {
  const bot = getBot('notice');
  if (!bot) {
    console.error('Notice bot is not initialized. Cannot send message.');
    return null;
  }

  const CHANNEL_ID = process.env.NOTICE_CHANNEL_ID;
  if (!CHANNEL_ID) {
    console.error('NOTICE_CHANNEL_ID is not set.');
    return null;
  }

  const baseOptions: SendMessageOptions | SendPhotoOptions = { ...(options as SendMessageOptions | SendPhotoOptions) };
  const isMarkdownV2 = baseOptions.parse_mode === 'MarkdownV2';
  const messageOptions = isMarkdownV2
    ? ({ ...baseOptions, parse_mode: 'MarkdownV2' } as SendMessageOptions | SendPhotoOptions)
    : baseOptions;

  try {
    if (imagePath) {
      const photoOptions: SendPhotoOptions = { ...messageOptions, caption: text } as SendPhotoOptions;
      const result = await bot.telegram.sendPhoto(CHANNEL_ID, { source: imagePath }, photoOptions);
      return result.message_id;
    } else {
      const result = await bot.telegram.sendMessage(CHANNEL_ID, text, messageOptions as SendMessageOptions);
      return result.message_id;
    }
  } catch (error) {
    console.error('Failed to send Telegram notification to channel:', error);

    try {
      const plainOptions: SendMessageOptions | SendPhotoOptions = { ...baseOptions };
      delete (plainOptions as Partial<SendMessageOptions | SendPhotoOptions>).parse_mode;

      if (imagePath) {
        const fallbackPhotoOptions: SendPhotoOptions = { ...plainOptions, caption: text } as SendPhotoOptions;
        const result = await bot.telegram.sendPhoto(CHANNEL_ID, { source: imagePath }, fallbackPhotoOptions);
        return result.message_id;
      } else {
        const result = await bot.telegram.sendMessage(CHANNEL_ID, text, plainOptions as SendMessageOptions);
        return result.message_id;
      }
    } catch (fallbackError) {
      console.error('Failed to send escaped Telegram notification to channel:', fallbackError);
    }

    try {
      const message = error instanceof Error ? error.message : String(error);
      await bot.telegram.sendMessage(CHANNEL_ID, `Failed to send a complex message. Error: ${message}`);
    } catch (nestedError) {
      console.error('Failed to send the failure notification as well:', nestedError);
    }
  }
  return null;
}

async function saveCookies(context: BrowserContext): Promise<void> {
  try {
    const cookies = await context.cookies();
    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2));
  } catch (_e) {
    console.warn('쿠키 저장 실패:', _e && (typeof _e === 'object' && 'message' in _e ? (_e as Error).message : _e));
  }
}

async function saveLocalStorage(page: Page): Promise<void> {
  try {
    const url = page.url();
    if (!url || url === 'about:blank') return;
    const origin = new URL(url).origin;
    const data = await page.evaluate(() => {
      const out: Record<string, string | null> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) out[key] = localStorage.getItem(key);
      }
      return out;
    });

    let all: Record<string, unknown> = {};
    if (fs.existsSync(LOCALSTORAGE_FILE)) {
      try {
        all = JSON.parse(fs.readFileSync(LOCALSTORAGE_FILE, 'utf8'));
      } catch (_e) {
        all = {};
      }
    }
    all[origin] = data;
    fs.writeFileSync(LOCALSTORAGE_FILE, JSON.stringify(all, null, 2));
  } catch (_e) {
    console.warn(
      'localStorage 저장 실패:',
      _e && (typeof _e === 'object' && 'message' in _e ? (_e as Error).message : _e),
    );
  }
}

async function loadCookies(context: BrowserContext): Promise<boolean> {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
      await context.addCookies(cookies);
      return true;
    }
  } catch (_e) {
    console.warn('쿠키 로드 실패:', _e && (typeof _e === 'object' && 'message' in _e ? (_e as Error).message : _e));
  }
  return false;
}

async function loadLocalStorage(page: Page, targetUrl: string): Promise<boolean> {
  try {
    if (!fs.existsSync(LOCALSTORAGE_FILE)) return false;
    const all = JSON.parse(fs.readFileSync(LOCALSTORAGE_FILE, 'utf8'));
    const origin = new URL(targetUrl).origin;
    const data = all[origin];
    if (!data) return false;

    try {
      const cur = page.url();
      if (!cur || !cur.startsWith(origin)) {
        await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
      }
    } catch (_e) {
      // ignore navigation errors, we'll still try to set items
    }

    await page.evaluate((store) => {
      try {
        Object.entries(store as Record<string, string | null>).forEach(([k, v]) =>
          localStorage.setItem(k, v as string),
        );
      } catch (_e) {
        /* ignore */
      }
    }, data);
    return true;
  } catch (_e) {
    console.warn(
      'localStorage 로드 실패:',
      _e && (typeof _e === 'object' && 'message' in _e ? (_e as Error).message : _e),
    );
  }
  return false;
}

async function safeGoto(page: Page, url: string, options: Parameters<Page['goto']>[1] = {}, retries = 2) {
  // dev-analytics 스크립트가 느려 load 이벤트가 지연되는 문제를 막기 위해 차단
  setupAnalyticsBlock(page);

  let attempt = 0;
  const originalUrl = url;

  function isAbsolute(u: string): boolean {
    return /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(u) || u.startsWith('about:') || u.startsWith('data:');
  }

  let resolvedUrl = url;
  try {
    if (typeof url === 'string' && !isAbsolute(url)) {
      const current = page && typeof page.url === 'function' ? page.url() : null;
      if (current && current !== 'about:blank') {
        resolvedUrl = new URL(url, current).toString();
      } else if (process.env.BASE_URL) {
        resolvedUrl = new URL(url, process.env.BASE_URL).toString();
      } else {
        console.warn('safeGoto: relative URL provided but no current page URL and BASE_URL not set:', url);
      }
    }
  } catch (_e) {
    console.error(
      'safeGoto: URL resolution error for',
      url,
      _e && (typeof _e === 'object' && 'stack' in _e ? (_e as Error).stack : _e),
    );
  }

  while (true) {
    attempt += 1;
    console.debug(`safeGoto: attempt ${attempt} -> ${resolvedUrl}`);
    try {
      return await page.goto(resolvedUrl, options);
    } catch (err) {
      const meta = {
        originalUrl,
        resolvedUrl,
        attempt,
        name: err && typeof err === 'object' && 'name' in err ? (err as Error).name : undefined,
        code: err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : undefined,
        message: err && typeof err === 'object' && 'message' in err ? (err as Error).message : undefined,
      };
      console.error(
        'safeGoto error:',
        meta,
        err && (typeof err === 'object' && 'stack' in err ? (err as Error).stack : err),
      );
      if (attempt > retries) {
        try {
          const errName = err && typeof err === 'object' && 'name' in err ? (err as Error).name : String(err);
          const errCode = err && typeof err === 'object' && 'code' in err ? (err as { code?: string }).code : '';

          let screenshotPath = null;
          try {
            const p = `screenshot_safegoto_failed_${Date.now()}.png`;
            await page.screenshot({ path: p, fullPage: false }).catch(() => {});
            screenshotPath = p;
          } catch (ssErr) {
            console.error('safeGoto screenshot capture failed', ssErr);
          }

          await sendTelegram(
            `❗ safeGoto completely failed (${resolvedUrl}) after ${attempt} attempts: ${errName}${errCode ? ` (${errCode})` : ''}`,
            screenshotPath,
          );

          if (screenshotPath) {
            const fsPromises = await import('fs/promises');
            await fsPromises.default.unlink(screenshotPath).catch(() => {});
          }
        } catch (notifyErr) {
          console.error(
            'notify failed',
            notifyErr &&
              (typeof notifyErr === 'object' && 'stack' in notifyErr ? (notifyErr as Error).stack : notifyErr),
          );
        }

        const errMessage = err && typeof err === 'object' && 'message' in err ? (err as Error).message : String(err);
        throw new Error(`safeGoto failed after ${attempt} attempts for ${resolvedUrl}: ${errMessage}`);
      }
      await sleep(1000 * attempt);
    }
  }
}

const verifiedLoggedInContexts = new WeakSet<BrowserContext>();

function invalidateLoginStatus(context?: BrowserContext): void {
  if (context) {
    verifiedLoggedInContexts.delete(context);
  }
}
const MYPAGE_INFO_URL = 'https://m.doctorville.co.kr/mypage/info';

type LoginStatus = 'LOGGED_IN' | 'NOT_LOGGED_IN' | 'UNKNOWN';

/**
 * HTTP 기반 로그인 상태 검사
 */
async function checkLoginStatusHttp(): Promise<LoginStatus> {
  try {
    const res = await httpGet(MYPAGE_INFO_URL);
    return parseLoginStatusHtml(res.body, res.url);
  } catch (err) {
    console.warn('checkLoginStatusHttp error:', err);
    return 'UNKNOWN';
  }
}

/**
 * Playwright Page 기반 로그인 상태 검사 (Fallback)
 */
async function checkLoginStatus(page: Page): Promise<LoginStatus> {
  await safeGoto(page, MYPAGE_INFO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 }, 1);
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

  try {
    const currentUrl = new URL(page.url());
    if (currentUrl.pathname === '/member/login') {
      const redirectParam = currentUrl.searchParams.get('redirect');
      if (redirectParam) {
        const decodedParam = decodeURIComponent(redirectParam);
        if (decodedParam === '/mypage/info' || redirectParam === '/mypage/info') {
          return 'NOT_LOGGED_IN';
        }
      }
      return 'NOT_LOGGED_IN';
    }
  } catch (_e) {
    /* ignore url parse error */
  }

  const infoButton = page.getByRole('button', { name: '회원정보수정', exact: true });
  const isButtonVisible = await infoButton.isVisible({ timeout: 3000 }).catch(() => false);
  if (isButtonVisible) {
    return 'LOGGED_IN';
  }

  return 'UNKNOWN';
}

async function ensureLoggedIn(args?: { page?: Page; context?: BrowserContext }): Promise<void> {
  const context = args?.context ?? args?.page?.context();
  if (context && verifiedLoggedInContexts.has(context)) {
    console.log('Login check: already verified for this browser context.');
    return;
  }

  // 1. HTTP 기반 로그인 검사 우선 시도
  let status = await checkLoginStatusHttp();
  if (status === 'LOGGED_IN') {
    console.log('Login check (HTTP): logged in ("회원정보수정" text found).');
    if (context) {
      verifiedLoggedInContexts.add(context);
    }
    // Playwright page 및 context에 저장된 쿠키 동적 주입 (필요 시)
    if (context) {
      await loadCookies(context).catch(() => {});
    }
    return;
  }

  console.log(`Login check (HTTP) returned status: ${status}. Proceeding to Playwright login check/flow.`);

  if (!args?.page || !context) {
    throw new Error('Playwright page or context is required for login fallback, but was not provided.');
  }

  const page = args.page;

  // 쿠키/로컬스토리지를 먼저 로드
  try {
    await loadCookies(context).catch(() => {});
    await loadLocalStorage(page, MYPAGE_INFO_URL).catch(() => {});
  } catch (_e) {
    /* ignore */
  }

  status = await checkLoginStatus(page);

  if (status === 'LOGGED_IN') {
    console.log('Login check (Playwright): already logged in.');
    if (context) {
      verifiedLoggedInContexts.add(context);
    }
    return;
  }

  if (status === 'NOT_LOGGED_IN') {
    console.log('Redirected to /member/login?redirect=/mypage/info.');
    console.log('Login required. Running login task.');
  } else {
    console.log('/mypage/info did not redirect to login, but "회원정보수정" button was not found.');
    console.log('Login status could not be verified. Running login task.');
  }

  const loginTask = await import('../tasks/login');
  await loginTask.run({ page, context });

  console.log('Login task completed. Verifying login status via HTTP & Playwright.');
  status = await checkLoginStatusHttp();
  if (status !== 'LOGGED_IN') {
    status = await checkLoginStatus(page);
  }

  if (status === 'LOGGED_IN') {
    console.log('Login verification successful.');
    if (context) {
      verifiedLoggedInContexts.add(context);
    }
  } else if (status === 'NOT_LOGGED_IN') {
    if (context) {
      invalidateLoginStatus(context);
    }
    console.log('Login task completed, but login verification still failed.');
    throw new Error('Login verification failed.');
  } else {
    if (context) {
      invalidateLoginStatus(context);
    }
    console.log('Login status could not be verified.');
    throw new Error('Login status could not be verified.');
  }
}

async function hasSurveyPointExcludedNotice(page: Page): Promise<boolean> {
  const isSurveyPointExcludedByBanner = await page
    .locator('text=/포인트가\\s*지급되지\\s*않는/')
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  const isSurveyPointExcludedByText = await page
    .locator('body')
    .first()
    .innerText()
    .then((text) => /포인트가\s*지급되지\s*않는\s*세미나/.test(text.replace(/\s+/g, ' ')))
    .catch(() => false);
  return isSurveyPointExcludedByBanner || isSurveyPointExcludedByText;
}

async function ensureSeminarDetailReady(page: Page, url: string): Promise<void> {
  const shareLocator = page.locator('text=공유').first();

  const maxRefreshRetries = 3;
  for (let attempt = 0; attempt <= maxRefreshRetries; attempt += 1) {
    const isShareVisible = await shareLocator.isVisible({ timeout: 3000 }).catch(() => false);
    if (isShareVisible) return;

    if (attempt < maxRefreshRetries) {
      console.warn(
        `세미나 상세 페이지 로딩 지연: 공유 텍스트 미검출, 새로고침 재시도 (${attempt + 1}/${maxRefreshRetries})`,
      );
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => false);
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => false);
      continue;
    }
  }

  const screenshotDir = path.join(process.cwd(), 'screenshot');
  const screenshotPath = path.join(
    screenshotDir,
    `seminar_detail_ready_failed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`,
  );

  try {
    await fs.promises.mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    await sendTelegram(`세미나 상세 페이지 로딩 확인 실패("공유" 텍스트 미검출): ${url}`, screenshotPath).catch(
      () => false,
    );
  } finally {
    await fs.promises.unlink(screenshotPath).catch(() => {});
  }

  throw new Error(`세미나 상세 페이지 로딩 확인 실패("공유" 텍스트 미검출): ${url}`);
}

/**
 * HTTP GET 기반 세미나 상세 페이지의 포인트 미지급 여부 검사
 */
async function isSurveyPointExcludedSeminarHttp(url: string): Promise<boolean> {
  try {
    const res = await httpGet(url);
    if (res.status === 200 && res.body) {
      return hasSurveyPointExcludedNoticeHtml(res.body);
    }
    return false;
  } catch (_e) {
    return false;
  }
}

async function isSurveyPointExcludedSeminar(context: BrowserContext, url: string): Promise<boolean> {
  // 1. HTTP GET으로 먼저 검사
  const httpResult = await isSurveyPointExcludedSeminarHttp(url);
  if (httpResult) return true;

  // 2. HTTP로 확인되지 않으면 Playwright fallback
  const page = await context.newPage();
  try {
    await ensureLoggedIn({ page, context });
    await safeGoto(page, url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await ensureSeminarDetailReady(page, url);
    return hasSurveyPointExcludedNotice(page);
  } catch (_e) {
    return false;
  } finally {
    await page.close().catch(() => {});
  }
}

function getSeminarIdFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    return urlObj.searchParams.get('seminarId');
  } catch (_e) {
    console.error('Failed to extract seminarId from URL:', url, _e);
    return null;
  }
}

/**
 * 포인트 전환 가능 여부 API HTTP GET 조회
 */
export async function getPointConversionAvailabilityHttp(): Promise<{
  available?: boolean;
  availablePlannedAt?: string;
  meridiem?: string;
} | null> {
  try {
    const API_URL = 'https://api.doctorville.co.kr/api/point/conversion/availability';
    const json = await httpGetJson<{ data?: { available?: boolean; availablePlannedAt?: string; meridiem?: string } }>(
      API_URL,
    );
    return json?.data ?? null;
  } catch (err) {
    console.error('getPointConversionAvailabilityHttp error:', err);
    return null;
  }
}

export {
  invalidateLoginStatus,
  sendTelegram,
  sendNotificationToChannel,
  saveCookies,
  loadCookies,
  saveLocalStorage,
  loadLocalStorage,
  safeGoto,
  sleep,
  maskToken,
  ensureLoggedIn,
  checkLoginStatus,
  checkLoginStatusHttp,
  escapeMarkdownV2,
  getSeminarIdFromUrl,
  hasSurveyPointExcludedNotice,
  ensureSeminarDetailReady,
  isSurveyPointExcludedSeminar,
  isSurveyPointExcludedSeminarHttp,
};

const analyticsBlockedPages = new WeakSet<Page>();
function setupAnalyticsBlock(page: Page): void {
  if (analyticsBlockedPages.has(page)) return;
  try {
    page.route('**/dev-analytics.villeway.com/**', (route) => route.abort().catch(() => {}));
    analyticsBlockedPages.add(page);
  } catch (_e) {
    console.error('setupAnalyticsBlock failed', _e);
  }
}
