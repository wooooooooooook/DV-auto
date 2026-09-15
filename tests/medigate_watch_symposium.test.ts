import { describe, it, expect, vi, beforeEach } from 'vitest';
import { request } from 'undici';
import {
  MedigateClient,
  type MedigateWatchResult,
  type MedigateWatchWorkflowResult,
  type MedigateLiveSession,
} from '../src/modules/medigate_api';
import { formatMedigateWatchMessage, run as runMedigateWatch } from '../src/tasks/medigate_watch_symposium';

vi.mock('undici', () => ({
  request: vi.fn(),
}));

const mockRequest = vi.mocked(request);

describe('Medigate Watch Symposium Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('단일 심포지움 시청 성공 메시지 포맷팅 테스트', () => {
    const mockResult: MedigateWatchResult = {
      webinarIdx: 5011,
      subject: 'Semaglutide Evidence-based Management of Diabetes and Obesity',
      success: true,
      message: '성공적으로 30분 동안 시청(Heartbeat 15회)을 완료했습니다.',
      startedAt: '2026-09-14T19:00:00.000Z',
      endedAt: '2026-09-14T19:30:00.000Z',
      durationMinutes: 30,
      heartbeatCount: 15,
      surveyUrl: 'https://att.nownsurvey.com/att/intro/sem-live/eno/0167538',
      platform: 'nownnow',
    };

    const msg = formatMedigateWatchMessage(mockResult);
    expect(msg).toContain('🩺 [메디게이트 심포지움 시청 완료]');
    expect(msg).toContain('[5011] Semaglutide Evidence-based Management of Diabetes and Obesity');
    expect(msg).toContain('⏱️ 시청 시간: 30분 (Heartbeat 15회 전송)');
    expect(msg).toContain('📡 플랫폼: nownnow');
    expect(msg).toContain('📝 설문 링크: https://att.nownsurvey.com/att/intro/sem-live/eno/0167538');
  });

  it('단일 심포지움 시청 실패 메시지 포맷팅 테스트', () => {
    const mockResult: MedigateWatchResult = {
      webinarIdx: 5011,
      subject: 'Semaglutide 웨비나',
      success: false,
      message: '시청 URL 발급 실패 (방송 시작 전이거나 신청되지 않음)',
      startedAt: '2026-09-14T19:00:00.000Z',
      endedAt: '2026-09-14T19:00:00.000Z',
      durationMinutes: 0,
      heartbeatCount: 0,
      platform: 'unknown',
    };

    const msg = formatMedigateWatchMessage(mockResult);
    expect(msg).toContain('❌ [메디게이트 심포지움 시청 실패]');
    expect(msg).toContain('[5011] Semaglutide 웨비나');
    expect(msg).toContain('⚠️ 사유: 시청 URL 발급 실패');
  });

  it('전체 On-Air 자동 시청 워크플로우 메시지 포맷팅 테스트', () => {
    const mockWorkflowResult: MedigateWatchWorkflowResult = {
      success: true,
      message: 'On-Air 심포지움 시청 완료',
      userName: '김영욱',
      userId: 'nubiz',
      totalOnAir: 2,
      watchedCount: 1,
      failedCount: 1,
      results: [
        {
          webinarIdx: 5011,
          subject: 'Semaglutide 심포지움',
          success: true,
          message: '시청 완료',
          startedAt: '2026-09-14T19:00:00.000Z',
          endedAt: '2026-09-14T19:30:00.000Z',
          durationMinutes: 30,
          heartbeatCount: 15,
          surveyUrl: 'https://att.nownsurvey.com/att/intro/sem-live/eno/0167538',
          platform: 'nownnow',
        },
        {
          webinarIdx: 5012,
          subject: '크로노트랙 웨비나',
          success: false,
          message: '시청 URL 획득 실패',
          startedAt: '2026-09-14T19:00:00.000Z',
          endedAt: '2026-09-14T19:00:00.000Z',
          durationMinutes: 0,
          heartbeatCount: 0,
          platform: 'unknown',
        },
      ],
    };

    const msg = formatMedigateWatchMessage(mockWorkflowResult);
    expect(msg).toContain('🩺 [메디게이트 On-Air 심포지움 자동 시청]');
    expect(msg).toContain('김영욱님 (nubiz)');
    expect(msg).toContain('On-Air 진행 중 2개 (시청 완료 1건 / 실패 1건)');
    expect(msg).toContain('✅ [5011] Semaglutide 심포지움');
    expect(msg).toContain('⚠️ [5012] 크로노트랙 웨비나');
  });

  it('On-Air 심포지움이 없는 경우 메시지 포맷팅 테스트', () => {
    const mockWorkflowResult: MedigateWatchWorkflowResult = {
      success: true,
      message: '현재 On-Air(진행 중)인 심포지움이 없습니다.',
      userName: '김영욱',
      userId: 'nubiz',
      totalOnAir: 0,
      watchedCount: 0,
      failedCount: 0,
      results: [],
    };

    const msg = formatMedigateWatchMessage(mockWorkflowResult);
    expect(msg).toContain('ℹ️ 현재 방송 진행 중인(On-Air) 심포지움이 없습니다.');
  });

  it('MedigateClient.sendSymposiumHeartbeat nownnow 플랫폼 전송 테스트', async () => {
    const client = new MedigateClient({
      accessToken: 'test-token',
    });

    const mockSession: MedigateLiveSession = {
      webinarIdx: 5011,
      subject: 'Semaglutide 웨비나',
      watchUrl: 'https://sem-live.nownnow.com?ememer_seq=0167538&webinar_seq=5011',
      platform: 'nownnow',
      cookieHeader: 'webinar=test-sess-cookie',
      roomUrl: 'https://webinar.nownnow.com/aspservice/include/webinar/room/room_sem-live.php?play_type=live',
      heartbeatUrl: 'https://webinar.nownnow.com/aspservice/include/webinar/room/videoClose_mj.php',
      heartbeatParams: {
        agent: 'medigate',
        nAspNo: '477',
        hAspCode: 'sem-live',
        userid: '477_1789380106890',
        username: '0167538',
        connType: 'PC',
        emailaddr: '',
        sess_id: 'test-sess-cookie',
        nUserIdn: '1716398',
        webinar_seq: '5011',
        webinarTitle: 'live',
      },
      surveyUrl: 'https://att.nownsurvey.com/att/intro/sem-live/eno/0167538',
    };

    mockRequest.mockResolvedValueOnce({
      statusCode: 200,
      headers: {},
      body: {
        text: async () => 'survey|||command',
      },
    } as unknown as Awaited<ReturnType<typeof request>>);

    const hbRes = await client.sendSymposiumHeartbeat(mockSession);
    expect(hbRes.success).toBe(true);
    expect(hbRes.status).toBe(200);
    expect(hbRes.surveyTriggered).toBe(true);
    expect(hbRes.surveyUrl).toBe('https://att.nownsurvey.com/att/intro/sem-live/eno/0167538');
  });

  it('MedigateClient.watchSymposiumLive 단기 시청 루프 테스트', async () => {
    const client = new MedigateClient({
      accessToken: 'test-token',
    });

    vi.spyOn(client, 'enterSymposiumLive').mockResolvedValueOnce({
      success: true,
      message: '세션 초기화 성공',
      session: {
        webinarIdx: 5011,
        subject: 'Semaglutide 웨비나',
        watchUrl: 'https://sem-live.nownnow.com',
        platform: 'nownnow',
      },
    });

    vi.spyOn(client, 'sendSymposiumHeartbeat').mockResolvedValue({
      success: true,
      status: 200,
      message: '성공',
    });

    // 0.001분 (0.06초) 동안 interval 0.02초로 테스트
    const watchRes = await client.watchSymposiumLive(5011, {
      durationMinutes: 0.001,
      intervalSeconds: 0.02,
    });

    expect(watchRes.success).toBe(true);
    expect(watchRes.webinarIdx).toBe(5011);
    expect(watchRes.heartbeatCount).toBeGreaterThanOrEqual(1);
    expect(watchRes.platform).toBe('nownnow');
  });

  it('run 태스크 실행 테스트 - 특정 webinarIdx 지정', async () => {
    vi.spyOn(MedigateClient.prototype, 'watchSymposiumLive').mockResolvedValueOnce({
      webinarIdx: 5011,
      subject: 'Semaglutide 웨비나',
      success: true,
      message: '시청 완료',
      startedAt: '2026-09-14T19:00:00.000Z',
      endedAt: '2026-09-14T19:30:00.000Z',
      durationMinutes: 30,
      heartbeatCount: 15,
      platform: 'nownnow',
    });

    const res = await runMedigateWatch({ args: { webinarIdx: '5011', duration: '30' } });
    expect(res.success).toBe(true);
    expect(res.message).toContain('[5011] Semaglutide 웨비나');
    expect(res.options?.durationMinutes).toBe(30);
  });

  it('run 태스크 실행 테스트 - On-Air 전체 자동 시청', async () => {
    vi.spyOn(MedigateClient.prototype, 'watchAllOnAirSymposiums').mockResolvedValueOnce({
      success: true,
      message: '완료',
      userName: '테스터',
      userId: 'testuser',
      totalOnAir: 1,
      watchedCount: 1,
      failedCount: 0,
      results: [
        {
          webinarIdx: 5011,
          subject: 'Semaglutide 웨비나',
          success: true,
          message: '시청 완료',
          startedAt: '2026-09-14T19:00:00.000Z',
          endedAt: '2026-09-14T19:30:00.000Z',
          durationMinutes: 30,
          heartbeatCount: 15,
          platform: 'nownnow',
        },
      ],
    });

    const res = await runMedigateWatch();
    expect(res.success).toBe(true);
    expect(res.message).toContain('On-Air 심포지움 자동 시청');
    expect(res.options?.watchedCount).toBe(1);
    expect(res.silent).toBe(false);
  });

  it('run 태스크 실행 테스트 - On-Air 없을 때 silent: true 적용', async () => {
    vi.spyOn(MedigateClient.prototype, 'watchAllOnAirSymposiums').mockResolvedValueOnce({
      success: true,
      message: '현재 On-Air(진행 중)인 심포지움이 없습니다.',
      userName: '테스터',
      userId: 'testuser',
      totalOnAir: 0,
      watchedCount: 0,
      failedCount: 0,
      results: [],
    });

    const res = await runMedigateWatch();
    expect(res.success).toBe(true);
    expect(res.silent).toBe(true);
    expect(res.options?.shouldNotify).toBe(false);
  });

  it('run 태스크 실행 테스트 - duration 미지정 시 기본 20분 적용', async () => {
    const watchSpy = vi.spyOn(MedigateClient.prototype, 'watchSymposiumLive').mockResolvedValueOnce({
      webinarIdx: 5011,
      subject: 'Semaglutide 웨비나',
      success: true,
      message: '시청 완료',
      startedAt: '2026-09-14T19:00:00.000Z',
      endedAt: '2026-09-14T19:20:00.000Z',
      durationMinutes: 20,
      heartbeatCount: 10,
      platform: 'nownnow',
    });

    const res = await runMedigateWatch({ args: { webinarIdx: '5011' } });
    expect(res.success).toBe(true);
    expect(watchSpy).toHaveBeenCalledWith(5011, expect.objectContaining({ durationMinutes: 20 }));
  });

  it('MedigateClient.watchSymposiumLive 방송 도중 종료 시 조기 종료 테스트', async () => {
    const client = new MedigateClient({
      accessToken: 'test-token',
    });

    vi.spyOn(client, 'enterSymposiumLive').mockResolvedValueOnce({
      success: true,
      message: '세션 초기화 성공',
      session: {
        webinarIdx: 5011,
        subject: 'Semaglutide 웨비나',
        watchUrl: 'https://sem-live.nownnow.com',
        platform: 'nownnow',
      },
    });

    vi.spyOn(client, 'sendSymposiumHeartbeat').mockResolvedValue({
      success: true,
      status: 200,
      message: '성공',
    });

    // 루프 내 첫 Heartbeat 후 방송 종료 상태(CLOSED 또는 null) 반환
    vi.spyOn(client, 'getSymposiumDetail').mockResolvedValue(null);

    const watchRes = await client.watchSymposiumLive(5011, {
      durationMinutes: 60,
      intervalSeconds: 0.02,
    });

    expect(watchRes.success).toBe(true);
    expect(watchRes.webinarIdx).toBe(5011);
    expect(watchRes.durationMinutes).toBeLessThan(1);
  });
});
