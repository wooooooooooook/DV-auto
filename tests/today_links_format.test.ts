import assert from 'node:assert';
import { formatTodayLinksBroadcast, type TodayLinksFormatInput } from '../src/tasks/today_links';

/**
 * 사용자가 제공한 예시 문구를 바탕으로 구성한 테스트 케이스
 */
function testTodayLinksFormatWithUserExample() {
  console.log('--- [Test] 오늘의 링크 포맷팅 및 인라인 버튼 테스트 시작 ---\n');

  const mockInput: TodayLinksFormatInput = {
    // 오늘의 퀴즈: 세벨머, 정답: 111
    quizInfo: {
      productTitle: '세벨머',
      answers: [1, 1, 1],
      link: 'https://www.doctorville.co.kr/product/productView?pId=161',
    },
    // 오늘의 세미나 리스트
    seminarMessage: {
      date: '2026-08-16',
      lunchSeminarIds: ['5538', '5565', '5531'],
      dinnerSeminarIds: ['5543', '5542', '5544'],
      message: `<b>오늘의 세미나 리스트:</b>
🍴 <b>[점심 세미나]</b>
- 13:00~14:00. <s>입시를 몰라도 자녀와 대화가 통하게 되는 50분</s> 🚫[포인트미지급] https://m.doctorville.co.kr/cme/seminar/5538
- 13:00~14:00. 눈에서 시작하는 심혈관 위험 평가와 AI의 미래 ✨<b>[심화설문]</b> https://m.doctorville.co.kr/cme/seminar/5565
- 13:00~14:00. Hypertension and Cardiovascular Protection From Guidelines to Clinical Practice https://m.doctorville.co.kr/cme/seminar/5531

🍴 <b>[저녁 세미나]</b>
- 17:00~18:30. 엔블로 Web Symposium ✨<b>[심화설문]</b> https://m.doctorville.co.kr/cme/seminar/5543
- 17:00~18:30. 진심(心), Symposium ✨<b>[심화설문]</b> https://m.doctorville.co.kr/cme/seminar/5542
- 18:30~19:30. AI와 함께하는 차세대 내시경 WAYMED ENDO로 완성하는 명의의 진단 노하우 ✨<b>[심화설문]</b> https://m.doctorville.co.kr/cme/seminar/5544`,
    },
    // 어제 추가된 신규 세미나
    storedNewSeminars: [
      {
        date: '9/1',
        time: '13:00~13:40',
        name: '척수성 근위축증(SMA) 조기 진단과 전원',
        seminarId: '5572',
        url: 'https://m.doctorville.co.kr/cme/seminar/5572',
        isPointExcluded: false,
        isAdvancedSurvey: false,
      },
      {
        date: '8/20',
        time: '13:00~14:00',
        name: 'ChatGPT 실용 입문 — AI로 알아보고, 읽고, 만들고, 검증하기',
        seminarId: '5573',
        url: 'https://m.doctorville.co.kr/cme/seminar/5573',
        isPointExcluded: true,
        isAdvancedSurvey: false,
      },
    ],
    // 포인트 전환 정보
    pointConversionInfo: {
      available: true,
    },
  };

  const { message, options } = formatTodayLinksBroadcast(mockInput);

  console.log('================ [생성된 텔레그램 메시지 본문] ================\n');
  console.log(message);
  console.log('\n================ [생성된 인라인 키보드 옵션] ================\n');
  console.log(JSON.stringify(options, null, 2));

  // 검증 단언 (Assertions)
  // 1. 출석체크
  assert(message.includes('✨ <b>출석체크:</b> https://m.doctorville.co.kr/mypage/attendance'));

  // 2. 오늘의 퀴즈 및 정답 (클릭 시 복사 가능한 <code> 태그 적용 확인)
  assert(message.includes('✏️ <b>오늘의 퀴즈:</b> <b>세벨머</b>, 정답: <code>111</code>'));
  assert(message.includes('https://www.doctorville.co.kr/product/productView?pId=161'));

  // 3. 오늘의 세미나 목록 및 강조된 플래그
  assert(message.includes('<s>입시를 몰라도 자녀와 대화가 통하게 되는 50분</s> 🚫[포인트미지급]'));
  assert(message.includes('https://m.doctorville.co.kr/cme/seminar/5538'));
  assert(message.includes('엔블로 Web Symposium ✨<b>[심화설문]</b>'));

  // 4. 신규 세미나 및 강조된 플래그
  assert(message.includes('🆕 <b>어제 추가된 신규 세미나</b>'));
  assert(message.includes('1. [9/1 13:00~13:40] 척수성 근위축증(SMA) 조기 진단과 전원'));
  assert(
    message.includes(
      '2. [8/20 13:00~14:00] <s>ChatGPT 실용 입문 — AI로 알아보고, 읽고, 만들고, 검증하기</s> 🚫[포인트미지급]',
    ),
  );

  // 5. 포인트 전환 안내
  assert(message.includes('💳 <b>오늘 네이버페이포인트 전환 가능 예정입니다. 전환 가능 알림을 기다려주세요!</b>'));

  // 6. 하단 봇 안내 인용구
  assert(
    message.includes(
      '<blockquote>🤖 <b>닥터빌 텔레그램방에 전송된 메시지입니다.</b>\n매일 오전 9시 링크모음 발송, 세미나 시작/종료, 퀴즈 정답 알림, 지금 가입하세요!\nhttps://t.me/+J1UGmvLA9jU4NjQ1</blockquote>',
    ),
  );

  // 7. 인라인 키보드 버튼 및 링크 미리보기 비활성화 검증
  assert.strictEqual(options.parse_mode, 'HTML');
  assert.strictEqual(options.link_preview_options?.is_disabled, true);
  assert.strictEqual(options.reply_markup.inline_keyboard.length, 2);
  assert.strictEqual(options.reply_markup.inline_keyboard[0][0].text, '✨ 출석체크 바로가기');
  assert.strictEqual(options.reply_markup.inline_keyboard[0][0].url, 'https://m.doctorville.co.kr/mypage/attendance');
  assert.strictEqual(options.reply_markup.inline_keyboard[0][1].text, '✏️ 오늘의 퀴즈 풀기');
  assert.strictEqual(
    options.reply_markup.inline_keyboard[0][1].url,
    'https://www.doctorville.co.kr/product/productView?pId=161',
  );
  assert.strictEqual(options.reply_markup.inline_keyboard[1][0].text, '💳 포인트 전환하러 가기');
  assert.strictEqual(
    options.reply_markup.inline_keyboard[1][0].url,
    'https://www.doctorville.co.kr/my/point/pointUseHistoryList',
  );

  console.log('\n✅ [Pass] 예시 문구 포맷팅 검증을 성공적으로 통과했습니다!\n');
}

function testDateParsingAndCustomDateFormat() {
  console.log('--- [Test] 날짜 파싱 및 지정 날짜 포맷팅 테스트 시작 ---\n');

  const { getTodayDateStrings } = require('../src/tasks/today_links');

  // 1. 기본 오늘
  const todayResult = getTodayDateStrings();
  assert.strictEqual(todayResult.isCustomDate, false);

  // 2. M/D 형식
  const mdResult = getTodayDateStrings('8/20');
  assert.strictEqual(mdResult.todayString, '8/20');
  assert.strictEqual(mdResult.isCustomDate, true);

  // 3. YYYY-MM-DD 형식
  const ymdResult = getTodayDateStrings('2026-09-01');
  assert.strictEqual(ymdResult.todayString, '9/1');
  assert.strictEqual(ymdResult.isoDate, '2026-09-01');
  assert.strictEqual(ymdResult.isCustomDate, true);

  // 4. 내일 / tomorrow
  const tomorrowResult = getTodayDateStrings('내일');
  assert.strictEqual(tomorrowResult.isCustomDate, true);

  // 5. 커스텀 날짜 포맷팅 검증 (퀴즈 없음 메시지 포함)
  const customInput: TodayLinksFormatInput = {
    quizInfo: null,
    seminarMessage: {
      date: '2026-08-20',
      lunchSeminarIds: ['5573'],
      dinnerSeminarIds: [],
      message:
        '<b>[8/20] 세미나 리스트:</b>\n🍴 <b>[점심 세미나]</b>\n- 13:00~14:00. AI 실용 입문 https://m.doctorville.co.kr/cme/seminar/5573',
    },
    storedNewSeminars: [],
    pointConversionInfo: null,
    targetDate: '2026-08-20 (8/20)',
    isCustomDate: true,
  };

  const { message } = formatTodayLinksBroadcast(customInput);
  assert(message.includes('📅 <b>[2026-08-20 (8/20) 링크 및 세미나]</b>'));
  assert(message.includes('✏️ <b>오늘의 퀴즈:</b> 오늘은 퀴즈가 없습니다. ☕'));
  assert(message.includes('<b>[8/20] 세미나 리스트:</b>'));

  // 6. 2026-08-18 형식 검증
  const aug18Result = getTodayDateStrings('2026-08-18');
  assert.strictEqual(aug18Result.todayString, '8/18');
  assert.strictEqual(aug18Result.isoDate, '2026-08-18');
  assert.strictEqual(aug18Result.targetMonth, 8);
  assert.strictEqual(aug18Result.targetDay, 18);
  assert.strictEqual(aug18Result.isCustomDate, true);

  console.log('✅ [Pass] 날짜 파싱 및 지정 날짜 포맷팅 검증을 성공적으로 통과했습니다!');
}

testTodayLinksFormatWithUserExample();
testDateParsingAndCustomDateFormat();

/**
 * 신규 세미나 필터링 로직 테스트 (seminar_list의 detectedDate 기준)
 * - 전날 detectedDate만 포함
 * - 오늘 detectedDate 제외
 * - 이틀 전 detectedDate 제외
 * - legacy new_seminars 키 없이도 정상 동작
 */
function testYesterdayAddedSeminarsFilter() {
  console.log('--- [Test] 신규 세미나 필터링: detectedDate 기준 전날만 포함 ---\\n');

  const { getYesterdayAddedSeminars } = require('../src/tasks/today_links');
  const storage = require('../src/services/storage');

  // 테스트용 목 데이터 저장
  const todayIso = '2026-08-18';
  const yesterdayIso = '2026-08-17';
  const twoDaysAgoIso = '2026-08-16';

  // storage를 깨끗이 비우고 테스트 데이터 주입
  const SEMINAR_LIST_KEY = 'apply_seminar:seminar_list';
  const testSeminars = [
    {
      name: '전날 세미나 큰 ID',
      url: 'https://m.doctorville.co.kr/cme/seminar/5580',
      seminarId: '5580',
      isPointExcluded: false,
      isAdvancedSurvey: false,
      date: '2026-08-18',
      time: '13:00~14:00',
      detectedDate: yesterdayIso,
      detectedAt: '2026-08-17T10:00:00.000Z',
    },
    {
      name: '전날 세미나 작은 ID',
      url: 'https://m.doctorville.co.kr/cme/seminar/5570',
      seminarId: '5570',
      isPointExcluded: false,
      isAdvancedSurvey: false,
      date: '2026-08-18',
      time: '13:00~14:00',
      detectedDate: yesterdayIso,
      detectedAt: '2026-08-17T10:00:00.000Z',
    },
    {
      name: '오늘 세미나 (제외됨)',
      url: 'https://m.doctorville.co.kr/cme/seminar/222',
      seminarId: '222',
      isPointExcluded: false,
      isAdvancedSurvey: false,
      date: '2026-08-18',
      time: '13:00~14:00',
      detectedDate: todayIso,
      detectedAt: '2026-08-18T10:00:00.000Z',
    },
    {
      name: '이틀 전 세미나 (제외됨)',
      url: 'https://m.doctorville.co.kr/cme/seminar/333',
      seminarId: '333',
      isPointExcluded: false,
      isAdvancedSurvey: false,
      date: '2026-08-16',
      time: '13:00~14:00',
      detectedDate: twoDaysAgoIso,
      detectedAt: '2026-08-16T10:00:00.000Z',
    },
    {
      name: 'detectedDate 없는 세미나 (제외됨)',
      url: 'https://m.doctorville.co.kr/cme/seminar/444',
      seminarId: '444',
      isPointExcluded: false,
      isAdvancedSurvey: false,
      date: '2026-08-18',
      time: '13:00~14:00',
    },
  ];

  storage.set(SEMINAR_LIST_KEY, testSeminars);

  // 실행
  const result = getYesterdayAddedSeminars(yesterdayIso);

  // 검증: 전날(detectedDate === yesterdayIso)인 것만 1건 포함
  assert.strictEqual(result.length, 2, '전날 detectedDate 세미나 2개 포함되어야 함');
  assert.strictEqual(result[0].seminarId, '5570', 'seminarId 순으로 오름차순 정렬되어야 함');
  assert.strictEqual(result[1].seminarId, '5580', 'seminarId 순으로 오름차순 정렬되어야 함');

  // legacy key가 없어도 에러 없이 동작하는지 확인 (new_seminars 키 사용 안 함)
  const NEW_SEMINAR_KEY = 'apply_seminar:new_seminars';
  const legacy = storage.get(NEW_SEMINAR_KEY);
  assert(legacy === undefined || legacy === null, '레거시 new_seminars 키는 존재하지 않아야 함 (또는 null)');

  console.log('  ✓ 전날 detectedDate 세미나 포함');
  console.log('  ✓ 오늘 detectedDate 세미나 제외');
  console.log('  ✓ 이틀 전 detectedDate 세미나 제외');
  console.log('  ✓ detectedDate 없는 세미나 제외');
  console.log('  ✓ 레거시 new_seminars 키 없이 정상 동작');
  console.log('\\n✅ [Pass] 신규 세미나 필터링 로직 검증 통과!\\n');

  // 정리
  storage.deleteKey(SEMINAR_LIST_KEY);
}

testYesterdayAddedSeminarsFilter();
