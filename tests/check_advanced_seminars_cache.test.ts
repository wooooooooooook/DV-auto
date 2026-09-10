import assert from 'node:assert';
import * as seminarRepo from '../src/services/seminar_repository';
import * as checkAdvancedSeminarsModule from '../src/tasks/check_advanced_seminars';
import { setBot } from '../src/services/bot_instance';
import type { Telegraf } from 'telegraf';
import { describe, it, vi } from 'vitest';

describe('check_advanced_seminars Cache & NoticeBot Support Tests', () => {
  it('캐시 및 공지봇 연동 종합 테스트', async () => {
    console.log('=== [Test] check_advanced_seminars Cache & NoticeBot Support Tests Started ===\n');

    const originalStoredList = seminarRepo.getAllSeminars();

    try {
      // 1. 방장 계정 기준 텍스트 포함 확인 (빈 목록)
      seminarRepo.clearSeminars();
      checkAdvancedSeminarsModule.clearCache();
      const emptyResult = checkAdvancedSeminarsModule.run();
      assert.strictEqual(emptyResult.success, true);
      assert(
        emptyResult.message.includes('방장 계정 기준'),
        '빈 세미나 목록 메시지에 방장 계정 기준 명시가 포함되어야 함',
      );
      console.log('  ✓ [Pass] 빈 목록 응답에 "방장 계정 기준" 문구 포함 검증');

      // 2. 세미나 데이터 추가 후 응답 메시지 검증
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      seminarRepo.setAllSeminars([
        {
          seminarId: '9991',
          name: '당뇨병 최신 진료지침',
          url: 'https://m.doctorville.co.kr/cme/seminar/9991',
          date: todayStr,
          time: '19:00',
          currentCount: '10',
          totalCount: '100',
          nightTime: false,
          isAdvancedSurvey: true,
          pointPaid: true,
          pointText: '5,000P',
        },
      ]);

      checkAdvancedSeminarsModule.clearCache();
      const result1 = checkAdvancedSeminarsModule.runCached();
      assert.strictEqual(result1.success, true);
      assert(result1.message.includes('방장 계정 기준'), '응답 메시지에 방장 계정 기준 문구가 포함되어야 함');
      assert(result1.message.includes('9991'), '9991 세미나가 포함되어야 함');
      console.log('  ✓ [Pass] 세미나 목록 응답에 "방장 계정 기준" 문구 및 항목 정상 포함 검증');

      // 3. 10분 캐시 검증
      // storage 내용을 변경하더라도 clearCache가 호출되지 않으면 이전 캐시 결과 반환해야 함
      seminarRepo.clearSeminars();
      const cachedResult = checkAdvancedSeminarsModule.runCached();
      assert.strictEqual(
        cachedResult.message,
        result1.message,
        '10분 이내 재호출 시 storage가 바뀌어도 캐시된 결과가 반환되어야 함',
      );
      console.log('  ✓ [Pass] 10분 캐시 히트 동작 검증');

      // 4. clearCache 후 갱신 검증
      checkAdvancedSeminarsModule.clearCache();
      const refreshedResult = checkAdvancedSeminarsModule.runCached();
      assert(refreshedResult.message.includes('심화설문 세미나가 없습니다'), '캐시 초기화 후 새 상태로 갱신되어야 함');
      console.log('  ✓ [Pass] 캐시 만료/초기화 후 결과 갱신 검증');

      // 5. noticeBot 및 adminBot 명령어 등록 및 핸들러 동작 검증
      const registeredCommands: Record<string, (ctx: unknown) => Promise<unknown>> = {};
      const mockNoticeBot = {
        command: (cmd: string, handler: (ctx: unknown) => Promise<unknown>) => {
          registeredCommands[cmd] = handler;
        },
      } as unknown as Telegraf;

      setBot('notice', mockNoticeBot);

      assert(
        typeof registeredCommands['check_advanced_seminars'] === 'function',
        'check_advanced_seminars 명령어 등록 확인',
      );

      // 핸들러 실행 시 응답 확인
      let repliedMessage = '';
      const mockCtx = {
        reply: async (msg: string) => {
          repliedMessage = msg;
        },
      };

      await registeredCommands['check_advanced_seminars'](mockCtx);
      assert(
        repliedMessage.includes('방장 계정 기준'),
        '핸들러 실행 시 방장 계정 기준 문구가 포함된 응답이 전송되어야 함',
      );
      console.log('  ✓ [Pass] noticeBot 명령어 핸들러 등록 및 응답 동작 검증 (/check_advanced_seminars)');

      // 6. refreshSeminarPointStatus 포인트 지급 변경 시 캐시 무효화 검증
      const { refreshSeminarPointStatus } = await import('../src/services/seminar_point_sync');
      const checkPointModule = await import('../src/tasks/check_seminar_point');

      // 미지급 상태 세미나 등록 후 캐시 생성
      seminarRepo.setAllSeminars([
        {
          seminarId: '5608',
          name: 'BEYOND Web Symposium',
          url: 'https://m.doctorville.co.kr/cme/seminar/5608',
          date: todayStr,
          time: '19:00',
          currentCount: '10',
          totalCount: '100',
          nightTime: false,
          isAdvancedSurvey: true,
          pointPaid: false,
          pointCheckedAt: new Date().toISOString(),
        },
      ]);
      checkAdvancedSeminarsModule.clearCache();
      const beforePointRes = checkAdvancedSeminarsModule.runCached();
      assert(beforePointRes.message.includes('❌ 미지급'), '포인트 지급 전에는 미지급으로 표시되어야 함');

      // searchSeminarPoints를 모킹하여 5608 포인트 지급 발생 시뮬레이션
      const pointsMap = new Map();
      pointsMap.set('5608', {
        found: true,
        type: '적립',
        point: 2000,
        pointText: '2,000P',
        date: '2026-09-10 10:37:42',
        content: 'BEYOND Web Symposium',
      });
      const searchSpy = vi.spyOn(checkPointModule, 'searchSeminarPoints').mockImplementation(async () => ({
        success: true,
        points: pointsMap,
      }));

      try {
        await refreshSeminarPointStatus(undefined, seminarRepo.getAllSeminars());
        // 별도의 clearCache 호출 없이도 runCached() 결과가 즉시 갱신되어야 함
        const afterPointRes = checkAdvancedSeminarsModule.runCached();
        assert(
          afterPointRes.message.includes('✅ 2,000P 지급됨'),
          '포인트 지급 감지 후 캐시가 무효화되어 지급됨으로 표시되어야 함',
        );
        console.log('  ✓ [Pass] 포인트 지급 변경 감지 시 check_advanced_seminars 캐시 자동 무효화 검증');
      } finally {
        searchSpy.mockRestore();
      }

      console.log('\n🎉 모든 check_advanced_seminars 캐시 및 공지봇 연동 테스트 통과!');
    } finally {
      if (originalStoredList !== undefined) {
        seminarRepo.setAllSeminars(originalStoredList);
      }
      checkAdvancedSeminarsModule.clearCache();
    }
  });
});
