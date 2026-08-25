import assert from 'node:assert';
import {
  splitHtml,
  splitMarkdownV2,
  splitPlainText,
  splitTelegramMessage,
  TELEGRAM_MAX_MESSAGE_LENGTH,
  TELEGRAM_SAFE_MESSAGE_LENGTH,
} from '../src/modules/telegram_splitter';
import { replyWithSplit } from '../src/modules/utils';
import { formatTodayLinksBroadcast, type TodayLinksFormatInput } from '../src/tasks/today_links';

console.log('=== [Test] 텔레그램 메시지 분할 전송(Message Splitting) 테스트 시작 ===\n');

// 1. Plain text 분할 테스트
function testPlainTextSplitting() {
  console.log('1. Plain text 분할 테스트');
  const shortText = '안녕하세요. 짧은 메시지입니다.';
  assert.deepStrictEqual(splitPlainText(shortText, 100), [shortText]);

  // 100줄, 총 5000자 텍스트
  const lines = Array.from({ length: 100 }, (_, i) => `${i + 1}. 이것은 테스트 라인입니다. (${i})`);
  const fullText = lines.join('\n');
  const chunks = splitPlainText(fullText, 1000);

  assert.ok(chunks.length > 1, `청크 개수(${chunks.length})는 1보다 커야 함`);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1000, `각 청크 길이(${chunk.length})는 1000자 이하여야 함`);
  }
  // 다시 합쳤을 때 원본과 동일
  assert.strictEqual(chunks.join('\n'), fullText, '분할된 청크를 합쳤을 때 원본과 동일해야 함');
  console.log('  ✓ Plain text 분할 성공');
}

// 2. MarkdownV2 분할 테스트
function testMarkdownV2Splitting() {
  console.log('2. MarkdownV2 분할 테스트');
  const shortText = '안녕하세요\\. *굵은글씨*';
  assert.deepStrictEqual(splitMarkdownV2(shortText, 100), [shortText]);

  const lines = Array.from({ length: 50 }, (_, i) => `${i + 1}\\. 테스트 항목 \\#${i}`);
  const fullText = lines.join('\n');
  const chunks = splitMarkdownV2(fullText, 500);

  assert.ok(chunks.length > 1, '청크 개수가 1보다 커야 함');
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 500, `각 청크 길이(${chunk.length}) <= 500`);
    assert.ok(!chunk.endsWith('\\'), '청크 끝이 이스케이프 문자 단독으로 끝나면 안 됨');
  }
  console.log('  ✓ MarkdownV2 분할 성공');
}

// 3. HTML 메시지 안전 분할 및 태그 보존 테스트
function testHtmlSplitting() {
  console.log('3. HTML 메시지 안전 분할 및 태그 닫기/다시 열기 테스트');

  // 3-1. 짧은 HTML은 분할 없이 원본 1개 반환
  const shortHtml = '<b>굵은 글씨</b> <i>기울임</i> <a href="https://example.com">링크</a>';
  assert.deepStrictEqual(splitHtml(shortHtml, 1000), [shortHtml]);

  // 3-2. blockquote 내부의 긴 목록 분할 테스트
  const lines = Array.from(
    { length: 50 },
    (_, i) => `- ${i + 1}번 <b>세미나 ${i}</b>: <s>내용</s> <a href="https://example.com/${i}">링크</a>`,
  );
  const blockquoteHtml = `<blockquote><b>[전체 세미나 목록]</b>\n${lines.join('\n')}</blockquote>`;

  const chunks = splitHtml(blockquoteHtml, 1200);
  assert.ok(chunks.length > 1, `분할된 청크 수(${chunks.length}) > 1`);

  const tagsToCheck = ['blockquote', 'b', 's', 'a'];

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    assert.ok(chunk.length <= 1200, `청크 #${i + 1} 길이(${chunk.length})가 제한(1200자) 이하여야 함`);

    // 각 청크의 모든 HTML 태그가 닫혀 있는지 검증 (open count === close count)
    for (const tag of tagsToCheck) {
      const openRegex = new RegExp(`<${tag}(?:\\s+[^>]*?)?>`, 'g');
      const closeRegex = new RegExp(`</${tag}>`, 'g');
      const openCount = (chunk.match(openRegex) || []).length;
      const closeCount = (chunk.match(closeRegex) || []).length;
      assert.strictEqual(
        openCount,
        closeCount,
        `청크 #${i + 1}에서 <${tag}> 열림(${openCount})과 </${tag}> 닫힘(${closeCount})이 일치해야 함: \n${chunk}`,
      );
    }
  }

  console.log('  ✓ HTML 메시지 안전 분할 및 태그 정합성 검증 성공');
}

// 4. 대량 세미나로 4096자를 초과하는 today_links 메시지의 전체 분할 전송 검증
function testTodayLinksFullMessageSplitting() {
  console.log('4. 대량 세미나 today_links 메시지 분할 전송 검증');

  // 신규 세미나 60개 생성 (메시지 총 길이 약 8000자 이상)
  const hugeNewSeminars = Array.from({ length: 60 }, (_, i) => ({
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

  // 원본 메시지는 전체 세미나를 모두 포함하여 4096자 초과
  assert.ok(message.length > 5000, `원본 메시지 길이는 5000자 이상이어야 함: ${message.length}`);

  // splitTelegramMessage로 분할
  const chunks = splitTelegramMessage(message, {
    parseMode: options.parse_mode,
    maxLength: TELEGRAM_SAFE_MESSAGE_LENGTH,
  });

  assert.ok(chunks.length >= 2, `총 ${chunks.length}개의 청크로 분할되어야 함`);

  // 모든 청크 검증
  const tags = ['b', 's', 'i', 'code', 'blockquote', 'a'];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    assert.ok(
      chunk.length <= TELEGRAM_SAFE_MESSAGE_LENGTH,
      `청크 #${i + 1} 길이(${chunk.length}) <= ${TELEGRAM_SAFE_MESSAGE_LENGTH}`,
    );
    assert.ok(chunk.length < TELEGRAM_MAX_MESSAGE_LENGTH, `청크 #${i + 1} 길이 < 4096`);

    for (const tag of tags) {
      const openRegex = new RegExp(`<${tag}(?:\\s+[^>]*?)?>`, 'g');
      const closeRegex = new RegExp(`</${tag}>`, 'g');
      const openCount = (chunk.match(openRegex) || []).length;
      const closeCount = (chunk.match(closeRegex) || []).length;
      assert.strictEqual(
        openCount,
        closeCount,
        `청크 #${i + 1}에서 <${tag}> 태그(${openCount}개)와 </${tag}> 태그(${closeCount}개) 쌍 일치`,
      );
    }
  }

  // 첫 번째 청크에는 출석체크와 퀴즈 포함
  assert.ok(chunks[0].includes('출석체크'), '첫 번째 청크에 출석체크 포함');
  assert.ok(chunks[0].includes('오늘의 퀴즈'), '첫 번째 청크에 오늘의 퀴즈 포함');

  // 마지막 청크에는 닥터빌 안내 blockquote 포함
  assert.ok(
    chunks[chunks.length - 1].includes('닥터빌 텔레그램방에 전송된 메시지입니다.'),
    '마지막 청크에 닥터빌 채널 안내 포함',
  );

  // 모든 세미나 번호(1번부터 60번까지)가 분할된 청크들 안에 누락 없이 포함되어 있는지 검증
  for (let i = 1; i <= 60; i++) {
    const targetTitle = `${i}. [8/26 13:00~14:00]`;
    const found = chunks.some((c) => c.includes(targetTitle));
    assert.ok(found, `세미나 #${i} (${targetTitle})가 분할된 청크 중 하나에 반드시 존재해야 함`);
  }

  console.log(
    `  ✓ 60개 신규 세미나 전체(${message.length}자)가 누락 없이 ${chunks.length}개 청크로 분할 전송 가능함을 확인`,
  );
}

// 5. replyWithSplit Mock 동작 테스트
async function testReplyWithSplitMock() {
  console.log('5. replyWithSplit Mock 전송 테스트');
  const replies: Array<{ text: string; options?: unknown }> = [];
  const mockCtx = {
    reply: async (text: string, options?: unknown) => {
      replies.push({ text, options });
    },
  };

  const longText = Array.from({ length: 80 }, (_, i) => `라인 ${i + 1}: 내용...`).join('\n');
  const mockOptions = {
    parse_mode: 'HTML' as const,
    reply_markup: {
      inline_keyboard: [[{ text: '버튼1', url: 'https://example.com' }]],
    },
  };

  await replyWithSplit(mockCtx, longText, mockOptions);

  assert.ok(replies.length >= 1, '최소 1회 이상 reply 호출');
  // 인라인 키보드는 마지막 reply에만 붙어야 함
  const lastReply = replies[replies.length - 1];
  assert.ok(
    (lastReply.options as { reply_markup?: unknown })?.reply_markup,
    '마지막 응답에 인라인 키보드가 첨부되어야 함',
  );

  if (replies.length > 1) {
    const firstReply = replies[0];
    assert.strictEqual(
      (firstReply.options as { reply_markup?: unknown })?.reply_markup,
      undefined,
      '첫 번째(중간) 응답에는 reply_markup이 제거되어야 함',
    );
  }

  console.log('  ✓ replyWithSplit Mock 전송 검증 성공');
}

async function runAllTests() {
  testPlainTextSplitting();
  testMarkdownV2Splitting();
  testHtmlSplitting();
  testTodayLinksFullMessageSplitting();
  await testReplyWithSplitMock();

  console.log('\n🎉 모든 텔레그램 메시지 분할 전송 테스트 통과!');
}

runAllTests().catch((e) => {
  console.error('테스트 실패:', e);
  process.exit(1);
});
