import type { BrowserContext } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { safeGoto, sendTelegram, ensureLoggedIn, loadCookies } from '../modules/utils';
import { attendSeminarApi, type AttendSeminarApiResult } from '../modules/seminar_api';
import { SEMINAR_DETAIL_PAGE, SEMINAR_DETAIL_PC_PAGE, type MonitoredSeminarItem } from './monitor_seminars_notice';

/**
 * 지정된 Concurrency(동시 작업 수)로 비동기 작업을 병렬 실행하는 헬퍼
 */
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      results[idx] = await fn(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Playwright BrowserContext 온디맨드 획득 헬퍼
 * 전달받은 context가 있으면 재사용하고, 없으면 필요한 시점에만 Chromium을 실행하고 종료합니다.
 */
export async function withBrowserContext<T>(
  providedContext: BrowserContext | undefined,
  callback: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  if (providedContext) {
    return await callback(providedContext);
  }

  const { chromium } = await import('playwright');
  const HEADLESS = (process.env.HEADLESS || 'true').toLowerCase() === 'true';
  const browser = await chromium.launch({ headless: HEADLESS, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await loadCookies(context).catch(() => {});

  // 불필요한 미디어 스트림 및 폰트 파일 로딩 차단 (속도 및 메모리 최적화)
  await context.route('**/*.{woff,woff2,ttf,otf,eot,mp4,webm,mp3,ogg}', (route) => route.abort()).catch(() => {});

  try {
    return await callback(context);
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Playwright로 세미나 라이브 방송에 자동 입장하는 함수
 */
export async function performAutoEnter(
  context: BrowserContext,
  seminarId: string | null,
  seminarName: string,
  targetUrl: string,
  screenshotKey: string,
): Promise<boolean> {
  const page = await context.newPage();
  let didEnter = false;

  try {
    console.log(`[monitor_seminars] Performing auto-enter for ${seminarId} (${targetUrl})`);

    await ensureLoggedIn({ page, context });
    await safeGoto(page, targetUrl, { waitUntil: 'networkidle', timeout: 15000 });

    const enterBtn = page.locator('text="입장하기"').first();
    if (!(await enterBtn.isVisible({ timeout: 5000 }))) {
      console.log(`[monitor_seminars] '입장하기' button not found for ${seminarId}. retry needed.`);
      const notFoundScreenshotPath = path.join(process.cwd(), `seminar_entry_notfound_${screenshotKey}.png`);
      try {
        await page.screenshot({ path: notFoundScreenshotPath, fullPage: false });
        await sendTelegram(
          `⚠️ '입장하기' 버튼을 찾지 못했습니다 (재시도 예정)\n${seminarName}\n${targetUrl}`,
          notFoundScreenshotPath,
        );
      } catch (ssErr) {
        console.error(`[monitor_seminars] Failed to take/send not-found screenshot for ${seminarId}`, ssErr);
      } finally {
        await fs.unlink(notFoundScreenshotPath).catch(() => {});
      }
      return false;
    }

    const popupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await enterBtn.click();

    const popup = await popupPromise;
    let activePage = page;

    if (popup) {
      console.log(`[monitor_seminars] Popup detected for ${seminarId}`);
      activePage = popup;
      await activePage.waitForLoadState('domcontentloaded');
    }

    // "채널 선택" 다이얼로그 감지 후 "확인" 버튼 클릭 (고정 sleep 대신 조건부 대기)
    console.log(`[monitor_seminars] Checking for '채널 선택' dialog after clicking '입장하기' (${seminarId})`);
    const channelSelectText = activePage.locator('text="채널 선택"').first();
    let isChannelSelectVisible = false;
    try {
      if (typeof channelSelectText.waitFor === 'function') {
        isChannelSelectVisible = await channelSelectText
          .waitFor({ state: 'visible', timeout: 3000 })
          .then(() => true)
          .catch(() => false);
      } else if (typeof channelSelectText.isVisible === 'function') {
        isChannelSelectVisible = await channelSelectText.isVisible().catch(() => false);
      }
    } catch {
      isChannelSelectVisible = false;
    }

    if (isChannelSelectVisible) {
      console.log(`[monitor_seminars] '채널 선택' dialog detected for ${seminarId}. Clicking '확인'.`);
      const confirmBtn = activePage.locator('text="확인"').first();
      await confirmBtn.click({ force: true }).catch(() => {
        console.warn(`[monitor_seminars] Failed to click '확인' button for ${seminarId}`);
      });
      console.log(`[monitor_seminars] Clicked '확인' for channel selection (${seminarId})`);
      if (typeof channelSelectText.waitFor === 'function') {
        await channelSelectText.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => {});
      }
    } else {
      console.log(`[monitor_seminars] No '채널 선택' dialog detected for ${seminarId}`);
    }

    console.log(`[monitor_seminars] Waiting for chat iframe to confirm seminar entry (${seminarId})`);
    const urlPattern = /https:\/\/m\.doctorville\.co\.kr\/cme\/seminar\/attend\?seminarId=\d+/;
    const on24Pattern = /https:\/\/event\.on24\.com\/eventRegistration\/console\/apollox\/mainEvent/;

    const checkEntryConfirmed = (): boolean => {
      const chatFrame = page
        .frames()
        .find((f) => f.url().includes('socialstream') || f.url().includes('video.ibm.com'));
      if (chatFrame) return true;
      const curUrl = activePage.url();
      return urlPattern.test(curUrl) || on24Pattern.test(curUrl);
    };

    let isQnaVisible = checkEntryConfirmed();
    if (!isQnaVisible) {
      for (let i = 0; i < 10; i++) {
        await activePage.waitForTimeout(300);
        if (checkEntryConfirmed()) {
          isQnaVisible = true;
          break;
        }
      }
    }

    if (isQnaVisible) {
      console.log(`[monitor_seminars] Chat iframe or entry URL pattern found for ${seminarId}. Entry confirmed.`);
    } else {
      console.log(`[monitor_seminars] Chat iframe not found and URL mismatch for ${seminarId}: ${activePage.url()}`);
    }

    if (!isQnaVisible) {
      console.warn(
        `[monitor_seminars] Q&A section not found after entry attempt for ${seminarId}. Entry may have failed.`,
      );

      // 불확실 시 → PC 도메인 상세 페이지로 fallback 후 '입장하기' 클릭
      if (seminarId) {
        const pcFallbackUrl = `${SEMINAR_DETAIL_PC_PAGE}?seminarId=${seminarId}`;
        console.log(`[monitor_seminars] PC fallback for ${seminarId} -> ${pcFallbackUrl}`);
        try {
          await ensureLoggedIn({ page: activePage, context });
          await safeGoto(activePage, pcFallbackUrl, { waitUntil: 'networkidle', timeout: 15000 });
          const pcEnterBtn = activePage.locator('text="입장하기"').first();
          if (await pcEnterBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
            const pcPopupPromise = context.waitForEvent('page', { timeout: 5000 }).catch(() => null);
            await pcEnterBtn.click().catch((e) => {
              console.warn(`[monitor_seminars] PC fallback '입장하기' click failed for ${seminarId}`, e);
            });
            const pcPopup = await pcPopupPromise;
            const pcActive = pcPopup ?? activePage;
            if (pcPopup) await pcActive.waitForLoadState('domcontentloaded').catch(() => {});

            const pcChatCheck = () => {
              const pcChatFrame = pcActive
                .frames()
                .find((f) => f.url().includes('socialstream') || f.url().includes('video.ibm.com'));
              const cur = pcActive.url();
              return !!pcChatFrame || urlPattern.test(cur) || on24Pattern.test(cur);
            };

            if (!pcChatCheck()) {
              for (let i = 0; i < 10; i++) {
                await pcActive.waitForTimeout(300);
                if (pcChatCheck()) break;
              }
            }

            if (pcChatCheck()) {
              isQnaVisible = true;
              activePage = pcActive;
              console.log(`[monitor_seminars] PC fallback entry confirmed for ${seminarId}.`);
            } else {
              console.warn(`[monitor_seminars] PC fallback also failed for ${seminarId}: ${pcActive.url()}`);
            }
            if (pcPopup) await pcPopup.close().catch(() => {});
          } else {
            console.warn(`[monitor_seminars] PC fallback '입장하기' button not found for ${seminarId}`);
          }
        } catch (pcErr) {
          console.error(`[monitor_seminars] PC fallback threw for ${seminarId}`, pcErr);
        }
      }
    } else {
      console.log(`[monitor_seminars] Q&A section confirmed. Seminar entry successful for ${seminarId}.`);
    }

    const screenshotPath = path.join(process.cwd(), `seminar_entry_${screenshotKey}.png`);
    try {
      await activePage.screenshot({ path: screenshotPath, fullPage: false });
      didEnter = isQnaVisible;
    } catch (screenshotError) {
      console.error(`[monitor_seminars] Failed to take screenshot for ${seminarId}`, screenshotError);
    } finally {
      await fs.unlink(screenshotPath).catch(() => {});
    }

    if (popup) {
      await popup.close().catch(() => {});
    }
  } catch (e) {
    console.error(`[monitor_seminars] Auto-enter failed for ${seminarId}`, e);
  } finally {
    await page.close().catch(() => {});
  }

  return didEnter;
}

/**
 * 1차 API 실패 시 관리자 알림 및 로그에 첨부할 디버깅 정보 포맷팅
 */
export function formatApiDebugInfo(apiRes?: AttendSeminarApiResult, apiErr?: unknown): string {
  const lines: string[] = [];
  if (apiErr) {
    lines.push(`• 예외: ${apiErr instanceof Error ? apiErr.message : String(apiErr)}`);
  }
  if (apiRes) {
    if (apiRes.errorMessage) lines.push(`• 에러 메시지: ${apiRes.errorMessage}`);
    lines.push(`• 세션 만료 여부: ${apiRes.isAuthExpired ? '만료됨(True)' : '정상(False)'}`);
    lines.push(`• 입장이력 확인: ${apiRes.hasEntryHistory ? '확인됨' : '미확인/실패'}`);
    if (apiRes.debugInfo) {
      if (apiRes.debugInfo.attendStatusCode !== undefined) {
        lines.push(`• Attend HTTP 상태: ${apiRes.debugInfo.attendStatusCode}`);
      }
      if (apiRes.debugInfo.attendResponse) {
        const attendStr =
          typeof apiRes.debugInfo.attendResponse === 'string'
            ? apiRes.debugInfo.attendResponse
            : JSON.stringify(apiRes.debugInfo.attendResponse);
        lines.push(`• Attend 응답: ${attendStr.slice(0, 300)}`);
      }
      if (apiRes.debugInfo.uasSessionResponse) {
        const sessionStr =
          typeof apiRes.debugInfo.uasSessionResponse === 'string'
            ? apiRes.debugInfo.uasSessionResponse
            : JSON.stringify(apiRes.debugInfo.uasSessionResponse);
        lines.push(`• UAS Session: ${sessionStr.slice(0, 200)}`);
      }
      if (apiRes.debugInfo.uasActivityResponse) {
        const actStr =
          typeof apiRes.debugInfo.uasActivityResponse === 'string'
            ? apiRes.debugInfo.uasActivityResponse
            : JSON.stringify(apiRes.debugInfo.uasActivityResponse);
        lines.push(`• UAS Activity: ${actStr.slice(0, 200)}`);
      }
      if (apiRes.debugInfo.postDetailResponse) {
        const detailObj = apiRes.debugInfo.postDetailResponse as Record<string, unknown>;
        const member = (detailObj?.seminarDetail as Record<string, unknown>)?.seminarMember || detailObj?.seminarMember;
        lines.push(`• SeminarMember: ${JSON.stringify(member || 'null')}`);
      }
    }
  }
  return lines.length > 0 ? lines.join('\n') : '• 세부 정보 없음';
}

/**
 * 입장 상태 확인 및 자동 입장 실행
 * 1차: 순수 HTTP API(attendSeminarApi) 호출 및 입장이력(hasEntryHistory) 검증
 * 2차 폴백: API 실패 또는 입장이력 미확인 시 Playwright 브라우저 자동화(performAutoEnter) 실행 (디버깅 정보 첨부)
 */
export async function checkAndPerformAutoEnter(
  context: BrowserContext | null | undefined,
  seminarId: string | null,
  seminarUrl: string,
  name: string,
  status: string,
  autoEnterDone: boolean | undefined,
): Promise<boolean> {
  const canEnter = status === '입장가능' || status === '입장하기';
  if (!canEnter || autoEnterDone) {
    return !!autoEnterDone;
  }

  const targetUrl = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : seminarUrl;
  let lastApiRes: AttendSeminarApiResult | undefined;
  let lastApiErr: unknown | undefined;
  let didAttemptApi = false;

  // ── 1. 1차: 순수 HTTP API 입장 시도
  if (seminarId) {
    didAttemptApi = true;
    console.log(`[monitor_seminars] 1차 API 자동 입장 시도: ${seminarId} (${name})`);
    try {
      lastApiRes = await attendSeminarApi(seminarId);
      if (lastApiRes.success && lastApiRes.hasEntryHistory) {
        console.log(`[monitor_seminars] 1차 API 자동 입장 성공 및 입장이력 확인됨: ${seminarId} (${name})`);
        const entryMessage = `🟢세미나 입장 완료 (API)\n${name}\n${targetUrl}`;
        await sendTelegram(entryMessage).catch((e) => {
          console.error(`[monitor_seminars] API 입장 완료 알림 발송 실패 (${seminarId}):`, e);
        });
        return true;
      } else {
        console.warn(
          `[monitor_seminars] 1차 API 자동 입장 미완료 (success=${lastApiRes.success}, hasEntryHistory=${lastApiRes.hasEntryHistory}, err=${lastApiRes.errorMessage || '없음'}). Playwright 브라우저로 폴백합니다.`,
        );
      }
    } catch (apiErr) {
      lastApiErr = apiErr;
      console.warn(
        `[monitor_seminars] 1차 API 자동 입장 중 예외 발생 (${seminarId}). Playwright 브라우저로 폴백합니다:`,
        apiErr,
      );
    }
  }

  // ── 2. 2차: Playwright 브라우저 자동화 폴백 (Fallback)
  console.log(`[monitor_seminars] 2차 Playwright 브라우저 자동 입장 폴백 실행: ${seminarId || targetUrl} (${name})`);
  const screenshotKey = seminarId || `url_${Date.now()}`;

  const runPlaywrightAutoEnter = async (ctx: BrowserContext): Promise<boolean> => {
    const didEnter = await performAutoEnter(ctx, seminarId, name, targetUrl, screenshotKey);
    if (didEnter) {
      let entryMessage = `🟢세미나 입장 완료 (Playwright)\n${name}\n${targetUrl}`;
      if (didAttemptApi) {
        const debugSummary = formatApiDebugInfo(lastApiRes, lastApiErr);
        entryMessage += `\n\n🔍 [1차 API 실패 디버깅 정보]\n${debugSummary}`;
      }

      const screenshotPath = path.join(process.cwd(), `seminar_entry_${screenshotKey}.png`);
      try {
        const page = await ctx.newPage();
        await ensureLoggedIn({ page, context: ctx });
        await safeGoto(page, targetUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.screenshot({ path: screenshotPath, fullPage: false });
        await sendTelegram(entryMessage, screenshotPath);
        await page.close().catch(() => {});
      } catch (e) {
        console.error(`[monitor_seminars] Playwright 입장 알림 발송 실패 (${seminarId})`, e);
      } finally {
        await fs.unlink(screenshotPath).catch(() => {});
      }
    }
    return didEnter;
  };

  if (context) {
    return await runPlaywrightAutoEnter(context);
  } else {
    let didEnter = false;
    await withBrowserContext(undefined, async (ctx) => {
      didEnter = await runPlaywrightAutoEnter(ctx);
    });
    return didEnter;
  }
}

export interface AutoEnterOptions {
  context?: BrowserContext;
  isAutoResume?: boolean;
  periodName?: string;
}

/**
 * 입장 가능한 세미나들에 대해 온디맨드 자동 입장을 일괄 수행합니다.
 * - 이미 입장이 완료된 세미나(autoEnterDone === true) 또는 종료된 세미나는 제외
 * - autoResume 시 입장이력이 확인된 경우(hasEntryHistory === true) 자동입장 생략 및 완료 처리
 * - 동시성 2개 제한(Concurrency: 2)으로 병렬 자동 입장 수행
 * - 실패 시 autoEnterDone === false로 남아 다음 폴링 주기에서 재시도(Retry) 가능
 */
export async function performAutoEnterForActiveSeminars(
  seminars: Iterable<MonitoredSeminarItem>,
  options: AutoEnterOptions = {},
): Promise<void> {
  const { context, isAutoResume, periodName = '세미나' } = options;
  const targetSeminars: MonitoredSeminarItem[] = [];

  for (const seminar of seminars) {
    if (seminar.status === '입장가능' && !seminar.isEnded && !seminar.autoEnterDone) {
      if (isAutoResume && seminar.hasEntryHistory) {
        console.log(
          `[${periodName}] [isAutoResume] 세미나(${seminar.seminarId}) 입장이력이 확인되어 자동입장 생략: ${seminar.name}`,
        );
        seminar.autoEnterDone = true;
        continue;
      }
      targetSeminars.push(seminar);
    }
  }

  if (targetSeminars.length === 0) return;

  // 동시 2개까지 병렬 자동 입장 수행
  await mapConcurrent(targetSeminars, 2, async (seminar) => {
    try {
      seminar.autoEnterDone = await checkAndPerformAutoEnter(
        context,
        seminar.seminarId,
        seminar.url,
        seminar.name,
        '입장가능',
        seminar.autoEnterDone,
      );
    } catch (err) {
      console.error(`[${periodName}] 자동입장 처리 중 오류 발생 (${seminar.name}):`, err);
      seminar.autoEnterDone = false;
    }
  });
}
