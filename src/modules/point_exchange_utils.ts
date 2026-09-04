import type { Page } from 'playwright';

/**
 * 텍스트 내용에서 가격을 파싱합니다.
 * @param text 대상 텍스트
 * @param maxExpectedPrice 정가 기준값 (할인가 우선 선택용)
 */
export function parsePriceFromSummaryText(text: string, maxExpectedPrice?: number): string | null {
  if (!text) return null;

  // 1. 결제 관련 명시적 키워드 우선 매칭
  const explicitPayMatch = text.match(
    /(?:결제\s*(?:예정\s*)?금액|주문\s*금액|총\s*결제금액|합계)[^\d]*(\d{1,3}(?:,\d{3})*)\s*원/,
  );
  if (explicitPayMatch) {
    return explicitPayMatch[1].replace(/,/g, '');
  }

  const prices = [...text.matchAll(/(\d{1,3}(?:,\d{3})*)\s*원/g)].map((m) => m[1].replace(/,/g, ''));
  if (prices.length > 0) {
    if (maxExpectedPrice !== undefined) {
      // 할인 금액(-100원 등)을 제외하기 위해 최소 임계값(정가의 50% 또는 1000원 이상) 조건 적용
      const minThreshold = Math.min(1000, maxExpectedPrice * 0.5);
      const salePrice = prices.find((p) => {
        const num = Number(p);
        return num < maxExpectedPrice && num >= minThreshold;
      });
      if (salePrice) return salePrice;

      // 정가 금액 일치 항목
      const exactPrice = prices.find((p) => Number(p) === maxExpectedPrice);
      if (exactPrice) return exactPrice;
    }
    return prices[0];
  }
  return null;
}

/**
 * 전체 body 텍스트에서 키워드 기반 금액을 파싱합니다.
 * @param bodyText 대상 본문 텍스트
 */
export function parsePriceFromBodyText(bodyText: string): string | null {
  if (!bodyText) return null;

  const payMatch = bodyText.match(/(?:최종\s*)?결제\s*(?:예정\s*)?금액[^\d]*(\d{1,3}(?:,\d{3})*)/);
  if (payMatch) return payMatch[1].replace(/,/g, '');

  const totalMatch = bodyText.match(/총\s*(?:상품\s*)?금액[^\d]*(\d{1,3}(?:,\d{3})*)/);
  if (totalMatch) return totalMatch[1].replace(/,/g, '');

  const goodsAmtMatch = bodyText.match(/상품금액[^\d]*(\d{1,3}(?:,\d{3})*)/);
  if (goodsAmtMatch) return goodsAmtMatch[1].replace(/,/g, '');

  return null;
}

/**
 * 결제 폼 또는 상품 페이지에서 실제 결제 금액을 추출합니다.
 * @param page Playwright Page 인스턴스
 * @param defaultPoint 추출 실패 시 사용할 기본 금액
 * @param maxExpectedPrice 할인가 식별을 위한 정가 기준값 (예: 5000원권이면 5000, 10000원권이면 10000)
 */
export async function getProductPrice(page: Page, defaultPoint: string, maxExpectedPrice?: number): Promise<string> {
  // 1. 상품 페이지의 할인가/판매가 선택자 탐색
  const goodsPageSelectors = ['.item_price_n', '.item_price_s'];
  for (const sel of goodsPageSelectors) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0) {
        const text = (await el.textContent()) || '';
        const cleaned = text.replace(/[^0-9]/g, '');
        if (cleaned.length >= 3) {
          return cleaned;
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. 결제 폼 주문 요약 영역 탐색 (바로구매 후에 활성화)
  const summarySelectors = [
    '.order_price_total',
    '.order_price',
    '#divOrderSummary',
    '.order_summary',
    '.pay_info',
    '.order_total_price',
    '.price_summary',
    '[class*="summary"]',
    '[class*="total"]',
    '[class*="pay"]',
  ];
  for (const sel of summarySelectors) {
    try {
      const el = page.locator(sel).first();
      if ((await el.count()) > 0) {
        const text = await el.textContent();
        if (text) {
          const parsed = parsePriceFromSummaryText(text, maxExpectedPrice);
          if (parsed) {
            return parsed;
          }
        }
      }
    } catch {
      // ignore
    }
  }

  // 3. Fallback: 페이지 전체 본문 텍스트에서 키워드로 추출
  try {
    const body = page.locator('body');
    const text = await body.textContent();
    if (text) {
      const parsed = parsePriceFromBodyText(text);
      if (parsed) {
        return parsed;
      }
    }
  } catch {
    // ignore
  }

  return defaultPoint;
}
