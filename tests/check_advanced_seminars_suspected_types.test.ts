import assert from 'node:assert';
import { describe, it } from 'vitest';
import * as seminarRepo from '../src/services/seminar_repository';
import * as checkAdvancedSeminarsModule from '../src/tasks/check_advanced_seminars';
import { setBot } from '../src/services/bot_instance';
import type { Telegraf } from 'telegraf';

describe('check_advanced_seminars 심화설문 의심 두 가지 경우 구분 및 조회 테스트', () => {
  it('심화설문 의심 구분: 심화설문인데 없는거 vs 심화설문이 아니었는데 심화의심 판정 및 check_advanced_seminars 표시 검증', async () => {
    // 1. 세미나 리포지토리 초기화
    seminarRepo.clearSeminars();
    checkAdvancedSeminarsModule.clearCache();

    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // 2. 세 가지 유형의 세미나 데이터 준비
    // (1) 확정 심화설문
    const advSeminar: seminarRepo.SeminarListItem = {
      seminarId: '7001',
      name: '확정 심화 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/7001',
      date: todayStr,
      time: '13:00',
      currentCount: '10',
      totalCount: '100',
      nightTime: false,
      isAdvancedSurvey: true,
      isSuspectedAdvancedSurvey: false,
      pointPaid: true,
      pointText: '5,000P',
    };

    // (2) 심화설문인데 없는 거 (useDepthSurvey='Y'이나 주관식 없음)
    const advNoSubjectiveSeminar: seminarRepo.SeminarListItem = {
      seminarId: '7002',
      name: '심화설문 주관식 부재 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/7002',
      date: todayStr,
      time: '14:00',
      currentCount: '20',
      totalCount: '100',
      nightTime: false,
      isAdvancedSurvey: true,
      isSuspectedAdvancedSurvey: true,
      suspectedAdvancedType: 'advanced_without_subjective',
      pointPaid: false,
      pointCheckedAt: '2026-11-17 14:00:00',
    };

    // (3) 심화설문이 아니었는데 심화설문 의심인 거 (useDepthSurvey='N'이나 주관식/키워드 감지)
    const notAdvSuspectedSeminar: seminarRepo.SeminarListItem = {
      seminarId: '7003',
      name: '미심화이나 주관식 발견 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/7003',
      date: todayStr,
      time: '15:00',
      currentCount: '30',
      totalCount: '100',
      nightTime: false,
      isAdvancedSurvey: false,
      isSuspectedAdvancedSurvey: true,
      suspectedAdvancedType: 'not_advanced_suspected',
      pointPaid: false,
    };

    // (4) 일반 세미나 (조회 제외 대상)
    const normalSeminar: seminarRepo.SeminarListItem = {
      seminarId: '7004',
      name: '일반 미심화 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/7004',
      date: todayStr,
      time: '16:00',
      currentCount: '40',
      totalCount: '100',
      nightTime: false,
      isAdvancedSurvey: false,
      isSuspectedAdvancedSurvey: false,
      pointPaid: false,
    };

    // DB에 일괄 저장
    seminarRepo.upsertSeminars([advSeminar, advNoSubjectiveSeminar, notAdvSuspectedSeminar, normalSeminar]);

    // 3. seminarRepo.getAdvancedSeminars가 심화 및 심화의심 2가지 경우를 모두 가져오는지 검증
    const past14Days = new Date(Date.now() - 14 * 86400 * 1000).toISOString().slice(0, 10);
    const futureDate = new Date(Date.now() + 86400 * 1000).toISOString().slice(0, 10);
    const queryResults = seminarRepo.getAdvancedSeminars(past14Days, futureDate);
    const resultIds = queryResults.map((s) => s.seminarId);

    assert(resultIds.includes('7001'), '확정 심화 세미나(7001)가 getAdvancedSeminars에 포함되어야 함');
    assert(resultIds.includes('7002'), '심화설문인데 없는 세미나(7002)가 getAdvancedSeminars에 포함되어야 함');
    assert(
      resultIds.includes('7003'),
      '심화설문이 아니었는데 의심인 세미나(7003)가 getAdvancedSeminars에 포함되어야 함',
    );
    assert(!resultIds.includes('7004'), '일반 세미나(7004)는 getAdvancedSeminars에서 제외되어야 함');

    // 4. check_advanced_seminars 실행 및 메시지 포맷 검증
    const runResult = checkAdvancedSeminarsModule.run();
    assert.strictEqual(runResult.success, true);
    const message = runResult.message;

    // 헤더 통계 확인
    assert(message.includes('최근 2주 심화설문 3건'), '총 3건이 집계되어야 함');
    assert(message.includes('심화설문 1건'), '확정 심화설문 1건 집계 확인');
    assert(message.includes('심화설문 어디갔지🧐 1건'), '심화설문 어디갔지🧐 1건 집계 확인');
    assert(message.includes('혹시 심화설문? 1건'), '혹시 심화설문? 1건 집계 확인');

    // 각 라인별 태그 및 내용 확인
    assert(message.includes('7001 | 확정 심화 세미나 | [심화설문] | ✅ 5,000P 지급됨'), '7001 라인 형식 검증');
    assert(message.includes('7002 | 심화설문 주관식 부... | [심화설문 어디갔지🧐] | ❌ 미지급'), '7002 라인 형식 검증');
    assert(message.includes('7003 | 미심화이나 주관식 ... | [혹시 심화설문?] | ⏳ 조회 대기'), '7003 라인 형식 검증');

    // 5. 텔레그램 명령어 별칭 (/check_advanced_seminar 단수형) 등록 및 동작 검증
    const registeredCommands: Record<string, (ctx: unknown) => Promise<unknown>> = {};
    const mockNoticeBot = {
      command: (cmd: string, handler: (ctx: unknown) => Promise<unknown>) => {
        registeredCommands[cmd] = handler;
      },
    } as unknown as Telegraf;

    setBot('notice', mockNoticeBot);

    assert(
      typeof registeredCommands['check_advanced_seminars'] === 'function',
      'check_advanced_seminars 복수형 명령어 등록 확인',
    );
    assert(
      typeof registeredCommands['check_advanced_seminar'] === 'function',
      'check_advanced_seminar 단수형 명령어 등록 확인',
    );

    let repliedMessage = '';
    const mockCtx = {
      from: { id: 12345 },
      reply: async (msg: string) => {
        repliedMessage = msg;
      },
    };

    await registeredCommands['check_advanced_seminar'](mockCtx);
    assert(repliedMessage.includes('7001'), '단수형 명령어로도 세미나 목록 정상 응답 확인');
    assert(repliedMessage.includes('[심화설문 어디갔지🧐]'), '단수형 명령어로도 심화설문 어디갔지🧐 표시 확인');
    assert(repliedMessage.includes('[혹시 심화설문?]'), '단수형 명령어로도 혹시 심화설문? 표시 확인');
  });

  it('기존 레거시 데이터 호환성 검증: suspectedAdvancedType이 없는 경우 isAdvancedSurvey로 자동 판별', () => {
    const legacyWithoutSubjective: seminarRepo.SeminarListItem = {
      seminarId: '8001',
      name: '레거시 심화 부재 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/8001',
      date: '2026-11-17',
      time: '10:00',
      currentCount: '1',
      totalCount: '100',
      nightTime: false,
      isAdvancedSurvey: true,
      isSuspectedAdvancedSurvey: true,
      // suspectedAdvancedType 생략
    };

    const legacyNotAdvSuspected: seminarRepo.SeminarListItem = {
      seminarId: '8002',
      name: '레거시 미심화 의심 세미나',
      url: 'https://m.doctorville.co.kr/cme/seminar/8002',
      date: '2026-11-17',
      time: '11:00',
      currentCount: '1',
      totalCount: '100',
      nightTime: false,
      isAdvancedSurvey: false,
      isSuspectedAdvancedSurvey: true,
      // suspectedAdvancedType 생략
    };

    assert.strictEqual(
      checkAdvancedSeminarsModule.getAdvancedSeminarType(legacyWithoutSubjective),
      'advanced_without_subjective',
    );
    assert.strictEqual(
      checkAdvancedSeminarsModule.getAdvancedSeminarTypeLabel('advanced_without_subjective'),
      '[심화설문 어디갔지🧐]',
    );

    assert.strictEqual(
      checkAdvancedSeminarsModule.getAdvancedSeminarType(legacyNotAdvSuspected),
      'not_advanced_suspected',
    );
    assert.strictEqual(
      checkAdvancedSeminarsModule.getAdvancedSeminarTypeLabel('not_advanced_suspected'),
      '[혹시 심화설문?]',
    );
  });

  it('채널 공지 태그(formatSeminarDisplayName)에서 심화설문 어디갔지🧐 와 혹시 심화설문? 분기 표시 검증', async () => {
    const { formatSeminarDisplayName } = await import('../src/modules/utils');

    // 1. 심화설문인데 주관식 없는 경우 -> [심화설문 어디갔지🧐]
    const withoutSubj = formatSeminarDisplayName({
      name: '당뇨 심화 세미나',
      isAdvancedSurvey: true,
      isSuspectedAdvancedSurvey: true,
      suspectedAdvancedType: 'advanced_without_subjective',
    });
    assert(withoutSubj.includes('✨<b>[심화설문 어디갔지🧐]</b> 당뇨 심화 세미나'));

    // 2. 심화설문이 아니었는데 심화설문 의심인 경우 -> [혹시 심화설문?]
    const suspected = formatSeminarDisplayName({
      name: '고혈압 일반 세미나',
      isAdvancedSurvey: false,
      isSuspectedAdvancedSurvey: true,
      suspectedAdvancedType: 'not_advanced_suspected',
    });
    assert(suspected.includes('✨<b>[혹시 심화설문?]</b> 고혈압 일반 세미나'));

    // 3. 확정 심화설문인 경우 -> [심화설문]
    const normalAdv = formatSeminarDisplayName({
      name: '비만 확정 세미나',
      isAdvancedSurvey: true,
      isSuspectedAdvancedSurvey: false,
    });
    assert(normalAdv.includes('✨<b>[심화설문]</b> 비만 확정 세미나'));
  });
});
