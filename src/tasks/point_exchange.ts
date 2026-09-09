import path from 'path';
import fs from 'fs/promises';
import type { PlaywrightRunArgs, TaskResult } from '../types';
import { ensureLoggedIn, safeGoto, sendTelegram, sleep } from '../modules/utils';
import { getProductPrice } from '../modules/point_exchange_utils';
import { getPoint } from './check_point';

const ENTERTAINMENT_URL = 'https://www.doctorville.co.kr/entertainment/main';
const SUCCESS_TEXT = '주문이 완료되었습니다.';

export function resolveTargetUrl(input: string, catecode = '14592'): string {
  const trimmed = input.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return `https://mcircle.bizmarketb2b.com/Goods/Content.aspx?guid=${trimmed}&catecode=${catecode}`;
}

export function extractGuidFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const guid = parsed.searchParams.get('guid');
    if (guid) return guid;
  } catch {
    // ignore
  }
  const match = url.match(/[?&]guid=(\d+)/i);
  return match ? match[1] : url;
}

export async function run({ page, context, maxIterations, args }: PlaywrightRunArgs): Promise<TaskResult> {
  const rawInput = args?.url || args?.guid || args?.item || '';
  if (!rawInput) {
    const message = '포인트교환 실패: 대상 상품 URL 또는 guid가 지정되지 않았습니다.';
    await sendTelegram(`❗ ${message}`).catch(() => {});
    return { success: false, message };
  }

  const catecode = args?.catecode || '14592';
  const targetUrl = resolveTargetUrl(rawInput, catecode);
  const guid = extractGuidFromUrl(targetUrl);
  const taskTitle = args?.name ? `${args.name} 포인트교환` : `포인트교환 (${guid})`;

  const name = process.env.USER_NAME?.trim();
  const phone1 = process.env.USER_PHONE_1?.trim();
  const phone2 = process.env.USER_PHONE_2?.trim();
  const phone3 = process.env.USER_PHONE_3?.trim();

  const finalMaxIterations =
    maxIterations !== undefined ? maxIterations : args?.maxIterations !== undefined ? Number(args.maxIterations) : 1;

  const refreshEvery = Number(process.env.POINT_EXCHANGE_REFRESH_EVERY || process.env.NAVERPAY_REFRESH_EVERY || '3');
  const iterationDelayMs = Number(
    process.env.POINT_EXCHANGE_ITERATION_DELAY_MS || process.env.NAVERPAY_ITERATION_DELAY_MS || '500',
  );

  if (!name || !phone1 || !phone2 || !phone3) {
    const missing = [
      !name ? 'USER_NAME' : null,
      !phone1 ? 'USER_PHONE_1' : null,
      !phone2 ? 'USER_PHONE_2' : null,
      !phone3 ? 'USER_PHONE_3' : null,
    ]
      .filter(Boolean)
      .join(', ');
    const message = `${taskTitle} 실패: 환경변수(${missing})를 확인해주세요.`;
    await sendTelegram(`❗ ${message}`).catch(() => {});
    return { success: false, message };
  }

  let workPage = page;

  if (!context) {
    const message = `${taskTitle} 실패: 로그인 확인을 위해 context가 필요합니다.`;
    await sendTelegram(`❗ ${message}`).catch(() => {});
    return { success: false, message };
  }

  await ensureLoggedIn({ page: workPage, context }).catch(() => {});

  const startPoint = await getPoint(context);
  console.log(`[point_exchange] 시작 전 남은 포인트: ${startPoint} (${taskTitle})`);
  await sendTelegram(`💳 ${taskTitle} 시작 전 남은 포인트: ${startPoint}`).catch(() => {});

  await fs.mkdir(path.join(process.cwd(), 'screenshot'), { recursive: true });
  let successCount = 0;
  let iteration = 0;

  const prepareShopPage = async () => {
    await ensureLoggedIn({ page: workPage, context }).catch(() => {});
    await safeGoto(workPage, ENTERTAINMENT_URL, { waitUntil: 'load', timeout: 20000 }, 2);
    const pointShopLink = workPage.locator('#btnPointShopLink').first();
    if ((await pointShopLink.count()) > 0) {
      const currentUrl = workPage.url();
      await Promise.all([
        workPage
          .waitForURL((url) => url.toString() !== currentUrl, { waitUntil: 'domcontentloaded', timeout: 10000 })
          .catch(() => null),
        pointShopLink.click(),
      ]);
    }
  };

  try {
    // 초기 1회 로그인 및 포인트샵 진입
    await prepareShopPage();

    // finalMaxIterations가 0이면 실패할 때까지 무제한 반복
    while (finalMaxIterations === 0 || iteration < finalMaxIterations) {
      // 일정 주기마다 새 페이지로 재생성하여 누적 리소스 사용을 줄임
      if (refreshEvery > 0 && iteration > 0 && iteration % refreshEvery === 0) {
        try {
          await workPage.close().catch(() => {});
        } catch (_e) {
          /* ignore */
        }
        workPage = await context.newPage();
        await prepareShopPage();
      }

      await safeGoto(workPage, targetUrl, { waitUntil: 'load', timeout: 30000 }, 2);

      iteration += 1; // 타깃 URL 진입 후에 이터레이션을 증가시켜 실제 시도 횟수만 센다

      const buyNowButton = workPage.locator('a', { hasText: '바로구매' }).first();
      await buyNowButton.waitFor({ state: 'visible', timeout: 15000 });
      await buyNowButton.click();

      await workPage.waitForSelector('#rcvName', { timeout: 10000 });
      const productPrice = await getProductPrice(workPage, '0');
      if (productPrice && productPrice !== '0') {
        console.log(`[point_exchange] 상품금액 추출 성공: ${productPrice}원`);
      }

      await workPage.fill('#rcvName', name);
      await workPage.fill('#rcvMobile1', phone1);
      await workPage.fill('#rcvMobile2', phone2);
      await workPage.fill('#rcvMobile3', phone3);
      await workPage.fill('#orderMemo', String(iteration));
      await workPage.fill('#point_etc1', productPrice);

      const pointUseButton = workPage.locator('#chkMcircelPoint a').first();
      if (await pointUseButton.isVisible()) {
        await pointUseButton.click();
      }

      const agreePersonalInfo = workPage.locator('label[for="agreeFlow"]').first();
      if (await agreePersonalInfo.isVisible()) {
        await agreePersonalInfo.click();
      }

      const agreeResale = workPage.locator('label[for="chkReSale"]').first();
      if (await agreeResale.isVisible()) {
        await agreeResale.click();
      }

      const currentUrl = workPage.url();
      await Promise.all([
        workPage
          .waitForURL((url) => url.toString() !== currentUrl, { waitUntil: 'domcontentloaded', timeout: 15000 })
          .catch(() => null),
        workPage.locator('#btnPayment').click(),
      ]);

      const orderCompleted = await workPage
        .locator(`text=${SUCCESS_TEXT}`)
        .first()
        .isVisible()
        .catch(() => false);

      if (orderCompleted) {
        successCount += 1;
        await sendTelegram(`✅ ${taskTitle} 성공 (${successCount}회 누적, 시도 ${iteration}회)`).catch(() => {});
        if (iterationDelayMs > 0) {
          await sleep(iterationDelayMs);
        }
        continue;
      }

      const failureShot = path.join(process.cwd(), 'screenshot', `point_exchange_${guid}_failure.png`);
      await workPage.screenshot({ path: failureShot, fullPage: true }).catch(() => {});
      const endPoint = await getPoint(context);
      const message = `${taskTitle} 실패 (시도 ${iteration}회, 성공 ${successCount}회). '${SUCCESS_TEXT}' 문구를 찾지 못했습니다.\n종료 후 남은 포인트: ${endPoint}`;
      await sendTelegram(`❗ ${message}`, failureShot).catch(() => {});
      return { success: false, message, imagePath: failureShot };
    }

    const endPoint = await getPoint(context);
    const message =
      finalMaxIterations > 0
        ? `${taskTitle} 완료: 설정된 ${finalMaxIterations}회 반복 종료 (성공 ${successCount}회).\n종료 후 남은 포인트: ${endPoint}`
        : `${taskTitle} 종료: 성공 ${successCount}회 후 반복이 중단되었습니다.\n종료 후 남은 포인트: ${endPoint}`;
    await sendTelegram(`✅ ${message}`).catch(() => {});
    return { success: true, message };
  } catch (error) {
    const errorShot = path.join(process.cwd(), 'screenshot', `point_exchange_${guid}_error.png`);
    await workPage.screenshot({ path: errorShot, fullPage: true }).catch(() => {});
    const endPoint = await getPoint(context);
    const message = `${taskTitle} 오류 발생 (성공 ${successCount}회): ${
      error instanceof Error ? error.message : String(error)
    }\n종료 후 남은 포인트: ${endPoint}`;
    await sendTelegram(`❗ ${message}`, errorShot).catch(() => {});
    return { success: false, message, imagePath: errorShot };
  }
}
