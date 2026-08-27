import assert from 'node:assert';
import { describe, it, vi, beforeEach } from 'vitest';
import type { Page, BrowserContext } from 'playwright';
import {
  enrichSeminarsWithDetail,
  shouldRunEnrich,
  recordEnrichTime,
  runHttpOnly,
  LAST_ENRICH_TIMESTAMP_KEY,
  type SeminarListItem,
} from '../src/tasks/apply_seminar';
import { monitorSeminars } from '../src/tasks/monitor_seminars';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as utilsModule from '../src/modules/utils';
import * as seminarQuizModule from '../src/tasks/seminar_quiz';
import * as checkPointModule from '../src/tasks/check_seminar_point';
import * as storage from '../src/services/storage';
import * as seminarRepo from '../src/services/seminar_repository';

describe('닥터빌 API 과다 호출 방지 및 라이브 모니터링 최적화 검증', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    storage.deleteKey(LAST_ENRICH_TIMESTAMP_KEY);
    seminarRepo.clearSeminars();
    vi.spyOn(checkPointModule, 'searchSeminarPoints').mockResolvedValue({
      success: true,
      points: new Map(),
    });
  });

  it('1. shouldRunEnrich 1시간 주기 및 forceEnrich 옵션 검증', () => {
    console.log('--- [Test 1] shouldRunEnrich 1시간 주기 검증 ---');

    // 1) 최초 실행 시 (기록 없음) -> true
    assert.strictEqual(shouldRunEnrich(), true, '기록이 없으면 enrich를 실행해야 함');

    // 2) 10분 전 실행 기록 -> false
    storage.set(LAST_ENRICH_TIMESTAMP_KEY, Date.now() - 10 * 60 * 1000);
    assert.strictEqual(shouldRunEnrich(), false, '10분 전 실행했으면 enrich를 건너뛰어야 함');

    // 3) 10분 전이라도 forceEnrich=true 이면 -> true
    assert.strictEqual(shouldRunEnrich(true), true, 'forceEnrich=true 이면 즉시 실행해야 함');

    // 4) 61분 전 실행 기록 -> true
    storage.set(LAST_ENRICH_TIMESTAMP_KEY, Date.now() - 61 * 60 * 1000);
    assert.strictEqual(shouldRunEnrich(), true, '60분이 지났으면 enrich를 실행해야 함');

    // 5) recordEnrichTime() 호출 후 -> false
    recordEnrichTime();
    assert.strictEqual(shouldRunEnrich(), false, 'recordEnrichTime 호출 직후에는 false여야 함');
    const recorded = storage.get<number>(LAST_ENRICH_TIMESTAMP_KEY, 0);
    assert.ok(recorded !== null && Date.now() - recorded < 1000, '현재 타임스탬프가 저장되어야 함');

    console.log('  ✓ [Pass] shouldRunEnrich 1시간 주기 및 강제 실행 판정 정상\n');
  });

  it('2. enrichSeminarsWithDetail 동시 요청 수(Concurrency: 2) 및 요청 간 딜레이(150ms) 검증', async () => {
    console.log('--- [Test 2] enrichSeminarsWithDetail Concurrency & Delay 검증 ---');

    const testSeminars: SeminarListItem[] = [
      {
        seminarId: '101',
        name: '세미나1',
        url: 'https://m.doctorville.co.kr/cme/seminar/101',
        time: '19:00',
        currentCount: '100',
        totalCount: '1000',
        nightTime: false,
        isAdvancedSurvey: false,
      },
      {
        seminarId: '102',
        name: '세미나2',
        url: 'https://m.doctorville.co.kr/cme/seminar/102',
        time: '19:00',
        currentCount: '100',
        totalCount: '1000',
        nightTime: false,
        isAdvancedSurvey: false,
      },
      {
        seminarId: '103',
        name: '세미나3',
        url: 'https://m.doctorville.co.kr/cme/seminar/103',
        time: '19:00',
        currentCount: '100',
        totalCount: '1000',
        nightTime: false,
        isAdvancedSurvey: false,
      },
      {
        seminarId: '104',
        name: '세미나4',
        url: 'https://m.doctorville.co.kr/cme/seminar/104',
        time: '19:00',
        currentCount: '100',
        totalCount: '1000',
        nightTime: false,
        isAdvancedSurvey: false,
      },
      {
        seminarId: '105',
        name: '세미나5',
        url: 'https://m.doctorville.co.kr/cme/seminar/105',
        time: '19:00',
        currentCount: '100',
        totalCount: '1000',
        nightTime: false,
        isAdvancedSurvey: false,
      },
    ];

    let currentActiveRequests = 0;
    let maxObservedConcurrency = 0;
    const requestTimes: number[] = [];

    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockImplementation(async (id: number | string) => {
      currentActiveRequests++;
      maxObservedConcurrency = Math.max(maxObservedConcurrency, currentActiveRequests);
      requestTimes.push(Date.now());

      await new Promise((resolve) => setTimeout(resolve, 30)); // 30ms 소요

      currentActiveRequests--;
      return {
        success: true,
        seminarId: String(id),
        hasEntryHistory: false,
        survey: { point: 1000 },
        isPointExcluded: false,
        rawResponse: {
          seminarDetail: {
            seminarId: Number(id),
            seminarNm: `세미나${id}_갱신`,
            processState: 2,
          },
        },
      };
    });

    const startTime = Date.now();
    const result = await enrichSeminarsWithDetail(testSeminars, 2, 50); // 테스트용 50ms 딜레이
    const totalElapsed = Date.now() - startTime;

    assert.strictEqual(result.seminars.length, 5);
    assert.strictEqual(result.isAuthExpired, false);
    assert.strictEqual(result.seminars[0].name, '세미나101_갱신');
    assert.strictEqual(
      maxObservedConcurrency <= 2,
      true,
      `최대 동시 요청 수가 2 이하여야 함 (실측: ${maxObservedConcurrency})`,
    );

    // 5개 세미나 (2개 + 2개 + 1개): 최소 2번의 청크 간 딜레이 (50ms * 2 = 100ms) 발생
    assert.ok(
      totalElapsed >= 100,
      `딜레이가 정상 적용되어 총 소요시간이 100ms 이상이어야 함 (실측: ${totalElapsed}ms)`,
    );

    console.log(
      `  ✓ [Pass] Concurrency(최대 ${maxObservedConcurrency}) 및 딜레이 정상 동작 (총 소요: ${totalElapsed}ms)\n`,
    );
  });

  it('3. runHttpOnly: 10분 루틴에서는 detail API 미호출, 1시간 경과 시에만 detail 호출 검증', async () => {
    console.log('--- [Test 3] runHttpOnly detail API 호출 조건부 제어 검증 ---');

    let detailApiCallCount = 0;
    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockImplementation(async (id: number | string) => {
      detailApiCallCount++;
      return {
        success: true,
        seminarId: String(id),
        hasEntryHistory: false,
        isPointExcluded: false,
        rawResponse: {
          seminarDetail: {
            seminarId: Number(id),
            seminarNm: `상세세미나${id}`,
          },
        },
      };
    });

    vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
      success: true,
      items: [
        {
          seminarId: 201,
          seminarNm: '메인목록 세미나 201',
          startDt: '2026-08-27 19:00:00',
          endDt: '2026-08-27 20:00:00',
          useSurvey: 'Y',
          useDepthSurvey: 'N',
          processState: 0,
          cancelProcessState: 1,
        },
      ],
      rawResponse: {},
    });

    vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true);
    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockResolvedValue(1);
    vi.spyOn(seminarApiModule, 'applySeminarWithTerms').mockResolvedValue({
      success: true,
      alreadyApplied: true,
      isAuthExpired: false,
    });

    // Case A: 10분 전 실행 기록 있음 (1시간 미경과) -> detail API 호출 0회
    storage.set(LAST_ENRICH_TIMESTAMP_KEY, Date.now() - 10 * 60 * 1000);
    detailApiCallCount = 0;
    const resA = await runHttpOnly({ notifyNewSeminarsToTelegram: false, notifyNewSeminarsToChannel: false });
    assert.strictEqual(resA.success, true);
    assert.strictEqual(detailApiCallCount, 0, '1시간 미경과 시에는 fetchSeminarDetail을 호출하지 않아야 함');

    // Case B: forceEnrich: true 지정 시 -> detail API 호출 1회
    detailApiCallCount = 0;
    const resB = await runHttpOnly({
      notifyNewSeminarsToTelegram: false,
      notifyNewSeminarsToChannel: false,
      forceEnrich: true,
    });
    assert.strictEqual(resB.success, true);
    assert.strictEqual(detailApiCallCount, 1, 'forceEnrich=true 시에는 fetchSeminarDetail을 호출해야 함');

    // Case C: 61분 전 기록 (1시간 경과) -> detail API 호출 1회 및 타임스탬프 갱신
    storage.set(LAST_ENRICH_TIMESTAMP_KEY, Date.now() - 61 * 60 * 1000);
    detailApiCallCount = 0;
    const resC = await runHttpOnly({ notifyNewSeminarsToTelegram: false, notifyNewSeminarsToChannel: false });
    assert.strictEqual(resC.success, true);
    assert.strictEqual(detailApiCallCount, 1, '1시간 경과 시 fetchSeminarDetail을 호출해야 함');
    assert.strictEqual(shouldRunEnrich(), false, '실행 후 타임스탬프가 갱신되어 shouldRunEnrich가 false여야 함');

    console.log('  ✓ [Pass] runHttpOnly 평소 detail 미호출 및 1시간 주기 정상 enrich 검증 완료\n');
  });

  it('4. monitorSeminars: 1분 모니터링 폴링 중 detail API 호출 전면 제거 검증', async () => {
    console.log('--- [Test 4] monitorSeminars 루프 내 detail API 호출 미발생 검증 ---');

    let detailApiCallCount = 0;
    vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockImplementation(async (id: number | string) => {
      detailApiCallCount++;
      return {
        success: true,
        seminarId: String(id),
        hasEntryHistory: false,
        survey: { point: 1000 },
        isPointExcluded: false,
        rawResponse: { seminarDetail: { processState: 7 } },
      };
    });

    let loopStep = 0;
    const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const currentHour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getHours();

    vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockImplementation(async () => {
      loopStep++;
      if (loopStep === 1) {
        // 초기: 대기 상태
        return {
          success: true,
          items: [
            {
              seminarId: 301,
              seminarNm: '모니터링 테스트 세미나 301',
              startDt: `${todayStr} ${String(currentHour).padStart(2, '0')}:00:00`,
              endDt: `${todayStr} ${String(currentHour + 1).padStart(2, '0')}:00:00`,
              useSurvey: 'Y',
              useDepthSurvey: 'N',
              processState: 2, // 대기
            },
          ],
          rawResponse: {},
        };
      } else if (loopStep === 2) {
        // 1분 후: 입장가능 상태
        return {
          success: true,
          items: [
            {
              seminarId: 301,
              seminarNm: '모니터링 테스트 세미나 301',
              startDt: `${todayStr} ${String(currentHour).padStart(2, '0')}:00:00`,
              endDt: `${todayStr} ${String(currentHour + 1).padStart(2, '0')}:00:00`,
              useSurvey: 'Y',
              useDepthSurvey: 'N',
              processState: 1, // 입장가능
            },
          ],
          rawResponse: {},
        };
      } else {
        // 2분 후: 방송종료 상태
        return {
          success: true,
          items: [
            {
              seminarId: 301,
              seminarNm: '모니터링 테스트 세미나 301',
              startDt: `${todayStr} ${String(currentHour).padStart(2, '0')}:00:00`,
              endDt: `${todayStr} ${String(currentHour + 1).padStart(2, '0')}:00:00`,
              useSurvey: 'Y',
              useDepthSurvey: 'N',
              processState: 7, // 방송종료
            },
          ],
          rawResponse: {},
        };
      }
    });

    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockResolvedValue(100);
    vi.spyOn(utilsModule, 'sendTelegram').mockResolvedValue(true);
    vi.spyOn(utilsModule, 'ensureLoggedIn').mockResolvedValue(undefined as never);
    vi.spyOn(utilsModule, 'safeGoto').mockResolvedValue(undefined as never);
    vi.spyOn(seminarQuizModule, 'processSeminarQuiz').mockResolvedValue({
      success: true,
      hasQuizResult: false,
      message: '설문 완료',
    });

    const mockPage = {
      locator: (selector: string) => ({
        first: () => ({
          isVisible: async () => selector.includes('입장하기') || selector.includes('설문참여'),
          click: async () => {},
          isEnabled: async () => true,
          count: async () => 1,
          waitFor: async () => {},
        }),
        count: async () => 1,
        waitFor: async () => {},
      }),
      getByRole: () => ({
        first: () => ({
          isVisible: async () => true,
          click: async () => {},
          waitFor: async () => {},
        }),
      }),
      evaluate: async () => [],
      on: () => {},
      waitForEvent: async () => null,
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
      screenshot: async () => {},
      frames: () => [{ url: () => 'https://video.ibm.com/socialstream/123' }],
      url: () => 'https://m.doctorville.co.kr/cme/seminar/attend?seminarId=301',
      close: async () => {},
    } as unknown as Page;

    const mockContext = {
      newPage: async () => mockPage,
      waitForEvent: async () => null,
      close: async () => {},
    } as unknown as BrowserContext;

    const monitorSuccess = await monitorSeminars('최적화테스트', currentHour, currentHour + 2, {
      pollIntervalMs: 10,
      context: mockContext,
    });

    assert.strictEqual(monitorSuccess, true);
    assert.strictEqual(
      detailApiCallCount,
      0,
      '모니터링 전체 주기 동안 fetchSeminarDetail 호출이 0회여야 함 (메인 API만으로 상태 감시 및 온디맨드 퀴즈)',
    );

    console.log('  ✓ [Pass] monitorSeminars 폴링 루프 중 detail API 호출 0회 확인 완료\n');
  });
});
