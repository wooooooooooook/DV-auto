import { describe, it, expect } from 'vitest';
import { formatSeminarDisplayName, type SeminarDisplayItem } from '../src/modules/utils';

describe('formatSeminarDisplayName 공통 함수 테스트', () => {
  it('1. 기본 세미나 이름 포맷팅 (20자 이하, 플래그 없음)', () => {
    const item: SeminarDisplayItem = {
      name: '일반 공개 세미나',
    };
    const result = formatSeminarDisplayName(item);
    expect(result).toBe('일반 공개 세미나');
  });

  it('2. 세미나 이름 20자 초과 truncation 검증 (기본 maxLen=20)', () => {
    const longName = '이것은스무글자를훨씬초과하는매우매우긴세미나이름입니다';
    const item: SeminarDisplayItem = {
      name: longName,
    };
    const result = formatSeminarDisplayName(item);
    expect(result).toBe(`${longName.slice(0, 20)}...`);
  });

  it('3. 커스텀 maxLen 및 maxLen=false/0 비활성화 검증', () => {
    const longName = '가나다라마바사아자차카타파하';
    const item: SeminarDisplayItem = { name: longName };

    expect(formatSeminarDisplayName(item, { maxLen: 5 })).toBe('가나다라마...');
    expect(formatSeminarDisplayName(item, { maxLen: false })).toBe(longName);
    expect(formatSeminarDisplayName(item, { maxLen: 0 })).toBe(longName);
    expect(formatSeminarDisplayName(item, { maxLen: null })).toBe(longName);
  });

  it('4. 날짜 및 시간 접두사 검증', () => {
    const item: SeminarDisplayItem = {
      name: '세미나',
      date: '2026-09-08',
      time: '13:00~14:00',
    };

    // 옵션 미지정 시 일시 미포함
    expect(formatSeminarDisplayName(item)).toBe('세미나');

    // 시간만 포함
    expect(formatSeminarDisplayName(item, { includeTime: true })).toBe('[13:00~14:00] 세미나');

    // 날짜만 포함
    expect(formatSeminarDisplayName(item, { includeDate: true })).toBe('[2026-09-08] 세미나');

    // 날짜 + 시간 모두 포함
    expect(formatSeminarDisplayName(item, { includeDate: true, includeTime: true })).toBe(
      '[2026-09-08 13:00~14:00] 세미나',
    );
  });

  it('5. 비공개 세미나 플래그 (질환분류명 포함 및 미포함)', () => {
    const privateWithCategory: SeminarDisplayItem = {
      name: '비공개 내과 세미나',
      hiddenYn: 'Y',
      diseaseCategoryNm: '심혈관질환',
    };
    expect(formatSeminarDisplayName(privateWithCategory)).toBe('🔒<b>[비공개][심혈관질환]</b> 비공개 내과 세미나');

    const privateWithoutCategory: SeminarDisplayItem = {
      name: '비공개 일반 세미나',
      hiddenYn: 'Y',
    };
    expect(formatSeminarDisplayName(privateWithoutCategory)).toBe('🔒<b>[비공개]</b> 비공개 일반 세미나');

    const publicSeminar: SeminarDisplayItem = {
      name: '공개 세미나',
      hiddenYn: 'N',
      diseaseCategoryNm: '심혈관질환',
    };
    expect(formatSeminarDisplayName(publicSeminar)).toBe('공개 세미나');
  });

  it('6. 포인트 미지급 플래그 및 취소선 검증', () => {
    const pointExcluded: SeminarDisplayItem = {
      name: '포인트 미지급 세미나',
      isPointExcluded: true,
    };
    expect(formatSeminarDisplayName(pointExcluded)).toBe('🚫<b>[포인트미지급]</b> <s>포인트 미지급 세미나</s>');
  });

  it('7. 심화설문 플래그 검증', () => {
    const advancedSurvey: SeminarDisplayItem = {
      name: '심화설문 세미나',
      isAdvancedSurvey: true,
    };
    expect(formatSeminarDisplayName(advancedSurvey)).toBe('✨<b>[심화설문]</b> 심화설문 세미나');
  });

  it('8. 정원(현재/총원) 표시 검증', () => {
    const item: SeminarDisplayItem = {
      name: '정원 세미나',
      currentCount: '15',
      totalCount: '100',
    };

    // 기본적으로 includeCapacity=false
    expect(formatSeminarDisplayName(item)).toBe('정원 세미나');

    // includeCapacity=true
    expect(formatSeminarDisplayName(item, { includeCapacity: true })).toBe('정원 세미나 (15/100)');
  });

  it('9. 모든 플래그 및 일시, 정원이 결합된 종합 포맷팅 및 순서(플래그가 제목 앞) 검증', () => {
    const item: SeminarDisplayItem = {
      name: '개원의를 위한 고혈압 처방 팁: 인다파미드 기반 3제 복합제로 강압효과 극대화하기',
      date: '2026-09-08',
      time: '13:00~14:00',
      currentCount: '995',
      totalCount: '4000',
      hiddenYn: 'Y',
      diseaseCategoryNm: '심혈관질환',
      isPointExcluded: true,
      isAdvancedSurvey: true,
    };

    const formatted = formatSeminarDisplayName(item, {
      includeDate: true,
      includeTime: true,
      includeCapacity: true,
      maxLen: 20,
    });

    const expectedName = `${item.name.slice(0, 20)}...`;
    expect(formatted).toBe(
      `[2026-09-08 13:00~14:00] 🔒<b>[비공개][심혈관질환]</b> 🚫<b>[포인트미지급]</b> ✨<b>[심화설문]</b> <s>${expectedName}</s> (995/4000)`,
    );
  });

  it('10. HTML 특수문자 이스케이프 처리 검증', () => {
    const item: SeminarDisplayItem = {
      name: '<당뇨 & 고혈압> 완벽 가이드',
      hiddenYn: 'Y',
      diseaseCategoryNm: '내분비 & 대사',
    };
    const result = formatSeminarDisplayName(item);
    expect(result).toBe('🔒<b>[비공개][내분비 &amp; 대사]</b> &lt;당뇨 &amp; 고혈압&gt; 완벽 가이드');
  });
});
