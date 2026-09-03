import assert from 'node:assert';
import { chromium } from 'playwright';
import { applySeminars as runApplySeminar } from '../src/tasks/apply_seminar';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as utilsModule from '../src/modules/utils';
import * as checkSeminarPointModule from '../src/tasks/check_seminar_point';
import * as seminarRepo from '../src/services/seminar_repository';
import { ProcessState } from '../src/modules/seminar_api';
import fs from 'fs';
import path from 'path';
import { describe, it, vi } from 'vitest';

function createFutureSeminarApiItem(
  seminarId: number,
  processState: number,
  applyCnt: number = 100,
  maxPeopleCnt: number = 5000,
): seminarApiModule.FutureSeminarApiItem {
  return {
    seminarId,
    seminarNm: `세미나 ${seminarId}`,
    startDt: '2026-08-25 13:00:00',
    endDt: '2026-08-25 14:00:00',
    maxPeopleCnt,
    applyCnt,
    processState,
    cancelProcessState: 0,
    seminarCompleted: 0,
  };
}

describe('Playwright 직접 상세페이지 진입 테스트', () => {
  it('직접 상세페이지 진입 및 오류 처리 종합 검증', async () => {
    console.log('===========================================================');
    console.log('  Playwright 직접 상세페이지 진입 테스트');
    console.log('===========================================================\n');

    let browserLaunchCount = 0;
    const safeGotoUrls: string[] = [];
    const sentMessages: string[] = [];

    vi.spyOn(checkSeminarPointModule, 'searchSeminarPoints').mockResolvedValue({
      success: true,
      points: new Map(),
    });

    const fetchSeminarDetailSpy = vi
      .spyOn(seminarApiModule, 'fetchSeminarDetail')
      .mockImplementation(async (id: number | string) => ({
        success: true,
        seminarId: String(id),
        hasEntryHistory: false,
        isPointExcluded: false,
        rawResponse: {
          seminarDetail: {
            seminarId: Number(id),
            seminarNm: `세미나 ${id}`,
            intro: '',
            applyCnt: 10,
            maxPeopleCnt: 100,
            useDepthSurvey: false,
            processState: 2,
          },
        },
      }));

    vi.spyOn(utilsModule, 'sendTelegram').mockImplementation(async (msg: string) => {
      sentMessages.push(msg);
      return true;
    });

    vi.spyOn(utilsModule, 'ensureLoggedIn').mockResolvedValue(true as never);

    vi.spyOn(utilsModule, 'safeGoto').mockImplementation(async (_page: unknown, url: string) => {
      safeGotoUrls.push(url);
      return true as never;
    });

    vi.spyOn(chromium, 'launch').mockImplementation(async (..._args) => {
      browserLaunchCount++;
      // 실제 브라우저를 실행하지 않고 mock page를 반환
      throw new Error('MOCK_BROWSER_LAUNCH');
    });

    const fetchMainFutureSpy = vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars');
    const applySeminarWithTermsSpy = vi.spyOn(seminarApiModule, 'applySeminarWithTerms');

    const createMockPage = () => ({
      context: () => ({}),
      locator: (_selector: string) => ({
        count: async () => 0,
        evaluateAll: async () => [],
        isVisible: async () => false,
        click: async () => {},
      }),
      click: async () => {},
      waitForSelector: async () => {},
      waitForTimeout: async () => {},
      screenshot: async () => {},
    });

    try {
      // ======================================================================
      // ① API 결과에 신청 대상이 없으면 Playwright 호출이 발생하지 않음
      // ======================================================================
      console.log('--- [Test ①] 신청 대상 없으면 Playwright 미호출 ---');
      seminarRepo.clearSeminars();
      browserLaunchCount = 0;
      safeGotoUrls.length = 0;

      fetchMainFutureSpy.mockResolvedValue({
        success: true,
        items: [
          createFutureSeminarApiItem(5607, ProcessState.PROCESS_CANCEL, 2359, 7000),
          createFutureSeminarApiItem(5608, ProcessState.PROCESS_ENTER, 1500, 3000),
          createFutureSeminarApiItem(5609, ProcessState.PROCESS_EXCESS, 500, 500),
        ],
        rawResponse: { futureSeminarList: { items: [] } },
      });

      const result1 = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
      assert.strictEqual(result1.success, true);
      assert.strictEqual(browserLaunchCount, 0, '① Chromium 미실행');
      assert.strictEqual(safeGotoUrls.length, 0, '① safeGoto 미호출');
      assert.ok((result1.message || '').includes('신청 완료'), `① 메시지: "${result1.message}"`);
      console.log(`  ✓ [Pass] 신청 대상 없이 정상 완료: "${result1.message}"\n`);

      // ======================================================================
      // ② 신청 대상 1개면 API 실패 시 Playwright 폴백으로 해당 상세 URL로 직접 진입함
      // ======================================================================
      console.log('--- [Test ②] 신청 대상 1개 → API 실패 시 Playwright 폴백으로 해당 상세 URL 진입 ---');
      seminarRepo.clearSeminars();
      browserLaunchCount = 0;
      safeGotoUrls.length = 0;

      fetchMainFutureSpy.mockResolvedValue({
        success: true,
        items: [
          createFutureSeminarApiItem(5607, ProcessState.PROCESS_CANCEL, 2359, 7000),
          createFutureSeminarApiItem(5610, ProcessState.PROCESS_APPLY, 100, 5000), // 신청 대상
        ],
        rawResponse: { futureSeminarList: { items: [] } },
      });

      applySeminarWithTermsSpy.mockResolvedValue({
        success: false,
        isAuthExpired: false,
        errorMessage: 'API 신청 실패 시뮬레이션',
      });

      fetchSeminarDetailSpy.mockImplementation(async (id: string | number) => {
        return {
          success: true,
          seminarId: String(id),
          isPointExcluded: false,
          hasEntryHistory: false,
          rawResponse: {
            seminarDetail: {
              seminarId: Number(id),
              processState: safeGotoUrls.length > 0 ? ProcessState.PROCESS_CANCEL : ProcessState.PROCESS_APPLY,
            },
          },
        };
      });

      const mockPage2 = createMockPage();
      const result2 = await runApplySeminar({ page: mockPage2 as never }, { notifyNewSeminarsToTelegram: false });
      assert.strictEqual(result2.success, true);
      assert.strictEqual(browserLaunchCount, 0, '② mock page 제공으로 launch 불필요');

      // safeGoto가 호출된 URL 중 5610 상세페이지로의 진입이 있는지 확인
      const detailUrl5610 = 'https://m.doctorville.co.kr/cme/seminar/5610';
      assert.ok(
        safeGotoUrls.some((u) => u === detailUrl5610),
        `② safeGoto에 ${detailUrl5610} 포함: ${JSON.stringify(safeGotoUrls)}`,
      );

      // 목록 페이지 URL이 호출되지 않았는지 확인
      const seminarMainUrl = 'https://www.doctorville.co.kr/seminar/main';
      assert.ok(
        !safeGotoUrls.some((u) => u === seminarMainUrl),
        `② 목록 페이지 미호출: ${JSON.stringify(safeGotoUrls)}`,
      );

      console.log(`  ✓ [Pass] 5610 상세 URL로 직접 진입 확인: "${result2.message}"\n`);

      // ======================================================================
      // ③ 신청 대상 여러 개면 각 상세 URL로 직접 진입함
      // ======================================================================
      console.log('--- [Test ③] 신청 대상 여러 개 → API 실패 시 각 상세 URL로 폴백 진입 ---');
      seminarRepo.clearSeminars();
      browserLaunchCount = 0;
      safeGotoUrls.length = 0;

      fetchMainFutureSpy.mockResolvedValue({
        success: true,
        items: [
          createFutureSeminarApiItem(5607, ProcessState.PROCESS_CANCEL, 2359, 7000),
          createFutureSeminarApiItem(5610, ProcessState.PROCESS_APPLY, 100, 5000),
          createFutureSeminarApiItem(5611, ProcessState.PROCESS_APPLY, 200, 5000),
          createFutureSeminarApiItem(5612, ProcessState.PROCESS_APPLY, 300, 5000),
        ],
        rawResponse: { futureSeminarList: { items: [] } },
      });

      applySeminarWithTermsSpy.mockResolvedValue({
        success: false,
        isAuthExpired: false,
        errorMessage: 'API 신청 실패 시뮬레이션',
      });

      fetchSeminarDetailSpy.mockImplementation(async (id: string | number) => {
        return {
          success: true,
          seminarId: String(id),
          isPointExcluded: false,
          hasEntryHistory: false,
          rawResponse: {
            seminarDetail: {
              seminarId: Number(id),
              processState: safeGotoUrls.length > 0 ? ProcessState.PROCESS_CANCEL : ProcessState.PROCESS_APPLY,
            },
          },
        };
      });

      const mockPage3 = createMockPage();
      const result3 = await runApplySeminar({ page: mockPage3 as never }, { notifyNewSeminarsToTelegram: false });
      assert.strictEqual(result3.success, true);

      const expectedIds = ['5610', '5611', '5612'];
      for (const id of expectedIds) {
        const expectedUrl = `https://m.doctorville.co.kr/cme/seminar/${id}`;
        assert.ok(
          safeGotoUrls.some((u) => u === expectedUrl),
          `③ ${expectedUrl} 진입 확인: ${JSON.stringify(safeGotoUrls)}`,
        );
      }

      // 목록 페이지 미호출 확인
      assert.ok(
        !safeGotoUrls.some((u) => u === seminarMainUrl),
        `③ 목록 페이지 미호출: ${JSON.stringify(safeGotoUrls)}`,
      );

      console.log(`  ✓ [Pass] 3개 상세 URL 각각 직접 진입 확인: "${result3.message}"\n`);

      // ======================================================================
      // ④ 신청 완료된 processState 세미나는 Playwright 대상에서 제외됨
      // ======================================================================
      console.log('--- [Test ④] 신청 완료 processState는 Playwright 대상 제외 ---');
      seminarRepo.clearSeminars();
      browserLaunchCount = 0;
      safeGotoUrls.length = 0;

      fetchMainFutureSpy.mockResolvedValue({
        success: true,
        items: [
          createFutureSeminarApiItem(5607, ProcessState.PROCESS_CANCEL, 2359, 7000), // 이미 신청 완료
          createFutureSeminarApiItem(5608, ProcessState.PROCESS_ENTER, 1500, 3000), // 입장 가능 (완료)
          createFutureSeminarApiItem(5609, ProcessState.PROCESS_STARTED, 500, 1000), // 진행중
          createFutureSeminarApiItem(5610, ProcessState.PROCESS_END, 300, 1000), // 종료
          createFutureSeminarApiItem(5611, ProcessState.PROCESS_COMPLETED, 200, 1000), // 완료
          createFutureSeminarApiItem(5612, ProcessState.PROCESS_EXCESS, 500, 500), // 정원 초과
          createFutureSeminarApiItem(5613, ProcessState.PROCESS_PREPARING, 0, 5000), // 준비중
        ],
        rawResponse: { futureSeminarList: { items: [] } },
      });

      const result4 = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
      assert.strictEqual(result4.success, true);
      assert.strictEqual(browserLaunchCount, 0, '④ 모든 세미나가 신청 완료/불가 → launch 없음');
      assert.strictEqual(safeGotoUrls.length, 0, '④ safeGoto 미호출');

      // CANCEL(3), ENTER(1), STARTED(6), END(7), COMPLETED(8) = 5개 신청 완료
      assert.ok((result4.message || '').includes('5개 세미나 신청 완료'), `④ 메시지: "${result4.message}"`);
      console.log(`  ✓ [Pass] 신청 완료 상태 제외 확인: "${result4.message}"\n`);

      // ======================================================================
      // ⑤ 목록 페이지의 a:has(.ico_apply)를 Playwright로 조회하는 코드가 신청 흐름에 남아 있지 않음
      // ======================================================================
      console.log('--- [Test ⑤] 코드에서 a:has(.ico_apply) Playwright 조회 코드 미존재 확인 ---');
      const sourceCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'tasks', 'apply_seminar.ts'), 'utf-8');

      // run() 함수에서 Playwright 구간 (ensureLoggedIn 이후) 에 a:has(.ico_apply) 조회가 없어야 함
      // applyLocator 또는 page.locator('a:has(.ico_apply)') 패턴이 있는지 확인
      const runFuncMatch = sourceCode.match(/async function run\([\s\S]*?^}/m);
      if (runFuncMatch) {
        const runFuncBody = runFuncMatch[0];

        // locator('a:has(.ico_apply)') 패턴 검색
        assert.ok(
          !runFuncBody.includes("locator('a:has(.ico_apply)')"),
          "⑤ run() 함수에 locator('a:has(.ico_apply)')가 남아있으면 안 됨",
        );
        assert.ok(
          !runFuncBody.includes('locator("a:has(.ico_apply)")'),
          '⑤ run() 함수에 locator("a:has(.ico_apply)")가 남아있으면 안 됨',
        );

        // 목록 페이지로의 safeGoto 호출도 제거되었는지 확인
        // ensureLoggedIn 이후 SEMINAR_PAGE가 사용되지 않아야 함
        const afterLogin = runFuncBody.split('ensureLoggedIn')[1] || '';
        assert.ok(!afterLogin.includes('SEMINAR_PAGE'), `⑤ run() ensureLoggedIn 이후에 SEMINAR_PAGE 참조가 없어야 함`);
      }

      // 또한 ico_completion 기반 결과 확인도 run()의 Playwright 구간에서 제거되었는지 확인
      if (runFuncMatch) {
        const runFuncBody = runFuncMatch[0];
        const afterLogin = runFuncBody.split('ensureLoggedIn')[1] || '';
        assert.ok(!afterLogin.includes('.ico_completion'), '⑤ run() Playwright 구간에서 .ico_completion 조회 제거됨');
      }

      console.log('  ✓ [Pass] a:has(.ico_apply) 및 .ico_completion 코드 미존재 확인\n');

      // ======================================================================
      // ⑥ seminarId 추출 실패 시 정상 종료가 아닌 명확한 오류(success: false) 반환
      // ======================================================================
      console.log('--- [Test ⑥] seminarId 추출 실패 시 명확한 오류 반환 ---');
      seminarRepo.clearSeminars();
      browserLaunchCount = 0;
      safeGotoUrls.length = 0;
      sentMessages.length = 0;

      // 잘못된 URL 및 빈 seminarId를 반환하는 시나리오
      fetchMainFutureSpy.mockResolvedValue({
        success: true,
        items: [
          {
            seminarId: '',
            seminarNm: 'ID 추출 불가 세미나',
            startDt: '2026-08-25 13:00:00',
            endDt: '2026-08-25 14:00:00',
            processState: ProcessState.PROCESS_APPLY,
          },
        ],
        rawResponse: { futureSeminarList: { items: [] } },
      });

      const result6 = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
      assert.strictEqual(result6.success, false, '⑥ seminarId 추출 실패 시 success는 false여야 함');
      assert.ok(
        (result6.message || '').includes('seminarId) 추출 실패'),
        `⑥ 에러 메시지에 seminarId 추출 실패 포함: "${result6.message}"`,
      );
      assert.ok(
        sentMessages.some((msg) => msg.includes('seminarId) 추출 실패')),
        '⑥ 텔레그램 오류 메시지 발송 확인',
      );
      console.log(`  ✓ [Pass] seminarId 추출 실패 시 명확한 오류 반환 확인: "${result6.message}"\n`);

      console.log('🎉 모든 Playwright 직접 상세페이지 진입 테스트 통과!\n');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
