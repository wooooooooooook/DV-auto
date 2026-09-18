import { describe, it, expect } from 'vitest';
import { getSeoulKoreanDate } from '../src/modules/utils';
import { formatTodayLinksBroadcast } from '../src/tasks/today_links';
import { buildSeminarStatusMessage, type MonitoredSeminarItem } from '../src/tasks/monitor_seminars_notice';
import { buildNewSeminarsNoticeMessage } from '../src/tasks/apply_seminar_notice';
import type { SeminarListItem } from '../src/services/seminar_repository';

describe('공지채널메시지 5종 날짜(MM월 DD일) 헤더 검증', () => {
  describe('getSeoulKoreanDate 유틸 함수', () => {
    it('YYYY-MM-DD 문자열을 MM월 DD일 형식으로 변환해야 함', () => {
      expect(getSeoulKoreanDate('2026-09-18')).toBe('09월 18일');
      expect(getSeoulKoreanDate('2026-01-05')).toBe('01월 05일');
      expect(getSeoulKoreanDate('2026-12-31')).toBe('12월 31일');
    });

    it('M/D 또는 MM/DD 문자열을 두 자리 패딩 MM월 DD일 형식으로 변환해야 함', () => {
      expect(getSeoulKoreanDate('9/5')).toBe('09월 05일');
      expect(getSeoulKoreanDate('09/18')).toBe('09월 18일');
    });

    it('Date 객체 및 timestamp를 KST(Asia/Seoul) 기준 MM월 DD일로 변환해야 함', () => {
      // 2026-09-18 00:00:00 KST = 2026-09-17 15:00:00 UTC
      const utcDate = new Date('2026-09-17T15:00:00Z');
      expect(getSeoulKoreanDate(utcDate)).toBe('09월 18일');
      expect(getSeoulKoreanDate(utcDate.getTime())).toBe('09월 18일');
    });
  });

  describe('1. 오늘의 링크 공지 메시지', () => {
    it('일반 당일 오늘의 링크 메시지 상단에 [MM월 DD일 오늘의 링크] 헤더가 포함되어야 함', () => {
      const { message } = formatTodayLinksBroadcast({
        quizInfo: null,
        seminarMessage: null,
        storedNewSeminars: [],
        pointConversionInfo: null,
        targetDate: '2026-09-18',
      });

      expect(message.startsWith('📅 <b>[09월 18일 오늘의 링크]</b>\n\n')).toBe(true);
      expect(message).toContain('✨ <b>출석체크:</b>');
    });
  });

  describe('2. 아침 세미나 현황 공지 메시지', () => {
    it('아침세미나 현황 메시지 상단에 🔔 [MM월 DD일] 아침세미나 헤더가 포함되어야 함', () => {
      const fixedNowMs = new Date('2026-09-18T00:00:00+09:00').getTime();
      const seminars: MonitoredSeminarItem[] = [
        {
          seminarId: '101',
          name: '아침 세미나 1',
          url: 'https://m.doctorville.co.kr/cme/seminar/101',
          status: '대기',
          time: '07:30~08:30',
        },
      ];

      const { text } = buildSeminarStatusMessage('아침', seminars, false, [], fixedNowMs);
      expect(text.startsWith('🔔 [09월 18일] 아침세미나\n\n')).toBe(true);
      expect(text).toContain('아침 세미나 1');
    });

    it('예정된 아침세미나가 없을 때도 🔔 [MM월 DD일] 아침세미나 헤더가 유지되어야 함', () => {
      const fixedNowMs = new Date('2026-09-18T00:00:00+09:00').getTime();
      const { text } = buildSeminarStatusMessage('아침', [], false, [], fixedNowMs);
      expect(text).toBe('🔔 [09월 18일] 아침세미나\n\n예정된 세미나가 없습니다.');
    });
  });

  describe('3. 점심 세미나 현황 공지 메시지', () => {
    it('점심세미나 현황 메시지 상단에 🔔 [MM월 DD일] 점심세미나 헤더가 포함되어야 함', () => {
      const fixedNowMs = new Date('2026-09-18T04:00:00+09:00').getTime();
      const seminars: MonitoredSeminarItem[] = [
        {
          seminarId: '102',
          name: '점심 세미나 1',
          url: 'https://m.doctorville.co.kr/cme/seminar/102',
          status: '입장가능',
          time: '12:30~13:30',
        },
      ];

      const { text } = buildSeminarStatusMessage('점심', seminars, false, [], fixedNowMs);
      expect(text.startsWith('🔔 [09월 18일] 점심세미나\n\n')).toBe(true);
      expect(text).toContain('점심 세미나 1');
    });

    it('예정된 점심세미나가 없을 때도 🔔 [MM월 DD일] 점심세미나 헤더가 유지되어야 함', () => {
      const fixedNowMs = new Date('2026-09-18T04:00:00+09:00').getTime();
      const { text } = buildSeminarStatusMessage('점심', [], false, [], fixedNowMs);
      expect(text).toBe('🔔 [09월 18일] 점심세미나\n\n예정된 세미나가 없습니다.');
    });
  });

  describe('4. 저녁 세미나 현황 공지 메시지', () => {
    it('저녁세미나 현황 메시지 상단에 🔔 [MM월 DD일] 저녁세미나 헤더가 포함되어야 함', () => {
      const fixedNowMs = new Date('2026-09-18T10:00:00+09:00').getTime();
      const seminars: MonitoredSeminarItem[] = [
        {
          seminarId: '103',
          name: '저녁 세미나 1',
          url: 'https://m.doctorville.co.kr/cme/seminar/103',
          status: '대기',
          time: '19:00~20:00',
        },
      ];

      const { text } = buildSeminarStatusMessage('저녁', seminars, false, [], fixedNowMs);
      expect(text.startsWith('🔔 [09월 18일] 저녁세미나\n\n')).toBe(true);
      expect(text).toContain('저녁 세미나 1');
    });

    it('예정된 저녁세미나가 없을 때도 🔔 [MM월 DD일] 저녁세미나 헤더가 유지되어야 함', () => {
      const fixedNowMs = new Date('2026-09-18T10:00:00+09:00').getTime();
      const { text } = buildSeminarStatusMessage('저녁', [], false, [], fixedNowMs);
      expect(text).toBe('🔔 [09월 18일] 저녁세미나\n\n예정된 세미나가 없습니다.');
    });
  });

  describe('5. 신규 세미나 공지 메시지', () => {
    it('신규 세미나 모음 메시지 상단에 🆕 [MM월 DD일] 오늘 추가된 세미나 모음 헤더가 포함되어야 함', () => {
      const seminars: SeminarListItem[] = [
        {
          seminarId: '104',
          name: '신규 감지 세미나',
          url: 'https://m.doctorville.co.kr/cme/seminar/104',
          date: '2026-09-25',
          time: '13:00~14:00',
          totalCount: '500',
          currentCount: '0',
          detectedDate: '2026-09-18',
        },
      ];

      const { text } = buildNewSeminarsNoticeMessage(seminars, ['104'], [], '2026-09-18');
      expect(text.startsWith('🆕 [09월 18일] 오늘 추가된 세미나 모음 (누적 1건)\n\n')).toBe(true);
      expect(text).toContain('1. [2026-09-25 13:00~14:00] 신규 감지 세미나');
    });
  });
});
