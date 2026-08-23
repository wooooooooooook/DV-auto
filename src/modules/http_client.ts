import { isAuthExpiredHtml } from './html_parser';
import fs from 'fs';
import path from 'path';
import { request } from 'undici';

export const COOKIE_FILE = path.join(process.cwd(), 'cookies.json');

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface HttpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD';
  headers?: Record<string, string>;
  body?: string | URLSearchParams | Buffer | Uint8Array;
  timeout?: number;
  followRedirects?: boolean;
  maxRedirects?: number;
}

export type HttpResultType = 'SUCCESS' | 'AUTH_EXPIRED' | 'HTTP_ERROR';

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  body: string;
  url: string;
  redirected: boolean;
  resultType: HttpResultType;
}

/**
 * targetUrl에 맞는 Domain/Path를 가진 쿠키만 선별하여 Cookie 헤더 문자열 생성
 */
export function getCookieHeader(targetUrl?: string): string {
  try {
    if (!fs.existsSync(COOKIE_FILE)) {
      return '';
    }
    const content = fs.readFileSync(COOKIE_FILE, 'utf8');
    const cookies: PlaywrightCookie[] = JSON.parse(content);
    if (!Array.isArray(cookies)) return '';

    const nowSeconds = Date.now() / 1000;
    let urlObj: URL | null = null;
    if (targetUrl) {
      try {
        urlObj = new URL(targetUrl);
      } catch (_e) {
        /* ignore */
      }
    }

    const validCookies = cookies.filter((c) => {
      // 1. 만료일 확인
      if (c.expires && c.expires > 0 && c.expires < nowSeconds) {
        return false;
      }

      // 2. targetUrl 매칭 확인 (도메인 / 경로)
      if (urlObj) {
        const hostname = urlObj.hostname.toLowerCase();
        let cookieDomain = (c.domain || '').toLowerCase();
        if (cookieDomain.startsWith('.')) {
          cookieDomain = cookieDomain.slice(1);
        }

        // 도메인 매칭 검사
        const isDomainMatch =
          hostname === cookieDomain || hostname.endsWith('.' + cookieDomain) || cookieDomain.endsWith('.' + hostname);

        if (!isDomainMatch) return false;

        // 경로 매칭 검사
        if (c.path && !urlObj.pathname.startsWith(c.path)) {
          return false;
        }
      }

      return true;
    });

    return validCookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } catch (_e) {
    return '';
  }
}

/**
 * 공통 HTTP 클라이언트 요청 함수
 */
export async function sendDoctorVilleRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  const method = options.method || 'GET';
  const cookieHeader = getCookieHeader(url);
  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
    ...options.headers,
  };

  if (cookieHeader) {
    headers['Cookie'] = cookieHeader;
  }

  const timeoutMs = options.timeout ?? 15000;
  const followRedirects = options.followRedirects ?? true;
  const maxRedirects = options.maxRedirects ?? 5;

  let currentUrl = url;
  let redirectCount = 0;
  let isRedirected = false;

  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let bodyData: string | Buffer | Uint8Array | undefined = undefined;
      if (options.body instanceof URLSearchParams) {
        bodyData = options.body.toString();
        if (!headers['Content-Type']) {
          headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      } else {
        bodyData = options.body;
      }

      const res = await request(currentUrl, {
        method,
        headers,
        body: bodyData,
        signal: controller.signal,
      });

      clearTimeout(timer);

      const status = res.statusCode;
      const resHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(res.headers)) {
        if (value !== undefined) {
          resHeaders[key.toLowerCase()] = value;
        }
      }

      // redirect 처리 (301, 302, 303, 307, 308)
      if (followRedirects && [301, 302, 303, 307, 308].includes(status)) {
        const location = resHeaders['location'];
        const locationUrl = Array.isArray(location) ? location[0] : location;
        if (locationUrl && redirectCount < maxRedirects) {
          redirectCount++;
          isRedirected = true;
          currentUrl = new URL(locationUrl, currentUrl).toString();
          // drain body
          await res.body.text().catch(() => {});
          continue;
        }
      }

      const responseText = await res.body.text();

      let resultType: HttpResultType = 'SUCCESS';
      if (status !== 200) {
        resultType = 'HTTP_ERROR';
      } else if (isAuthExpiredHtml(responseText)) {
        resultType = 'AUTH_EXPIRED';
      }

      return {
        status,
        statusText: String(status),
        headers: resHeaders,
        body: responseText,
        url: currentUrl,
        redirected: isRedirected,
        resultType,
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      const errMessage =
        err && typeof err === 'object' && 'name' in err && (err as Error).name === 'AbortError'
          ? `HTTP request timed out after ${timeoutMs}ms: ${url}`
          : err instanceof Error
            ? err.message
            : String(err);

      return {
        status: 0,
        statusText: errMessage,
        headers: {},
        body: '',
        url: currentUrl,
        redirected: isRedirected,
        resultType: 'HTTP_ERROR',
      };
    }
  }
}

/**
 * GET 요청 헬퍼
 */
export async function httpGet(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
  return sendDoctorVilleRequest(url, { method: 'GET', headers });
}

/**
 * POST Form 요청 헬퍼
 */
export async function httpPostForm(
  url: string,
  formData: Record<string, string>,
  headers?: Record<string, string>,
): Promise<HttpResponse> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(formData)) {
    params.append(k, v);
  }
  return sendDoctorVilleRequest(url, {
    method: 'POST',
    body: params,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    },
  });
}

/**
 * JSON GET/POST 헬퍼
 */
export async function httpGetJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const res = await sendDoctorVilleRequest(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json, text/plain, */*',
      ...headers,
    },
  });
  return JSON.parse(res.body) as T;
}
