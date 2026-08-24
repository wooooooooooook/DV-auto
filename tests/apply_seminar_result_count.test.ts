import assert from 'node:assert';
import { isAppliedSeminar } from '../src/tasks/apply_seminar';
import { run as runApplySeminar, SEMINAR_LIST_KEY } from '../src/tasks/apply_seminar';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as utilsModule from '../src/modules/utils';
import * as checkSeminarPointModule from '../src/tasks/check_seminar_point';
import * as storage from '../src/services/storage';
import { ProcessState } from '../src/modules/seminar_api';

function testIsAppliedSeminar() {
  console.log('--- [Test 1] isAppliedSeminar: processState 기반 신청 완료 판정 ---');

  // 신청 완료 상태
  assert.strictEqual(isAppliedSeminar(ProcessState.PROCESS_CANCEL), true, 'PROCESS_CANCEL(3)은 신청 완료');
  assert.strictEqual(isAppliedSeminar(ProcessState.PROCESS_ENTER), true, 'PROCESS_ENTER(1)은 신청 완료');
  assert.strictEqual(isAppliedSeminar(ProcessState.PROCESS_STARTED), true, 'PROCESS_STARTED(6)은 신청 완료');
  assert.strictEqual(isAppliedSeminar(ProcessState.PROCESS_END), true, 'PROCESS_END(7)은 신청 완료');
  assert.strictEqual(isAppliedSeminar(ProcessState.PROCESS_COMPLETED), true, 'PROCESS_COMPLETED(8)은 신청 완료');

  // 미신청/신청 불가 상태
  assert.strictEqual(isAppliedSeminar(ProcessState.PROCESS_APPLY), false, 'PROCESS_APPLY(2)은 미신청');
  assert.strictEqual(isAppliedSeminar(ProcessState.PROCESS_PREPARING), false, 'PROCESS_PREPARING(4)은 미신청');
  assert.strictEqual(isAppliedSeminar(ProcessState.PROCESS_EXCESS), false, 'PROCESS_EXCESS(5)은 정원 초과');

  // undefined
  assert.strictEqual(isAppliedSeminar(undefined), false, 'undefined는 false');
  assert.strictEqual(isAppliedSeminar(0), false, '0은 false');
  assert.strictEqual(isAppliedSeminar(99), false, '알 수 없는 상태는 false');

  console.log('  ✓ [Pass] 모든 processState에 대한 신청 완료 판정 정확\n');
}

function createFutureSeminarApiItem(
  seminarId: number,
  processState: number,
  applyCnt: number,
  maxPeopleCnt: number,
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

async function testResultCountAccuracy() {
  console.log('--- [Test 2] 신청 결과 집계 정확성: 혼합 processState 시나리오 ---');

  const originalFetchMainFuture = seminarApiModule.fetchMainFutureSeminars;
  const originalSearchSeminarPoints = checkSeminarPointModule.searchSeminarPoints;
  const originalSendTelegram = utilsModule.sendTelegram;
  const sentMessages: string[] = [];

  (utilsModule as unknown as { sendTelegram: unknown }).sendTelegram = async (msg: string) => {
    sentMessages.push(msg);
    return true;
  };

  (checkSeminarPointModule as unknown as { searchSeminarPoints: unknown }).searchSeminarPoints = async () => ({
    success: true,
    points: new Map(),
  });

  try {
    // Case A: 전체 성공 (모든 세미나가 PROCESS_CANCEL = 이미 신청 완료)
    console.log('  Case A: 전체 세미나 신청 완료 상태');
    storage.set(SEMINAR_LIST_KEY, []);
    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
      success: true,
      items: [
        createFutureSeminarApiItem(5607, ProcessState.PROCESS_CANCEL, 2359, 7000),
        createFutureSeminarApiItem(5608, ProcessState.PROCESS_CANCEL, 1500, 3000),
        createFutureSeminarApiItem(5609, ProcessState.PROCESS_ENTER, 500, 1000),
      ],
      rawResponse: { futureSeminarList: { items: [] } },
    });

    const resultA = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultA.success, true);
    assert.ok(resultA.message.includes('3개 세미나 신청 완료!'), `전체 성공 메시지 검증: "${resultA.message}"`);
    assert.ok(resultA.message.includes('(3/3)'), `전체 성공 카운트 검증: "${resultA.message}"`);
    console.log(`    ✓ [Pass] 결과: "${resultA.message}"\n`);

    // Case B: 일부 정원 초과 (5606=EXCESS, 5607=CANCEL, 5608=CANCEL)
    console.log('  Case B: 일부 정원 초과로 신청 불가');
    storage.set(SEMINAR_LIST_KEY, []);
    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
      success: true,
      items: [
        createFutureSeminarApiItem(5606, ProcessState.PROCESS_EXCESS, 2500, 2500),
        createFutureSeminarApiItem(5607, ProcessState.PROCESS_CANCEL, 2359, 7000),
        createFutureSeminarApiItem(5608, ProcessState.PROCESS_CANCEL, 1500, 3000),
      ],
      rawResponse: { futureSeminarList: { items: [] } },
    });

    const resultB = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultB.success, true);
    assert.ok(resultB.message.includes('2개 세미나 신청 완료'), `일부 실패 카운트 검증: "${resultB.message}"`);
    assert.ok(resultB.message.includes('(2/3)'), `분자/분모 검증: "${resultB.message}"`);
    assert.ok(resultB.message.includes('1개 정원 초과'), `정원 초과 상세 검증: "${resultB.message}"`);
    assert.ok(!resultB.message.includes('신청 완료!'), `느낌표 없는 메시지: "${resultB.message}"`);
    console.log(`    ✓ [Pass] 결과: "${resultB.message}"\n`);

    // Case C: 정원 초과 + 미신청 혼합
    console.log('  Case C: 정원 초과 + 미신청(PREPARING) 혼합');
    storage.set(SEMINAR_LIST_KEY, []);
    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
      success: true,
      items: [
        createFutureSeminarApiItem(5606, ProcessState.PROCESS_EXCESS, 2500, 2500),
        createFutureSeminarApiItem(5607, ProcessState.PROCESS_CANCEL, 2359, 7000),
        createFutureSeminarApiItem(5610, ProcessState.PROCESS_PREPARING, 0, 5000),
      ],
      rawResponse: { futureSeminarList: { items: [] } },
    });

    const resultC = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultC.success, true);
    assert.ok(resultC.message.includes('1개 세미나 신청 완료'), `혼합 카운트 검증: "${resultC.message}"`);
    assert.ok(resultC.message.includes('(1/3)'), `혼합 분자/분모 검증: "${resultC.message}"`);
    assert.ok(resultC.message.includes('1개 정원 초과'), `정원 초과 검증: "${resultC.message}"`);
    assert.ok(resultC.message.includes('1개 미신청'), `미신청 검증: "${resultC.message}"`);
    console.log(`    ✓ [Pass] 결과: "${resultC.message}"\n`);

    // Case D: 실제 사례 재현 - 30개 세미나 중 일부 정원 초과
    console.log('  Case D: 실제 사례 재현 (30개 세미나, 일부 정원 초과)');
    storage.set(SEMINAR_LIST_KEY, []);
    const items: seminarApiModule.FutureSeminarApiItem[] = [];
    // 28개는 PROCESS_CANCEL (신청 완료)
    for (let i = 0; i < 28; i++) {
      items.push(createFutureSeminarApiItem(5600 + i, ProcessState.PROCESS_CANCEL, 1000, 5000));
    }
    // 2개는 PROCESS_EXCESS (정원 초과)
    items.push(createFutureSeminarApiItem(5628, ProcessState.PROCESS_EXCESS, 2500, 2500));
    items.push(createFutureSeminarApiItem(5629, ProcessState.PROCESS_EXCESS, 3000, 3000));

    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
      success: true,
      items,
      rawResponse: { futureSeminarList: { items: [] } },
    });

    const resultD = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultD.success, true);
    // 기존 버그: "30개 세미나 신청 완료! (30/30)" 이었음
    assert.ok(resultD.message.includes('28개 세미나 신청 완료'), `30/30 버그 수정 검증: "${resultD.message}"`);
    assert.ok(resultD.message.includes('(28/30)'), `실제 성공 카운트: "${resultD.message}"`);
    assert.ok(resultD.message.includes('2개 정원 초과'), `정원 초과 카운트: "${resultD.message}"`);
    assert.ok(!resultD.message.includes('30개 세미나 신청 완료'), `30/30 아님: "${resultD.message}"`);
    console.log(`    ✓ [Pass] 결과: "${resultD.message}" (기존 버그 "30/30"이 "28/30"으로 수정됨)\n`);

    // Case E: 모든 세미나가 정원 초과
    console.log('  Case E: 모든 세미나 정원 초과');
    storage.set(SEMINAR_LIST_KEY, []);
    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars = async () => ({
      success: true,
      items: [
        createFutureSeminarApiItem(5606, ProcessState.PROCESS_EXCESS, 2500, 2500),
        createFutureSeminarApiItem(5607, ProcessState.PROCESS_EXCESS, 3000, 3000),
      ],
      rawResponse: { futureSeminarList: { items: [] } },
    });

    const resultE = await runApplySeminar({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(resultE.success, true);
    assert.ok(resultE.message.includes('0개 세미나 신청 완료'), `전체 실패 검증: "${resultE.message}"`);
    assert.ok(resultE.message.includes('(0/2)'), `0/2 카운트: "${resultE.message}"`);
    assert.ok(resultE.message.includes('2개 정원 초과'), `정원 초과 검증: "${resultE.message}"`);
    console.log(`    ✓ [Pass] 결과: "${resultE.message}"\n`);

    console.log('🎉 모든 신청 결과 집계 정확성 테스트 통과!\n');
  } finally {
    (seminarApiModule as unknown as { fetchMainFutureSeminars: unknown }).fetchMainFutureSeminars =
      originalFetchMainFuture;
    (checkSeminarPointModule as unknown as { searchSeminarPoints: unknown }).searchSeminarPoints =
      originalSearchSeminarPoints;
    (utilsModule as unknown as { sendTelegram: unknown }).sendTelegram = originalSendTelegram;
  }
}

async function runAllTests() {
  console.log('===========================================================');
  console.log('  apply_seminar 신청 결과 집계 정확성 테스트');
  console.log('===========================================================\n');

  testIsAppliedSeminar();
  await testResultCountAccuracy();

  console.log('🎉 모든 apply_seminar 결과 집계 테스트 성공적 통과!\n');
}

runAllTests().catch((err) => {
  console.error('❌ apply_seminar result count test failed:', err);
  process.exit(1);
});
