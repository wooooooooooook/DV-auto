import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as monitorModule from '../src/tasks/monitor_seminars';
import * as utilsModule from '../src/modules/utils';

describe('monitor_seminars - checkAndPerformAutoEnter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1차 API 입장이 성공하고 입장이력이 확인되면 Playwright 없이 바로 true 반환', async () => {
    vi.spyOn(seminarApiModule, 'attendSeminarApi').mockResolvedValue({
      success: true,
      hasEntryHistory: true,
      isAuthExpired: false,
    });

    const sendTelegramSpy = vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true as never);
    const performAutoEnterSpy = vi.spyOn(monitorModule, 'performAutoEnter').mockResolvedValue(true);

    const result = await monitorModule.checkAndPerformAutoEnter(
      undefined,
      '5585',
      'https://m.doctorville.co.kr/cme/seminar/5585',
      '테스트 세미나',
      '입장가능',
      false,
    );

    expect(result).toBe(true);
    expect(seminarApiModule.attendSeminarApi).toHaveBeenCalledWith('5585');
    // API 성공 시 performAutoEnter(Playwright)는 호출되지 않아야 함
    expect(performAutoEnterSpy).not.toHaveBeenCalled();
    // 텔레그램 알림 전송 확인
    expect(sendTelegramSpy).toHaveBeenCalledWith(expect.stringContaining('🟢세미나 입장 완료 (API)'));
  });

  it('1차 API 입장이 실패(또는 입장이력 미확인)하면 Playwright 브라우저로 폴백', async () => {
    vi.spyOn(seminarApiModule, 'attendSeminarApi').mockResolvedValue({
      success: false,
      hasEntryHistory: false,
      isAuthExpired: false,
      errorMessage: '서버 오류',
    });

    const sendTelegramSpy = vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true as never);
    vi.spyOn(utilsModule, 'ensureLoggedIn').mockResolvedValue(undefined as never);
    vi.spyOn(utilsModule, 'safeGoto').mockResolvedValue(true as never);

    const mockButton = {
      isVisible: vi.fn().mockResolvedValue(true),
      click: vi.fn().mockResolvedValue(undefined),
      first: () => mockButton,
    };
    const mockPage = {
      screenshot: vi.fn().mockResolvedValue(Buffer.from('')),
      close: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue(mockButton),
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
      url: vi.fn().mockReturnValue('https://m.doctorville.co.kr/cme/seminar/attend?seminarId=5585'),
      frames: vi.fn().mockReturnValue([{ url: () => 'https://video.ibm.com/socialstream/123' }]),
    };
    const fakeContext = {
      newPage: vi.fn().mockResolvedValue(mockPage),
      waitForEvent: vi.fn().mockResolvedValue(null),
    } as never;

    const result = await monitorModule.checkAndPerformAutoEnter(
      fakeContext,
      '5585',
      'https://m.doctorville.co.kr/cme/seminar/5585',
      '테스트 세미나',
      '입장가능',
      false,
    );

    expect(result).toBe(true);
    expect(seminarApiModule.attendSeminarApi).toHaveBeenCalledWith('5585');
    // API 실패 시 Playwright 알림에 디버깅 정보가 포함되어야 함
    expect(sendTelegramSpy).toHaveBeenCalledWith(
      expect.stringContaining('🔍 [1차 API 실패 디버깅 정보]'),
      expect.any(String),
    );
  });
});
