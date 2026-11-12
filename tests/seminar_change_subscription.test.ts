import assert from 'node:assert';
import * as storage from '../src/services/storage';
import {
  SEMINAR_CHANGE_SUBSCRIBERS_KEY,
  getSeminarChangeSubscribers,
  addSeminarChangeSubscriber,
  removeSeminarChangeSubscriber,
  sendSeminarChangesToSubscribers,
} from '../src/services/seminar_subscribers';
import {
  getSubscription,
  toggleSeminarChangeCategory,
  setSeminarChangeCategoriesAll,
  buildSeminarChangesMenu,
  buildMainMenu,
  ALL_SEMINAR_CHANGE_CATEGORIES,
} from '../src/services/subscription_service';
import type { SeminarInfoChange } from '../src/tasks/apply_seminar_notice';
import { setBot } from '../src/services/bot_instance';
import type { Telegraf } from 'telegraf';
import { describe, it } from 'vitest';

describe('세미나 정보 변경 알림 구독 및 발송 테스트', () => {
  it('구독자 등록, 조회 및 일괄 알림 발송 검증', async () => {
    console.log('=== [Test] 세미나 정보 변경 알림 구독 및 발송 테스트 시작 ===\n');

    const originalSubscribers = storage.get(SEMINAR_CHANGE_SUBSCRIBERS_KEY);

    try {
      // 1. 구독자 등록 및 조회 단위 테스트
      storage.set(SEMINAR_CHANGE_SUBSCRIBERS_KEY, []);
      assert.deepStrictEqual(getSeminarChangeSubscribers(), []);

      // 1-1. 신규 구독자 추가
      const added1 = addSeminarChangeSubscriber(12345);
      assert.strictEqual(added1, true, '첫 구독은 true를 반환해야 함');
      assert.deepStrictEqual(getSeminarChangeSubscribers(), [12345]);

      // 1-2. 중복 구독자 추가 시도
      const addedDuplicate = addSeminarChangeSubscriber(12345);
      assert.strictEqual(addedDuplicate, false, '중복 구독 시 false를 반환해야 함');
      assert.deepStrictEqual(getSeminarChangeSubscribers(), [12345]);

      // 1-3. 추가 구독자 등록
      const added2 = addSeminarChangeSubscriber(67890);
      assert.strictEqual(added2, true);
      assert.deepStrictEqual(getSeminarChangeSubscribers(), [12345, 67890]);
      console.log('  ✓ [Pass] 구독자 등록, 중복 방지 및 조회 검증 완료');

      // 1-4. 구독자 해제
      const removed1 = removeSeminarChangeSubscriber(12345);
      assert.strictEqual(removed1, true, '존재하는 구독자 해제 시 true 반환');
      assert.deepStrictEqual(getSeminarChangeSubscribers(), [67890]);

      // 1-5. 미등록 구독자 해제 시도
      const removedNonExistent = removeSeminarChangeSubscriber(99999);
      assert.strictEqual(removedNonExistent, false, '존재하지 않는 구독자 해제 시 false 반환');
      assert.deepStrictEqual(getSeminarChangeSubscribers(), [67890]);
      console.log('  ✓ [Pass] 구독자 해제 및 예외 케이스 검증 완료');

      // 2. 공지봇 커맨드 핸들러 동작 검증
      storage.set(SEMINAR_CHANGE_SUBSCRIBERS_KEY, []);

      const registeredCommands: Record<string, (ctx: unknown) => Promise<unknown>> = {};
      const mockBot = {
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

      setBot('notice', mockBot);

      assert(
        typeof registeredCommands['subscribe_seminar_changes'] === 'function',
        'subscribe_seminar_changes 커맨드 등록 확인',
      );
      assert(
        typeof registeredCommands['unsubscribe_seminar_changes'] === 'function',
        'unsubscribe_seminar_changes 커맨드 등록 확인',
      );

      // 2-1. 커맨드를 통한 구독 테스트
      let replyMsg = '';
      const mockCtxSubscribe = {
        chat: { id: 111222 },
        reply: async (msg: string) => {
          replyMsg = msg;
        },
      };

      await registeredCommands['subscribe_seminar_changes'](mockCtxSubscribe);
      assert(replyMsg.includes('구독이 완료되었습니다'), '구독 완료 안내 메시지 확인');
      assert.deepStrictEqual(getSeminarChangeSubscribers(), [111222]);

      // 2-2. 커맨드를 통한 중복 구독 테스트
      replyMsg = '';
      await registeredCommands['subscribe_seminar_changes'](mockCtxSubscribe);
      assert(replyMsg.includes('이미'), '중복 구독 안내 메시지 확인');
      assert.deepStrictEqual(getSeminarChangeSubscribers(), [111222]);

      // 2-3. 커맨드를 통한 구독 해제 테스트
      replyMsg = '';
      await registeredCommands['unsubscribe_seminar_changes'](mockCtxSubscribe);
      assert(replyMsg.includes('구독이 해제되었습니다'), '구독 해제 안내 메시지 확인');
      assert.deepStrictEqual(getSeminarChangeSubscribers(), []);

      // 2-4. 커맨드를 통한 미구독 상태 해제 시도
      replyMsg = '';
      await registeredCommands['unsubscribe_seminar_changes'](mockCtxSubscribe);
      assert(replyMsg.includes('구독하고 있지 않습니다'), '미구독 상태 안내 메시지 확인');
      console.log(
        '  ✓ [Pass] 공지봇 커맨드 핸들러(/subscribe_seminar_changes, /unsubscribe_seminar_changes) 동작 검증 완료',
      );

      // 3. 메시지 발송(sendSeminarChangesToSubscribers) 및 차단된 사용자 자동 정리 검증
      storage.set(SEMINAR_CHANGE_SUBSCRIBERS_KEY, [100, 200, 300]);
      const sentMessages: Array<{ chatId: number; text: string }> = [];

      const mockBotForSend = {
        telegram: {
          sendMessage: async (chatId: number, text: string) => {
            if (chatId === 200) {
              throw new Error('403 Forbidden: bot was blocked by the user');
            }
            sentMessages.push({ chatId, text });
            return { message_id: 1 };
          },
        },
        command: () => {},
      } as unknown as Telegraf;

      setBot('notice', mockBotForSend);

      const sendResult = await sendSeminarChangesToSubscribers('🔔 [테스트] 세미나 정보 변경 알림');
      assert.strictEqual(sendResult.successCount, 2, '성공 2건');
      assert.strictEqual(sendResult.failCount, 1, '실패 1건');
      assert.deepStrictEqual(
        sentMessages.map((m) => m.chatId),
        [100, 300],
        '100, 300번 구독자에게 메시지 발송됨',
      );

      // 차단된 200번 사용자는 구독자 목록에서 자동 정리되어야 함
      assert.deepStrictEqual(
        getSeminarChangeSubscribers(),
        [100, 300],
        '차단된 200번 구독자는 목록에서 자동 해제되어야 함',
      );
      console.log('  ✓ [Pass] 구독자 일괄 알림 발송 및 차단 사용자(403) 자동 정리 검증 완료');

      console.log('\n🎉 모든 세미나 정보 변경 알림 구독 및 발송 테스트 100% 통과!');
    } finally {
      if (originalSubscribers !== undefined) {
        storage.set(SEMINAR_CHANGE_SUBSCRIBERS_KEY, originalSubscribers);
      }
    }
  });

  it('세미나 변경 알림 카테고리별 ON/OFF 및 통합 카테고리(증원/감원, 공개/비공개, 심화설문, 포인트 주는/안주는 변경) 동작 검증', () => {
    const testChatId = 777001;

    // 1. 초기 구독 상태 조회 시 기본 모든 카테고리(7개) true
    const initial = getSubscription(testChatId);
    assert.strictEqual(initial.seminarChanges, false);
    assert.strictEqual(ALL_SEMINAR_CHANGE_CATEGORIES.length, 7);
    for (const cat of ALL_SEMINAR_CHANGE_CATEGORIES) {
      assert.strictEqual(initial.seminarChangeCategories[cat], true);
    }

    // 2. 통합 카테고리들 토글 검증
    const toggled1 = toggleSeminarChangeCategory(testChatId, 'capacity');
    assert.strictEqual(toggled1.seminarChangeCategories.capacity, false);
    assert.strictEqual(toggled1.seminarChangeCategories.visibility, true);
    assert.strictEqual(toggled1.seminarChangeCategories.advanced_survey, true);
    assert.strictEqual(toggled1.seminarChangeCategories.point_eligibility, true);

    const toggledVis = toggleSeminarChangeCategory(testChatId, 'visibility');
    assert.strictEqual(toggledVis.seminarChangeCategories.visibility, false);

    const toggledAdv = toggleSeminarChangeCategory(testChatId, 'advanced_survey');
    assert.strictEqual(toggledAdv.seminarChangeCategories.advanced_survey, false);

    const toggledPointElig = toggleSeminarChangeCategory(testChatId, 'point_eligibility');
    assert.strictEqual(toggledPointElig.seminarChangeCategories.point_eligibility, false);

    // 3. 전체 카테고리 끄기
    const allOff = setSeminarChangeCategoriesAll(testChatId, false);
    for (const cat of ALL_SEMINAR_CHANGE_CATEGORIES) {
      assert.strictEqual(allOff.seminarChangeCategories[cat], false);
    }

    // 4. 개별 카테고리 켜기 (time_changed: false -> true), 이때 seminarChanges 마스터 스위치도 true로 자동 활성화
    const toggled2 = toggleSeminarChangeCategory(testChatId, 'time_changed');
    assert.strictEqual(toggled2.seminarChangeCategories.time_changed, true);
    assert.strictEqual(toggled2.seminarChanges, true);

    // 5. 메뉴 빌더 검증
    const menu = buildSeminarChangesMenu(testChatId);
    assert(menu.text.includes('1/7개 활성화'), '활성화된 카테고리 수(1/7) 표시 확인');
    assert(
      menu.text.includes('증원/감원, 공개/비공개 전환, 심화설문 추가/해제, 포인트 주는/안주는 세미나로 변경'),
      '통합 카테고리 안내 문구 확인',
    );

    const flattenedButtons = menu.replyMarkup.inline_keyboard.flat();
    // 증원/감원 통합 버튼 존재 확인
    const capacityBtn = flattenedButtons.find((b) => b.callback_data === 'sub:toggle_cat:capacity');
    assert(capacityBtn !== undefined, '증원/감원 카테고리 버튼 존재 확인');
    assert(capacityBtn.text.includes('증원/감원: OFF 🔴'), '증원/감원 단일 버튼 텍스트 확인');

    // 공개/비공개 전환 통합 버튼 존재 확인
    const visibilityBtn = flattenedButtons.find((b) => b.callback_data === 'sub:toggle_cat:visibility');
    assert(visibilityBtn !== undefined, '공개/비공개 전환 카테고리 버튼 존재 확인');
    assert(visibilityBtn.text.includes('공개/비공개 전환: OFF 🔴'), '공개/비공개 단일 버튼 텍스트 확인');

    // 심화설문 추가/해제 통합 버튼 존재 확인
    const advSurveyBtn = flattenedButtons.find((b) => b.callback_data === 'sub:toggle_cat:advanced_survey');
    assert(advSurveyBtn !== undefined, '심화설문 추가/해제 카테고리 버튼 존재 확인');
    assert(advSurveyBtn.text.includes('심화설문 추가/해제: OFF 🔴'), '심화설문 단일 버튼 텍스트 확인');

    // 포인트 주는/안주는 세미나로 변경 통합 버튼 존재 확인
    const pointEligBtn = flattenedButtons.find((b) => b.callback_data === 'sub:toggle_cat:point_eligibility');
    assert(pointEligBtn !== undefined, '포인트 주는/안주는 세미나로 변경 카테고리 버튼 존재 확인');
    assert(
      pointEligBtn.text.includes('포인트 주는/안주는 세미나로 변경: OFF 🔴'),
      '포인트 주는/안주는 단일 버튼 텍스트 확인',
    );

    // 심화포인트지급 버튼 존재 확인
    const pointPaidBtn = flattenedButtons.find((b) => b.callback_data === 'sub:toggle_cat:point_paid');
    assert(pointPaidBtn !== undefined, '심화포인트지급 카테고리 버튼 존재 확인');
    assert(pointPaidBtn.text.includes('심화포인트지급: OFF 🔴'), '심화포인트지급 라벨 확인');

    // 시간변경 버튼 존재 확인
    const timeBtn = flattenedButtons.find((b) => b.callback_data === 'sub:toggle_cat:time_changed');
    assert(timeBtn !== undefined);
    assert(timeBtn.text.includes('세미나시간변경: ON 🟢'));

    // 메인 메뉴 버튼 연동 확인
    const mainMenu = buildMainMenu(testChatId);
    const mainFlattened = mainMenu.replyMarkup.inline_keyboard.flat();
    const changesMenuBtn = mainFlattened.find((b) => b.callback_data === 'sub:menu:seminar_changes');
    assert(changesMenuBtn !== undefined, '메인 메뉴에 세미나 변경 서브메뉴 진입 버튼 존재 확인');
  });

  it('구독자별 카테고리 맞춤 필터링 알림 발송 검증 (증원감원, 공개비공개, 심화설문, 포인트 주는/안주는 변경 포함)', async () => {
    const user1 = 888001; // time_changed만 ON
    const user2 = 888002; // capacity(증원/감원)만 ON
    const user3 = 888003; // point_paid(심화포인트지급)만 ON
    const user4 = 888004; // visibility(공개/비공개 전환)만 ON
    const user5 = 888005; // advanced_survey(심화설문 추가/해제)만 ON
    const user6 = 888006; // point_eligibility(포인트 주는/안주는 세미나로 변경)만 ON
    const user7 = 888007; // 전체 ON

    // 각 유저 설정
    setSeminarChangeCategoriesAll(user1, false);
    toggleSeminarChangeCategory(user1, 'time_changed');

    setSeminarChangeCategoriesAll(user2, false);
    toggleSeminarChangeCategory(user2, 'capacity');

    setSeminarChangeCategoriesAll(user3, false);
    toggleSeminarChangeCategory(user3, 'point_paid');

    setSeminarChangeCategoriesAll(user4, false);
    toggleSeminarChangeCategory(user4, 'visibility');

    setSeminarChangeCategoriesAll(user5, false);
    toggleSeminarChangeCategory(user5, 'advanced_survey');

    setSeminarChangeCategoriesAll(user6, false);
    toggleSeminarChangeCategory(user6, 'point_eligibility');

    setSeminarChangeCategoriesAll(user7, true);

    const sentMap = new Map<number, string[]>();
    const mockBot = {
      telegram: {
        sendMessage: async (chatId: number, text: string) => {
          if (!sentMap.has(chatId)) {
            sentMap.set(chatId, []);
          }
          sentMap.get(chatId)!.push(text);
          return { message_id: 1 };
        },
      },
      command: () => {},
    } as unknown as Telegraf;

    setBot('notice', mockBot);

    // Case A: 시간 변경과 증원이 동시에 발생한 경우
    const infoChangesA: SeminarInfoChange[] = [
      {
        seminarId: '9001',
        name: '시간 변경 세미나',
        date: '2026-08-25',
        changes: [{ field: 'time', label: '시간', oldValue: '19:00', newValue: '20:00' }],
      },
      {
        seminarId: '9002',
        name: '증원 세미나',
        date: '2026-08-25',
        changes: [{ field: 'totalCount', label: '총원', oldValue: '100', newValue: '200' }],
      },
    ];

    sentMap.clear();
    await sendSeminarChangesToSubscribers('전체 세미나 변경 공지', {
      infoChanges: infoChangesA,
      pointChanges: [],
    });

    // 1) user1 (time_changed만 ON): 시간 변경만 수신, 증원은 미포함
    assert(sentMap.has(user1), 'user1은 시간 변경 알림을 수신해야 함');
    const user1Msg = sentMap.get(user1)!.join('\n');
    assert(user1Msg.includes('[세미나시간변경]'), 'user1 메시지에 세미나시간변경 포함');
    assert(user1Msg.includes('시간 변경 세미나'));
    assert(!user1Msg.includes('[증원]'), 'user1 메시지에는 증원이 제외되어야 함');
    assert(!user1Msg.includes('증원 세미나'));

    // 2) user2 (capacity만 ON): 증원만 수신, 시간 변경은 미포함
    assert(sentMap.has(user2), 'user2는 증원 알림을 수신해야 함');
    const user2Msg = sentMap.get(user2)!.join('\n');
    assert(user2Msg.includes('[증원]'), 'user2 메시지에 증원 포함');
    assert(user2Msg.includes('증원 세미나'));
    assert(!user2Msg.includes('[세미나시간변경]'), 'user2 메시지에는 시간변경이 제외되어야 함');
    assert(!user2Msg.includes('시간 변경 세미나'));

    // 3) user3 (point_paid만 ON): 이번 변경에 심화포인트지급이 없으므로 수신하지 않음
    assert(!sentMap.has(user3), 'user3은 해당하는 변경 카테고리가 없어 수신하지 않아야 함');

    // 4) user7 (전체 ON): 시간 변경과 증원 둘 다 수신
    assert(sentMap.has(user7), 'user7은 전체 알림을 수신해야 함');
    const user7Msg = sentMap.get(user7)!.join('\n');
    assert(user7Msg.includes('[세미나시간변경]'));
    assert(user7Msg.includes('[증원]'));

    // Case B: 감원이 발생했을 때 capacity(증원/감원) 카테고리로 감원도 정상 수신되는지 검증
    const infoChangesB: SeminarInfoChange[] = [
      {
        seminarId: '9003',
        name: '감원 세미나',
        date: '2026-08-25',
        changes: [{ field: 'totalCount', label: '총원', oldValue: '300', newValue: '150' }],
      },
    ];

    sentMap.clear();
    await sendSeminarChangesToSubscribers('감원 공지', {
      infoChanges: infoChangesB,
      pointChanges: [],
    });

    assert(sentMap.has(user2), 'user2는 capacity 설정으로 감원 알림도 수신해야 함');
    const user2MsgB = sentMap.get(user2)!.join('\n');
    assert(user2MsgB.includes('[감원]'), 'user2 메시지에 감원 포함');
    assert(user2MsgB.includes('감원 세미나'));

    assert(!sentMap.has(user1), 'user1(시간변경만 ON)은 감원 알림을 수신하지 않아야 함');
    assert(!sentMap.has(user3), 'user3은 감원 알림을 수신하지 않아야 함');
    assert(sentMap.has(user7), 'user7은 감원 알림을 수신해야 함');

    // Case C: 공개 전환 및 비공개 전환 발생 시 visibility 단일 카테고리로 둘 다 수신되는지 검증
    const infoChangesC: SeminarInfoChange[] = [
      {
        seminarId: '9004',
        name: '공개전환 세미나',
        date: '2026-08-25',
        changes: [{ field: 'hiddenYn', label: '비공개', oldValue: true, newValue: false }],
      },
      {
        seminarId: '9005',
        name: '비공개전환 세미나',
        date: '2026-08-25',
        hiddenYn: 'Y',
        changes: [{ field: 'hiddenYn', label: '비공개', oldValue: false, newValue: true }],
      },
    ];

    sentMap.clear();
    await sendSeminarChangesToSubscribers('공개비공개 공지', {
      infoChanges: infoChangesC,
      pointChanges: [],
    });

    assert(sentMap.has(user4), 'user4(visibility ON)는 공개/비공개 전환 알림을 수신해야 함');
    const user4MsgC = sentMap.get(user4)!.join('\n');
    assert(user4MsgC.includes('[비공개가 공개전환]'), 'user4 메시지에 비공개가 공개전환 포함');
    assert(user4MsgC.includes('[공개가 비공개전환]'), 'user4 메시지에 공개가 비공개전환 포함');
    assert(user4MsgC.includes('공개전환 세미나'));
    assert(user4MsgC.includes('비공개전환 세미나'));

    assert(!sentMap.has(user1), 'user1은 visibility 알림을 수신하지 않아야 함');
    assert(!sentMap.has(user2), 'user2는 visibility 알림을 수신하지 않아야 함');
    assert(sentMap.has(user7), 'user7(전체 ON)은 수신해야 함');

    // Case D: 심화설문 추가 및 해제 발생 시 advanced_survey 단일 카테고리로 둘 다 수신되는지 검증
    const infoChangesD: SeminarInfoChange[] = [
      {
        seminarId: '9006',
        name: '심화설문 추가 세미나',
        date: '2026-08-25',
        isAdvancedSurvey: true,
        changes: [{ field: 'isAdvancedSurvey', label: '심화설문', oldValue: false, newValue: true }],
      },
      {
        seminarId: '9007',
        name: '심화설문 해제 세미나',
        date: '2026-08-25',
        changes: [{ field: 'isAdvancedSurvey', label: '심화설문', oldValue: true, newValue: false }],
      },
    ];

    sentMap.clear();
    await sendSeminarChangesToSubscribers('심화설문 공지', {
      infoChanges: infoChangesD,
      pointChanges: [],
    });

    assert(sentMap.has(user5), 'user5(advanced_survey ON)는 심화설문 알림을 수신해야 함');
    const user5MsgD = sentMap.get(user5)!.join('\n');
    assert(user5MsgD.includes('[심화설문 추가]'), 'user5 메시지에 심화설문 추가 포함');
    assert(user5MsgD.includes('[심화설문 해제]'), 'user5 메시지에 심화설문 해제 포함');
    assert(user5MsgD.includes('심화설문 추가 세미나'));
    assert(user5MsgD.includes('심화설문 해제 세미나'));

    assert(!sentMap.has(user1), 'user1은 advanced_survey 알림을 수신하지 않아야 함');
    assert(!sentMap.has(user2), 'user2는 advanced_survey 알림을 수신하지 않아야 함');
    assert(!sentMap.has(user4), 'user4는 advanced_survey 알림을 수신하지 않아야 함');
    assert(sentMap.has(user7), 'user7(전체 ON)은 수신해야 함');

    // Case E: 포인트 주는/안주는 세미나로 변경 (point_eligibility) 단일 카테고리 검증
    const infoChangesE: SeminarInfoChange[] = [
      {
        seminarId: '9008',
        name: '포인트지급으로 변경 세미나',
        date: '2026-08-25',
        changes: [{ field: 'isPointExcluded', label: '포인트미지급', oldValue: true, newValue: false }],
      },
      {
        seminarId: '9009',
        name: '포인트미지급으로 변경 세미나',
        date: '2026-08-25',
        changes: [{ field: 'isPointExcluded', label: '포인트미지급', oldValue: false, newValue: true }],
      },
    ];

    sentMap.clear();
    await sendSeminarChangesToSubscribers('포인트정책 공지', {
      infoChanges: infoChangesE,
      pointChanges: [],
    });

    assert(sentMap.has(user6), 'user6(point_eligibility ON)은 포인트 대상 여부 변경 알림을 수신해야 함');
    const user6MsgE = sentMap.get(user6)!.join('\n');
    assert(user6MsgE.includes('[포인트지급으로변경]'), 'user6 메시지에 포인트지급으로변경 포함');
    assert(user6MsgE.includes('[미지급으로 변경]'), 'user6 메시지에 미지급으로 변경 포함');
    assert(user6MsgE.includes('포인트지급으로 변경 세미나'));
    assert(user6MsgE.includes('포인트미지급으로 변경 세미나'));

    assert(!sentMap.has(user1), 'user1은 point_eligibility 알림을 수신하지 않아야 함');
    assert(
      !sentMap.has(user3),
      'user3(심화포인트지급 ON)은 포인트 대상 여부 변경 알림을 수신하지 않아야 함 (헷갈림 방지 검증)',
    );
    assert(sentMap.has(user7), 'user7(전체 ON)은 수신해야 함');
  });
});
