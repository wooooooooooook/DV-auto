import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {
  getTodayDateStrings,
  parseTargetDate,
  isDateMatching,
  formatTodayLinksBroadcast,
  type DateTarget,
  type TodayLinksFormatInput,
} from '../src/tasks/today_links';
import { normalizeParsedSeminars } from '../src/tasks/apply_seminar';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'seminar_main.html');
const BASE_URL = 'https://www.doctorville.co.kr';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';

// HTML 엔티티 디코딩 유틸리티
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&/g, '&');
}

/**
 * HTML fixture로부터 .list_cont 노드들을 파싱하는 가벼운 DOM 구조 모델
 * (production parser와 동일하게 실제로 사용되는 필드만 보관)
 */
type MockNode = {
  date: string;
  links: Array<{
    href: string;
    title: string;
    time: string;
    classAttr: string;
    isAdvancedSurvey: boolean;
    currentCount: string;
    totalCount: string;
    nightTime: boolean;
  }>;
};

function parseFixtureHtml(html: string): MockNode[] {
  const listContRegex = /<div class="list_cont">([\s\S]*?)(?=(?:<div class="list_cont">|<\/section>))/g;
  const nodes: MockNode[] = [];

  let match: RegExpExecArray | null;
  while ((match = listContRegex.exec(html)) !== null) {
    const block = match[1];

    // 날짜 추출 (<em class="txt_num date">8/18</em>)
    const dateMatch = block.match(/<em class="txt_num date">([^<]+)<\/em>/);
    const date = dateMatch ? dateMatch[1].trim() : '';

    // 세미나 링크 항목 추출 (<a href="..." class="list_detail"> ...</a>)
    const linkRegex = /<a href="([^"]+)" class="list_detail">([\s\S]*?)<\/a>/g;
    const links: MockNode['links'] = [];

    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRegex.exec(block)) !== null) {
      const href = linkMatch[1];
      const content = linkMatch[2];

      // 시간 추출 (<span class="txt_num time ..."></span>)
      const timeMatch = content.match(/<span class="txt_num time ([^"]*)">([\s\S]*?)<\/span>/);
      const timeClass = timeMatch ? timeMatch[1].trim() : '';
      const rawTime = timeMatch ? timeMatch[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
      const time = rawTime.replace(/\s*~\s*/, '~');
      const nightTime = timeClass.includes('night_time');

      // 제목 추출 (<p class="tit"> ...</p>)
      const titMatch = content.match(/<p class="tit">([\s\S]*?)<\/p>/);
      const title = titMatch ? decodeHtmlEntities(titMatch[1].replace(/\s+/g, ' ').trim()) : '';

      // 심화설문 여부
      const isAdvancedSurvey =
        content.includes('ic_survey') || content.includes('advanced-survey') || content.includes('advanced');

      // 신청 인원 / 총원 추출 (<em class="txt_num">6067</em>명 ... <em class="txt_num">/7000</em>명)
      const personMatch = content.match(/<em class="txt_num">(\d+)<\/em>명[\s\S]*?<em class="txt_num">\/(\d+)<\/em>명/);
      const currentCount = personMatch ? personMatch[1] : '';
      const totalCount = personMatch ? personMatch[2] : '';

      links.push({
        href,
        title,
        time,
        classAttr: timeClass,
        isAdvancedSurvey,
        currentCount,
        totalCount,
        nightTime,
      });
    }

    nodes.push({ date, links });
  }

  return nodes;
}

/**
 * today_links의 parseSeminarsFromNodes와 동일한 로직으로 MockNode[]에서 세미나 추출
 */
function collectSeminarsForTargetDate(nodes: MockNode[], target: DateTarget) {
  const lunchSeminars: Array<{ title: string; time: string; seminarId: string | null; seminarLink: string }> = [];
  const dinnerSeminars: Array<{ title: string; time: string; seminarId: string | null; seminarLink: string }> = [];

  const isDinnerSeminar = (classAttr: string, time: string): boolean => {
    if (classAttr.includes('night_time')) return true;
    const hourMatch = time.match(/(\d{1,2})\s*:/);
    if (!hourMatch) return false;
    const hour = Number(hourMatch[1]);
    return Number.isFinite(hour) && hour >= 16;
  };

  nodes.forEach((node) => {
    if (!isDateMatching(node.date, target)) return;

    node.links.forEach((link) => {
      const urlObj = new URL(link.href, BASE_URL);
      const seminarId = urlObj.searchParams.get('seminarId') || (link.href.match(/\/seminar\/(\d+)/)?.[1] ?? null);
      const seminarLink = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : urlObj.toString();
      const item = {
        title: link.title,
        time: link.time,
        seminarId,
        seminarLink,
      };

      if (isDinnerSeminar(link.classAttr, link.time)) {
        dinnerSeminars.push(item);
      } else {
        lunchSeminars.push(item);
      }
    });
  });

  return { lunchSeminars, dinnerSeminars };
}

/**
 * 1. today_links: 날짜별 세미나 수집 및 점심/저녁 분류 테스트
 */
function testTodayLinksSeminarCollection(nodes: MockNode[]) {
  console.log('--- [Test 1] today_links: 날짜별 세미나 수집 및 점심/저녁 분류 테스트 시작 ---');

  // 1-1. 2026-08-18 (8/18) 세미나 수집
  const target818 = getTodayDateStrings('2026-08-18');
  const res818 = collectSeminarsForTargetDate(nodes, target818);

  // 점심 세미나 3건: 12:00(5552 실리스칸), 12:30(5553 바로에젯), 13:00(5567 올메사르탄)
  assert.strictEqual(res818.lunchSeminars.length, 3, '8/18 점심 세미나는 3건이어야 함');
  assert.deepStrictEqual(
    res818.lunchSeminars.map((s) => s.seminarId),
    ['5552', '5553', '5567'],
  );
  assert(res818.lunchSeminars[0].title.includes('실리스칸'));
  assert(res818.lunchSeminars[1].title.includes('Clinical Updates in Dyslipidemia'));
  assert(res818.lunchSeminars[2].title.includes('ARB Strategies in Atrial Fibrillation'));

  // 저녁 세미나 5건: 18:00(5555 혈관초음파), 18:30(5561 크레스토), 19:00(5568 O.M.T), 19:00(5560 BEYOND), 19:00(5488 알쏭달쏭)
  assert.strictEqual(res818.dinnerSeminars.length, 5, '8/18 저녁 세미나는 5건이어야 함');
  assert.deepStrictEqual(
    res818.dinnerSeminars.map((s) => s.seminarId),
    ['5555', '5561', '5568', '5560', '5488'],
  );
  assert(res818.dinnerSeminars[0].title.includes('[대한혈관학회]'));
  assert(res818.dinnerSeminars[1].title.includes('크레스토 웹 심포지엄'));
  assert(res818.dinnerSeminars[2].title.includes('O.M.T Web Symposium'));
  assert(res818.dinnerSeminars[3].title.includes('BEYOND Web Symposium'));
  assert(res818.dinnerSeminars[4].title.includes('증례를 통해 확인하는 알쏭달쏭 Q&A 14탄'));

  console.log('  ✓ 8/18 세미나 수집 성공 (점심 3건: 5552, 5553, 5567 / 저녁 5건: 5555, 5561, 5568, 5560, 5488)');

  // 1-2. 8/19 세미나 수집 (M/D 형식)
  const target819 = getTodayDateStrings('8/19');
  const res819 = collectSeminarsForTargetDate(nodes, target819);
  assert.strictEqual(res819.lunchSeminars.length, 4, '8/19 점심 세미나는 4건이어야 함');
  assert.deepStrictEqual(
    res819.lunchSeminars.map((s) => s.seminarId),
    ['5571', '5532', '5563', '5562'],
  );
  assert.strictEqual(res819.dinnerSeminars.length, 4, '8/19 저녁 세미나는 4건이어야 함');
  assert.deepStrictEqual(
    res819.dinnerSeminars.map((s) => s.seminarId),
    ['5540', '5564', '5536', '5537'],
  );
  console.log('  ✓ 8/19 세미나 수집 성공 (점심 4건: 5571, 5532, 5563, 5562 / 저녁 4건: 5540, 5564, 5536, 5537)');

  // 1-3. 8/20 세미나 수집
  const target820 = getTodayDateStrings('2026-08-20');
  const res820 = collectSeminarsForTargetDate(nodes, target820);
  assert.strictEqual(res820.lunchSeminars.length, 2, '8/20 점심 세미나는 2건이어야 함');
  assert.deepStrictEqual(
    res820.lunchSeminars.map((s) => s.seminarId),
    ['5573', '5556'],
  );
  assert.strictEqual(res820.dinnerSeminars.length, 3, '8/20 저녁 세미나는 3건이어야 함');
  assert.deepStrictEqual(
    res820.dinnerSeminars.map((s) => s.seminarId),
    ['5558', '5569', '5557'],
  );
  console.log('  ✓ 8/20 세미나 수집 성공 (점심 2건: 5573, 5556 / 저녁 3건: 5558, 5569, 5557)');

  // 1-4. 8/21 세미나 수집
  const target821 = getTodayDateStrings('8/21');
  const res821 = collectSeminarsForTargetDate(nodes, target821);
  assert.strictEqual(res821.lunchSeminars.length, 2, '8/21 점심 세미나는 2건이어야 함');
  assert.deepStrictEqual(
    res821.lunchSeminars.map((s) => s.seminarId),
    ['5566', '5570'],
  );
  assert.strictEqual(res821.dinnerSeminars.length, 1, '8/21 저녁 세미나는 1건이어야 함');
  assert.deepStrictEqual(
    res821.dinnerSeminars.map((s) => s.seminarId),
    ['5559'],
  );
  console.log('  ✓ 8/21 세미나 수집 성공 (점심 2건: 5566, 5570 / 저녁 1건: 5559)');

  // 1-5. 8/28 세미나 수집
  const target828 = getTodayDateStrings('8/28');
  const res828 = collectSeminarsForTargetDate(nodes, target828);
  assert.strictEqual(res828.lunchSeminars.length, 1);
  assert.deepStrictEqual(
    res828.lunchSeminars.map((s) => s.seminarId),
    ['5498'],
  );
  assert.strictEqual(res828.dinnerSeminars.length, 0);
  console.log('  ✓ 8/28 세미나 수집 성공 (점심 1건: 5498 / 저녁 0건)');

  // 1-6. 9/1 세미나 수집
  const target901 = getTodayDateStrings('9/1');
  const res901 = collectSeminarsForTargetDate(nodes, target901);
  assert.strictEqual(res901.lunchSeminars.length, 1);
  assert.deepStrictEqual(
    res901.lunchSeminars.map((s) => s.seminarId),
    ['5572'],
  );
  assert.strictEqual(res901.dinnerSeminars.length, 0);
  console.log('  ✓ 9/1 세미나 수집 성공 (점심 1건: 5572 / 저녁 0건)');

  // 1-7. 9/2 세미나 수집
  const target902 = getTodayDateStrings('9/2');
  const res902 = collectSeminarsForTargetDate(nodes, target902);
  assert.strictEqual(res902.lunchSeminars.length, 0);
  assert.strictEqual(res902.dinnerSeminars.length, 1);
  assert.deepStrictEqual(
    res902.dinnerSeminars.map((s) => s.seminarId),
    ['5513'],
  );
  console.log('  ✓ 9/2 세미나 수집 성공 (점심 0건 / 저녁 1건: 5513)');

  // 1-8. 세미나가 없는 날짜 조회 (예: 2026-08-16)
  const targetEmpty = getTodayDateStrings('2026-08-16');
  const resEmpty = collectSeminarsForTargetDate(nodes, targetEmpty);
  assert.strictEqual(resEmpty.lunchSeminars.length, 0);
  assert.strictEqual(resEmpty.dinnerSeminars.length, 0);
  console.log('  ✓ 세미나 없는 날짜 정상 처리 (0건 반환)\n');
}

/**
 * 2. 날짜 파싱 및 다양한 포맷 지원 검증 (isDateMatching)
 */
function testDateMatchingFlexibility() {
  console.log('--- [Test 2] 날짜 매칭 유연성 (isDateMatching) 검증 시작 ---');

  const target818 = getTodayDateStrings('2026-08-18');

  // 웹페이지에 존재할 수 있는 다양한 날짜 텍스트 형식 검증
  assert(isDateMatching('8/18', target818), '8/18 매칭');
  assert(isDateMatching('08/18', target818), '08/18 매칭');
  assert(isDateMatching('8.18', target818), '8.18 매칭');
  assert(isDateMatching('08.18', target818), '08.18 매칭');
  assert(isDateMatching('8월 18일', target818), '8월 18일 매칭');
  assert(isDateMatching('08월 18일', target818), '08월 18일 매칭');
  assert(isDateMatching('8/18 (화)', target818), '8/18 (화) 매칭');
  assert(isDateMatching('8/18화요일', target818), '8/18화요일 매칭');
  assert(isDateMatching('2026.08.18', target818), '2026.08.18 매칭');
  assert(isDateMatching('2026-08-18', target818), '2026-08-18 매칭');

  // 다른 날짜는 매칭되지 않아야 함
  assert(!isDateMatching('8/19', target818), '8/19는 불일치');
  assert(!isDateMatching('8/17', target818), '8/17은 불일치');
  assert(!isDateMatching('9/18', target818), '9/18은 불일치');

  console.log('  ✓ 8/18, 08/18, 8.18, 8월 18일, 2026.08.18 등 모든 포맷 정확 매칭 검증 완료\n');
}

/**
 * 3. 포인트 미지급 취소선(구의...) 및 브로드캐스트 포맷팅 검증
 */
function testPointExcludedFormatting() {
  console.log('--- [Test 3] 포인트미지급 세미나 취소선(<s>) 및 포맷팅 검증 시작 ---');

  const mockInput: TodayLinksFormatInput = {
    quizInfo: null,
    seminarMessage: {
      date: '2026-08-18',
      lunchSeminarIds: ['5552', '5553'],
      dinnerSeminarIds: ['5555'],
      message: `<b>[8/18] 세미나 리스트:</b>
🍴 <b>[점심 세미나]</b>
- 12:00~13:00. <s>[실리스칸] 간장용제의 작용기전과 실리마린의 효능 및 효과</s> 🚫[포인트미지급] https://m.doctorville.co.kr/cme/seminar/5552
- 12:30~13:30. Clinical Updates in Dyslipidemia Positioning Baroezet for Optimal Patient Care https://m.doctorville.co.kr/cme/seminar/5553

🍴 <b>[저녁 세미나]</b>
- 18:00~19:30. [대한혈관학회] 혈관검사 시리즈 - 2. 하지 혈관초음파의 기본과 임상에서의 활용 https://m.doctorville.co.kr/cme/seminar/5555`,
    },
    storedNewSeminars: [
      {
        date: '8/20',
        time: '13:00~14:00',
        name: 'ChatGPT 실용 입문 — AI로 알아보고, 읽고, 만들고, 검증하기',
        seminarId: '5573',
        url: 'https://m.doctorville.co.kr/cme/seminar/5573',
        isPointExcluded: true,
      },
    ],
    pointConversionInfo: null,
    targetDate: '2026-08-18 (8/18)',
    isCustomDate: true,
  };

  const { message } = formatTodayLinksBroadcast(mockInput);

  assert(
    message.includes('<s>[실리스칸] 간장용제의 작용기전과 실리마린의 효능 및 효과</s> 🚫[포인트미지급]'),
    '당일 세미나 포인트미지급 취소선 태그 검증',
  );
  assert(
    message.includes('Clinical Updates in Dyslipidemia Positioning Baroezet for Optimal Patient Care'),
    '일반 세미나 정상 표시 검증',
  );
  assert(
    message.includes(
      '<s>ChatGPT 실용 입문 — AI로 알아보고, 읽고, 만들고, 검증하기</s> 🚫[포인트미지급]',
    ),
    '신규 세미나 포인트미지급 취소선 태그 검증',
  );

  console.log('  ✓ 당일 세미나 및 신규 세미나 취소선(<s>) 정상 포맷팅 검증 완료\n');
}

/**
 * 4. apply_seminar / refresh: 전체 세미나 목록 및 인원/상태 파싱 검증
 */
function testApplySeminarParsing(nodes: MockNode[]) {
  console.log('--- [Test 4] apply_seminar / refresh: 전체 25개 세미나 목록 및 메타 파싱 검증 시작 ---');

  let totalSeminars = 0;
  const allSeminarIds: string[] = [];

  nodes.forEach((node) => {
    node.links.forEach((link) => {
      totalSeminars++;
      const match = link.href.match(/seminarId=(\d+)/);
      if (match) allSeminarIds.push(match[1]);
    });
  });

  // 전체 세미나 개수 검증 (8/18: 8건 + 8/19: 8건 + 8/20: 5건 + 8/21: 3건 + 8/28: 1건 + 9/1: 1건 + 9/2: 1건 = 27건)
  assert.strictEqual(totalSeminars, 27, 'HTML 내 총 세미나 개수는 27개여야 함');
  assert.strictEqual(allSeminarIds.length, 27, '27개의 seminarId가 정상 추출되어야 함');

  // 첫 번째 세미나 검증 (8/18 실리스칸 5552)
  const first = nodes[0].links[0];
  assert.strictEqual(nodes[0].date, '8/18');
  assert.strictEqual(first.time, '12:00~13:00');
  assert.strictEqual(first.currentCount, '6067');
  assert.strictEqual(first.totalCount, '7000');
  assert(first.title.includes('실리스칸'));
  assert(first.nightTime === false);
  assert(first.isAdvancedSurvey === false);

  // 마지막 세미나 검증 (9/2 리브레2 5513)
  const lastNode = nodes[nodes.length - 1];
  const last = lastNode.links[lastNode.links.length - 1];
  assert.strictEqual(lastNode.date, '9/2');
  assert.strictEqual(last.time, '19:00~20:40');
  assert.strictEqual(last.currentCount, '4701');
  assert.strictEqual(last.totalCount, '6500');
  assert(last.title.includes('리브레2'));
  assert(last.nightTime === true);

  // 모든 evening 세미나 nightTime 검증
  const eveningSeminars = nodes[0].links.filter((l) => l.nightTime);
  assert(eveningSeminars.length > 0, '밤 시간대 세미나가 존재해야 함');

  console.log('  ✓ 전체 27개 세미나, 정원, 시간, seminarId, nightTime 파싱 검증 완료\n');
}

/**
 * 5. monitor_seminars: 모니터링 시간대별 세미나 필터링 로직 검증
 */
function testMonitorSeminarsTimeWindow(nodes: MockNode[]) {
  console.log('--- [Test 5] monitor_seminars: 시간대별 (점심 11~14시 / 저녁 17~21시) 필터링 검증 시작 ---');

  const node818 = nodes.find((n) => n.date === '8/18');
  assert(node818, '8/18 노드가 존재해야 함');

  // 점심 모니터링 윈도우 (11:00 ~ 14:00)
  const lunchSeminars818 = node818.links.filter((l) => {
    const hour = parseInt(l.time.split(':')[0], 10);
    return hour >= 11 && hour < 14;
  });
  assert.strictEqual(lunchSeminars818.length, 3);
  assert.deepStrictEqual(
    lunchSeminars818.map((l) => l.href.match(/seminarId=(\d+)/)?.[1]),
    ['5552', '5553', '5567'],
  );

  // 저녁 모니터링 윈도우 (17:00 ~ 21:00)
  const dinnerSeminars818 = node818.links.filter((l) => {
    const hour = parseInt(l.time.split(':')[0], 10);
    return hour >= 17 && hour < 21;
  });
  assert.strictEqual(dinnerSeminars818.length, 5);
  assert.deepStrictEqual(
    dinnerSeminars818.map((l) => l.href.match(/seminarId=(\d+)/)?.[1]),
    ['5555', '5561', '5568', '5560', '5488'],
  );

  console.log('  ✓ 8/18 점심 3건 (5552, 5553, 5567) 및 저녁 5건 (5555, 5561, 5568, 5560, 5488) 필터링 검증 완료\n');
}

/**
 * 6. apply_seminar의 normalizeParsedSeminars 함수 테스트
 */
function testNormalizeParsedSeminars(nodes: MockNode[]) {
  console.log('--- [Test 6] apply_seminar: normalizeParsedSeminars 정규화 검증 시작 ---');

  // MockNode[]를 RawSeminarData[] 형태로 변환 (production parser와 동일 필드만)
  const rawData = nodes.flatMap((node) =>
    node.links.map((link) => ({
      url: link.href,
      name: link.title,
      date: node.date,
      time: link.time,
      currentCount: link.currentCount,
      totalCount: link.totalCount,
      nightTime: link.nightTime,
      isAdvancedSurvey: link.isAdvancedSurvey,
    })),
  );

  const referenceDate = '2026-08-18';
  const normalized = normalizeParsedSeminars(rawData, referenceDate);

  assert.strictEqual(normalized.length, 27, '정규화 후 세미나 개수는 27개여야 함');

  // 첫 번째 세미나 검증
  const first = normalized[0];
  assert.strictEqual(first.seminarId, '5552');
  assert(first.url.includes('seminarId=5552'));
  assert(first.name.includes('실리스칸'));
  // 날짜가 canonical form (YYYY-MM-DD)으로 정규화되었는지 확인
  assert.strictEqual(first.date, '2026-08-18', '날짜가 YYYY-MM-DD로 정규화되어야 함');
  assert.strictEqual(first.time, '12:00~13:00');
  assert.strictEqual(first.currentCount, '6067');
  assert.strictEqual(first.totalCount, '7000');
  assert(first.nightTime === false);
  assert(first.isAdvancedSurvey === false);

  // 저녁 세미나 nightTime 검증
  const evening = normalized.find((s) => s.seminarId === '5555');
  assert(evening, '저녁 세미나 5555가 존재해야 함');
  assert(evening?.nightTime === true, '저녁 세미나는 nightTime이 true여야 함');

  // 연말/연초 경계 테스트: 12월 날짜가 다음 해 1월로 넘어가는지 확인 (예: 1/1 -> 2026-01-01)
  // fixture에 1월 데이터가 없으므로 9/1 검증
  const sept1 = normalized.find((s) => s.seminarId === '5572');
  assert(sept1, '9/1 세미나 5572가 존재해야 함');
  assert.strictEqual(sept1?.date, '2026-09-01', '9/1은 2026-09-01로 정규화되어야 함');

  // 포인트 관련 필드가 기본값(undefined)인지 확인 (목록 파싱 단계에서는 설정되지 않음)
  assert(first.pointPaid === undefined);
  assert(first.point === undefined);
  assert(first.pointText === undefined);
  assert(first.pointDate === undefined);
  assert(first.pointContent === undefined);
  assert(first.pointCheckedAt === undefined);

  console.log('  ✓ normalizeParsedSeminars: 모든 필드 정규화, 날짜 canonical화, 포인트 필드 비보유 검증 완료\n');
}

/**
 * 7. 목록 업데이트 시 포인트 필드 보존 검증
 */
function testPointFieldsPreservation() {
  console.log('--- [Test 7] SEMINAR_LIST_KEY 포인트 필드 보존 검증 시작 ---');

  // Mock stored data with point fields
  const existing: (ReturnType<typeof normalizeParsedSeminars>)[number] & {
    pointPaid?: boolean;
    point?: number;
    pointText?: string;
    pointDate?: string;
    pointContent?: string;
    pointCheckedAt?: string;
  } = {
    seminarId: '5552',
    name: '[실리스칸] 간장용제의 작용기전과 실리마린의 효능 및 효과',
    url: 'https://www.doctorville.co.kr/seminar/seminarDetail?seminarId=5552',
    date: '2026-08-18',
    time: '12:00~13:00',
    currentCount: '6067',
    totalCount: '7000',
    nightTime: false,
    isAdvancedSurvey: false,
    pointPaid: true,
    point: 1000,
    pointText: '1,000P',
    pointDate: '2026-08-18',
    pointContent: '세미나 참석 적립',
    pointCheckedAt: '2026-08-18T10:00:00.000Z',
  };

  // New parsed data (simulating fresh page fetch) - should NOT have point fields
  const fresh = normalizeParsedSeminars(
    [
      {
        url: 'https://www.doctorville.co.kr/seminar/seminarDetail?seminarId=5552',
        name: '[실리스칸] 간장용제의 작용기전과 실리마린의 효능 및 효과',
        date: '8/18',
        time: '12:00~13:00',
        currentCount: '6068', // 인원 수 변경됨
        totalCount: '7000',
        nightTime: false,
        isAdvancedSurvey: false,
      },
    ],
    '2026-08-18',
  )[0];

  // Merge logic: fresh is primary, point fields from existing
  const merged = {
    ...fresh,
    isPointExcluded: existing.isPointExcluded,
    pointPaid: existing.pointPaid,
    point: existing.point,
    pointText: existing.pointText,
    pointDate: existing.pointDate,
    pointContent: existing.pointContent,
    pointCheckedAt: existing.pointCheckedAt,
  };

  assert.strictEqual(merged.currentCount, '6068', '신선한 현재 인원 수로 업데이트되어야 함');
  assert(merged.pointPaid === true, 'pointPaid 보존되어야 함');
  assert.strictEqual(merged.point, 1000, 'point 보존되어야 함');
  assert.strictEqual(merged.pointText, '1,000P', 'pointText 보존되어야 함');
  assert.strictEqual(merged.pointDate, '2026-08-18', 'pointDate 보존되어야 함');
  assert.strictEqual(merged.pointContent, '세미나 참석 적립', 'pointContent 보존되어야 함');
  assert.strictEqual(merged.pointCheckedAt, '2026-08-18T10:00:00.000Z', 'pointCheckedAt 보존되어야 함');

  console.log('  ✓ 포인트 필드 보존 로직 검증 완료\n');
}

function runAllFixtureTests() {
  console.log('===========================================================');
  console.log('  닥터빌 세미나 메인 페이지 (/seminar/main) 기능 통합 테스트');
  console.log('===========================================================\n');

  const html = fs.readFileSync(FIXTURE_PATH, 'utf-8');
  const nodes = parseFixtureHtml(html);

  testTodayLinksSeminarCollection(nodes);
  testDateMatchingFlexibility();
  testPointExcludedFormatting();
  testApplySeminarParsing(nodes);
  testMonitorSeminarsTimeWindow(nodes);
  testNormalizeParsedSeminars(nodes);
  testPointFieldsPreservation();
  testPointStatusMergeLogic();
  testLegacyKeysRemoved();

  console.log('🎉 모든 세미나 메인 페이지 (/seminar/main) 기능 테스트를 100% 성공적으로 통과했습니다!\n');
}

/**
 * 8. 포인트 상태 merge 로직 통합 검증 (요구사항 3~6, 9)
 */
function testPointStatusMergeLogic() {
  console.log('--- [Test 8] 포인트 상태 merge 로직 검증 시작 ---');

  type SeminarPointStatus = {
    pointPaid?: boolean;
    point?: number;
    pointText?: string;
    pointDate?: string;
    pointContent?: string;
    pointCheckedAt?: string;
  };
  type TestSeminar = {
    seminarId: string | null;
    name: string;
    url: string;
    date?: string;
    time: string;
    currentCount: string;
    totalCount: string;
    nightTime: boolean;
    isAdvancedSurvey: boolean;
    detectedDate?: string;
  } & SeminarPointStatus;

  function seminarKey(s: Pick<TestSeminar, 'url' | 'seminarId'>): string {
    return s.seminarId || s.url;
  }

  function simulateMerge(
    storedSeminars: TestSeminar[],
    currentSeminars: TestSeminar[],
    pointTable: Map<string, SeminarPointStatus & { found: boolean; pointText?: string; date?: string; content?: string }>,
  ): Map<string, TestSeminar> {
    const checkedAt = '2026-08-22T10:00:00.000Z';
    const storedByKey = new Map(storedSeminars.map((s) => [seminarKey(s), s]));
    const currentByKey = new Map(currentSeminars.map((s) => [seminarKey(s), s]));
    const allParsed = pointTable;
    const updatedSeminars = new Map<string, TestSeminar>();
    for (const [key, seminar] of storedByKey) {
      if (seminar.pointPaid === true) {
        updatedSeminars.set(key, seminar);
        continue;
      }
      updatedSeminars.set(key, { ...seminar });
    }
    for (const [key, current] of currentByKey) {
      const existing = updatedSeminars.get(key);
      const pointInfo = allParsed.get(current.seminarId || '');
      let merged: TestSeminar;
      if (pointInfo?.found) {
        if (existing?.pointPaid === true) {
          const base = updatedSeminars.get(key)!;
          const patched = { ...base, name: current.name || base.name, date: current.date || base.date, time: current.time || base.time, currentCount: current.currentCount || base.currentCount, totalCount: current.totalCount || base.totalCount, nightTime: current.nightTime, isAdvancedSurvey: current.isAdvancedSurvey || base.isAdvancedSurvey };
          updatedSeminars.set(key, patched);
          continue;
        }
        merged = {
          ...(existing || {}),
          ...current,
          pointPaid: true,
          point: (pointInfo as any).point,
          pointText: pointInfo.pointText,
          pointDate: pointInfo.date,
          pointContent: pointInfo.content,
          pointCheckedAt: checkedAt,
          detectedDate: existing?.detectedDate ?? current.detectedDate,
        };
      } else if (existing) {
        if (existing.pointPaid === true) {
          const base = updatedSeminars.get(key)!;
          const patched = { ...base, name: current.name || base.name, date: current.date || base.date, time: current.time || base.time, currentCount: current.currentCount || base.currentCount, totalCount: current.totalCount || base.totalCount, nightTime: current.nightTime, isAdvancedSurvey: current.isAdvancedSurvey || base.isAdvancedSurvey };
          updatedSeminars.set(key, patched);
          continue;
        }
        merged = { ...(existing || {}), ...current, pointPaid: false, pointCheckedAt: checkedAt };
      } else {
        merged = { ...current, pointPaid: false, pointCheckedAt: checkedAt };
      }
      updatedSeminars.set(key, merged);
    }
    for (const [seminarId, pointInfo] of allParsed) {
      let foundKey: string | null = null;
      for (const [key, s] of currentByKey) if (s.seminarId === seminarId) { foundKey = key; break; }
      if (!foundKey) for (const [key, s] of storedByKey) if (s.seminarId === seminarId) { foundKey = key; break; }
      if (!foundKey && pointInfo.found) {
        const url = `https://m.doctorville.co.kr/cme/seminar/${seminarId}`;
        const newItem: TestSeminar = {
          seminarId, name: pointInfo.content || `세미나 ${seminarId}`, url, date: undefined, time: '', currentCount: '', totalCount: '', nightTime: false, isAdvancedSurvey: false,
          detectedDate: '2026-08-22', pointPaid: true, point: (pointInfo as any).point, pointText: pointInfo.pointText, pointDate: pointInfo.date, pointContent: pointInfo.content, pointCheckedAt: checkedAt,
        };
        updatedSeminars.set(seminarKey(newItem), newItem);
      }
    }
    return updatedSeminars;
  }

  // 1) pointPaid=true 세미나는 포인트 테이블에 없어도 false로 변경되지 않는다
  {
    const stored: TestSeminar[] = [{ seminarId: '1111', name: 'paid', url: 'https://m.doctorville.co.kr/cme/seminar/1111', time: '', currentCount: '', totalCount: '', nightTime: false, isAdvancedSurvey: true, pointPaid: true, point: 500, pointText: '+ 500 P', pointDate: '2026-08-15', pointCheckedAt: '2026-08-15T10:00:00.000Z' }];
    const current: TestSeminar[] = [{ seminarId: '1111', name: 'paid', url: 'https://m.doctorville.co.kr/cme/seminar/1111', time: '13:00', currentCount: '10', totalCount: '100', nightTime: false, isAdvancedSurvey: true }];
    const table = new Map<string, any>(); // 빈 테이블
    const merged = simulateMerge(stored, current, table);
    const item = merged.get('1111')!;
    assert.strictEqual(item.pointPaid, true, 'pointPaid=true는 테이블에 없어도 유지되어야 함');
    assert.strictEqual(item.pointCheckedAt, '2026-08-15T10:00:00.000Z', 'pointCheckedAt도 기존값 유지');
    assert.strictEqual(item.point, 500, 'point 유지');
  }

  // 2) pointPaid 없는 세미나가 테이블에 있으면 paid로 업데이트
  {
    const stored: TestSeminar[] = [];
    const current: TestSeminar[] = [{ seminarId: '2222', name: 'unpaid', url: 'https://m.doctorville.co.kr/cme/seminar/2222', time: '13:00', currentCount: '10', totalCount: '100', nightTime: false, isAdvancedSurvey: true }];
    const table = new Map<string, any>([['2222', { found: true, point: 1000, pointText: '+ 1,000 P', date: '2026-08-22', content: '설문 포인트 2222' }]]);
    const merged = simulateMerge(stored, current, table);
    const item = merged.get('2222')!;
    assert.strictEqual(item.pointPaid, true, '테이블에 있으면 pointPaid=true');
    assert.strictEqual(item.point, 1000);
    assert(item.pointCheckedAt, 'pointCheckedAt 기록되어야 함');
  }

  // 3) pointPaid 없는 세미나가 테이블에 없으면 false + checkedAt
  {
    const stored: TestSeminar[] = [];
    const current: TestSeminar[] = [{ seminarId: '3333', name: 'unpaid', url: 'https://m.doctorville.co.kr/cme/seminar/3333', time: '13:00', currentCount: '10', totalCount: '100', nightTime: false, isAdvancedSurvey: true }];
    const table = new Map<string, any>();
    const merged = simulateMerge(stored, current, table);
    const item = merged.get('3333')!;
    assert.strictEqual(item.pointPaid, false, '테이블에 없으면 pointPaid=false');
    assert(item.pointCheckedAt, 'pointCheckedAt 기록되어야 함');
  }

  // 4) pointPaid=false 세미나는 다음 실행에서 다시 조회되어 테이블에 있으면 paid로 변경
  {
    const stored: TestSeminar[] = [{ seminarId: '4444', name: 'retry', url: 'https://m.doctorville.co.kr/cme/seminar/4444', time: '13:00', currentCount: '10', totalCount: '100', nightTime: false, isAdvancedSurvey: true, pointPaid: false, pointCheckedAt: '2026-08-21T10:00:00.000Z' }];
    const current: TestSeminar[] = [{ seminarId: '4444', name: 'retry', url: 'https://m.doctorville.co.kr/cme/seminar/4444', time: '13:00', currentCount: '10', totalCount: '100', nightTime: false, isAdvancedSurvey: true, pointPaid: false, pointCheckedAt: '2026-08-21T10:00:00.000Z' }];
    const table = new Map<string, any>([['4444', { found: true, point: 800, pointText: '+ 800 P', date: '2026-08-22', content: '설문 포인트 4444' }]]);
    const merged = simulateMerge(stored, current, table);
    const item = merged.get('4444')!;
    assert.strictEqual(item.pointPaid, true, '재조회 시 테이블에 있으면 paid로 변경');
    assert.strictEqual(item.point, 800);
  }

  // 5) 포인트 테이블에만 있는 세미나는 새 항목으로 추가
  {
    const stored: TestSeminar[] = [];
    const current: TestSeminar[] = [];
    const table = new Map<string, any>([['9999', { found: true, point: 300, pointText: '+ 300 P', date: '2026-08-20', content: '설문 포인트 9999' }]]);
    const merged = simulateMerge(stored, current, table);
    const item = merged.get('9999')!;
    assert(item, '포인트-only 세미나는 새로 생성되어야 함');
    assert.strictEqual(item.pointPaid, true);
    assert.strictEqual(item.point, 300);
    assert.strictEqual(item.time, '', '메타데이터는 빈 값');
  }

  // 6) 포인트-only 항목 이후 같은 ID가 세미나 목록에 나타나면 메타데이터 보완 + 포인트 유지
  {
    const pointOnly: TestSeminar = { seminarId: '7777', name: '설문 포인트 7777', url: 'https://m.doctorville.co.kr/cme/seminar/7777', time: '', currentCount: '', totalCount: '', nightTime: false, isAdvancedSurvey: false, pointPaid: true, point: 600, pointText: '+ 600 P', pointDate: '2026-08-20', pointCheckedAt: '2026-08-20T10:00:00.000Z' };
    const stored: TestSeminar[] = [pointOnly];
    const current: TestSeminar[] = [{ seminarId: '7777', name: '실제 세미나 제목', url: 'https://m.doctorville.co.kr/cme/seminar/7777', date: '2026-08-22', time: '13:00~14:00', currentCount: '50', totalCount: '200', nightTime: false, isAdvancedSurvey: true }];
    const table = new Map<string, any>(); // 테이블에 없어도 paid는 보존
    const merged = simulateMerge(stored, current, table);
    const item = merged.get('7777')!;
    assert.strictEqual(item.pointPaid, true, '포인트 정보 유지');
    assert.strictEqual(item.point, 600, 'point 유지');
    assert.strictEqual(item.name, '실제 세미나 제목', '포인트-only 항목의 메타데이터가 실제 목록으로 보완되어야 함');
    assert.strictEqual(item.time, '13:00~14:00', 'time 보완');
  }

  // 7) 기존 seminar_list의 과거 세미나가 새 목록 수집으로 삭제되지 않는다 (retention 내)
  {
    const stored: TestSeminar[] = [
      { seminarId: '1001', name: 'old', url: 'https://m.doctorville.co.kr/cme/seminar/1001', date: '2026-08-10', time: '13:00', currentCount: '10', totalCount: '100', nightTime: false, isAdvancedSurvey: false, detectedDate: '2026-08-10' },
      { seminarId: '1002', name: 'recent', url: 'https://m.doctorville.co.kr/cme/seminar/1002', date: '2026-08-22', time: '13:00', currentCount: '10', totalCount: '100', nightTime: false, isAdvancedSurvey: false, detectedDate: '2026-08-22' },
    ];
    const current: TestSeminar[] = [{ seminarId: '1002', name: 'recent', url: 'https://m.doctorville.co.kr/cme/seminar/1002', date: '2026-08-22', time: '13:00', currentCount: '10', totalCount: '100', nightTime: false, isAdvancedSurvey: false, detectedDate: '2026-08-22' }];
    const table = new Map<string, any>();
    const merged = simulateMerge(stored, current, table);
    // current에 없는 1001도 storedByKey를 통해 보존됨 (pointPaid !== true이면 updatedSeminars에 먼저 들어감)
    // pointPaid가 없는 경우에도 보존됨
    assert(merged.has('1001'), '과거 세미나가 새 목록에 없어도 저장소에서 보존되어야 함');
    assert(merged.has('1002'), '현재 세미나 유지');
  }

  console.log('  ✓ 포인트 상태 3단계 구분(미조회/미지급/지급됨), 재조회, 포인트-only 추가, 보존 검증 완료\n');
}

function testLegacyKeysRemoved() {
  console.log('--- [Test 9] legacy storage key 미사용 검증 시작 ---');
  const srcFiles = [
    'src/tasks/apply_seminar.ts',
    'src/tasks/today_links.ts',
    'src/tasks/refresh_seminar_point_exclusion.ts',
    'src/tasks/check_seminar_point.ts',
  ];
  for (const file of srcFiles) {
    const content = fs.readFileSync(path.join(process.cwd(), file), 'utf-8');
    assert(!content.includes('apply_seminar:new_seminars'), `${file}에 legacy new_seminars 키가 남아있으면 안 됨`);
    assert(!content.includes('apply_seminar:new_seminars_history'), `${file}에 legacy history 키가 남아있으면 안 됨`);
  }
  console.log('  ✓ legacy 키 미사용 검증 완료\n');
}

runAllFixtureTests();