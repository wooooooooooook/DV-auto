import { request } from 'undici';
import * as logger from '../services/logger';

/**
 * 닥플캐스트 VOD의 영상 길이를 서명된 영상 URL만으로 추정합니다.
 *
 * 서버는 `watch/progress` 의 watchedEnd(재생 위치)가 영상 길이를 넘으면
 * POSITION_EXCEEDS_DURATION 으로 거부하기 때문에, 보고 위치를 영상 길이 이내로
 * 제한하려면 영상 길이를 알아야 합니다.
 *
 * - HLS(.m3u8): #EXTINF 세그먼트 길이 합계
 * - MP4: mvhd 박스의 duration / timescale (moov가 파일 끝에 있어도 tail range 요청으로 탐색)
 */

const PROBE_TIMEOUT_MS = 8000;
const HEAD_BYTES = 512 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_PLAUSIBLE_SECONDS = 6 * 60 * 60;
const MAX_PROBE_BODY_BYTES = 8 * 1024 * 1024;
const MAX_YOUTUBE_HTML_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface ProbeResponse {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  bytes: Buffer;
}

function headerValue(headers: ProbeResponse['headers'], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === 'string' ? value : undefined;
}

async function fetchProbe(url: string, range?: string, redirectsLeft = MAX_REDIRECTS): Promise<ProbeResponse | null> {
  try {
    const res = await request(url, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Referer: 'https://docple-plus.com/',
        Accept: '*/*',
        ...(range ? { Range: range } : {}),
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (res.statusCode >= 300 && res.statusCode < 400) {
      const location = headerValue(res.headers, 'location');
      await res.body.dump().catch(() => undefined);
      if (!location || redirectsLeft <= 0) return null;
      return fetchProbe(new URL(location, url).toString(), range, redirectsLeft - 1);
    }

    if (res.statusCode >= 400) {
      await res.body.dump().catch(() => undefined);
      return null;
    }

    // Range 를 무시하고 전체 파일을 내려주는 서버에서 큰 영상을 통째로 받지 않도록 방어
    const contentLength = Number(headerValue(res.headers, 'content-length'));
    if (Number.isFinite(contentLength) && contentLength > MAX_PROBE_BODY_BYTES) {
      await res.body.dump().catch(() => undefined);
      return null;
    }

    const bytes = Buffer.from(await res.body.arrayBuffer());
    return { statusCode: res.statusCode, headers: res.headers, bytes };
  } catch (error) {
    logger.debug('video_duration: probe request failed', error instanceof Error ? error.message : error);
    return null;
  }
}

function toPlausibleSeconds(seconds: number | null): number | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  if (seconds <= 0.5 || seconds > MAX_PLAUSIBLE_SECONDS) return null;
  return seconds;
}

/**
 * 버퍼 안에서 mvhd 박스를 찾아 duration/timescale(초)을 계산합니다.
 */
function findMvhdDuration(buf: Buffer): number | null {
  if (buf.length < 24) return null;

  let idx = buf.indexOf('mvhd', 0, 'latin1');
  while (idx >= 0) {
    const boxStart = idx - 4;
    const payload = idx + 4;
    if (boxStart >= 0) {
      const boxSize = buf.readUInt32BE(boxStart);
      if (boxSize >= 16) {
        const version = buf[payload];
        if (version === 0 && payload + 20 <= buf.length) {
          const timescale = buf.readUInt32BE(payload + 12);
          const duration = buf.readUInt32BE(payload + 16);
          const seconds = timescale > 0 ? toPlausibleSeconds(duration / timescale) : null;
          if (seconds) return seconds;
        } else if (version === 1 && payload + 32 <= buf.length) {
          const timescale = buf.readUInt32BE(payload + 20);
          const duration = Number(buf.readBigUInt64BE(payload + 24));
          const seconds = timescale > 0 ? toPlausibleSeconds(duration / timescale) : null;
          if (seconds) return seconds;
        }
      }
    }
    idx = buf.indexOf('mvhd', idx + 4, 'latin1');
  }

  return null;
}

function parseTotalSize(contentRange: string | undefined): number | null {
  if (!contentRange) return null;
  const match = contentRange.match(/bytes\s+\d+-\d+\/(\d+)/i);
  if (!match) return null;
  const total = Number(match[1]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

async function fetchMp4Duration(url: string): Promise<number | null> {
  const head = await fetchProbe(url, `bytes=0-${HEAD_BYTES - 1}`);
  if (!head) return null;

  const fromHead = findMvhdDuration(head.bytes);
  if (fromHead) return fromHead;

  const total = parseTotalSize(headerValue(head.headers, 'content-range'));
  if (!total || head.statusCode !== 206 || total <= head.bytes.length) return null;

  const tailStart = Math.max(0, total - TAIL_BYTES);
  if (tailStart + head.bytes.length >= total) return null;

  const tail = await fetchProbe(url, `bytes=${tailStart}-${total - 1}`);
  if (!tail) return null;

  return findMvhdDuration(tail.bytes);
}

async function fetchHlsDuration(url: string, depth: number): Promise<number | null> {
  if (depth > 2) return null;

  const res = await fetchProbe(url);
  if (!res) return null;

  const text = res.bytes.toString('utf8');
  if (!text.includes('#EXTM3U')) return null;

  if (text.includes('#EXT-X-STREAM-INF')) {
    const lines = text.split(/\r?\n/);
    let best: { bandwidth: number; uri: string } | null = null;
    for (let i = 0; i < lines.length; i += 1) {
      const match = lines[i].match(/#EXT-X-STREAM-INF:.*BANDWIDTH=(\d+)/);
      if (!match) continue;
      const uriLine = lines.slice(i + 1).find((line) => line.trim() && !line.trim().startsWith('#'));
      if (!uriLine) continue;
      const bandwidth = Number(match[1]);
      if (!best || bandwidth > best.bandwidth) {
        best = { bandwidth, uri: uriLine.trim() };
      }
    }
    if (!best) return null;
    return fetchHlsDuration(new URL(best.uri, url).toString(), depth + 1);
  }

  let total = 0;
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/#EXTINF:\s*([\d.]+)/);
    if (!match) continue;
    const seconds = Number(match[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) continue;
    total += seconds;
    found = true;
  }

  return found ? toPlausibleSeconds(total) : null;
}

function extractYouTubeVideoId(url: URL): string | null {
  if (/(^|\.)youtu\.be$/i.test(url.hostname)) {
    return url.pathname.split('/').filter(Boolean)[0] || null;
  }
  if (!/(^|\.)youtube\.com$/i.test(url.hostname)) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts[0] === 'watch') return url.searchParams.get('v');
  if (parts[0] === 'shorts' || parts[0] === 'embed' || parts[0] === 'live') return parts[1] || null;
  return null;
}

/**
 * YouTube watch 페이지의 lengthSeconds 메타데이터로 길이를 확인합니다.
 * (Shorts 도 /watch?v= 페이지에서 동일하게 확인 가능)
 */
async function fetchYouTubeLengthSeconds(videoId: string): Promise<number | null> {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=ko`;
  try {
    const res = await request(watchUrl, {
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (res.statusCode < 200 || res.statusCode >= 300) {
      await res.body.dump().catch(() => undefined);
      return null;
    }

    // 페이지 전체(1~2MB)를 메모리에 쌓지 않고, lengthSeconds 가 나오는 즉시 중단합니다.
    let total = 0;
    let buffered = '';
    for await (const chunk of res.body) {
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : Buffer.from(chunk as Uint8Array).toString('utf8');
      buffered += text;
      total += text.length;

      const match = buffered.match(/"lengthSeconds":"(\d+)"/);
      if (match) return toPlausibleSeconds(Number(match[1]));
      if (total > MAX_YOUTUBE_HTML_BYTES) break;
      if (buffered.length > 16_384) buffered = buffered.slice(-8192);
    }

    return null;
  } catch (error) {
    logger.debug('video_duration: youtube probe failed', error instanceof Error ? error.message : error);
    return null;
  }
}

/**
 * 영상 URL에서 재생 길이(초)를 반환합니다. 확인할 수 없으면 null.
 */
export async function getVideoDurationSeconds(videoUrl?: string | null): Promise<number | null> {
  if (!videoUrl) return null;

  let url: URL;
  try {
    url = new URL(videoUrl);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  try {
    const youtubeVideoId = extractYouTubeVideoId(url);
    if (youtubeVideoId) return await fetchYouTubeLengthSeconds(youtubeVideoId);

    if (/\.m3u8$/i.test(url.pathname)) {
      return await fetchHlsDuration(videoUrl, 0);
    }

    const mp4Duration = await fetchMp4Duration(videoUrl);
    if (mp4Duration) return mp4Duration;

    // 파일 확장자가 없는 URL은 HLS로 서빙될 수 있으므로 보조 탐색
    if (/\.[a-z0-9]{2,5}$/i.test(url.pathname)) return null;
    return await fetchHlsDuration(videoUrl, 0);
  } catch (error) {
    logger.debug('video_duration: failed to resolve duration', error instanceof Error ? error.message : error);
    return null;
  }
}
