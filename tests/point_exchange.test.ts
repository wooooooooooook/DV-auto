import { describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import {
  getProductPrice,
  parsePriceFromBodyText,
  parsePriceFromSummaryText,
} from '../src/modules/point_exchange_utils';
import * as pointExchangeTask from '../src/tasks/point_exchange';

describe('point_exchange_utils', () => {
  describe('parsePriceFromSummaryText', () => {
    it('단일 금액 텍스트에서 금액을 정확히 추출한다', () => {
      expect(parsePriceFromSummaryText('총 결제금액: 4,900원')).toBe('4900');
      expect(parsePriceFromSummaryText('9,700원')).toBe('9700');
      expect(parsePriceFromSummaryText('3,000 원')).toBe('3000');
    });

    it('정가와 할인가가 함께 있을 때 정가 미만의 할인가를 우선 선택한다', () => {
      const summaryText = '상품금액 5,000원 할인금액 -100원 결제금액 4,900원';
      expect(parsePriceFromSummaryText(summaryText, 5000)).toBe('4900');
    });

    it('키워드 없는 가격 목록에서 작은 할인액(-100원 등)을 건너뛰고 올바른 상품 결제금액을 선택한다', () => {
      const priceListText = '5,000원 100원 4,900원';
      expect(parsePriceFromSummaryText(priceListText, 5000)).toBe('4900');
    });

    it('할인가가 없는 경우 정가 금액을 반환한다', () => {
      const summaryText = '상품 5,000원';
      expect(parsePriceFromSummaryText(summaryText, 5000)).toBe('5000');
    });

    it('매칭되는 금액이 없거나 빈 문자열이면 null을 반환한다', () => {
      expect(parsePriceFromSummaryText('')).toBeNull();
      expect(parsePriceFromSummaryText('금액 정보 없음')).toBeNull();
    });
  });

  describe('parsePriceFromBodyText', () => {
    it('상품금액 키워드에서 금액을 추출한다', () => {
      expect(parsePriceFromBodyText('상품금액: 4,900원')).toBe('4900');
      expect(parsePriceFromBodyText('상품금액 9,700')).toBe('9700');
    });

    it('결제 금액 키워드에서 금액을 추출한다', () => {
      expect(parsePriceFromBodyText('최종 결제 금액 : 5,000원')).toBe('5000');
    });

    it('총 금액 키워드에서 금액을 추출한다', () => {
      expect(parsePriceFromBodyText('총 상품 금액 3,000')).toBe('3000');
    });

    it('매칭되지 않는 경우 null을 반환한다', () => {
      expect(parsePriceFromBodyText('')).toBeNull();
      expect(parsePriceFromBodyText('무관한 본문 텍스트')).toBeNull();
    });
  });

  describe('getProductPrice with mock page', () => {
    it('상품 상세 페이지 선택자(.item_price_n)가 있으면 즉시 추출한다', async () => {
      const mockPage = {
        locator: vi.fn((sel: string) => {
          if (sel === '.item_price_n') {
            return {
              first: () => ({
                count: async () => 1,
                textContent: async () => '4,900원',
              }),
            };
          }
          return {
            first: () => ({
              count: async () => 0,
              textContent: async () => null,
            }),
          };
        }),
      } as unknown as Page;

      const price = await getProductPrice(mockPage, '5000', 5000);
      expect(price).toBe('4900');
    });

    it('주문 요약 영역(#divOrderSummary)에서 할인가를 추출한다', async () => {
      const mockPage = {
        locator: vi.fn((sel: string) => {
          if (sel === '#divOrderSummary') {
            return {
              first: () => ({
                count: async () => 1,
                textContent: async () => '상품가 10,000원 결제예정금액 9,900원',
              }),
            };
          }
          return {
            first: () => ({
              count: async () => 0,
              textContent: async () => null,
            }),
          };
        }),
      } as unknown as Page;

      const price = await getProductPrice(mockPage, '10000', 10000);
      expect(price).toBe('9900');
    });

    it('모든 탐색 실패 시 defaultPoint로 fallback한다', async () => {
      const mockPage = {
        locator: vi.fn(() => ({
          first: () => ({
            count: async () => 0,
            textContent: async () => null,
          }),
          textContent: async () => null,
        })),
      } as unknown as Page;

      const price = await getProductPrice(mockPage, '9900', 10000);
      expect(price).toBe('9900');
    });
  });
});

describe('point_exchange URL and guid helpers', () => {
  it('guid 문자열이 입력되면 올바른 포인트몰 URL을 생성한다', () => {
    const url = pointExchangeTask.resolveTargetUrl('14131415');
    expect(url).toBe('https://mcircle.bizmarketb2b.com/Goods/Content.aspx?guid=14131415&catecode=14592');
  });

  it('전체 URL이 입력되면 그대로 반환한다', () => {
    const fullUrl = 'https://mcircle.bizmarketb2b.com/Goods/Content.aspx?guid=14152303&catecode=14592&eventuid=21006';
    const url = pointExchangeTask.resolveTargetUrl(fullUrl);
    expect(url).toBe(fullUrl);
  });

  it('URL에서 guid를 정확히 추출한다', () => {
    expect(
      pointExchangeTask.extractGuidFromUrl(
        'https://mcircle.bizmarketb2b.com/Goods/Content.aspx?guid=14627547&catecode=14592',
      ),
    ).toBe('14627547');
    expect(pointExchangeTask.extractGuidFromUrl('14627547')).toBe('14627547');
  });
});

describe('Point Exchange Task execution check', () => {
  it('point_exchange 모듈에 run 함수가 정의되어 있어야 한다', () => {
    expect(typeof pointExchangeTask.run).toBe('function');
  });

  it('상품 대상(URL 또는 guid)이 지정되지 않으면 실패해야 한다', async () => {
    const mockPage = {} as unknown as Page;
    const mockContext = {} as unknown as BrowserContext;

    const res = await pointExchangeTask.run({ page: mockPage, context: mockContext });
    expect(res.success).toBe(false);
  });

  it('환경변수가 없으면 태스크 실행 시 실패를 반환해야 한다', async () => {
    const originalEnv = { ...process.env };
    delete process.env.USER_NAME;
    delete process.env.USER_PHONE_1;

    try {
      const mockPage = {} as unknown as Page;
      const mockContext = {} as unknown as BrowserContext;

      const res = await pointExchangeTask.run({
        page: mockPage,
        context: mockContext,
        args: { guid: '14131415' },
      });
      expect(res.success).toBe(false);
    } finally {
      process.env = originalEnv;
    }
  });
});
