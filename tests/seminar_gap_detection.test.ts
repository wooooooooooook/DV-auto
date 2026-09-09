import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import assert from 'node:assert';
import * as storage from '../src/services/storage';
import * as seminarRepo from '../src/services/seminar_repository';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as utilsModule from '../src/modules/utils';
import * as checkPointModule from '../src/tasks/check_seminar_point';
import * as channelRepo from '../src/services/channel_message_repository';
import * as subscriptionService from '../src/services/subscription_service';
import { discoverMissingGapSeminars, CHECKED_GAP_SEMINAR_IDS_KEY } from '../src/services/seminar_gap_service';
import { buildNewSeminarsNoticeMessage } from '../src/tasks/apply_seminar_notice';
import { syncSeminars, LAST_ENRICH_TIMESTAMP_KEY } from '../src/tasks/apply_seminar';
import type { SeminarListItem } from '../src/services/seminar_repository';

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

    // 1회차 실행: 5651(정원50), 5652(404), 5654(forward 404) 조회 -> 둘 다 100명 이상이 아니므로 gapSeminars는 빈 배열
    const res1 = await discoverMissingGapSeminars(currentSeminars, storedSeminars, '2026-08-27');
    assert.strictEqual(res1.gapSeminars.length, 0);
    assert.strictEqual(fetchDetailCount, 3);

    // checked_gap_ids에 5651, 5652가 캐싱되었는지 확인 (404인 5654는 미등록이므로 캐싱 제외)
    const checked = storage.get<number[]>(CHECKED_GAP_SEMINAR_IDS_KEY, []);
    assert.ok(checked.includes(5651));
    assert.ok(checked.includes(5652));
    assert.ok(!checked.includes(5654));

    // 2회차 실행: 5651, 5652는 캐싱되어 있으므로 gap 재조회 0회, forward 5654만 1회 재확인
    fetchDetailCount = 0;
    const res2 = await discoverMissingGapSeminars(currentSeminars, storedSeminars, '2026-08-27');
    assert.strictEqual(res2.gapSeminars.length, 0);
    assert.strictEqual(fetchDetailCount, 1, 'gap ID는 캐시되어 재조회하지 않고 forward 미등록 ID(5654)만 확인해야 함');
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
    expect(channelNotice.text).toContain(
      '[2026-09-08 13:00~14:00] 🔒<b>[비공개][심혈관질환]</b> 개원의를 위한 고혈압 처방 팁',
    );

    // 구독자 개인별 알림 메시지 검증
    const singleMsg = subscriptionService.buildSingleNewSeminarMessage(item);
    expect(singleMsg.text).toContain('[2026-09-08 13:00~14:00] 🔒<b>[비공개][심혈관질환]</b>');
    expect(singleMsg.text).toContain('개원의를 위한 고혈압 처방 팁');
  });

  it('4. syncSeminars E2E: 불연속 갭으로 비공개 세미나 발굴 시 신규 세미나 알림 발송 및 DB 저장 검증', async () => {
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

    const result = await syncSeminars({
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
    assert.strictEqual(saved5652.isClosed, false);
    assert.strictEqual(saved5652.hiddenYn, 'Y');
    assert.strictEqual(saved5652.diseaseCategoryNm, '심혈관질환');

    const saved5653 = seminarRepo.getSeminarById('5653');
    assert.ok(saved5653);
    assert.strictEqual(saved5653.isClosed, false);
    assert.strictEqual(saved5653.diseaseCategoryNm, '내분비질환');

    // 채널 공지 메시지에 [비공개]와 [심혈관질환] 태그가 포함되어 발송되었는지 확인
    // 비공개 세미나(5652)는 [비공개] + [심혈관질환] 태그가 붙어야 함
    assert.ok(publishedChannelNoticeText.includes('[비공개]'));
    assert.ok(publishedChannelNoticeText.includes('[심혈관질환]'));
    // 공개 세미나(5653)는 질환분류명 태그를 붙이지 않음
    assert.ok(!publishedChannelNoticeText.includes('[내분비질환]'));

    // 구독자에게도 비공개 세미나(5652)가 전달되었는지 확인
    assert.ok(subscriberSentSeminars.some((s) => s.seminarId === '5652'));
  });

  it('5. discoverMissingGapSeminars: 마지막 저장된 세미나 번호 + 1 (5654)을 조회하여 정원 100명 이상인 경우 발굴 및 404는 캐시하지 않음', async () => {
    const storedSeminars: SeminarListItem[] = [
      {
        seminarId: '5653',
        name: '저장된 세미나 5653',
        url: 'https://m.doctorville.co.kr/cme/seminar/5653',
        time: '13:00~14:00',
        currentCount: '10',
        totalCount: '1000',
        nightTime: false,
        isAdvancedSurvey: false,
      },
    ];
    const currentSeminars: SeminarListItem[] = [];

    const fetchedIds: string[] = [];
    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockImplementation(async (id: number | string) => {
      const sid = String(id);
      fetchedIds.push(sid);
      if (sid === '5654') {
        return {
          success: true,
          seminarId: '5654',
          hasEntryHistory: false,
          isPointExcluded: false,
          rawResponse: {
            seminarDetail: {
              seminarId: 5654,
              seminarNm: '신규 등록 세미나 5654',
              startDt: '2026-09-12 19:00:00.0',
              endDt: '2026-09-12 20:00:00.0',
              maxPeopleCnt: 3000,
              applyCnt: 1,
              hiddenYn: 'Y',
              useDepthSurvey: 'N',
              processState: 0,
            },
          },
        };
      }
      // 5655는 아직 미등록(404)
      return {
        success: false,
        seminarId: sid,
        isAuthExpired: false,
        errorMessage: '404 Not Found',
      };
    });

    const { gapSeminars, isAuthExpired } = await discoverMissingGapSeminars(
      currentSeminars,
      storedSeminars,
      '2026-08-27',
    );

    assert.strictEqual(isAuthExpired, false);
    assert.strictEqual(gapSeminars.length, 1);
    assert.strictEqual(gapSeminars[0].seminarId, '5654');
    assert.strictEqual(gapSeminars[0].name, '신규 등록 세미나 5654');
    assert.strictEqual(gapSeminars[0].totalCount, '3000');
    assert.deepStrictEqual(fetchedIds, ['5654', '5655']);

    // 404로 끝난 5655는 캐시에 저장되지 않아야 함 (차후 등록 시 재조회 가능해야 함)
    const checked = storage.get<number[]>(CHECKED_GAP_SEMINAR_IDS_KEY, []);
    assert.strictEqual(checked.includes(5655), false);
  });

  it('6. discoverMissingGapSeminars: +1(5654)이 정원 50명(100명 미만)인 경우 캐싱하고, 다음 번호 +2(5655)를 계속 조회하여 발굴', async () => {
    const storedSeminars: SeminarListItem[] = [
      {
        seminarId: '5653',
        name: '저장된 세미나 5653',
        url: 'https://m.doctorville.co.kr/cme/seminar/5653',
        time: '13:00~14:00',
        currentCount: '10',
        totalCount: '1000',
        nightTime: false,
        isAdvancedSurvey: false,
      },
    ];
    const currentSeminars: SeminarListItem[] = [];

    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockImplementation(async (id: number | string) => {
      const sid = String(id);
      if (sid === '5654') {
        // 정원 50명 소규모 세미나
        return {
          success: true,
          seminarId: '5654',
          hasEntryHistory: false,
          isPointExcluded: false,
          rawResponse: {
            seminarDetail: {
              seminarId: 5654,
              seminarNm: '소규모 세미나 5654',
              maxPeopleCnt: 50,
              hiddenYn: 'Y',
            },
          },
        };
      }
      if (sid === '5655') {
        // 정상 정원 2000명 세미나
        return {
          success: true,
          seminarId: '5655',
          hasEntryHistory: false,
          isPointExcluded: false,
          rawResponse: {
            seminarDetail: {
              seminarId: 5655,
              seminarNm: '신규 세미나 5655',
              maxPeopleCnt: 2000,
              hiddenYn: 'N',
            },
          },
        };
      }
      return {
        success: false,
        seminarId: sid,
        isAuthExpired: false,
        errorMessage: '404 Not Found',
      };
    });

    const { gapSeminars } = await discoverMissingGapSeminars(currentSeminars, storedSeminars, '2026-08-27');

    assert.strictEqual(gapSeminars.length, 1);
    assert.strictEqual(gapSeminars[0].seminarId, '5655');

    // 5654는 정원 미달이므로 캐시됨
    const checked = storage.get<number[]>(CHECKED_GAP_SEMINAR_IDS_KEY, []);
    assert.strictEqual(checked.includes(5654), true);
  });

  it('7. syncSeminars E2E: 마지막 저장된 세미나 번호 + 1로 신규 세미나 발굴 시 알림 발송 및 신청 대상(hasApplyTarget: true) 연계 검증', async () => {
    // DB에 5653번 저장
    seminarRepo.upsertSeminar({
      seminarId: '5653',
      name: '기존 세미나 5653',
      url: 'https://m.doctorville.co.kr/cme/seminar/5653',
      time: '13:00',
      currentCount: '10',
      totalCount: '1000',
      nightTime: false,
      isAdvancedSurvey: false,
      detectedDate: '2026-08-26',
    });

    // 메인 API 목록에는 5653만 존재
    vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
      success: true,
      items: [
        {
          seminarId: 5653,
          seminarNm: '기존 세미나 5653',
          startDt: '2026-09-10 13:00:00',
          endDt: '2026-09-10 14:00:00',
          maxPeopleCnt: 1000,
          applyCnt: 10,
          useDepthSurvey: 'N',
          hiddenYn: 'N',
          processState: seminarApiModule.ProcessState.PROCESS_APPLY,
        },
      ],
      rawResponse: {},
    });

    // 상세 API: 5654(신규 +1 세미나)가 등록되어 있음, 5655는 404
    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockImplementation(async (id: number | string) => {
      if (String(id) === '5654') {
        return {
          success: true,
          seminarId: '5654',
          hasEntryHistory: false,
          isPointExcluded: false,
          rawResponse: {
            seminarDetail: {
              seminarId: 5654,
              seminarNm: '최신 신규 세미나 5654',
              startDt: '2026-09-15 13:00:00.0',
              endDt: '2026-09-15 14:00:00.0',
              maxPeopleCnt: 3000,
              applyCnt: 5,
              hiddenYn: 'Y',
              useDepthSurvey: 'N',
              processState: seminarApiModule.ProcessState.PROCESS_APPLY,
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

    vi.spyOn(checkPointModule, 'searchSeminarPoints').mockResolvedValue({
      success: true,
      points: new Map(),
    });
    vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true);

    let publishedChannelNoticeText = '';
    vi.spyOn(channelRepo, 'publishAndReplaceChannelNotice').mockImplementation(async (opts) => {
      const built = opts.buildMessageFn([]);
      publishedChannelNoticeText = built.text;
      return { newMessageId: 1001, success: true };
    });

    const subscriberSentSeminars: SeminarListItem[] = [];
    vi.spyOn(subscriptionService, 'sendNewSeminarToSubscribers').mockImplementation(async (seminars) => {
      subscriberSentSeminars.push(...seminars);
      return { successCount: 1, failCount: 0 };
    });

    storage.set(LAST_ENRICH_TIMESTAMP_KEY, Date.now() - 10 * 60 * 1000);

    const result = await syncSeminars({
      notifyNewSeminarsToChannel: true,
      notifyNewSeminarsToTelegram: false,
      silentIfNoNew: true,
    });

    assert.strictEqual(result.success, true);
    assert.strictEqual(
      result.hasApplyTarget,
      true,
      '신규 발굴된 세미나가 신청 가능 상태이므로 hasApplyTarget이 true여야 함',
    );
    assert.strictEqual(result.newlyAdded?.length, 1);
    assert.strictEqual(result.newlyAdded?.[0].seminarId, '5654');

    // DB에 5654 저장 확인
    const saved5654 = seminarRepo.getSeminarById('5654');
    assert.ok(saved5654);
    assert.strictEqual(saved5654.name, '최신 신규 세미나 5654');

    // 공지 및 구독자 알림 발송 확인
    assert.ok(publishedChannelNoticeText.includes('최신 신규 세미나 5654'));
    assert.ok(subscriberSentSeminars.some((s) => s.seminarId === '5654'));
  });
});
