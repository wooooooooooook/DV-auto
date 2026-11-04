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

export interface ExchangeTarget {
  url: string;
  quantity: number;
  label: string;
}

/**
 * 다중 상품 교환 대상(args.products)을 파싱합니다.
 * JSON 문자열 또는 배열을 지원하며, 각 항목은 URL/guid 문자열이거나
 * `{ url | guid, catecode?, quantity?, label? }` 객체입니다.
 */
export function parseExchangeTargets(raw: unknown, catecode = '14592'): ExchangeTarget[] {
  if (!raw) return [];

  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const parsed: unknown = JSON.parse(trimmed);
      list = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      list = trimmed
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean);
    }
  } else {
    return [];
  }

  const targets: ExchangeTarget[] = [];
  for (const item of list) {
    if (typeof item === 'string') {
      if (!item.trim()) continue;
      const url = resolveTargetUrl(item, catecode);
      targets.push({ url, quantity: 1, label: extractGuidFromUrl(url) });
      continue;
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const rawUrl = record.url ?? record.guid ?? record.item;
      if (typeof rawUrl !== 'string' || !rawUrl.trim()) continue;
      const itemCatecode = typeof record.catecode === 'string' && record.catecode ? record.catecode : catecode;
      const url = resolveTargetUrl(rawUrl, itemCatecode);
      const parsedQuantity = Number(record.quantity);
      const quantity = Number.isFinite(parsedQuantity) && parsedQuantity > 0 ? Math.floor(parsedQuantity) : 1;
      const label = typeof record.label === 'string' && record.label ? record.label : extractGuidFromUrl(url);
      targets.push({ url, quantity, label });
    }
  }
  return targets;
}

export interface ExchangeStep {
  url: string;
  guid: string;
  label: string;
  groupIndex: number;
}

/** 상품별 수량을 반복 실행 단위로 펼칩니다. */
export function buildExchangeSteps(targets: ExchangeTarget[]): ExchangeStep[] {
  const steps: ExchangeStep[] = [];
  targets.forEach((target, groupIndex) => {
    const guid = extractGuidFromUrl(target.url);
    for (let i = 0; i < target.quantity; i += 1) {
      steps.push({ url: target.url, guid, label: target.label, groupIndex });
    }
  });
  return steps;
}

export async function run({ page, context, maxIterations, args }: PlaywrightRunArgs): Promise<TaskResult> {
  const catecode = args?.catecode || '14592';
  const targets = parseExchangeTargets(args?.products, catecode);
  const isMultiTarget = targets.length > 0;
  const multiSteps = isMultiTarget ? buildExchangeSteps(targets) : [];

  const rawInput = args?.url || args?.guid || args?.item || '';
  if (!isMultiTarget && !rawInput) {
    const message = '포인트교환 실패: 대상 상품 URL 또는 guid가 지정되지 않았습니다.';
    await sendTelegram(`❗ ${message}`).catch(() => {});
    return { success: false, message };
  }

  const singleUrl = isMultiTarget ? '' : resolveTargetUrl(rawInput, catecode);
  const guid = isMultiTarget ? extractGuidFromUrl(targets[0].url) : extractGuidFromUrl(singleUrl);
  const taskTitle = args?.name ? `${args.name} 포인트교환` : isMultiTarget ? '포인트교환' : `포인트교환 (${guid})`;

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
  const totalIterations = isMultiTarget ? multiSteps.length : finalMaxIterations > 0 ? finalMaxIterations : Infinity;
  const startDetail = isMultiTarget ? ` (상품 ${targets.length}개, 총 ${multiSteps.length}회)` : '';
  console.log(`[point_exchange] 시작 전 남은 포인트: ${startPoint} (${taskTitle})`);
  await sendTelegram(`💳 ${taskTitle} 시작 전 남은 포인트: ${startPoint}${startDetail}`).catch(() => {});

  await fs.mkdir(path.join(process.cwd(), 'screenshot'), { recursive: true });
  const singleStep: ExchangeStep = { url: singleUrl, guid, label: guid, groupIndex: 0 };
  const stepAt = (index: number): ExchangeStep => (isMultiTarget ? multiSteps[index] : singleStep);
  const successByGroup = new Map<number, number>();
  const failedGroups = new Set<number>();
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

    // finalMaxIterations가 0이면 실패할 때까지 무제한 반복 (단일 상품 모드)
    while (iteration < totalIterations) {
      const step = stepAt(iteration);

      // 이미 실패한 상품의 남은 수량은 건너뛴다
      if (isMultiTarget && failedGroups.has(step.groupIndex)) {
        iteration += 1;
        continue;
      }

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

      await safeGoto(workPage, step.url, { waitUntil: 'load', timeout: 30000 }, 2);

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
        successByGroup.set(step.groupIndex, (successByGroup.get(step.groupIndex) || 0) + 1);
        await sendTelegram(`✅ ${taskTitle} 성공 (${successCount}회 누적, 시도 ${iteration}회)`).catch(() => {});
        if (iterationDelayMs > 0) {
          await sleep(iterationDelayMs);
        }
        continue;
      }

      const failureShot = path.join(process.cwd(), 'screenshot', `point_exchange_${step.guid}_failure.png`);
      await workPage.screenshot({ path: failureShot, fullPage: true }).catch(() => {});

      if (isMultiTarget) {
        // 다중 상품 모드에서는 실패한 상품만 건너뛰고 나머지 상품 교환을 계속 진행한다
        failedGroups.add(step.groupIndex);
        await sendTelegram(
          `❗ ${taskTitle} 실패: ${step.label} 상품 (시도 ${iteration}회, 성공 ${successCount}회). '${SUCCESS_TEXT}' 문구를 찾지 못해 다음 상품으로 넘어갑니다.`,
          failureShot,
        ).catch(() => {});
        continue;
      }

      const endPoint = await getPoint(context);
      const message = `${taskTitle} 실패 (시도 ${iteration}회, 성공 ${successCount}회). '${SUCCESS_TEXT}' 문구를 찾지 못했습니다.\n종료 후 남은 포인트: ${endPoint}`;
      await sendTelegram(`❗ ${message}`, failureShot).catch(() => {});
      return { success: false, message, imagePath: failureShot };
    }

    const endPoint = await getPoint(context);

    if (isMultiTarget) {
      const lines = targets.map((target, index) => {
        const succeeded = successByGroup.get(index) || 0;
        const mark = failedGroups.has(index) ? '❌' : succeeded >= target.quantity ? '✅' : '⚠️';
        return `${mark} [${index + 1}] ${target.label}: ${succeeded}/${target.quantity}회`;
      });
      const isAllSucceeded = failedGroups.size === 0 && successCount >= multiSteps.length;
      const message = `${taskTitle} 종료: 성공 ${successCount}회 / 총 ${multiSteps.length}회\n${lines.join('\n')}\n종료 후 남은 포인트: ${endPoint}`;
      await sendTelegram(`${isAllSucceeded ? '✅' : '❗'} ${message}`).catch(() => {});
      return { success: isAllSucceeded, message };
    }

    const message =
      finalMaxIterations > 0
        ? `${taskTitle} 완료: 설정된 ${finalMaxIterations}회 반복 종료 (성공 ${successCount}회).\n종료 후 남은 포인트: ${endPoint}`
        : `${taskTitle} 종료: 성공 ${successCount}회 후 반복이 중단되었습니다.\n종료 후 남은 포인트: ${endPoint}`;
    await sendTelegram(`✅ ${message}`).catch(() => {});
    return { success: true, message };
  } catch (error) {
    const screenshotKey = isMultiTarget ? 'multi' : guid;
    const errorShot = path.join(process.cwd(), 'screenshot', `point_exchange_${screenshotKey}_error.png`);
    await workPage.screenshot({ path: errorShot, fullPage: true }).catch(() => {});
    const endPoint = await getPoint(context);
    const message = `${taskTitle} 오류 발생 (성공 ${successCount}회): ${
      error instanceof Error ? error.message : String(error)
    }\n종료 후 남은 포인트: ${endPoint}`;
    await sendTelegram(`❗ ${message}`, errorShot).catch(() => {});
    return { success: false, message, imagePath: errorShot };
  }
}
