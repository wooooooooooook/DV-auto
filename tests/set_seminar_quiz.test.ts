import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as channelRepo from '../src/services/channel_message_repository';
import {
  formatQuizAnswerInput,
  updateSeminarQuizInMessageText,
  updateActiveSeminarQuiz,
  activeMonitors,
  setSeminarQuizAnswer,
  type MonitoredSeminarItem,
} from '../src/tasks/monitor_seminars';

describe('formatQuizAnswerInput', () => {
  it('숫자 형태의 정답을 "퀴즈 정답 <숫자>"로 포맷팅', () => {
    expect(formatQuizAnswerInput('112')).toBe('퀴즈 정답 112');
    expect(formatQuizAnswerInput('1 2 3')).toBe('퀴즈 정답 1 2 3');
  });

  it('텍스트/문장 형태의 정답을 "퀴즈 정답 <텍스트>"로 포맷팅', () => {
    expect(formatQuizAnswerInput('1번 O, 2번 X')).toBe('퀴즈 정답 1번 O, 2번 X');
    expect(formatQuizAnswerInput('1번 1, 2번 2, 3번 3')).toBe('퀴즈 정답 1번 1, 2번 2, 3번 3');
  });

  it('이미 "퀴즈 정답" 또는 "퀴즈정답"으로 시작하는 경우 중복 접두사 방지', () => {
    expect(formatQuizAnswerInput('퀴즈 정답 112')).toBe('퀴즈 정답 112');
    expect(formatQuizAnswerInput('퀴즈정답 123')).toBe('퀴즈정답 123');
    expect(formatQuizAnswerInput('퀴즈 정답: 1번 O, 2번 X')).toBe('퀴즈 정답: 1번 O, 2번 X');
  });

  it('대괄호 마커([퀴즈], [OX] 등) 또는 "정답 :" 접두사가 있는 경우 중복 접두사 방지', () => {
    expect(formatQuizAnswerInput('[퀴즈] 정답 112')).toBe('[퀴즈] 정답 112');
    expect(formatQuizAnswerInput('[OX] 정답 12')).toBe('[OX] 정답 12');
    expect(formatQuizAnswerInput('[주관식] 정답 아스피린')).toBe('[주관식] 정답 아스피린');
    expect(formatQuizAnswerInput('정답 : 1번 O, 2번 X')).toBe('정답 : 1번 O, 2번 X');
    expect(formatQuizAnswerInput('정답: 2번')).toBe('정답: 2번');
  });

  it('공백 문자열 처리', () => {
    expect(formatQuizAnswerInput('   ')).toBe('');
  });
});

describe('updateSeminarQuizInMessageText', () => {
  it('기존에 퀴즈가 없던 종료 세미나(설문 마감 카운트다운 포함)에 퀴즈 정답 삽입', () => {
    const original = [
      '🔔 점심세미나',
      '',
      '🔴 종료 | 12:30 만성질환 관리',
      'https://m.doctorville.co.kr/cme/seminar/12345',
      '(설문 마감 약 40분 남음)',
      '',
      '━━━━━━━━━━━━━━━━━━',
      '🏁 점심세미나가 모두 종료되었습니다.',
    ].join('\n');

    const result = updateSeminarQuizInMessageText(original, '12345', '퀴즈 정답 112');
    expect(result.success).toBe(true);
    expect(result.updatedText).toBe(
      [
        '🔔 점심세미나',
        '',
        '🔴 종료 | 12:30 만성질환 관리',
        'https://m.doctorville.co.kr/cme/seminar/12345',
        '퀴즈 정답 112',
        '(설문 마감 약 40분 남음)',
        '',
        '━━━━━━━━━━━━━━━━━━',
        '🏁 점심세미나가 모두 종료되었습니다.',
      ].join('\n'),
    );
  });

  it('기존 퀴즈 정답이 있던 항목을 새 정답으로 교체', () => {
    const original = [
      '🔔 저녁세미나',
      '',
      '🔴 종료 | 18:30 순환기 최신지견',
      'https://m.doctorville.co.kr/cme/seminar/5580',
      '퀴즈 정답 1-?-? (일부 미해결)',
      '(설문 마감 약 30분 남음)',
    ].join('\n');

    const result = updateSeminarQuizInMessageText(original, '5580', '퀴즈 정답 1번 O, 2번 X');
    expect(result.success).toBe(true);
    expect(result.updatedText).toBe(
      [
        '🔔 저녁세미나',
        '',
        '🔴 종료 | 18:30 순환기 최신지견',
        'https://m.doctorville.co.kr/cme/seminar/5580',
        '퀴즈 정답 1번 O, 2번 X',
        '(설문 마감 약 30분 남음)',
      ].join('\n'),
    );
  });

  it('설문이 없는 세미나에 퀴즈 정답 삽입', () => {
    const original = [
      '🔔 점심세미나',
      '',
      '🔴 종료 | 12:30 학술 심포지엄',
      'https://m.doctorville.co.kr/cme/seminar/9999',
      '(설문이 없는 세미나)',
    ].join('\n');

    const result = updateSeminarQuizInMessageText(original, '9999', '퀴즈 정답 123');
    expect(result.success).toBe(true);
    expect(result.updatedText).toBe(
      [
        '🔔 점심세미나',
        '',
        '🔴 종료 | 12:30 학술 심포지엄',
        'https://m.doctorville.co.kr/cme/seminar/9999',
        '퀴즈 정답 123',
        '(설문이 없는 세미나)',
      ].join('\n'),
    );
  });

  it('여러 세미나가 있을 때 대상 세미나만 정확히 수정', () => {
    const original = [
      '🔔 저녁세미나',
      '',
      '🔴 종료 | 18:00 세미나 A',
      'https://m.doctorville.co.kr/cme/seminar/1111',
      '(설문 마감 약 10분 남음)',
      '',
      '🔴 종료 | 18:30 세미나 B',
      'https://m.doctorville.co.kr/cme/seminar/2222',
      '(설문 마감 약 40분 남음)',
    ].join('\n');

    const result = updateSeminarQuizInMessageText(original, '2222', '퀴즈 정답 321');
    expect(result.success).toBe(true);
    expect(result.updatedText).toBe(
      [
        '🔔 저녁세미나',
        '',
        '🔴 종료 | 18:00 세미나 A',
        'https://m.doctorville.co.kr/cme/seminar/1111',
        '(설문 마감 약 10분 남음)',
        '',
        '🔴 종료 | 18:30 세미나 B',
        'https://m.doctorville.co.kr/cme/seminar/2222',
        '퀴즈 정답 321',
        '(설문 마감 약 40분 남음)',
      ].join('\n'),
    );
  });

  it('존재하지 않는 세미나 ID인 경우 실패 및 원본 반환', () => {
    const original = '🔔 점심세미나\n\n🔴 종료 | 12:30 세미나\nhttps://m.doctorville.co.kr/cme/seminar/1111';
    const result = updateSeminarQuizInMessageText(original, '9999', '퀴즈 정답 123');
    expect(result.success).toBe(false);
    expect(result.updatedText).toBe(original);
  });
});

describe('updateActiveSeminarQuiz', () => {
  beforeEach(() => {
    activeMonitors.clear();
  });

  afterEach(() => {
    activeMonitors.clear();
  });

  it('활성 모니터링 맵이 등록되어 있을 때 quizResultMessage를 실시간 업데이트', () => {
    const mockMap = new Map<string, MonitoredSeminarItem>();
    mockMap.set('https://m.doctorville.co.kr/cme/seminar/5580', {
      seminarId: '5580',
      url: 'https://m.doctorville.co.kr/cme/seminar/5580',
      name: '심화 세미나',
      status: '종료',
      quizResultMessage: null,
    });

    activeMonitors.add(mockMap);

    const updated = updateActiveSeminarQuiz('5580', '퀴즈 정답 112');
    expect(updated).toBe(true);
    expect(mockMap.get('https://m.doctorville.co.kr/cme/seminar/5580')?.quizResultMessage).toBe('퀴즈 정답 112');
  });

  it('해당 세미나가 활성 모니터링에 없는 경우 false 반환', () => {
    const mockMap = new Map<string, MonitoredSeminarItem>();
    mockMap.set('https://m.doctorville.co.kr/cme/seminar/5580', {
      seminarId: '5580',
      url: 'https://m.doctorville.co.kr/cme/seminar/5580',
      name: '심화 세미나',
      status: '종료',
    });

    activeMonitors.add(mockMap);

    const updated = updateActiveSeminarQuiz('9999', '퀴즈 정답 112');
    expect(updated).toBe(false);
  });
});

describe('setSeminarQuizAnswer 통합 동작', () => {
  it('유효하지 않은 인자 검증', async () => {
    const res1 = await setSeminarQuizAnswer('', '112');
    expect(res1.success).toBe(false);
    expect(res1.message).toContain('세미나 번호');

    const res2 = await setSeminarQuizAnswer('12345', '   ');
    expect(res2.success).toBe(false);
    expect(res2.message).toContain('퀴즈 정답');
  });

  it('다수의 공지 메시지 중 가장 최신 메시지(DESC 정렬 첫 번째 항목)를 찾아 즉시 수정', async () => {
    const oldText = [
      '🔔 점심세미나',
      '',
      '🔴 종료 | 12:30 세미나',
      'https://m.doctorville.co.kr/cme/seminar/5612',
      '(설문 마감 약 40분 남음)',
    ].join('\n');

    const latestText = [
      '🔔 저녁세미나',
      '',
      '🔴 종료 | 18:30 세미나',
      'https://m.doctorville.co.kr/cme/seminar/5612',
      '(설문 마감 약 30분 남음)',
    ].join('\n');

    const mockMessages: channelRepo.ChannelMessageRecord[] = [
      {
        id: 2,
        messageId: 2489,
        channelId: '-1001234567890',
        date: '2026-09-02',
        status: 'sent',
        text: latestText,
        mediaType: 'text',
        createdAt: '2026-09-02T19:00:00.000Z',
      },
      {
        id: 1,
        messageId: 2488,
        channelId: '-1001234567890',
        date: '2026-09-02',
        status: 'sent',
        text: oldText,
        mediaType: 'text',
        createdAt: '2026-09-02T13:00:00.000Z',
      },
    ];

    const getRecentSpy = vi.spyOn(channelRepo, 'getRecentChannelMessages').mockReturnValue(mockMessages);
    const editSpy = vi.spyOn(channelRepo, 'editChannelMessage').mockResolvedValue({
      success: true,
      message: '메시지 수정 완료',
    });
    const updateStatusSpy = vi.spyOn(channelRepo, 'updateChannelMessageStatus').mockImplementation(() => {});

    const res = await setSeminarQuizAnswer('5612', '234');

    expect(res.success).toBe(true);
    expect(res.channelMessageId).toBe(2489); // 과거 메시지 2488이 아닌 최신 메시지 2489가 수정되어야 함!
    expect(editSpy).toHaveBeenCalledWith(
      2489,
      expect.stringContaining('퀴즈 정답 234'),
      expect.objectContaining({ channelId: '-1001234567890' }),
    );
    expect(updateStatusSpy).toHaveBeenCalledWith(2489, 'edited', expect.any(String), '-1001234567890');

    getRecentSpy.mockRestore();
    editSpy.mockRestore();
    updateStatusSpy.mockRestore();
  });
});
