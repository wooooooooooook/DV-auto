import assert from 'node:assert';
import {
  getSeminarInfoChanges,
  formatSeminarChangeNotification,
  refreshSeminarPointStatus,
  buildNewSeminarsNoticeMessage,
  applySeminars as runApplySeminar,
  syncSeminars,
  syncSeminarsTask,
  type SeminarListItem,
  type SeminarInfoChange,
  type SeminarPointChange,
} from '../src/tasks/apply_seminar';
import { buildSingleNewSeminarMessage } from '../src/services/subscription_service';
import * as runner from '../src/core/runner';
import * as utilsModule from '../src/modules/utils';
import * as seminarApiModule from '../src/modules/seminar_api';
import * as checkSeminarPointModule from '../src/tasks/check_seminar_point';
import * as seminarRepo from '../src/services/seminar_repository';
import type { PlaywrightRunArgs } from '../src/types';
import { describe, it, vi } from 'vitest';

describe('apply_seminar 정보 변경 및 포인트 신규 지급 감지 테스트', () => {
  it('정보 변경 및 포인트 신규 지급 감지 종합 테스트', async () => {
    console.log('===========================================================');
    console.log('  apply_seminar 정보 변경 및 포인트 신규 지급 감지 테스트');
    console.log('===========================================================\n');

    const sentTelegramMessages: Array<{ message: string; imagePath?: string }> = [];
    const sentChannelMessages: string[] = [];

    // 모킹
    vi.spyOn(utilsModule, 'sendTelegram').mockImplementation(async (msg: string, img?: string | null) => {
      sentTelegramMessages.push({ message: msg, imagePath: img ?? undefined });
      return true;
    });
    vi.spyOn(utilsModule, 'sendNotificationToChannel').mockImplementation(async (msg: string) => {
      sentChannelMessages.push(msg);
      return 1;
    });

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

      // 2-1. name (제목) 만 변경 시 변경 감지 없음
      console.log('--- Case 2-1: name(제목) 만 변경 시 변경 감지 없음 ---');
      const nameA: SeminarListItem = { ...sameA, name: '기존 세미나 제목' };
      const nameB: SeminarListItem = { ...sameB, name: '수정된 새로운 세미나 제목' };
      const changesName = getSeminarInfoChanges(nameA, nameB);
      assert.strictEqual(changesName.length, 0, '세미나 제목(name)만 변경된 경우 변경 알림 대상에서 제외되어야 함');
      console.log('  ✓ [Pass] 세미나 제목만 변경 시 변경 알림 없음\n');

      // 2-2. nightTime (야간세미나) 만 변경 시 변경 감지 없음
      console.log('--- Case 2-2: nightTime(야간세미나) 만 변경 시 변경 감지 없음 ---');
      const nightA: SeminarListItem = { ...sameA, nightTime: false };
      const nightB: SeminarListItem = { ...sameB, nightTime: true };
      const changesNight = getSeminarInfoChanges(nightA, nightB);
      assert.strictEqual(
        changesNight.length,
        0,
        '야간세미나(nightTime)만 변경된 경우 변경 알림 대상에서 제외되어야 함',
      );
      console.log('  ✓ [Pass] 야간세미나만 변경 시 변경 알림 없음\n');

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

      // 6-1. 포인트미지급(isPointExcluded) undefined -> false 시 변경 감지 안 됨 (신규 세미나 등록 후 기본값 확인 시 오탐 방지)
      console.log('--- Case 6-1: 포인트미지급 undefined -> false 시 변경 감지 없음 ---');
      const pointExcludedUndef: SeminarListItem = { ...sameA, isPointExcluded: undefined };
      const pointExcludedFalse: SeminarListItem = { ...sameA, isPointExcluded: false };
      const changesPointExcludedDefault = getSeminarInfoChanges(pointExcludedUndef, pointExcludedFalse);
      assert.strictEqual(
        changesPointExcludedDefault.length,
        0,
        'undefined -> false 는 기본값이 채워진 것이므로 변경 알림 대상이 아니어야 함',
      );
      console.log('  ✓ [Pass] 포인트미지급 undefined -> false 시 변경 알림 없음\n');

      // 6-2. 포인트미지급(isPointExcluded) undefined -> true 시 변경 감지 안 됨 (미확인 상태에서 초기 정보 수집 시 오탐 방지)
      console.log('--- Case 6-2: 포인트미지급 undefined -> true 시 변경 감지 없음 ---');
      const pointExcludedTrue: SeminarListItem = { ...sameA, isPointExcluded: true };
      const changesPointExcludedFromUndefToTrue = getSeminarInfoChanges(pointExcludedUndef, pointExcludedTrue);
      assert.strictEqual(
        changesPointExcludedFromUndefToTrue.length,
        0,
        'undefined -> true 는 초기 정보 수집이 완료된 것이므로 변경 알림 대상이 아니어야 함',
      );
      console.log('  ✓ [Pass] 포인트미지급 undefined -> true 시 변경 알림 없음\n');

      // 6-3. 포인트미지급(isPointExcluded) false -> true 시 변경 감지 (실제 주최측 정보 변경)
      console.log('--- Case 6-3: 포인트미지급 false -> true 시 변경 감지 ---');
      const changesPointExcludedFalseToTrue = getSeminarInfoChanges(pointExcludedFalse, pointExcludedTrue);
      assert.strictEqual(changesPointExcludedFalseToTrue.length, 1);
      assert.strictEqual(changesPointExcludedFalseToTrue[0].field, 'isPointExcluded');
      assert.strictEqual(changesPointExcludedFalseToTrue[0].oldValue, false);
      assert.strictEqual(changesPointExcludedFalseToTrue[0].newValue, true);
      console.log('  ✓ [Pass] 포인트미지급 false -> true 시 변경 감지 성공 (false → true)\n');

      // 6-4. 포인트미지급(isPointExcluded) true -> false 시 변경 감지 (true → false)
      console.log('--- Case 6-4: 포인트미지급 true -> false 시 변경 감지 ---');
      const changesPointExcludedToFalse = getSeminarInfoChanges(pointExcludedTrue, pointExcludedFalse);
      assert.strictEqual(changesPointExcludedToFalse.length, 1);
      assert.strictEqual(changesPointExcludedToFalse[0].field, 'isPointExcluded');
      assert.strictEqual(changesPointExcludedToFalse[0].oldValue, true);
      assert.strictEqual(changesPointExcludedToFalse[0].newValue, false);
      console.log('  ✓ [Pass] 포인트미지급 true -> false 시 변경 감지 성공 (true → false)\n');

      // 6-5. 비공개(isClosed) undefined -> false 시 변경 감지 없음
      console.log('--- Case 6-5: 비공개(isClosed) undefined -> false 시 변경 감지 없음 ---');
      const closedUndef: SeminarListItem = { ...sameA, isClosed: undefined };
      const closedFalse: SeminarListItem = { ...sameA, isClosed: false };
      const changesClosedDefault = getSeminarInfoChanges(closedUndef, closedFalse);
      assert.strictEqual(changesClosedDefault.length, 0);
      console.log('  ✓ [Pass] 비공개 undefined -> false 시 변경 알림 없음\n');

      // 6-6. 심화설문(isAdvancedSurvey) undefined -> false 시 변경 감지 없음
      console.log('--- Case 6-6: 심화설문(isAdvancedSurvey) undefined -> false 시 변경 감지 없음 ---');
      const advancedUndef: SeminarListItem = { ...sameA, isAdvancedSurvey: false };
      const changesAdvancedDefault = getSeminarInfoChanges(
        { ...sameA, isAdvancedSurvey: undefined as unknown as boolean },
        advancedUndef,
      );
      assert.strictEqual(changesAdvancedDefault.length, 0);
      console.log('  ✓ [Pass] 심화설문 undefined -> false 시 변경 알림 없음\n');

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
      vi.spyOn(checkSeminarPointModule, 'searchSeminarPoints').mockResolvedValue({
        success: true,
        points: mockPointHistory,
      });

      const initSeminars: SeminarListItem[] = [
        { ...sameA, seminarId: '200', url: 'https://m.doctorville.co.kr/cme/seminar/200', pointPaid: false },
        {
          ...sameA,
          seminarId: '300',
          url: 'https://m.doctorville.co.kr/cme/seminar/300',
          pointPaid: true,
          point: 1000,
        },
      ];
      const pointResult = await refreshSeminarPointStatus({} as PlaywrightRunArgs['context'], initSeminars);
      assert.strictEqual(pointResult.pointChanges.length, 1, 'pointPaid false -> true 만 감지되어야 함');
      assert.strictEqual(pointResult.pointChanges[0].seminarId, '200');
      assert.strictEqual(pointResult.pointChanges[0].point, 3000);
      assert.strictEqual(
        pointResult.pointChanges[0].url,
        'https://m.doctorville.co.kr/cme/seminar/200',
        '포인트 변경에 세미나 url이 포함되어야 함',
      );
      console.log('  ✓ [Pass] 포인트 false -> true 신규 지급 감지 (pointPaid=true인 300번 세미나는 재감지 안함)\n');

      // 9. 여러 변경이 한 번 실행에서 발생 시 단일 adminbot 메시지로 묶임
      console.log('--- Case 9: 여러 변경사항 단일 메시지 포맷팅 테스트 ---');
      const infoChanges: SeminarInfoChange[] = [
        {
          seminarId: '12346',
          name: '정보 변경 세미나',
          url: 'https://m.doctorville.co.kr/cme/seminar/12346',
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
          url: 'https://m.doctorville.co.kr/cme/seminar/12345',
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
      assert(
        formattedMessage.includes('https://m.doctorville.co.kr/cme/seminar/12345'),
        '포인트 지급 알림에 세미나 url 포함',
      );
      assert(formattedMessage.includes('[정보 변경]'));
      assert(formattedMessage.includes('seminarId: 12346'));
      assert(formattedMessage.includes('시간: 20:00 → 21:00'));
      assert(formattedMessage.includes('총원: 100 → 120'));
      assert(
        formattedMessage.includes('https://m.doctorville.co.kr/cme/seminar/12346'),
        '정보 변경 알림에 세미나 url 포함',
      );
      console.log('  ✓ [Pass] 여러 변경사항 단일 메시지 포맷팅 및 url 포함 성공\n');

      // 10 & 11. sync_seminars 실행 시 변경 알림은 adminbot으로만 전송되고 notice channel에는 전송되지 않는지 모킹 E2E 검증
      console.log('--- Case 10 & 11: apply_seminars 실행 및 sync_seminars 알림 분리 테스트 ---');

      vi.spyOn(utilsModule, 'ensureLoggedIn').mockResolvedValue(true as never);
      vi.spyOn(utilsModule, 'safeGoto').mockResolvedValue(undefined as never);

      vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
        success: true,
        items: [
          {
            seminarId: 100,
            seminarNm: '테스트 세미나',
            startDt: '2026-08-24 21:00:00',
            applyCnt: 15,
            maxPeopleCnt: 100,
            processState: seminarApiModule.ProcessState.PROCESS_CANCEL,
            cancelProcessState: 0,
            seminarCompleted: 0,
            useDepthSurvey: false,
          },
        ],
        rawResponse: {},
      });

      vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockResolvedValue({
        success: true,
        seminarId: '100',
        hasEntryHistory: false,
        isPointExcluded: false,
        rawResponse: {
          seminarDetail: {
            seminarId: 100,
            seminarNm: '테스트 세미나',
            applyCnt: 15,
            maxPeopleCnt: 100,
            processState: seminarApiModule.ProcessState.PROCESS_CANCEL,
          },
        },
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
          isPointExcluded: false,
          isAdvancedSurvey: false,
          pointPaid: false,
        },
      ];
      seminarRepo.setAllSeminars(storedList);

      sentTelegramMessages.length = 0;
      sentChannelMessages.length = 0;

      const mockPage = createMockPage() as unknown as PlaywrightRunArgs['page'];
      const mockContext = {} as PlaywrightRunArgs['context'];

      // sync_seminars 모드로 실행 (notifyNewSeminarsToTelegram: false, notifyNewSeminarsToChannel: false)
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

      console.log('  ✓ [Pass] sync_seminars 실행 시 변경 알림은 adminbot으로만 전송되고 notice channel 전송 없음\n');

      // 12. sync_seminars 실행 시 아무런 변경(신규/정보/포인트)이 없을 때 메시지를 보내지 않고 silent=true 검증
      console.log('--- Case 12: sync_seminars 아무 작업도 하지 않았을 때 메시지 미전송 검증 ---');
      mockPointHistory.clear();
      sentTelegramMessages.length = 0;
      sentChannelMessages.length = 0;

      // 현재 저장소와 Mock HTML의 내용이 일치하도록 설정 (ID 100: time='21:00', currentCount='15')
      const currentStoredList: SeminarListItem[] = [
        {
          seminarId: '100',
          name: '테스트 세미나',
          url: 'https://m.doctorville.co.kr/cme/seminar/100',
          date: '2026-08-24',
          time: '21:00',
          currentCount: '15',
          totalCount: '100',
          nightTime: true,
          isPointExcluded: false,
          isAdvancedSurvey: false,
          pointPaid: true,
        },
      ];
      seminarRepo.setAllSeminars(currentStoredList);

      // 1) syncSeminars() 직접 실행 (옵션 미지정/기본값)
      const directResult = await syncSeminars();
      assert.strictEqual(directResult.success, true);
      assert.strictEqual(directResult.silent, true, '신규 세미나가 없을 때 directResult.silent가 true여야 함');
      assert.strictEqual(sentTelegramMessages.length, 0, '아무 변경이 없을 때 직접 전송된 텔레그램 메시지가 없어야 함');
      assert.strictEqual(sentChannelMessages.length, 0, '아무 변경이 없을 때 채널 전송 메시지가 없어야 함');

      // 2) runner.runTask(syncSeminarsTask, { notifyAdminOnSuccess: true }) 스케줄러 환경 실행
      sentTelegramMessages.length = 0;
      const runnerResult = await runner.runTask(syncSeminarsTask, { notifyAdminOnSuccess: true });
      assert.ok(typeof runnerResult === 'object' && runnerResult !== null);
      assert.strictEqual((runnerResult as { silent?: boolean }).silent, true);
      assert.strictEqual(
        sentTelegramMessages.length,
        0,
        'runner 실행 시 silent=true이므로 adminbot 완료 알림 메시지도 전송되지 않아야 함',
      );

      console.log('  ✓ [Pass] sync_seminars 실행 시 아무런 변경이 없으면 텔레그램 메시지를 일체 전송하지 않음\n');

      // 13. 신규 세미나가 처음에 isPointExcluded: undefined로 등록된 후, 1시간 뒤 상세 조회로 isPointExcluded: false가 확인되어도 변경 감지 오탐 알림이 발생하지 않는지 검증
      console.log('--- Case 13: 신규 세미나 등록 후 포인트미지급 false 확인 시 변경 감지 오탐 방지 검증 ---');
      sentTelegramMessages.length = 0;
      sentChannelMessages.length = 0;

      // 1) 신규 세미나가 처음에 저장소에 isPointExcluded: undefined (또는 필드 없음) 상태로 등록되어 있음
      const initial500: SeminarListItem = {
        seminarId: '500',
        name: '신규 발견 세미나',
        url: 'https://m.doctorville.co.kr/cme/seminar/500',
        date: '2026-08-25',
        time: '19:00',
        currentCount: '0',
        totalCount: '500',
        nightTime: true,
        isPointExcluded: undefined,
        isAdvancedSurvey: false,
        pointPaid: false,
      };
      seminarRepo.setAllSeminars([initial500]);

      // 2) 상세 조회를 통해 isPointExcluded: false (일반 포인트 지급 세미나)가 들어오는 상황
      const incoming500: SeminarListItem = {
        ...initial500,
        isPointExcluded: false,
      };

      const changes500 = getSeminarInfoChanges(initial500, incoming500);
      assert.strictEqual(
        changes500.length,
        0,
        'undefined -> false 는 기본값 확인이므로 변경 감지 목록에 포함되면 안 됨',
      );

      const notificationText = formatSeminarChangeNotification(
        changes500.length > 0 ? [{ seminarId: '500', name: '신규 발견 세미나', url: '', changes: changes500 }] : [],
        [],
      );
      assert.strictEqual(notificationText, null, '알림 메시지가 생성되지 않아야 함');

      console.log('  ✓ [Pass] 신규 세미나 undefined -> false 확인 시 변경 감지 오탐 방지 검증 완료\n');

      // 14. 신규 세미나가 실제 포인트 미지급 세미나인 경우, 즉시 enrich되어 신규 세미나 알림 시점에 [포인트미지급] 플래그가 정상 반영되는지 검증
      console.log('--- Case 14: 신규 포인트 미지급 세미나 등록 시 [포인트미지급] 태그 정상 발송 검증 ---');
      sentTelegramMessages.length = 0;
      sentChannelMessages.length = 0;

      vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
        success: true,
        items: [
          {
            seminarId: 600,
            seminarNm: '신규 포인트 미지급 세미나',
            startDt: '2026-08-25 19:00:00',
            applyCnt: 0,
            maxPeopleCnt: 500,
            processState: seminarApiModule.ProcessState.PROCESS_APPLY,
            // 목록 API에는 intro가 제공되지 않음
          },
        ],
        rawResponse: {},
      });

      vi.spyOn(seminarApiModule, 'fetchSeminarDetail').mockResolvedValue({
        success: true,
        seminarId: '600',
        hasEntryHistory: false,
        isPointExcluded: true, // 포인트 미지급 세미나
        rawResponse: {
          seminarDetail: {
            seminarId: 600,
            seminarNm: '신규 포인트 미지급 세미나',
            intro: '본 세미나는 포인트가 지급되지 않는 세미나입니다.',
            applyCnt: 0,
            maxPeopleCnt: 500,
            processState: seminarApiModule.ProcessState.PROCESS_APPLY,
          },
        },
      });

      seminarRepo.setAllSeminars([]);

      // 신규 세미나 등록 실행 (forceEnrich=false 평소 루틴)
      const newNoPointResult = await syncSeminars({ forceEnrich: false });
      assert.strictEqual(newNoPointResult.success, true);

      // 저장소에 등록된 600번 세미나 확인
      const stored600 = seminarRepo.getAllSeminars().find((s) => s.seminarId === '600');
      assert(stored600 !== undefined, '600번 세미나가 저장소에 저장되어야 함');
      assert.strictEqual(stored600.isPointExcluded, true, 'isPointExcluded: true 로 등록되어야 함');

      // 1) 채널 공지 메시지 빌더 검증
      const channelNotice = buildNewSeminarsNoticeMessage([stored600], ['600']);
      assert.ok(
        channelNotice.text.includes('[포인트미지급]'),
        `채널 공지 메시지에 [포인트미지급] 태그가 포함되어야 함: "${channelNotice.text}"`,
      );

      // 2) 개인 구독자 알림 메시지 빌더 검증
      const subscriberNotice = buildSingleNewSeminarMessage(stored600);
      assert.ok(
        subscriberNotice.text.includes('[포인트미지급]'),
        `구독자 알림 메시지에 [포인트미지급] 태그가 포함되어야 함: "${subscriberNotice.text}"`,
      );

      console.log('  ✓ [Pass] 신규 포인트 미지급 세미나 등록 시 [포인트미지급] 플래그 정상 반영 검증 완료\n');

      console.log('🎉 모든 apply_seminar 정보 변경 및 포인트 신규 지급 감지 테스트 통과!\n');
    } finally {
      vi.restoreAllMocks();
    }
  });
});
