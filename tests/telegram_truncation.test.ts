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

console.log('=== [Test] 텔레그램 메시지 Truncation 및 길이 제한 방어 테스트 시작 ===\n');

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
  // 끝부분이 '\\... \\(길이 제한으로 생략됨\\)' 처럼 이스케이프가 깨지지 않아야 함
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
  const nestedHtml = '<blockquote><b><i><s><code><a href="https://example.com">매우 긴 텍스트입니다. 계속 이어집니다. 1234567890</a></code></s></i></b></blockquote>';
  const truncated = truncateHtml(nestedHtml, 60, '\n... (생략)');
  assert.ok(truncated.length <= 60, `HTML truncated length ${truncated.length} must be <= 60`);
  assert.ok(truncated.includes('... (생략)'), 'Suffix must be included');

  // 열린 태그들이 올바른 역순으로 닫혔는지 검증
  // 열린 순서: blockquote -> b -> i -> s -> code -> a
  // 닫힌 순서: </a></code></s></i></b></blockquote> (도중에 잘렸을 경우 그 시점에 열려있던 태그들이 닫혀야 함)
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
  const hugeHtml = `<b>[초대형 세미나 목록]</b>\n` +
    Array.from({ length: 100 }, (_, i) => `${i + 1}. <b>세미나 ${i}</b>: <s>내용 ${i}</s> <a href="https://m.doctorville.co.kr/cme/seminar/${5000 + i}">링크</a>`).join('\n') +
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

// 4. 대량 신규 세미나 (50개) 발생 시 today_links 포맷팅 스마트 truncation 테스트
function testTodayLinksHugeNewSeminars() {
  console.log('4. today_links 대량 신규 세미나(50개) 스마트 truncation 테스트');

  // 신규 세미나 50개 생성 (각 항목 약 120자 -> 총 6000자 이상)
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
      message: '<b>오늘의 세미나 리스트:</b>\n🍴 <b>[점심 세미나]</b>\n- 13:00. 점심 세미나\n🍴 <b>[저녁 세미나]</b>\n- 18:00. 저녁 세미나',
    },
    storedNewSeminars: hugeNewSeminars,
    pointConversionInfo: {
      available: true,
    },
  };

  const { message, options } = formatTodayLinksBroadcast(input);

  // 검증:
  // 1. 전체 메시지 길이가 텔레그램 상한(4096자) 및 안전 길이(4000자) 이하인지 확인
  assert.ok(
    message.length <= 4000,
    `Today links message length (${message.length}) must be <= 4000 to prevent Telegram 400 Bad Request error`,
  );

  // 2. 핵심 정보(출석체크, 오늘의 퀴즈, 오늘 세미나)가 온전히 유지되었는지 확인
  assert.ok(message.includes('✨ <b>출석체크:</b>'), '출석체크 정보 포함 확인');
  assert.ok(message.includes('✏️ <b>오늘의 퀴즈:</b> <b>테스트약품</b>, 정답: <code>123</code>'), '퀴즈 정보 포함 확인');
  assert.ok(message.includes('오늘의 세미나 리스트:'), '오늘의 세미나 리스트 포함 확인');

  // 3. 신규 세미나 스마트 생략 문구가 포함되어 있는지 확인
  assert.ok(
    message.includes('신규 세미나 생략') || message.includes('길이 제한으로 생략됨'),
    '신규 세미나 요약/생략 문구가 포함되어야 함',
  );

  // 4. 포인트 전환 정보 및 인라인 버튼이 온전한지 확인
  assert.ok(message.includes('현재 네이버페이 포인트 전환 가능합니다.'), '포인트 전환 문구 포함 확인');
  assert.strictEqual(options.reply_markup.inline_keyboard.length, 3, '인라인 키보드 3줄 정상 생성');

  // 5. HTML 태그 밸런스 확인
  const openB = (message.match(/<b>/g) || []).length;
  const closeB = (message.match(/<\/b>/g) || []).length;
  assert.strictEqual(openB, closeB, `<b> 태그 수(${openB})와 </b> 태그 수(${closeB}) 일치`);

  const openBlockquote = (message.match(/<blockquote>/g) || []).length;
  const closeBlockquote = (message.match(/<\/blockquote>/g) || []).length;
  assert.strictEqual(
    openBlockquote,
    closeBlockquote,
    `<blockquote> 태그 수(${openBlockquote})와 </blockquote> 태그 수(${closeBlockquote}) 일치`,
  );

  console.log('  ✓ 대량 신규 세미나 today_links 포맷팅 스마트 truncation 성공');
}

testPlainTextTruncation();
testMarkdownV2Truncation();
testHtmlTruncation();
testTodayLinksHugeNewSeminars();

console.log('\n🎉 모든 텔레그램 메시지 Truncation 테스트 통과!');
