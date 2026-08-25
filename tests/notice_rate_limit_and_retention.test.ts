import assert from 'node:assert';
import * as storage from '../src/services/storage';
import * as seminarRepo from '../src/services/seminar_repository';
import type { SeminarListItem } from '../src/tasks/apply_seminar';
import { isSeminarExpired, updateStoredSeminarFromDetail, type SeminarDetail } from '../src/tasks/seminar_detail';
import { checkNoticeCooldown, clearNoticeCooldowns, setBot } from '../src/services/bot_instance';
import type { Telegraf } from 'telegraf';

async function runTests(): Promise<void> {
  console.log('=== [Test] 공지봇 어뷰징 방지 및 세미나 60일 보존 테스트 시작 ===\n');

  const originalSeminarList = seminarRepo.getAllSeminars();

  try {
    // 1. checkNoticeCooldown 테스트
    clearNoticeCooldowns();
    const user1 = 12345;
    assert.strictEqual(checkNoticeCooldown(user1), true, '첫 번째 요청은 허용되어야 함');
    assert.strictEqual(checkNoticeCooldown(user1), false, '2초 이내 두 번째 요청은 차단되어야 함');
    assert.strictEqual(checkNoticeCooldown(99999), true, '다른 사용자의 첫 번째 요청은 허용되어야 함');

    // 2초 지난 후
    assert.strictEqual(checkNoticeCooldown(user1, 0), true, '쿨다운 경과 후 요청은 허용되어야 함');
    console.log('  ✓ [Pass] checkNoticeCooldown 동작 및 사용자별 격리 검증 완료');

    // 2. 공지봇 명령어 쿨다운 차단 검증
    clearNoticeCooldowns();
    const registeredCommands: Record<string, (ctx: unknown) => Promise<unknown>> = {};
    const mockNoticeBot = {
      command: (cmd: string | string[], handler: (ctx: unknown) => Promise<unknown>) => {
        if (Array.isArray(cmd)) {
          for (const c of cmd) {
            registeredCommands[c] = handler;
          }
        } else {
          registeredCommands[cmd] = handler;
        }
      },
    } as unknown as Telegraf;

    setBot('notice', mockNoticeBot);

    let replyMsg = '';
    const mockCtx = {
      from: { id: 777 },
      message: { text: '/today_links' },
      reply: async (msg: string) => {
        replyMsg = msg;
      },
    };

    // 첫 요청 성공
    await registeredCommands['today_links'](mockCtx);
    assert.ok(replyMsg.length > 0, '첫 요청 시 응답 메시지가 있어야 함');

    // 즉시 두 번째 요청 -> 쿨다운 메시지
    replyMsg = '';
    await registeredCommands['today_links'](mockCtx);
    assert(replyMsg.includes('요청이 너무 빠릅니다'), '연속 호출 시 쿨다운 안내 메시지가 반환되어야 함');
    console.log('  ✓ [Pass] 공지봇 명령어 연속 호출 시 쿨다운 차단 검증 완료');

    // 3. isSeminarExpired 및 60일 초과 세미나 저장 방지 검증
    const referenceDate = '2026-08-24';

    // 3-1. isSeminarExpired 검증
    assert.strictEqual(isSeminarExpired('2026-08-20', referenceDate), false, '4일 전 세미나는 만료 아님');
    assert.strictEqual(isSeminarExpired('2026-07-01', referenceDate), false, '54일 전 세미나는 60일 만료 아님');
    assert.strictEqual(isSeminarExpired('2026-05-01', referenceDate), true, '115일 전 세미나는 60일 만료');
    assert.strictEqual(isSeminarExpired('2026-09-01', referenceDate), false, '미래 세미나는 만료 아님');
    console.log('  ✓ [Pass] isSeminarExpired 날짜별 만료 판정 검증 완료');

    // 3-2. updateStoredSeminarFromDetail 로 60일 초과 세미나 저장 방지 검증
    seminarRepo.clearSeminars();

    // 60일 초과된 오래된 세미나 (2026-05-01)
    const oldSeminarDetail: SeminarDetail = {
      seminarId: 1001,
      seminarTy: 1,
      seminarNm: '오래된 세미나 1001',
      regUsn: 1,
      startDt: '2026-05-01 19:00:00',
      endDt: '2026-05-01 20:00:00',
      maxPeopleCnt: 100,
      intro: '',
      tutorId: 1,
      tutorNm: '',
      surveyId: null,
      categoryCd: 1,
      createDt: '2026-05-01',
      updateDt: null,
      introImg: '',
      attachFileOrigin: '',
      viewCnt: 0,
      applyCnt: 10,
      scrapId: null,
      userTy: 1,
      memberCreateDt: null,
      broadcastUrl: '',
      broadcastUrl2: '',
      broadcastTy: 1,
      broadcastTy2: 1,
      diseaseCategoryNm: '',
      diseaseCategoryCd: '',
      hiddenYn: 'N',
      allowUsn: null,
      chattingRoom: '',
      payPoint: null,
      seminarVod: null,
      seminarVodReplay: null,
      seminarTutor: null,
      regUser: null,
      survey: null,
      seminarMember: null,
      tag: null,
      regChk: 0,
      showFg: null,
      vodMarkerList: null,
      seminarCompleted: 0,
      useSurvey: 'N',
      useDepthSurvey: 'N',
      useVod: 'N',
      useVodNotify: 'N',
      keyMessage: '',
      encIntroImg: '',
      encAttachFilePath: '',
      categoryCdNm: '',
      processState: 1,
      cancelProcessState: 0,
      startMonthAndDay: '05.01',
      startDayOfWeek: '금',
      endTime: '20:00',
      startTime: '19:00',
    };

    updateStoredSeminarFromDetail(oldSeminarDetail);
    const listAfterOld = seminarRepo.getAllSeminars();
    assert.strictEqual(listAfterOld.length, 0, '60일 초과된 오래된 세미나는 seminar_list에 저장되지 않아야 함');

    // 최근 세미나 (2026-08-20)
    const recentSeminarDetail: SeminarDetail = {
      ...oldSeminarDetail,
      seminarId: 2002,
      seminarNm: '최근 세미나 2002',
      startDt: '2026-08-20 19:00:00',
      endDt: '2026-08-20 20:00:00',
    };

    updateStoredSeminarFromDetail(recentSeminarDetail);
    const listAfterRecent = seminarRepo.getAllSeminars();
    assert.strictEqual(listAfterRecent.length, 1, '최근 세미나는 seminar_list에 저장되어야 함');
    assert.strictEqual(listAfterRecent[0].seminarId, '2002');
    console.log('  ✓ [Pass] updateStoredSeminarFromDetail 60일 초과 세미나 저장 방지 및 최근 세미나 저장 검증 완료');

    console.log('\n🎉 모든 공지봇 어뷰징 방지 및 세미나 60일 보존 테스트 100% 통과!');
  } finally {
    clearNoticeCooldowns();
    if (originalSeminarList !== undefined) {
      seminarRepo.setAllSeminars(originalSeminarList);
    }
  }
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
