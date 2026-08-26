import assert from 'node:assert';
import { describe, it } from 'vitest';
import {
  buildSeminarMonitorStatusMessage,
  getSeminarStatusDisplay,
  type SeminarInfo,
} from '../src/tasks/monitor_seminars';

describe('buildSeminarMonitorStatusMessage 세미나 모니터 현황 메시지 포맷팅 테스트', () => {
  it('** 볼드 제거, 시작종료시각 제목 앞 표시, 20글자 트렁케이션, 심화설문 접미사 검증', () => {
    const seminars: Record<string, SeminarInfo> = {
      'https://m.doctorville.co.kr/cme/seminar/5580': {
        seminarId: '5580',
        url: 'https://m.doctorville.co.kr/cme/seminar/5580',
        name: '[재] ENVLO WEB SYMPOSIUM',
        status: '입장하기',
        processState: 1, // PROCESS_ENTER
        time: '18:00~19:00',
        isAdvancedSurvey: true,
      },
      'https://m.doctorville.co.kr/cme/seminar/5579': {
        seminarId: '5579',
        url: 'https://m.doctorville.co.kr/cme/seminar/5579',
        name: '[재] Redefining P-CAB: From Gastritis to GERD',
        status: '진행중',
        processState: 6, // PROCESS_STARTED
        time: '18:30~19:30',
        isAdvancedSurvey: true,
      },
      'https://m.doctorville.co.kr/cme/seminar/5600': {
        seminarId: '5600',
        url: 'https://m.doctorville.co.kr/cme/seminar/5600',
        name: 'DIVE (Digital Innovation, Value & Experience) Web symposium',
        status: '대기중',
        processState: 2, // PROCESS_APPLY
        time: '19:00~20:00',
        isAdvancedSurvey: false,
      },
    };

    const message = buildSeminarMonitorStatusMessage('저녁', seminars);

    // 1. 헤더 검증
    assert(message.startsWith('🔔 저녁세미나\n\n'), '헤더가 🔔 저녁세미나로 시작해야 함');

    // 2. ** 볼드 마크다운이 포함되지 않았는지 검증
    assert(!message.includes('**'), '메시지에 ** 볼드 마크다운이 포함되지 않아야 함');

    // 3. 5580 세미나 검증: 🟢 입장가능 | 18:00~19:00 [재] ENVLO WEB SYMPOS [심화설문]
    assert(
      message.includes('🟢 입장가능 | 18:00~19:00 [재] ENVLO WEB SYMPOS [심화설문]'),
      '5580 세미나의 시작종료시각, 20자 트렁케이션, 심화설문 태그가 올바르게 포맷되어야 함',
    );
    assert(message.includes('https://m.doctorville.co.kr/cme/seminar/5580'), '5580 URL이 포함되어야 함');

    // 4. 5579 세미나 검증: 🟢 입장가능 | 18:30~19:30 [재] Redefining P-CAB [심화설문]
    assert(
      message.includes('🟢 입장가능 | 18:30~19:30 [재] Redefining P-CAB [심화설문]'),
      '5579 세미나의 시작종료시각, 20자 트렁케이션, 심화설문 태그가 올바르게 포맷되어야 함',
    );
    assert(message.includes('https://m.doctorville.co.kr/cme/seminar/5579'), '5579 URL이 포함되어야 함');

    // 5. 5600 세미나 검증: ⏳ 대기 | 19:00~20:00 DIVE (Digital Innova
    assert(
      message.includes('⏳ 대기 | 19:00~20:00 DIVE (Digital Innova\nhttps://m.doctorville.co.kr/cme/seminar/5600'),
      '5600 세미나의 대기 상태, 시작종료시각, 20자 트렁케이션이 올바르게 포맷되어야 함',
    );
  });

  it('20글자 이하 제목은 트렁케이션 없이 그대로 유지', () => {
    const seminars: SeminarInfo[] = [
      {
        seminarId: '1234',
        name: '짧은 세미나 제목',
        status: '입장하기',
        processState: 1,
        time: '12:00~13:00',
        isAdvancedSurvey: false,
      },
    ];

    const message = buildSeminarMonitorStatusMessage('점심', seminars);
    assert(message.includes('🟢 입장가능 | 12:00~13:00 짧은 세미나 제목'));
  });

  it('시간(time) 정보가 없을 경우 시간 생략 후 제목 바로 출력', () => {
    const seminars: SeminarInfo[] = [
      {
        seminarId: '1234',
        name: '시간 미정 세미나',
        status: '대기',
        processState: 4,
      },
    ];

    const message = buildSeminarMonitorStatusMessage('저녁', seminars);
    assert(message.includes('⏳ 대기 | 시간 미정 세미나'));
  });

  it('getSeminarStatusDisplay 상태별 이모지 및 텍스트 매핑 검증', () => {
    // 1. 종료 상태
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '종료' }), { emoji: '🔴', text: '종료' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '', seminarCompleted: 1 }), { emoji: '🔴', text: '종료' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '', processState: 7 }), { emoji: '🔴', text: '종료' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '', processState: 8 }), { emoji: '🔴', text: '종료' });

    // 2. 입장 가능 상태
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '입장하기' }), { emoji: '🟢', text: '입장가능' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '진행중' }), { emoji: '🟢', text: '입장가능' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '', processState: 1 }), { emoji: '🟢', text: '입장가능' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '', processState: 6 }), { emoji: '🟢', text: '입장가능' });

    // 3. 대기 상태
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '대기중' }), { emoji: '⏳', text: '대기' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '신청하기' }), { emoji: '⏳', text: '대기' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '신청완료' }), { emoji: '⏳', text: '대기' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '', processState: 2 }), { emoji: '⏳', text: '대기' });
    assert.deepStrictEqual(getSeminarStatusDisplay({ status: '', processState: 3 }), { emoji: '⏳', text: '대기' });
  });

  it('세미나가 없는 경우 기본 메시지 반환', () => {
    const message = buildSeminarMonitorStatusMessage('저녁', []);
    assert.strictEqual(message, '🔔 저녁세미나\n\n예정된 세미나가 없습니다.');
  });
});
