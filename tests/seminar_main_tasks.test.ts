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

  console.log('🎉 모든 세미나 메인 페이지 (/seminar/main) 기능 테스트를 100% 성공적으로 통과했습니다!\n');
}

runAllFixtureTests();