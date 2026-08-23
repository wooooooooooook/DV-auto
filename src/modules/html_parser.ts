import * as cheerio from 'cheerio';
import type { RawSeminarData } from '../tasks/apply_seminar';
import type { SeminarPointResult } from '../tasks/check_seminar_point';

/**
 * 로그인 상태 확인 HTML 파싱
 * URL: https://m.doctorville.co.kr/mypage/info
 */
export function parseLoginStatusHtml(html: string, finalUrl?: string): 'LOGGED_IN' | 'NOT_LOGGED_IN' | 'UNKNOWN' {
  if (finalUrl) {
    try {
      const u = new URL(finalUrl);
      if (u.pathname === '/member/login') {
        return 'NOT_LOGGED_IN';
      }
    } catch (_e) {
      /* ignore */
    }
  }

  const $ = cheerio.load(html);
  // '회원정보수정' 버튼/링크나 텍스트가 있는지 확인
  const text = $.text();
  if (text.includes('회원정보수정')) {
    return 'LOGGED_IN';
  }

  // /member/login 리다이렉트 스크립트나 메시지 검출
  if (html.includes('/member/login') || html.includes('로그인')) {
    if (!text.includes('회원정보수정')) {
      return 'NOT_LOGGED_IN';
    }
  }

  return 'UNKNOWN';
}

/**
 * 세미나 목록 HTML 파싱
 * URL: https://www.doctorville.co.kr/seminar/main
 */
export function parseSeminarListHtml(
  html: string,
  baseUrl = 'https://www.doctorville.co.kr/seminar/main',
): RawSeminarData[] {
  const $ = cheerio.load(html);
  const results: RawSeminarData[] = [];

  $('.list_cont').each((_, node) => {
    const $node = $(node);
    const date = $node.find('.seminar_day .date').text().trim() || '';

    $node.find('a.list_detail').each((__, link) => {
      const $link = $(link);
      const href = $link.attr('href') || '';
      if (!href) return;

      const name = $link.find('.list_tit .tit').text().trim() || $link.text().trim() || '세미나';

      const timeNode = $link.find('.txt_num.time');
      const time = timeNode.text().replace(/\n/g, '').trim() || '';
      const nightTime = timeNode.hasClass('night_time');

      const personNode = $link.find('.person');
      const personClone = personNode.clone();
      personClone.find('.total').remove();
      const currentCount = personClone.find('.txt_num').text().trim() || '';

      const totalCount = personNode.find('.total .txt_num').text().replace(/\//g, '').trim() || '';

      const isAdvancedSurvey = $link.find('.ic_survey').length > 0;

      const absoluteUrl = new URL(href, baseUrl).toString();

      results.push({
        url: absoluteUrl,
        name,
        date,
        time,
        currentCount,
        totalCount,
        nightTime,
        isAdvancedSurvey,
      });
    });
  });

  return results;
}

/**
 * 신청 완료 건수 파싱 (.ico_completion 개수)
 */
export function parseCompletionCountHtml(html: string): number {
  const $ = cheerio.load(html);
  return $('.ico_completion').length;
}

/**
 * 포인트 미지급 세미나 문구 검출
 * 세미나 상세 HTML
 */
export function hasSurveyPointExcludedNoticeHtml(html: string): boolean {
  const $ = cheerio.load(html);
  const bodyText = $('body').text().replace(/\s+/g, ' ');
  return /포인트가\s*지급되지\s*않는\s*세미나/.test(bodyText) || /포인트가\s*지급되지\s*않는/.test(bodyText);
}

/**
 * 포인트 내역 HTML 파싱
 * URL: https://www.doctorville.co.kr/my/point/pointUseHistoryList
 */
export function parseRecentSeminarPointRowsHtml(html: string): Map<string, SeminarPointResult> {
  const $ = cheerio.load(html);
  const results = new Map<string, SeminarPointResult>();

  let $rows = $('#useList table tbody tr');
  if ($rows.length === 0) {
    $rows = $('table tbody tr');
  }

  $rows.each((_, tr) => {
    const cells: string[] = [];
    $(tr)
      .find('td')
      .each((__, td) => {
        cells.push($(td).text().replace(/\s+/g, ' ').trim());
      });

    if (cells.length < 5) return;

    const date = cells[0] || '';
    const service = cells[1] || '';
    const content = cells[2] || '';
    const type = cells[3] || '';
    const pointText = cells[4] || '';
    const expiry = cells[5] || '';

    if (type !== '적립') return;

    // 실제 지급내역: "8/14 설문 포인트 5544"
    const idMatch = content.match(/설문\s*포인트\s*(\d+)/);
    if (!idMatch) return;
    const seminarId = idMatch[1];
    const pointMatch = pointText.match(/[+]?\s*([\d,]+)\s*P/i);
    const point = pointMatch ? parseInt(pointMatch[1].replace(/,/g, ''), 10) : undefined;

    if (!results.has(seminarId)) {
      results.set(seminarId, {
        found: true,
        point,
        pointText,
        date,
        service,
        content,
        type: '적립',
        expiry,
      });
    }
  });

  return results;
}

/**
 * 현재 포인트 파싱 (.member_point)
 * URL: https://www.doctorville.co.kr/main
 */
export function parseCurrentPointHtml(html: string): string {
  const $ = cheerio.load(html);
  const pointText = $('.member_point').text().trim();
  if (pointText) {
    return pointText;
  }
  return '조회 실패';
}
