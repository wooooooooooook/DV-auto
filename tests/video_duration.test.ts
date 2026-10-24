import { describe, it, expect, vi, beforeEach } from 'vitest';
import { request } from 'undici';
import { getVideoDurationSeconds } from '../src/modules/video_duration';

vi.mock('undici', () => ({
  request: vi.fn(),
}));

const mockRequest = vi.mocked(request);

function createMockResponse(
  bytes: Buffer | string,
  init: { statusCode?: number; headers?: Record<string, string> } = {},
) {
  const buffer = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes;
  return {
    statusCode: init.statusCode ?? 200,
    headers: init.headers ?? {},
    body: {
      arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
      dump: async () => undefined,
      destroy: () => undefined,
      [Symbol.asyncIterator]: async function* () {
        yield buffer;
      },
    },
  } as unknown as Awaited<ReturnType<typeof request>>;
}

/**
 * mvhd(timescale=duration*timescale) 를 포함한 최소 MP4 버퍼를 만듭니다.
 */
function createMp4Buffer(durationSeconds: number, timescale = 1000): Buffer {
  const mvhdSize = 108;
  const mvhd = Buffer.alloc(mvhdSize);
  mvhd.writeUInt32BE(mvhdSize, 0);
  mvhd.write('mvhd', 4, 'latin1');
  mvhd[8] = 0; // version
  mvhd.writeUInt32BE(0, 12); // creation_time
  mvhd.writeUInt32BE(0, 16); // modification_time
  mvhd.writeUInt32BE(timescale, 20);
  mvhd.writeUInt32BE(Math.round(durationSeconds * timescale), 24);

  const moov = Buffer.alloc(8 + mvhdSize);
  moov.writeUInt32BE(8 + mvhdSize, 0);
  moov.write('moov', 4, 'latin1');
  mvhd.copy(moov, 8);

  const ftyp = Buffer.alloc(24);
  ftyp.writeUInt32BE(24, 0);
  ftyp.write('ftyp', 4, 'latin1');
  ftyp.write('isom', 8, 'latin1');

  return Buffer.concat([ftyp, moov]);
}

describe('video_duration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('MP4 mvhd(timescale/duration)로 영상 길이를 계산한다', async () => {
    const mp4 = createMp4Buffer(125);
    mockRequest.mockResolvedValueOnce(
      createMockResponse(mp4, {
        statusCode: 206,
        headers: { 'content-range': `bytes 0-${mp4.length - 1}/${mp4.length}` },
      }),
    );

    await expect(getVideoDurationSeconds('https://cdn.example.com/v/movie.mp4?signature=abc')).resolves.toBe(125);
  });

  it('moov 박스가 파일 끝에 있으면 tail range 요청으로 탐색한다', async () => {
    const total = 5_000_000;
    const head = Buffer.alloc(100, 0);
    const tail = Buffer.concat([Buffer.alloc(64, 0), createMp4Buffer(300)]);
    const tailStart = total - 2 * 1024 * 1024;

    mockRequest
      .mockResolvedValueOnce(
        createMockResponse(head, {
          statusCode: 206,
          headers: { 'content-range': `bytes 0-99/${total}` },
        }),
      )
      .mockResolvedValueOnce(
        createMockResponse(tail, {
          statusCode: 206,
          headers: { 'content-range': `bytes ${tailStart}-${total - 1}/${total}` },
        }),
      );

    await expect(getVideoDurationSeconds('https://cdn.example.com/v/long.mp4')).resolves.toBe(300);

    const secondCallHeaders = mockRequest.mock.calls[1]?.[1]?.headers as Record<string, string> | undefined;
    expect(secondCallHeaders?.Range).toBe(`bytes=${tailStart}-${total - 1}`);
  });

  it('리다이렉트(301/302)는 Location을 따라가서 길이를 확인한다', async () => {
    const mp4 = createMp4Buffer(42);
    mockRequest
      .mockResolvedValueOnce(
        createMockResponse('', { statusCode: 302, headers: { location: 'https://cdn.example.com/v/moved.mp4' } }),
      )
      .mockResolvedValueOnce(
        createMockResponse(mp4, {
          statusCode: 206,
          headers: { 'content-range': `bytes 0-${mp4.length - 1}/${mp4.length}` },
        }),
      );

    await expect(getVideoDurationSeconds('https://cdn.example.com/v/original.mp4')).resolves.toBe(42);
    expect(String(mockRequest.mock.calls[1]?.[0])).toBe('https://cdn.example.com/v/moved.mp4');
  });

  it('HLS 미디어 플레이리스트의 #EXTINF 합계를 사용한다', async () => {
    const playlist = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXTINF:10.5,',
      'segment1.ts',
      '#EXTINF:9.5,',
      'segment2.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    mockRequest.mockResolvedValueOnce(createMockResponse(playlist));

    await expect(getVideoDurationSeconds('https://cdn.example.com/v/hls/index.m3u8')).resolves.toBe(20);
  });

  it('HLS 마스터 플레이리스트는 대역폭이 가장 높은 variant를 따라간다', async () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=500000',
      'low/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
      'high/index.m3u8',
    ].join('\n');
    const media = ['#EXTM3U', '#EXTINF:7,', 'a.ts', '#EXTINF:8,', 'b.ts'].join('\n');

    mockRequest.mockResolvedValueOnce(createMockResponse(master)).mockResolvedValueOnce(createMockResponse(media));

    await expect(getVideoDurationSeconds('https://cdn.example.com/v/master.m3u8')).resolves.toBe(15);
    expect(String(mockRequest.mock.calls[1]?.[0])).toBe('https://cdn.example.com/v/high/index.m3u8');
  });

  it('YouTube URL은 watch 페이지의 lengthSeconds로 길이를 확인한다', async () => {
    const html =
      '<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"Zv1lh1TKc2o","lengthSeconds":"1048"}};</script>';
    mockRequest.mockResolvedValueOnce(createMockResponse(html));

    await expect(getVideoDurationSeconds('https://youtu.be/Zv1lh1TKc2o')).resolves.toBe(1048);
    expect(String(mockRequest.mock.calls[0]?.[0])).toBe('https://www.youtube.com/watch?v=Zv1lh1TKc2o&hl=ko');
  });

  it('YouTube Shorts URL도 watch 페이지로 변환해 길이를 확인한다', async () => {
    const html = '{"lengthSeconds":"112"}';
    mockRequest.mockResolvedValueOnce(createMockResponse(html));

    await expect(getVideoDurationSeconds('https://www.youtube.com/shorts/BL6DYiSalBc')).resolves.toBe(112);
    expect(String(mockRequest.mock.calls[0]?.[0])).toBe('https://www.youtube.com/watch?v=BL6DYiSalBc&hl=ko');
  });

  it('YouTube 페이지에 길이 정보가 없으면 null을 반환한다', async () => {
    mockRequest.mockResolvedValueOnce(createMockResponse('<html>consent</html>'));

    await expect(getVideoDurationSeconds('https://www.youtube.com/watch?v=abc')).resolves.toBeNull();
  });

  it('길이를 확인할 수 없으면 null을 반환한다', async () => {
    mockRequest.mockResolvedValue(createMockResponse(Buffer.alloc(64, 1)));

    await expect(getVideoDurationSeconds('https://cdn.example.com/v/unknown.mp4')).resolves.toBeNull();
  });

  it('요청이 실패하면 null을 반환한다', async () => {
    mockRequest.mockRejectedValue(new Error('network down'));

    await expect(getVideoDurationSeconds('https://cdn.example.com/v/error.mp4')).resolves.toBeNull();
  });
});
