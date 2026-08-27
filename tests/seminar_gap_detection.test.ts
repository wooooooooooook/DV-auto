import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import assert from 'node:assert';
import * as storage from '../src/services/storage';
import * as seminarRepo from '../src/services/seminar_repository';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as utilsModule from '../src/modules/utils';
import * as checkPointModule from '../src/tasks/check_seminar_point';
import * as channelRepo from '../src/services/channel_message_repository';
import * as subscriptionService from '../src/services/subscription_service';
import {
  discoverMissingGapSeminars,
  buildNewSeminarsNoticeMessage,
  runHttpOnly,
  CHECKED_GAP_SEMINAR_IDS_KEY,
  LAST_ENRICH_TIMESTAMP_KEY,
  type SeminarListItem,
} from '../src/tasks/apply_seminar';

describe('세미나 ID 불연속(Gap) 탐색 및 비공개 세미나 발굴/알림 테스트', () => {
  beforeEach(() => {
    storage.setDatabasePath(':memory:');
    storage.clear();
    seminarRepo.clearSeminars();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    storage.closeDatabase();
  });

  it('1. discoverMissingGapSeminars: mainFuture API 결과(5651, 5653)의 불연속 ID(5652)를 탐색하여 정원 100명 이상인 경우 [비공개] 및 질환분류 정보와 함께 발굴', async () => {
    const storedSeminars: SeminarListItem[] = [];

    const currentSeminars: SeminarListItem[] = [
      {
        seminarId: '5651',
        name: '공개 세미나 5651',
        url: 'https://m.doctorville.co.kr/cme/seminar/5651',
        time: '13:00~14:00',
        currentCount: '10',
        totalCount: '1000',
        nightTime: false,
        isAdvancedSurvey: false,
      },
      {
        seminarId: '5653',
        name: '공개 세미나 5653',
        url: 'https://m.doctorville.co.kr/cme/seminar/5653',
        time: '13:00~14:00',
        currentCount: '50',
        totalCount: '2000',
        nightTime: false,
        isAdvancedSurvey: false,
      },
    ];

    // 5652번 상세 API 모킹 (비공개 내과 세미나, 정원 4000명, 질환분류: 심혈관질환)
    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockImplementation(async (id: number | string) => {
      if (String(id) === '5652') {
        return {
          success: true,
          seminarId: '5652',
          hasEntryHistory: false,
          isPointExcluded: false,
          rawResponse: {
            seminarDetail: {
              seminarId: 5652,
              seminarNm: '개원의를 위한 고혈압 처방 팁 (비공개)',
              startDt: '2026-09-08 13:00:00.0',
              endDt: '2026-09-08 14:00:00.0',
              maxPeopleCnt: 4000,
              applyCnt: 995,
              hiddenYn: 'Y',
              diseaseCategoryNm: '심혈관질환',
              useDepthSurvey: 'N',
            },
          },
        };
      }
      return {
        success: false,
        seminarId: String(id),
        isAuthExpired: false,
        errorMessage: 'Not found',
      };
    });

    const { gapSeminars, isAuthExpired } = await discoverMissingGapSeminars(
      currentSeminars,
      storedSeminars,
      '2026-08-27',
    );

    assert.strictEqual(isAuthExpired, false);
    assert.strictEqual(gapSeminars.length, 1);
    const discovered = gapSeminars[0];
    assert.strictEqual(discovered.seminarId, '5652');
    assert.strictEqual(discovered.name, '개원의를 위한 고혈압 처방 팁 (비공개)');
    assert.strictEqual(discovered.totalCount, '4000');
    assert.strictEqual(discovered.isClosed, true);
    assert.strictEqual(discovered.hiddenYn, 'Y');
    assert.strictEqual(discovered.diseaseCategoryNm, '심혈관질환');
    assert.strictEqual(discovered.date, '2026-09-08');
    assert.strictEqual(discovered.time, '13:00~14:00');
  });

  it('2. discoverMissingGapSeminars: 정원 100명 미만인 세미나는 발굴 대상에서 제외하고 checked_gap_ids에 캐싱', async () => {
    const storedSeminars: SeminarListItem[] = [];

    const currentSeminars: SeminarListItem[] = [
      {
        seminarId: '5650',
        name: '세미나 5650',
        url: 'https://m.doctorville.co.kr/cme/seminar/5650',
        time: '13:00',
        currentCount: '',
        totalCount: '500',
        nightTime: false,
        isAdvancedSurvey: false,
      },
      {
        seminarId: '5653',
        name: '세미나 5653',
        url: 'https://m.doctorville.co.kr/cme/seminar/5653',
        time: '13:00',
        currentCount: '',
        totalCount: '500',
        nightTime: false,
        isAdvancedSurvey: false,
      },
    ];

    let fetchDetailCount = 0;
    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockImplementation(async (id: number | string) => {
      fetchDetailCount++;
      if (String(id) === '5651') {
        // 정원 50명 (100명 미만)
        return {
          success: true,
          seminarId: '5651',
          hasEntryHistory: false,
          isPointExcluded: false,
          rawResponse: {
            seminarDetail: {
              seminarId: 5651,
              seminarNm: '소규모 테스트 세미나',
              maxPeopleCnt: 50,
              hiddenYn: 'Y',
            },
          },
        };
      }
      // 5652는 404
      return {
        success: false,
        seminarId: String(id),
        isAuthExpired: false,
        errorMessage: '404 Not Found',
      };
    });

    // 1회차 실행: 5651, 5652 조회 -> 둘 다 100명 이상이 아니므로 gapSeminars는 빈 배열
    const res1 = await discoverMissingGapSeminars(currentSeminars, storedSeminars, '2026-08-27');
    assert.strictEqual(res1.gapSeminars.length, 0);
    assert.strictEqual(fetchDetailCount, 2);

    // checked_gap_ids에 5651, 5652가 캐싱되었는지 확인
    const checked = storage.get<number[]>(CHECKED_GAP_SEMINAR_IDS_KEY, []);
    assert.ok(checked.includes(5651));
    assert.ok(checked.includes(5652));

    // 2회차 실행: 캐싱되어 있으므로 fetchSeminarDetail 재호출 0회
    fetchDetailCount = 0;
    const res2 = await discoverMissingGapSeminars(currentSeminars, storedSeminars, '2026-08-27');
    assert.strictEqual(res2.gapSeminars.length, 0);
    assert.strictEqual(fetchDetailCount, 0, '이미 검사한 ID는 재조회하지 않아야 함');
  });

  it('3. buildNewSeminarsNoticeMessage & buildSingleNewSeminarMessage: [비공개] 및 [질환분류명] 태그가 올바르게 포맷팅되는지 검증', () => {
    const item: SeminarListItem = {
      seminarId: '5652',
      name: '개원의를 위한 고혈압 처방 팁',
      url: 'https://m.doctorville.co.kr/cme/seminar/5652',
      date: '2026-09-08',
      time: '13:00~14:00',
      currentCount: '995',
      totalCount: '4000',
      nightTime: false,
      isClosed: true,
      hiddenYn: 'Y',
      diseaseCategoryNm: '심혈관질환',
      isPointExcluded: false,
      isAdvancedSurvey: false,
    };

    // 채널 공지 메시지 검증
    const channelNotice = buildNewSeminarsNoticeMessage([item], ['5652']);
    expect(channelNotice.text).toContain('[2026-09-08 13:00~14:00]');
    expect(channelNotice.text).toContain('[비공개]');
    expect(channelNotice.text).toContain('[심혈관질환]');
    expect(channelNotice.text).toContain('[2026-09-08 13:00~14:00] [비공개] [심혈관질환] 개원의를 위한 고혈압 처방 팁');

    // 구독자 개인별 알림 메시지 검증
    const singleMsg = subscriptionService.buildSingleNewSeminarMessage(item);
    expect(singleMsg.text).toContain('[2026-09-08 13:00~14:00] [비공개] [심혈관질환]');
    expect(singleMsg.text).toContain('<b>개원의를 위한 고혈압 처방 팁</b>');
  });

  it('4. runHttpOnly E2E: 불연속 갭으로 비공개 세미나 발굴 시 신규 세미나 알림 발송 및 DB 저장 검증', async () => {
    // DB에 기존 5650번 저장
    seminarRepo.upsertSeminar({
      seminarId: '5650',
      name: '기존 세미나 5650',
      url: 'https://m.doctorville.co.kr/cme/seminar/5650',
      time: '13:00',
      currentCount: '10',
      totalCount: '1000',
      nightTime: false,
      isAdvancedSurvey: false,
      detectedDate: '2026-08-26',
    });

    // 메인 API 목록에는 5650과 5653이 들어옴 (5651, 5652 누락)
    vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
      success: true,
      items: [
        {
          seminarId: 5650,
          seminarNm: '기존 공개 세미나 5650',
          startDt: '2026-09-07 13:00:00',
          endDt: '2026-09-07 14:00:00',
          maxPeopleCnt: 1000,
          applyCnt: 10,
          useDepthSurvey: 'N',
          diseaseCategoryNm: '순환기',
          hiddenYn: 'N',
          processState: 0,
        },
        {
          seminarId: 5653,
          seminarNm: '신규 공개 세미나 5653',
          startDt: '2026-09-10 13:00:00',
          endDt: '2026-09-10 14:00:00',
          maxPeopleCnt: 2000,
          applyCnt: 10,
          useDepthSurvey: 'N',
          diseaseCategoryNm: '내분비질환',
          hiddenYn: 'N',
          processState: 0,
        },
      ],
      rawResponse: {},
    });

    // 상세 API 모킹: 5652번은 정원 4000명의 비공개 세미나, 5651번은 404
    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockImplementation(async (id: number | string) => {
      if (String(id) === '5652') {
        return {
          success: true,
          seminarId: '5652',
          hasEntryHistory: false,
          isPointExcluded: false,
          rawResponse: {
            seminarDetail: {
              seminarId: 5652,
              seminarNm: '내과 전용 비공개 세미나',
              startDt: '2026-09-08 13:00:00.0',
              endDt: '2026-09-08 14:00:00.0',
              maxPeopleCnt: 4000,
              applyCnt: 993,
              hiddenYn: 'Y',
              diseaseCategoryNm: '심혈관질환',
              useDepthSurvey: 'N',
            },
          },
        };
      }
      return {
        success: false,
        seminarId: String(id),
        isAuthExpired: false,
        errorMessage: '404 Not Found',
      };
    });

    // 기타 의존 모듈 모킹
    vi.spyOn(checkPointModule, 'searchSeminarPoints').mockResolvedValue({
      success: true,
      points: new Map(),
    });
    vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true);

    let publishedChannelNoticeText = '';
    vi.spyOn(channelRepo, 'publishAndReplaceChannelNotice').mockImplementation(async (opts) => {
      const built = opts.buildMessageFn([]);
      publishedChannelNoticeText = built.text;
      return { newMessageId: 999, success: true };
    });

    const subscriberSentSeminars: SeminarListItem[] = [];
    vi.spyOn(subscriptionService, 'sendNewSeminarToSubscribers').mockImplementation(async (seminars) => {
      subscriberSentSeminars.push(...seminars);
      return { successCount: 1, failCount: 0 };
    });

    // 1시간 미경과 설정
    storage.set(LAST_ENRICH_TIMESTAMP_KEY, Date.now() - 10 * 60 * 1000);

    const result = await runHttpOnly({
      notifyNewSeminarsToChannel: true,
      notifyNewSeminarsToTelegram: false,
      silentIfNoNew: true,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.silent, undefined, '신규 세미나가 발굴되었으므로 silent=true가 아니어야 함');

    // DB에 5652(비공개)와 5653(공개) 모두 저장되었는지 확인
    const saved5652 = seminarRepo.getSeminarById('5652');
    assert.ok(saved5652);
    assert.strictEqual(saved5652.name, '내과 전용 비공개 세미나');
    assert.strictEqual(saved5652.isClosed, true);
    assert.strictEqual(saved5652.hiddenYn, 'Y');
    assert.strictEqual(saved5652.diseaseCategoryNm, '심혈관질환');

    const saved5653 = seminarRepo.getSeminarById('5653');
    assert.ok(saved5653);
    assert.strictEqual(saved5653.isClosed, false);
    assert.strictEqual(saved5653.diseaseCategoryNm, '내분비질환');

    // 채널 공지 메시지에 [비공개]와 [심혈관질환] 태그가 포함되어 발송되었는지 확인
    assert.ok(publishedChannelNoticeText.includes('[비공개]'));
    assert.ok(publishedChannelNoticeText.includes('[심혈관질환]'));
    assert.ok(publishedChannelNoticeText.includes('[내분비질환]'));

    // 구독자에게도 비공개 세미나(5652)가 전달되었는지 확인
    assert.ok(subscriberSentSeminars.some((s) => s.seminarId === '5652'));
  });
});
