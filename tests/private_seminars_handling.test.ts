import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkSeminarEndStatusFromApi, getTodaysSeminarsFromApi } from '../src/tasks/monitor_seminars';
import { applySeminars } from '../src/tasks/apply_seminar';
import { formatTodayLinksBroadcast, collectTodaySeminarMessage } from '../src/tasks/today_links';
import * as seminarApi from '../src/modules/seminar_api';
import * as seminarRepo from '../src/services/seminar_repository';
import * as utils from '../src/modules/utils';

describe('비공개 세미나 예외처리 및 today_links 비공개 플래그 테스트', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. checkSeminarEndStatusFromApi: hiddenYn이 Y인 비공개 세미나는 삭제/취소(isClosedOrCancelled)로 오인되지 않아야 한다', async () => {
    vi.spyOn(seminarApi, 'fetchSeminarDetail').mockResolvedValue({
      success: true,
      seminarId: '5653',
      isPointExcluded: false,
      hasEntryHistory: false,
      rawResponse: {
        seminarDetail: {
          seminarId: 5653,
          seminarNm: '개원의를 위한 고혈압 처방 팁',
          hiddenYn: 'Y',
          processState: seminarApi.ProcessState.PROCESS_APPLY,
          seminarCompleted: 0,
        },
      },
    });

    const result = await checkSeminarEndStatusFromApi('5653');
    expect(result.isPrivate).toBe(true);
    expect(result.isClosedOrCancelled).toBe(false);
    expect(result.isDeletedOrNotFound).toBe(false);
    expect(result.isEnded).toBe(false);
  });

  it('2. checkSeminarEndStatusFromApi: 세미나 정보를 찾을 수 없는 경우 isDeletedOrNotFound가 true여야 한다', async () => {
    vi.spyOn(seminarApi, 'fetchSeminarDetail').mockResolvedValue({
      success: false,
      seminarId: '9999',
      isAuthExpired: false,
      isNotFound: true,
      errorMessage: '세미나 정보를 찾을 수 없습니다.',
    });

    const result = await checkSeminarEndStatusFromApi('9999');
    expect(result.isDeletedOrNotFound).toBe(true);
    expect(result.isClosedOrCancelled).toBe(false);
  });

  it('3. getTodaysSeminarsFromApi: 당일 DB에 저장된 비공개 세미나(hiddenYn=Y)가 모니터링 목록에 보충되어야 한다', async () => {
    vi.spyOn(seminarApi, 'fetchMainFutureSeminars').mockResolvedValue({
      success: true,
      items: [], // 메인 API에는 비공개 세미나가 노출되지 않음
      rawResponse: {},
    });

    vi.spyOn(seminarRepo, 'getAllSeminars').mockReturnValue([
      {
        seminarId: '5653',
        name: '개원의를 위한 고혈압 처방 팁',
        url: 'https://m.doctorville.co.kr/cme/seminar/5653',
        date: '2026-09-08',
        time: '13:00~14:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        isClosed: false,
        hiddenYn: 'Y',
        processState: seminarApi.ProcessState.PROCESS_APPLY,
        isPointExcluded: false,
        isAdvancedSurvey: false,
      },
    ]);

    const res = await getTodaysSeminarsFromApi(12, 14, '2026-09-08');
    expect(res.success).toBe(true);
    const trackingKey = Object.keys(res.seminars).find((k) => k.includes('5653'));
    expect(trackingKey).toBeDefined();
    expect(res.seminars[trackingKey!].name).toBe('개원의를 위한 고혈압 처방 팁');
  });

  it('4. applySeminars: 비공개 세미나 API 신청 실패 시 Playwright 폴백을 패스해야 한다', async () => {
    const sendTelegramSpy = vi.spyOn(utils, 'sendTelegram').mockResolvedValue(true);
    vi.spyOn(seminarApi, 'applySeminarWithTerms').mockResolvedValue({
      success: false,
      isAuthExpired: false,
      errorMessage: '비공개 세미나 초대 대상자가 아님',
    });

    vi.spyOn(seminarRepo, 'getSeminarById').mockImplementation((id: string) => {
      if (id === '5674' || id === '5605') {
        return {
          seminarId: id,
          name: `비공개 세미나 ${id}`,
          url: `https://m.doctorville.co.kr/cme/seminar/${id}`,
          date: '2026-09-08',
          time: '13:00~14:00',
          currentCount: '0',
          totalCount: '100',
          nightTime: false,
          hiddenYn: 'Y',
          isAdvancedSurvey: false,
        };
      }
      return null;
    });

    const mockSyncResult = {
      success: true,
      currentSeminars: [
        {
          seminarId: '5674',
          name: '비공개 세미나 5674',
          url: 'https://m.doctorville.co.kr/cme/seminar/5674',
          date: '2026-09-08',
          time: '13:00~14:00',
          currentCount: '0',
          totalCount: '100',
          nightTime: false,
          hiddenYn: 'Y',
          processState: seminarApi.ProcessState.PROCESS_APPLY,
          isAdvancedSurvey: false,
        },
        {
          seminarId: '5605',
          name: '비공개 세미나 5605',
          url: 'https://m.doctorville.co.kr/cme/seminar/5605',
          date: '2026-09-08',
          time: '13:00~14:00',
          currentCount: '0',
          totalCount: '100',
          nightTime: false,
          hiddenYn: 'Y',
          processState: seminarApi.ProcessState.PROCESS_APPLY,
          isAdvancedSurvey: false,
        },
      ],
      newlyAdded: [],
      hasApplyTarget: true,
    };

    const result = await applySeminars({}, {}, mockSyncResult as unknown as Parameters<typeof applySeminars>[2]);
    expect(result.success).toBe(true);

    // Playwright 폴백 안내 텔레그램 메시지가 전송되지 않아야 함
    const fallbackCall = sendTelegramSpy.mock.calls.find((call) =>
      typeof call[0] === 'string' ? call[0].includes('Playwright 브라우저 폴백') : false,
    );
    expect(fallbackCall).toBeUndefined();
  });

  it('5. today_links: collectTodaySeminarMessage에서 DB 비공개 세미나 보충 및 🔒[비공개] 플래그가 붙어야 한다', async () => {
    vi.spyOn(seminarApi, 'fetchMainFutureSeminars').mockResolvedValue({
      success: true,
      items: [], // 메인 API에는 없음
      rawResponse: {},
    });

    vi.spyOn(seminarRepo, 'getAllSeminars').mockReturnValue([
      {
        seminarId: '5653',
        name: '개원의를 위한 고혈압 처방 팁',
        url: 'https://m.doctorville.co.kr/cme/seminar/5653',
        date: '2026-09-08',
        time: '13:00~14:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: false,
        hiddenYn: 'Y',
        diseaseCategoryNm: '심혈관질환',
        processState: seminarApi.ProcessState.PROCESS_APPLY,
        isPointExcluded: false,
        isAdvancedSurvey: false,
      },
    ]);

    const res = await collectTodaySeminarMessage(undefined, '2026-09-08');
    expect(res.message).toContain('개원의를 위한 고혈압 처방 팁');
    expect(res.message).toContain('🔒<b>[비공개][심혈관질환]</b>');
    expect(res.lunchSeminarIds).toContain('5653');
  });

  it('6. today_links: formatTodayLinksBroadcast에서 어제 추가된 비공개 신규 세미나에 🔒[비공개][질환분류명] 플래그가 붙어야 한다', () => {
    const formatted = formatTodayLinksBroadcast({
      quizInfo: null,
      seminarMessage: null,
      storedNewSeminars: [
        {
          name: '비공개 신규 세미나',
          url: 'https://m.doctorville.co.kr/cme/seminar/5674',
          seminarId: '5674',
          date: '2026-09-09',
          time: '13:00~14:00',
          currentCount: '0',
          totalCount: '500',
          hiddenYn: 'Y',
          diseaseCategoryNm: '심혈관질환',
          isPointExcluded: false,
          isAdvancedSurvey: false,
        },
      ],
      pointConversionInfo: null,
    });

    expect(formatted.message).toContain('비공개 신규 세미나');
    expect(formatted.message).toContain('🔒<b>[비공개][심혈관질환]</b>');
  });
});
