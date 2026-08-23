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

export interface HttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string | string[]>;
  body: string;
  url: string;
  redirected: boolean;
}

/**
 * cookies.json 파일에서 Playwright 쿠키 목록을 읽고, Cookie 헤더 문자열을 작성한다.
 */
export function getCookieHeader(): string {
  try {
    if (!fs.existsSync(COOKIE_FILE)) {
      return '';
    }
    const content = fs.readFileSync(COOKIE_FILE, 'utf8');
    const cookies: PlaywrightCookie[] = JSON.parse(content);
    if (!Array.isArray(cookies)) return '';

    const nowSeconds = Date.now() / 1000;
    const validCookies = cookies.filter((c) => {
      if (c.expires && c.expires > 0 && c.expires < nowSeconds) {
        return false;
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
  const cookieHeader = getCookieHeader();
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

      return {
        status,
        statusText: String(status),
        headers: resHeaders,
        body: responseText,
        url: currentUrl,
        redirected: isRedirected,
      };
    } catch (err: unknown) {
      clearTimeout(timer);
      if (err && typeof err === 'object' && 'name' in err && (err as Error).name === 'AbortError') {
        throw new Error(`HTTP request timed out after ${timeoutMs}ms: ${url}`);
      }
      throw err;
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
