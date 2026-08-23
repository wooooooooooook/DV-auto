import assert from 'node:assert';
import {
  getSeminarInfoChanges,
  formatSeminarChangeNotification,
  refreshSeminarPointStatus,
  run as runApplySeminar,
  SEMINAR_LIST_KEY,
  type SeminarListItem,
  type SeminarInfoChange,
  type SeminarPointChange,
} from '../src/tasks/apply_seminar';
import * as utilsModule from '../src/modules/utils';
import * as checkSeminarPointModule from '../src/tasks/check_seminar_point';
import * as storage from '../src/services/storage';
import type { PlaywrightRunArgs } from '../src/types';

async function testApplySeminarChanges() {
  console.log('===========================================================');
  console.log('  apply_seminar 정보 변경 및 포인트 신규 지급 감지 테스트');
  console.log('===========================================================\n');

  // 백업
  const originalHttpGet = (await import('../src/modules/http_client')).httpGet;
  const originalSendTelegram = utilsModule.sendTelegram;
  const originalSendNotificationToChannel = utilsModule.sendNotificationToChannel;
  const originalEnsureLoggedIn = utilsModule.ensureLoggedIn;
  const originalSafeGoto = utilsModule.safeGoto;
  const originalSearchSeminarPoints = checkSeminarPointModule.searchSeminarPoints;

  const sentTelegramMessages: Array<{ message: string; imagePath?: string }> = [];
  const sentChannelMessages: string[] = [];

  // 모킹
  (utilsModule as unknown as { sendTelegram: unknown }).sendTelegram = async (msg: string, img?: string) => {
    sentTelegramMessages.push({ message: msg, imagePath: img });
    return true;
  };
  (utilsModule as unknown as { sendNotificationToChannel: unknown }).sendNotificationToChannel = async (
    msg: string,
  ) => {
    sentChannelMessages.push(msg);
    return true;
  };

  try {
    // 1. 기존 세미나 정보 동일 시 변경 감지 없음
    console.log('--- Case 1: 기존 세미나 정보 동일 시 변경 감지 없음 ---');
    const sameA: SeminarListItem = {
      seminarId: '100',
      name: '동일 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/100',
      date: '2026-08-24',
      time: '20:00',
      currentCount: '10',
      totalCount: '100',
      nightTime: true,
      isPointExcluded: false,
      isAdvancedSurvey: false,
    };
    const sameB: SeminarListItem = {
      seminarId: '100',
      name: '동일 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/100',
      date: '2026-08-24',
      time: '20:00',
      currentCount: '10',
      totalCount: '100',
      nightTime: true,
      isPointExcluded: false,
      isAdvancedSurvey: false,
    };
    const changesSame = getSeminarInfoChanges(sameA, sameB);
    assert.strictEqual(changesSame.length, 0, '동일 정보는 변경 사항이 없어야 함');
    console.log('  ✓ [Pass] 기존 세미나 정보가 동일하면 변경 알림 없음\n');

    // 2. currentCount 만 변경 시 변경 감지 없음
    console.log('--- Case 2: currentCount 만 변경 시 변경 감지 없음 ---');
    const countA: SeminarListItem = { ...sameA, currentCount: '10' };
    const countB: SeminarListItem = { ...sameB, currentCount: '25' };
    const changesCount = getSeminarInfoChanges(countA, countB);
    assert.strictEqual(changesCount.length, 0, 'currentCount 변경은 무시되어야 함');
    console.log('  ✓ [Pass] currentCount 만 변경 시 변경 알림 없음\n');

    // 3. 시간 변경 시 변경 감지
    console.log('--- Case 3: 시간 변경 시 변경 감지 ---');
    const timeA: SeminarListItem = { ...sameA, time: '20:00' };
    const timeB: SeminarListItem = { ...sameB, time: '21:00' };
    const changesTime = getSeminarInfoChanges(timeA, timeB);
    assert.strictEqual(changesTime.length, 1);
    assert.strictEqual(changesTime[0].field, 'time');
    assert.strictEqual(changesTime[0].oldValue, '20:00');
    assert.strictEqual(changesTime[0].newValue, '21:00');
    console.log('  ✓ [Pass] 시간 변경 감지 성공 (20:00 → 21:00)\n');

    // 4. 날짜 변경 시 변경 감지
    console.log('--- Case 4: 날짜 변경 시 변경 감지 ---');
    const dateA: SeminarListItem = { ...sameA, date: '2026-08-24' };
    const dateB: SeminarListItem = { ...sameB, date: '2026-08-25' };
    const changesDate = getSeminarInfoChanges(dateA, dateB);
    assert.strictEqual(changesDate.length, 1);
    assert.strictEqual(changesDate[0].field, 'date');
    assert.strictEqual(changesDate[0].oldValue, '2026-08-24');
    assert.strictEqual(changesDate[0].newValue, '2026-08-25');
    console.log('  ✓ [Pass] 날짜 변경 감지 성공 (2026-08-24 → 2026-08-25)\n');

    // 5. 총원 변경 시 변경 감지
    console.log('--- Case 5: 총원 변경 시 변경 감지 ---');
    const totalA: SeminarListItem = { ...sameA, totalCount: '100' };
    const totalB: SeminarListItem = { ...sameB, totalCount: '120' };
    const changesTotal = getSeminarInfoChanges(totalA, totalB);
    assert.strictEqual(changesTotal.length, 1);
    assert.strictEqual(changesTotal[0].field, 'totalCount');
    assert.strictEqual(changesTotal[0].oldValue, '100');
    assert.strictEqual(changesTotal[0].newValue, '120');
    console.log('  ✓ [Pass] 총원 변경 감지 성공 (100 → 120)\n');

    // 6. 심화설문 여부 변경 시 변경 감지
    console.log('--- Case 6: 심화설문 여부 변경 시 변경 감지 ---');
    const surveyA: SeminarListItem = { ...sameA, isAdvancedSurvey: false };
    const surveyB: SeminarListItem = { ...sameB, isAdvancedSurvey: true };
    const changesSurvey = getSeminarInfoChanges(surveyA, surveyB);
    assert.strictEqual(changesSurvey.length, 1);
    assert.strictEqual(changesSurvey[0].field, 'isAdvancedSurvey');
    assert.strictEqual(changesSurvey[0].oldValue, false);
    assert.strictEqual(changesSurvey[0].newValue, true);
    console.log('  ✓ [Pass] 심화설문 여부 변경 감지 성공 (false → true)\n');

    // 7. 포인트 false -> true 시 신규 지급 감지
    console.log('--- Case 7 & 8: 포인트 false -> true 및 true -> true 테스트 ---');
    const mockPointHistory = new Map<string, checkSeminarPointModule.SeminarPointResult>([
      [
        '200',
        {
          found: true,
          point: 3000,
          pointText: '3,000P',
          date: '2026-08-23',
          content: '설문 포인트 200',
          type: '적립',
        },
      ],
    ]);
    (checkSeminarPointModule as unknown as { searchSeminarPoints: unknown }).searchSeminarPoints = async () => ({
      success: true,
      points: mockPointHistory,
    });

    const initSeminars: SeminarListItem[] = [
      { ...sameA, seminarId: '200', pointPaid: false },
      { ...sameA, seminarId: '300', pointPaid: true, point: 1000 },
    ];
    const pointResult = await refreshSeminarPointStatus({} as PlaywrightRunArgs['context'], initSeminars);
    assert.strictEqual(pointResult.pointChanges.length, 1, 'pointPaid false -> true 만 감지되어야 함');
    assert.strictEqual(pointResult.pointChanges[0].seminarId, '200');
    assert.strictEqual(pointResult.pointChanges[0].point, 3000);
    console.log('  ✓ [Pass] 포인트 false -> true 신규 지급 감지 (pointPaid=true인 300번 세미나는 재감지 안함)\n');

    // 9. 여러 변경이 한 번 실행에서 발생 시 단일 adminbot 메시지로 묶임
    console.log('--- Case 9: 여러 변경사항 단일 메시지 포맷팅 테스트 ---');
    const infoChanges: SeminarInfoChange[] = [
      {
        seminarId: '12346',
        name: '정보 변경 세미나',
        changes: [
          { field: 'time', label: '시간', oldValue: '20:00', newValue: '21:00' },
          { field: 'totalCount', label: '총원', oldValue: '100', newValue: '120' },
        ],
      },
    ];
    const pointChanges: SeminarPointChange[] = [
      {
        seminarId: '12345',
        name: '포인트 지급 세미나',
        point: 3000,
        pointText: '3,000P',
        pointDate: '2026-08-23',
      },
    ];
    const formattedMessage = formatSeminarChangeNotification(infoChanges, pointChanges);
    assert(formattedMessage !== null);
    assert(formattedMessage.includes('🔔 세미나 정보 변경 감지'));
    assert(formattedMessage.includes('[포인트 지급]'));
    assert(formattedMessage.includes('seminarId: 12345'));
    assert(formattedMessage.includes('포인트: 3,000P'));
    assert(formattedMessage.includes('[정보 변경]'));
    assert(formattedMessage.includes('seminarId: 12346'));
    assert(formattedMessage.includes('시간: 20:00 → 21:00'));
    assert(formattedMessage.includes('총원: 100 → 120'));
    console.log('  ✓ [Pass] 여러 변경사항 단일 메시지 포맷팅 성공\n');

    // 10 & 11. apply_seminar_extra 실행 시 변경 알림은 adminbot으로만 전송되고 notice channel에는 전송되지 않는지 모킹 E2E 검증
    console.log('--- Case 10 & 11: apply_seminar 실행 및 apply_seminar_extra 알림 분리 테스트 ---');

    (utilsModule as unknown as { ensureLoggedIn: unknown }).ensureLoggedIn = async () => {};
    (utilsModule as unknown as { safeGoto: unknown }).safeGoto = async () => {};

    (await import('../src/modules/http_client')).httpGet = async () => ({
      status: 200,
      body: `
        <div class="list_cont">
          <div class="seminar_day"><span class="date">2026-08-24</span></div>
          <a class="list_detail" href="/seminar/seminarDetail?seminarId=100">
            <div class="list_tit"><span class="tit">테스트 세미나</span></div>
            <span class="txt_num time night_time">21:00</span>
            <div class="person"><span class="txt_num">15</span><span class="total"><span class="txt_num">/100</span></span></div>
          </a>
        </div>
      `,
      statusText: '200',
      headers: {},
      url: 'https://www.doctorville.co.kr/seminar/main',
      redirected: false,
      resultType: 'SUCCESS',
    });

    // Mock page with minimal locator implementations
    const createMockPage = () => {
      return {
        context: () => ({}),
        locator: (selector: string) => {
          if (selector === 'a.list_detail') return { count: async () => 1 };
          if (selector === '.ico_finish') return { count: async () => 0 };
          if (selector === 'a:has(.ico_apply)') return { evaluateAll: async () => [] };
          if (selector === 'a:has(.ico_completion)') return { count: async () => 1 };
          if (selector === '.list_cont') {
            return {
              evaluateAll: async () => [
                {
                  url: 'https://www.doctorville.co.kr/seminar/seminarDetail?seminarId=100',
                  name: '테스트 세미나',
                  date: '2026-08-24',
                  time: '21:00', // 기존 20:00에서 21:00로 변경
                  currentCount: '15', // currentCount 변경
                  totalCount: '100',
                  nightTime: true,
                  isAdvancedSurvey: false,
                },
              ],
            };
          }
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
    };

    // 저장소 초기 상태 설정 (seminarId 100: time='20:00')
    const storedList: SeminarListItem[] = [
      {
        seminarId: '100',
        name: '테스트 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/100',
        date: '2026-08-24',
        time: '20:00',
        currentCount: '10',
        totalCount: '100',
        nightTime: true,
        isAdvancedSurvey: false,
        pointPaid: false,
      },
    ];
    storage.set(SEMINAR_LIST_KEY, storedList);

    sentTelegramMessages.length = 0;
    sentChannelMessages.length = 0;

    const mockPage = createMockPage() as unknown as PlaywrightRunArgs['page'];
    const mockContext = {} as PlaywrightRunArgs['context'];

    // apply_seminar_extra 모드로 실행 (notifyNewSeminarsToTelegram: false, notifyNewSeminarsToChannel: false)
    await runApplySeminar(
      { page: mockPage, context: mockContext },
      { notifyNewSeminarsToTelegram: false, notifyNewSeminarsToChannel: false, silentIfNoNew: true },
    );

    // 검증: 정보 변경 알림이 sendTelegram (adminbot)으로만 전송되었고 channel 메시지는 없어야 함
    assert(sentTelegramMessages.length >= 1, 'adminbot으로 정보 변경 알림이 전송되어야 함');
    const changeMsg = sentTelegramMessages.find((m) => m.message.includes('🔔 세미나 정보 변경 감지'));
    assert(changeMsg !== undefined, '정보 변경 알림 메시지가 포함되어야 함');
    assert(changeMsg.message.includes('시간: 20:00 → 21:00'));
    assert.strictEqual(sentChannelMessages.length, 0, 'notice channel에는 변경 알림이 전송되면 안 됨');

    console.log(
      '  ✓ [Pass] apply_seminar_extra 실행 시 변경 알림은 adminbot으로만 전송되고 notice channel 전송 없음\n',
    );

    console.log('🎉 모든 apply_seminar 정보 변경 및 포인트 신규 지급 감지 테스트 통과!\n');
  } finally {
    (await import('../src/modules/http_client')).httpGet = originalHttpGet;
    (utilsModule as unknown as { sendTelegram: unknown }).sendTelegram = originalSendTelegram;
    (utilsModule as unknown as { sendNotificationToChannel: unknown }).sendNotificationToChannel =
      originalSendNotificationToChannel;
    (utilsModule as unknown as { ensureLoggedIn: unknown }).ensureLoggedIn = originalEnsureLoggedIn;
    (utilsModule as unknown as { safeGoto: unknown }).safeGoto = originalSafeGoto;
    (checkSeminarPointModule as unknown as { searchSeminarPoints: unknown }).searchSeminarPoints =
      originalSearchSeminarPoints;
  }
}

testApplySeminarChanges().catch((err) => {
  console.error(err);
  process.exit(1);
});
