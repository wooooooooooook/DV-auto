import path from 'path';
import fs from 'fs/promises';
import type { PlaywrightRunArgs, TaskResult } from '../types';
import { ensureLoggedIn, safeGoto, sendTelegram, sleep } from '../modules/utils';

const TARGET_URL = 'https://mcircle.bizmarketb2b.com/Goods/Content.aspx?guid=14131415&catecode=14592';
const SUCCESS_TEXT = '주문이 완료되었습니다.';
const DEFAULT_POINT = '4900';

async function run({ page, context }: PlaywrightRunArgs): Promise<TaskResult> {
  const name = process.env.USER_NAME?.trim();
  const phone1 = process.env.USER_PHONE_1?.trim();
  const phone2 = process.env.USER_PHONE_2?.trim();
  const phone3 = process.env.USER_PHONE_3?.trim();
  const maxIterations = Number(process.env.NAVERPAY_MAX_ITERATIONS || '0');

  if (!name || !phone1 || !phone2 || !phone3) {
    const missing = [
      !name ? 'USER_NAME' : null,
      !phone1 ? 'USER_PHONE_1' : null,
      !phone2 ? 'USER_PHONE_2' : null,
      !phone3 ? 'USER_PHONE_3' : null,
    ]
      .filter(Boolean)
      .join(', ');
    const message = `네이버페이포인트교환 실패: 환경변수(${missing})를 확인해주세요.`;
    await sendTelegram(`❗ ${message}`).catch(() => {});
    return { success: false, message };
  }

  if (context) {
    await ensureLoggedIn({ page, context }).catch(() => {});
  }

  await fs.mkdir(path.join(process.cwd(), 'screenshot'), { recursive: true });
  let successCount = 0;
  let iteration = 0;

  try {
    // maxIterations가 0이면 실패할 때까지 무제한 반복
    while (maxIterations === 0 || iteration < maxIterations) {
      iteration += 1;

      await safeGoto(page, TARGET_URL, { waitUntil: 'load', timeout: 30000 }, 2);

      const buyNowButton = page.locator('a', { hasText: '바로구매' }).first();
      await buyNowButton.waitFor({ state: 'visible', timeout: 15000 });
      await buyNowButton.click();

      await page.waitForSelector('#rcvName', { timeout: 10000 });
      await page.fill('#rcvName', name);
      await page.fill('#rcvMobile1', phone1);
      await page.fill('#rcvMobile2', phone2);
      await page.fill('#rcvMobile3', phone3);
      await page.fill('#orderMemo', String(iteration));
      await page.fill('#point_etc1', DEFAULT_POINT);

      const pointUseButton = page.locator('#chkMcircelPoint a').first();
      if (await pointUseButton.isVisible()) {
        await pointUseButton.click();
      }

      const agreePersonalInfo = page.locator('label[for="agreeFlow"]').first();
      if (await agreePersonalInfo.isVisible()) {
        await agreePersonalInfo.click();
      }

      const agreeResale = page.locator('label[for="chkReSale"]').first();
      if (await agreeResale.isVisible()) {
        await agreeResale.click();
      }

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
        page.locator('#btnPayment').click(),
      ]);

      const orderCompleted = await page
        .locator(`text=${SUCCESS_TEXT}`)
        .first()
        .isVisible()
        .catch(() => false);

      if (orderCompleted) {
        successCount += 1;
        await sendTelegram(`✅ 네이버페이포인트교환 성공 (${successCount}회 누적, 시도 ${iteration}회)`).catch(() => {});
        await sleep(500);
        continue;
      }

      const failureShot = path.join(process.cwd(), 'screenshot', 'naverpay_point_exchange_failure.png');
      await page.screenshot({ path: failureShot, fullPage: true }).catch(() => {});
      const message = `네이버페이포인트교환 실패 (시도 ${iteration}회, 성공 ${successCount}회). '${SUCCESS_TEXT}' 문구를 찾지 못했습니다.`;
      await sendTelegram(`❗ ${message}`, failureShot).catch(() => {});
      return { success: false, message, imagePath: failureShot };
    }

    const message =
      maxIterations > 0
        ? `네이버페이포인트교환 완료: 설정된 ${maxIterations}회 반복 종료 (성공 ${successCount}회).`
        : `네이버페이포인트교환 종료: 성공 ${successCount}회 후 반복이 중단되었습니다.`;
    return { success: true, message };
  } catch (error) {
    const errorShot = path.join(process.cwd(), 'screenshot', 'naverpay_point_exchange_error.png');
    await page.screenshot({ path: errorShot, fullPage: true }).catch(() => {});
    const message = `네이버페이포인트교환 오류 발생 (성공 ${successCount}회): ${
      error instanceof Error ? error.message : String(error)
    }`;
    await sendTelegram(`❗ ${message}`, errorShot).catch(() => {});
    return { success: false, message, imagePath: errorShot };
  }
}

export { run };
