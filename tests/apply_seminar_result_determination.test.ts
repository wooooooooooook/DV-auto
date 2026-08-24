import assert from "node:assert";
import { run as runApplySeminar } from "../src/tasks/apply_seminar";
import * as seminarApiModule from "../src/modules/seminar_api";
import * as checkSeminarPointModule from "../src/tasks/check_seminar_point";
import * as httpClientModule from "../src/modules/http_client";
import * as utilsModule from "../src/modules/utils";
import { ProcessState } from "../src/modules/seminar_api";

async function testApplySeminarResultDetermination() {
  console.log("===========================================================");
  console.log("  apply_seminar 신청 결과 판정 및 집계 테스트");
  console.log("===========================================================\n");

  const originalFetchMainFutureSeminars = seminarApiModule.fetchMainFutureSeminars;
  const originalSearchSeminarPoints = checkSeminarPointModule.searchSeminarPoints;
  const originalHttpGet = httpClientModule.httpGet;
  const originalEnsureLoggedIn = utilsModule.ensureLoggedIn;
  const originalSafeGoto = utilsModule.safeGoto;
  const originalSendTelegram = utilsModule.sendTelegram;

  (checkSeminarPointModule as unknown as { searchSeminarPoints: unknown }).searchSeminarPoints = async () => ({
    success: true,
    points: new Map(),
  });

  (utilsModule as unknown as { sendTelegram: unknown }).sendTelegram = async () => true;
  (utilsModule as unknown as { ensureLoggedIn: unknown }).ensureLoggedIn = async () => true;
  (utilsModule as unknown as { safeGoto: unknown }).safeGoto = async () => true;

  try {
    // -------------------------------------------------------------------
    // Test Case 1: 신청 대상 없음 (정원 초과 5606 / 신청 완료 5607 포함)
    // -------------------------------------------------------------------
    console.log("--- Test Case 1: 정원 초과(5606) 및 신청 완료(5607) 혼합 시 집계 검증 ---");
    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
      success: true,
      items: [
        {
          seminarId: 5606,
          seminarNm: "정원 초과 세미나 5606",
          startDt: "2026-09-01 19:00:00",
          maxPeopleCnt: 2500,
          applyCnt: 2500,
          processState: ProcessState.PROCESS_EXCESS, // 5 (신청 마감/정원 초과)
        },
        {
          seminarId: 5607,
          seminarNm: "신청 완료 세미나 5607",
          startDt: "2026-09-01 20:00:00",
          maxPeopleCnt: 7000,
          applyCnt: 2359,
          processState: ProcessState.PROCESS_CANCEL, // 3 (신청 완료 / 취소가능)
        },
      ],
      rawResponse: {},
    });

    const res1 = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(res1.success, true);
    assert.ok(res1.message.includes("1개 세미나 신청 완료! (1/2)"), "성공 수치는 1/2 이어야 함 (5606 정원초과는 제외, 5607 신청완료만 포함)");
    assert.ok(res1.message.includes("1개는 신청 마감되어 신청하지 못했습니다"), "정원 초과 마감 1개 메시지 포함");
    console.log("  ✓ [Pass] 정원 초과 5606 제외 및 신청 완료 5607 정상 집계 완료\n");

    // -------------------------------------------------------------------
    // Test Case 2: 모두 신청 완료 상태 (이미 신청 완료)
    // -------------------------------------------------------------------
    console.log("--- Test Case 2: 이미 모든 세미나가 신청 완료 상태인 경우 ---");
    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
      success: true,
      items: [
        {
          seminarId: 5607,
          seminarNm: "세미나 5607",
          startDt: "2026-09-01 20:00:00",
          processState: ProcessState.PROCESS_CANCEL, // 3
        },
        {
          seminarId: 5608,
          seminarNm: "세미나 5608",
          startDt: "2026-09-01 21:00:00",
          processState: ProcessState.PROCESS_CANCEL, // 3
        },
      ],
      rawResponse: {},
    });

    const res2 = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(res2.success, true);
    assert.ok(res2.message.includes("2개 세미나 신청 완료! (2/2)"), "성공 수치는 2/2 이어야 함");
    assert.ok(!res2.message.includes("신청 마감되어"), "마감 메시지 없어야 함");
    console.log("  ✓ [Pass] 이미 신청 완료된 세미나 정상 집계 완료\n");

    // -------------------------------------------------------------------
    // Test Case 3: Playwright 시도 중 일부 신청 성공 및 일부 실패 (정원 초과/마감 등)
    // -------------------------------------------------------------------
    console.log("--- Test Case 3: Playwright 시도 후 일부 신청 성공, 일부 실패 ---");
    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
      success: true,
      items: [
        {
          seminarId: 5609,
          seminarNm: "신청 대상 세미나 5609",
          startDt: "2026-09-02 19:00:00",
          processState: ProcessState.PROCESS_APPLY, // 2 (신청하기)
        },
        {
          seminarId: 5610,
          seminarNm: "신청 대상 세미나 5610",
          startDt: "2026-09-02 20:00:00",
          processState: ProcessState.PROCESS_APPLY, // 2 (신청하기)
        },
      ],
      rawResponse: {},
    });

    const mockPage = {
      context: () => ({}),
      locator: (selector: string) => {
        if (selector === "a.list_detail") return { count: async () => 2 };
        if (selector === ".ico_finish") return { count: async () => 1 }; // 1개 마감됨
        if (selector === "a:has(.ico_apply)") {
          return {
            evaluateAll: async () => [
              { href: "https://www.doctorville.co.kr/seminar/seminarDetail?seminarId=5609", text: "신청하기" },
              { href: "https://www.doctorville.co.kr/seminar/seminarDetail?seminarId=5610", text: "신청하기" },
            ],
          };
        }
        if (selector === "a:has(.ico_completion)") return { count: async () => 1 }; // 1개 성공
        return {
          count: async () => 0,
          evaluateAll: async () => [],
          isVisible: async () => false,
          click: async () => {},
        };
      },
      click: async () => {},
      waitForSelector: async () => {},
      waitForTimeout: async () => {},
      screenshot: async () => {},
    };

    const res3 = await runApplySeminar({ page: mockPage as never }, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(res3.success, true);
    assert.ok(res3.message.includes("1개 세미나 신청 완료! (1/2)"), "신청 완료는 1/2이어야 함");
    assert.ok(res3.message.includes("1개는 마감 등의 사유로 신청 실패"), "실패 수치 1개 포함");
    assert.ok(res3.message.includes("1개는 신청 마감되어 신청하지 못했습니다"), "마감 수치 1개 포함");
    console.log("  ✓ [Pass] Playwright 신청 시도 결과 분리 집계 완료\n");

    console.log("🎉 모든 apply_seminar 결과 판정 및 집계 테스트 성공적 통과!\n");
  } finally {
    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = originalFetchMainFutureSeminars;
    (checkSeminarPointModule as unknown as { searchSeminarPoints: unknown }).searchSeminarPoints = originalSearchSeminarPoints;
    (httpClientModule as unknown as { httpGet: unknown }).httpGet = originalHttpGet;
    (utilsModule as unknown as { ensureLoggedIn: unknown }).ensureLoggedIn = originalEnsureLoggedIn;
    (utilsModule as unknown as { safeGoto: unknown }).safeGoto = originalSafeGoto;
    (utilsModule as unknown as { sendTelegram: unknown }).sendTelegram = originalSendTelegram;
  }
}

testApplySeminarResultDetermination().catch((err) => {
  console.error("❌ apply_seminar result determination test failed:", err);
  process.exit(1);
});
