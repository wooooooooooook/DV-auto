import assert from 'node:assert';
import {
  truncateHtml,
  truncateMarkdownV2,
  truncatePlainText,
  truncateTelegramMessage,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TELEGRAM_SAFE_MESSAGE_LENGTH,
  TELEGRAM_MAX_CAPTION_LENGTH,
  TELEGRAM_SAFE_CAPTION_LENGTH,
} from '../src/modules/telegram_truncator';
import { formatTodayLinksBroadcast, type TodayLinksFormatInput } from '../src/tasks/today_links';
import { describe, it } from 'vitest';

// 1. Plain text truncation 테스트
function testPlainTextTruncation() {
  console.log('1. Plain text truncation 테스트');
  const shortText = '안녕하세요. 짧은 메시지입니다.';
  assert.strictEqual(truncatePlainText(shortText, 100), shortText);

  const longText = 'A'.repeat(5000);
  const truncated = truncatePlainText(longText, 4000);
  assert.ok(truncated.length <= 4000, `Truncated text length ${truncated.length} must be <= 4000`);
  assert.ok(truncated.endsWith('... (길이 제한으로 생략됨)'), 'Suffix must be present');
  console.log('  ✓ Plain text truncation 성공');
}

// 2. MarkdownV2 truncation 테스트
function testMarkdownV2Truncation() {
  console.log('2. MarkdownV2 truncation 테스트');
  const shortText = '안녕하세요\\. *굵은글씨*';
  assert.strictEqual(truncateMarkdownV2(shortText, 100), shortText);

  // 이스케이프 문자(\)가 잘리는 경계에 있는 경우
  const textWithEscapes = 'Hello\\! World\\! '.repeat(300);
  const truncated = truncateMarkdownV2(textWithEscapes, 50);
  assert.ok(truncated.length <= 50, `Length ${truncated.length} must be <= 50`);
  assert.ok(!truncated.includes('\\...'), 'Escapes must not be broken before suffix');
  console.log('  ✓ MarkdownV2 truncation 성공');
}

// 3. HTML truncation 및 열린 태그 자동 닫기 테스트
function testHtmlTruncation() {
  console.log('3. HTML truncation 및 태그 안전 닫기 테스트');

  // 3-1. 짧은 HTML은 변형 없음
  const shortHtml = '<b>굵은 글씨</b> <i>기울임</i> <a href="https://example.com">링크</a>';
  assert.strictEqual(truncateHtml(shortHtml, 1000), shortHtml);

  // 3-2. 중첩된 태그 자동 닫기
  const nestedHtml =
    '<blockquote><b><i><s><code><a href="https://example.com">매우 긴 텍스트입니다. 계속 이어집니다. 1234567890</a></code></s></i></b></blockquote>';
  const truncated = truncateHtml(nestedHtml, 60, '\n... (생략)');
  assert.ok(truncated.length <= 60, `HTML truncated length ${truncated.length} must be <= 60`);
  assert.ok(truncated.includes('... (생략)'), 'Suffix must be included');

  // 열린 태그들이 올바른 역순으로 닫혔는지 검증
  const openCountB = (truncated.match(/<b>/g) || []).length;
  const closeCountB = (truncated.match(/<\/b>/g) || []).length;
  assert.strictEqual(openCountB, closeCountB, `<b> 태그 개수(${openCountB})와 </b> 태그 개수(${closeCountB}) 일치`);

  const openCountBlockquote = (truncated.match(/<blockquote>/g) || []).length;
  const closeCountBlockquote = (truncated.match(/<\/blockquote>/g) || []).length;
  assert.strictEqual(
    openCountBlockquote,
    closeCountBlockquote,
    `<blockquote> 태그 개수(${openCountBlockquote})와 </blockquote> 태그 개수(${closeCountBlockquote}) 일치`,
  );

  // 3-3. 텔레그램 상한(4096자)을 넘는 10,000자 초대형 HTML 메시지 truncation
  const hugeHtml =
    `<b>[초대형 세미나 목록]</b>\n` +
    Array.from(
      { length: 100 },
      (_, i) =>
        `${i + 1}. <b>세미나 ${i}</b>: <s>내용 ${i}</s> <a href="https://m.doctorville.co.kr/cme/seminar/${5000 + i}">링크</a>`,
    ).join('\n') +
    `\n<blockquote>하단 안내 문구입니다.</blockquote>`;

  const safeHugeTruncated = truncateTelegramMessage(hugeHtml, { parseMode: 'HTML', maxLength: 4000 });
  assert.ok(
    safeHugeTruncated.length <= TELEGRAM_SAFE_MESSAGE_LENGTH,
    `Truncated huge HTML length ${safeHugeTruncated.length} must be <= ${TELEGRAM_SAFE_MESSAGE_LENGTH}`,
  );
  assert.ok(
    safeHugeTruncated.length < TELEGRAM_MAX_MESSAGE_LENGTH,
    `Truncated huge HTML length ${safeHugeTruncated.length} must be < 4096`,
  );

  // HTML 태그 정합성 검증 (열린 태그 = 닫힌 태그)
  const tags = ['b', 's', 'i', 'code', 'blockquote', 'a'];
  for (const tag of tags) {
    const openRegex = new RegExp(`<${tag}(?:\\s+[^>]*?)?>`, 'g');
    const closeRegex = new RegExp(`</${tag}>`, 'g');
    const openCount = (safeHugeTruncated.match(openRegex) || []).length;
    const closeCount = (safeHugeTruncated.match(closeRegex) || []).length;
    assert.strictEqual(
      openCount,
      closeCount,
      `<${tag}> 태그(${openCount}개)와 </${tag}> 태그(${closeCount}개)의 쌍이 정확히 일치해야 함`,
    );
  }
  console.log('  ✓ HTML truncation 및 태그 안전 닫기 성공');
}

// 4. 대량 세미나로 인해 4096자를 초과하는 today_links 메시지의 전송 시 truncation 검증
function testTodayLinksTelegramTruncation() {
  console.log('4. 긴 today_links 메시지의 텔레그램 전송 시 truncation 검증');

  // 신규 세미나 50개 생성 (메시지 총 길이 약 7000자)
  const hugeNewSeminars = Array.from({ length: 50 }, (_, i) => ({
    date: '8/26',
    time: '13:00~14:00',
    name: `제${i + 1}회 닥터빌 최신 의학 심포지엄 및 신약 임상 세미나 상세 안내 (${i + 1}번째)`,
    seminarId: `${6000 + i}`,
    url: `https://m.doctorville.co.kr/cme/seminar/${6000 + i}`,
    isPointExcluded: i % 3 === 0,
    isAdvancedSurvey: i % 2 === 0,
  }));

  const input: TodayLinksFormatInput = {
    quizInfo: {
      productTitle: '테스트약품',
      answers: [1, 2, 3],
      link: 'https://www.doctorville.co.kr/product/productView?pId=123',
    },
    seminarMessage: {
      date: '2026-08-26',
      lunchSeminarIds: ['5501', '5502'],
      dinnerSeminarIds: ['5503'],
      message:
        '<b>오늘의 세미나 리스트:</b>\n🍴 <b>[점심 세미나]</b>\n- 13:00. 점심 세미나\n🍴 <b>[저녁 세미나]</b>\n- 18:00. 저녁 세미나',
    },
    storedNewSeminars: hugeNewSeminars,
    pointConversionInfo: {
      available: true,
    },
  };

  const { message, options } = formatTodayLinksBroadcast(input);

  // 원본 메시지는 전체 목록을 포함하여 4096자 초과
  assert.ok(message.length > 4096, `원본 메시지 길이는 4096자 초과여야 함: ${message.length}`);

  // 텔레그램 전송 시 truncateTelegramMessage 적용
  const sendableMessage = truncateTelegramMessage(message, {
    parseMode: options.parse_mode,
    maxLength: TELEGRAM_SAFE_MESSAGE_LENGTH,
  });

  // 검증:
  // 1. 전송 메시지 길이가 텔레그램 한도(4096자) 및 안전 기준(4000자) 이하인지 확인
  assert.ok(
    sendableMessage.length <= TELEGRAM_SAFE_MESSAGE_LENGTH,
    `전송 메시지 길이(${sendableMessage.length})가 ${TELEGRAM_SAFE_MESSAGE_LENGTH}자 이하여야 함`,
  );
  assert.ok(sendableMessage.length < TELEGRAM_MAX_MESSAGE_LENGTH, '텔레그램 4096자 제한 미만 확인');

  // 2. Truncation suffix 포함 확인
  assert.ok(sendableMessage.includes('... (길이 제한으로 생략됨)'), '생략 안내 문구 포함 확인');

  // 3. HTML 태그 닫힘 정합성 검증
  const tags = ['b', 's', 'i', 'code', 'blockquote', 'a'];
  for (const tag of tags) {
    const openRegex = new RegExp(`<${tag}(?:\\s+[^>]*?)?>`, 'g');
    const closeRegex = new RegExp(`</${tag}>`, 'g');
    const openCount = (sendableMessage.match(openRegex) || []).length;
    const closeCount = (sendableMessage.match(closeRegex) || []).length;
    assert.strictEqual(
      openCount,
      closeCount,
      `전송 메시지에서 <${tag}> 태그(${openCount}개)와 </${tag}> 태그(${closeCount}개) 쌍이 정확히 일치해야 함`,
    );
  }

  console.log('  ✓ 긴 today_links 메시지의 텔레그램 전송 truncation 성공');
}

describe('텔레그램 메시지 Truncation 및 길이 제한 방어 테스트', () => {
  it('Plain text truncation 테스트', () => {
    testPlainTextTruncation();
  });

  it('MarkdownV2 truncation 테스트', () => {
    testMarkdownV2Truncation();
  });

  it('Html truncation 테스트', () => {
    testHtmlTruncation();
  });

  it('긴 today_links 메시지의 텔레그램 전송 truncation 테스트', () => {
    testTodayLinksTelegramTruncation();
  });
});
