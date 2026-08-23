import assert from 'assert';
import {
  parseLoginStatusHtml,
  parseSeminarListHtml,
  parseCompletionCountHtml,
  hasSurveyPointExcludedNoticeHtml,
  parseRecentSeminarPointRowsHtml,
  parseCurrentPointHtml,
} from '../src/modules/html_parser';
import { isSurveyPointExcludedSeminarHttp } from '../src/modules/utils';

async function testHtmlParser() {
  console.log('Testing HTML Parser and isSurveyPointExcludedStatus...');

  // 1. login status
  const loggedInHtml = '<div><button>회원정보수정</button></div>';
  assert.strictEqual(parseLoginStatusHtml(loggedInHtml), 'LOGGED_IN');

  const loggedOutHtml = '<div><script>location.href="/member/login";</script></div>';
  assert.strictEqual(parseLoginStatusHtml(loggedOutHtml, 'https://m.doctorville.co.kr/member/login'), 'NOT_LOGGED_IN');

  const plainTextHtml = '<p>회원정보수정 안내 문구입니다</p>';
  assert.strictEqual(parseLoginStatusHtml(plainTextHtml), 'UNKNOWN');

  // 2. seminar main parsing
  const seminarMainHtml = `
    <div class="list_cont">
      <div class="seminar_day"><span class="date">2025.05.20</span></div>
      <a class="list_detail" href="/seminar/seminarDetail?seminarId=9999">
        <div class="list_tit"><span class="tit">테스트 세미나 1</span></div>
        <span class="txt_num time night_time">19:00</span>
        <div class="person"><span class="txt_num">10</span><span class="total"><span class="txt_num">/100</span></span></div>
        <span class="ic_survey"></span>
      </a>
    </div>
    <a class="list_detail" href="/seminar/seminarDetail?seminarId=8888">
      <span class="ico_completion"></span>
    </a>
  `;
  const parsedSeminars = parseSeminarListHtml(seminarMainHtml);
  assert.strictEqual(parsedSeminars.length, 1);
  assert.strictEqual(parsedSeminars[0].name, '테스트 세미나 1');
  assert.strictEqual(parsedSeminars[0].nightTime, true);
  assert.strictEqual(parsedSeminars[0].isAdvancedSurvey, true);
  assert.strictEqual(parsedSeminars[0].currentCount, '10');
  assert.strictEqual(parsedSeminars[0].totalCount, '100');

  // 3. completion count parsing
  assert.strictEqual(parseCompletionCountHtml(seminarMainHtml), 1);

  // 4. seminar detail point excluded notice parsing
  const excludedHtml = '<div>이 세미나는 설문 포인트가 지급되지 않는 세미나입니다.</div>';
  const normalDetailHtml = '<div>즐거운 세미나 되세요.</div>';
  assert.strictEqual(hasSurveyPointExcludedNoticeHtml(excludedHtml), true);
  assert.strictEqual(hasSurveyPointExcludedNoticeHtml(normalDetailHtml), false);

  // 5. isSurveyPointExcludedSeminarHttp error statuses (invalid URL / non-200)
  const invalidUrlRes = await isSurveyPointExcludedSeminarHttp('http://localhost:99999/not_exist');
  assert.strictEqual(invalidUrlRes.status, 'error');

  // 6. point history parsing
  const pointHistoryHtml = `
    <div id="useList">
      <table>
        <tbody>
          <tr>
            <td>2025-05-19</td>
            <td>설문</td>
            <td>8/14 설문 포인트 9999</td>
            <td>적립</td>
            <td>+1,000 P</td>
            <td>2026-05-19</td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
  const pointsMap = parseRecentSeminarPointRowsHtml(pointHistoryHtml);
  assert.strictEqual(pointsMap.size, 1);
  const p = pointsMap.get('9999');
  assert.ok(p);
  assert.strictEqual(p?.found, true);
  assert.strictEqual(p?.point, 1000);
  assert.strictEqual(p?.type, '적립');

  // 7. current point parsing
  const mainPointHtml = '<div class="member_point">12,500P</div>';
  assert.strictEqual(parseCurrentPointHtml(mainPointHtml), '12,500P');

  console.log('✅ HTML Parser & isSurveyPointExcludedStatus tests passed!');
}

testHtmlParser().catch((err) => {
  console.error('❌ HTML Parser tests failed:', err);
  process.exit(1);
});
