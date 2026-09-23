/**
 * 세션 만료 여부 확인 HTML 파싱
 */
export function isAuthExpiredHtml(html: string): boolean {
  return html.includes('로그인이 되어 있지 않습니다');
}

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

  if (isAuthExpiredHtml(html)) {
    return 'NOT_LOGGED_IN';
  }

  const $ = cheerio.load(html);

  // 1. '회원정보수정' 버튼/링크 요소 검출
  const hasButton =
    $('button:contains("회원정보수정")').length > 0 ||
    $('a:contains("회원정보수정")').length > 0 ||
    $('.btn:contains("회원정보수정")').length > 0;

  if (hasButton) {
    return 'LOGGED_IN';
  }

  // 2. /member/login 리다이렉트 스크립트나 로그인 페이지 여부 확인
  if (html.includes('/member/login') || html.includes('location.href')) {
    return 'NOT_LOGGED_IN';
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

      const hasIcoApply = $link.find('.ico_apply').length > 0;

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
        hasIcoApply,
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

export interface ActiveSurveyItem {
  surveyId?: string;
  surveyType?: number;
  itemId?: string;
  category: string;
  title: string;
  date: string;
  startDate?: string;
  endDate?: string;
  isOngoing: boolean;
  progress: string;
  pointText: string;
  point?: number;
  surveyUrl?: string;
  isAvailable: boolean;
  minutesLeft?: number;
  url: string;
}

/**
 * 설문 기간 문자열(예: '2026-09-16 ~ 2026-09-18' 또는 '2026-09-17') 파싱 및
 * 기준일(오늘 KST) 기준 진행 중인 기간인지 판별합니다.
 */
export function parseSurveyDateRange(
  dateStr: string,
  referenceDate: string = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }),
): { startDate?: string; endDate?: string; isOngoing: boolean } {
  if (!dateStr) return { isOngoing: false };

  const matches = dateStr.match(/(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/g);
  if (matches && matches.length >= 2) {
    const start = matches[0].replace(/[/.]/g, '-');
    const end = matches[1].replace(/[/.]/g, '-');
    return {
      startDate: start,
      endDate: end,
      isOngoing: end >= referenceDate,
    };
  }
  if (matches && matches.length === 1) {
    const single = matches[0].replace(/[/.]/g, '-');
    return {
      startDate: single,
      endDate: single,
      isOngoing: single >= referenceDate,
    };
  }
  return { isOngoing: false };
}

/**
 * 닥터빌 설문 메인(https://www.doctorville.co.kr/survey/main) HTML 파싱
 * 참여 가능한 설문(시장조사 및 세미나 설문 등)을 식별합니다.
 */
export function parseSurveyMainListHtml(
  html: string,
  baseUrl = 'https://www.doctorville.co.kr/survey/main',
  referenceDate: string = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }),
): ActiveSurveyItem[] {
  const $ = cheerio.load(html);
  const results: ActiveSurveyItem[] = [];
  const seenKeys = new Set<string>();

  // 1. 상단 활성 설문 배너 카드 영역 (.survey_box li.link_info 또는 .survey_box .link_info)
  const $boxItems = $('.survey_box li.link_info, .survey_box .link_info');
  const boxElements = $boxItems.length > 0 ? $boxItems : $('.survey_box li');

  boxElements.each((_, el) => {
    const $item = $(el);
    const title = $item.find('.tit_info .tit, .tit').text().trim() || '';
    if (!title) return;

    const category = $item.find('.tit_info .category, .category').text().trim() || '';
    const timerEl = $item.find('.survey-timer');
    const timerText = timerEl.text().trim() || '';
    const date = timerText || $item.find('.tit_info .date, .date').text().trim() || '';

    const progressNode = $item.find('.progress');
    const progressSpan = progressNode.find('span').text().trim();
    const progress = progressSpan || progressNode.clone().children().remove().end().text().trim() || '';

    const pointNode = $item.find('.tit_info .point, .point');
    const pointText = pointNode.text().trim().replace(/\s+/g, ' ') || '';
    const pointMatch = pointText.match(/([\d,]+)\s*P/i);
    const point = pointMatch ? parseInt(pointMatch[1].replace(/,/g, ''), 10) : undefined;

    const surveyId = $item.find('.surveyIdCls').val()?.toString().trim() || undefined;
    const surveyTypeStr = $item.find('.surveyTypeCls').val()?.toString().trim();
    const surveyType = surveyTypeStr ? parseInt(surveyTypeStr, 10) : undefined;
    const itemId = $item.find('.itemIdCls').val()?.toString().trim() || undefined;
    const surveyUrl = $item.find('.surveyUrl').val()?.toString().trim() || undefined;

    const minutesLeftAttr = timerEl.attr('data-minutes-left');
    const minutesLeft = minutesLeftAttr !== undefined ? parseInt(minutesLeftAttr, 10) : undefined;

    const hasButton = $item.find('.btn_survey, .btn_apply, button, a').length > 0;
    const isFinishClass = progressNode.hasClass('finish');
    const isClosedText =
      progress.includes('달성') ||
      progress.includes('마감') ||
      progress.includes('종료') ||
      progress.includes('바로지급') ||
      progress.includes('일괄지급');

    let isAvailable = false;
    if (progress.includes('진행중')) {
      isAvailable = true;
    } else if (hasButton) {
      isAvailable = true;
    } else if (minutesLeft !== undefined && minutesLeft > 0) {
      isAvailable = true;
    } else if (surveyId && !isFinishClass && !isClosedText) {
      isAvailable = true;
    }

    const { startDate, endDate, isOngoing } = parseSurveyDateRange(date, referenceDate);
    const url = itemId && itemId !== '0' ? `https://m.doctorville.co.kr/cme/seminar/${itemId}` : baseUrl;

    const dedupeKey = surveyId ? `id_${surveyId}` : `title_${title}_${date}`;
    if (!seenKeys.has(dedupeKey)) {
      seenKeys.add(dedupeKey);
      results.push({
        surveyId,
        surveyType,
        itemId,
        category,
        title,
        date,
        startDate,
        endDate,
        isOngoing,
        progress,
        pointText,
        point,
        surveyUrl,
        isAvailable,
        minutesLeft,
        url,
      });
    }
  });

  // 2. 하단 설문 목록 테이블 영역 (.survey_list table tbody tr)
  $('.survey_list table tbody tr').each((_, tr) => {
    const $tr = $(tr);
    const category = $tr.find('.tit_info .category').text().trim() || '';
    const title = $tr.find('.tit_info .tit').text().trim() || '';
    if (!title) return;

    const date = $tr.find('.tit_info .date').text().trim() || '';
    const progressNode = $tr.find('td:nth-child(1) .progress');
    const progress = progressNode.text().trim() || '';
    const pointText = $tr.find('td:nth-child(1) .point').text().trim() || '';

    const pointMatch = pointText.match(/([\d,]+)\s*P/i);
    const point = pointMatch ? parseInt(pointMatch[1].replace(/,/g, ''), 10) : undefined;

    const actionTd = $tr.find('td:nth-child(3)');
    const surveyId = actionTd.find('.surveyIdCls').val()?.toString().trim() || undefined;
    const surveyTypeStr = actionTd.find('.surveyTypeCls').val()?.toString().trim();
    const surveyType = surveyTypeStr ? parseInt(surveyTypeStr, 10) : undefined;
    const itemId = actionTd.find('.itemIdCls').val()?.toString().trim() || undefined;
    const surveyUrl = actionTd.find('.surveyUrl').val()?.toString().trim() || undefined;

    const timerEl = $tr.find('.survey-timer');
    const minutesLeftAttr = timerEl.attr('data-minutes-left');
    const minutesLeft = minutesLeftAttr !== undefined ? parseInt(minutesLeftAttr, 10) : undefined;

    const hasButton = actionTd.find('.btn_survey, .btn_apply, button, a').length > 0;
    const isFinishClass = progressNode.hasClass('finish');
    const isClosedText =
      progress.includes('달성') ||
      progress.includes('마감') ||
      progress.includes('종료') ||
      progress.includes('바로지급') ||
      progress.includes('일괄지급');

    let isAvailable = false;
    if (progress.includes('진행중')) {
      isAvailable = true;
    } else if (hasButton) {
      isAvailable = true;
    } else if (minutesLeft !== undefined && minutesLeft > 0) {
      isAvailable = true;
    } else if (surveyId && !isFinishClass && !isClosedText) {
      isAvailable = true;
    }

    const { startDate, endDate, isOngoing } = parseSurveyDateRange(date, referenceDate);
    const url = itemId && itemId !== '0' ? `https://m.doctorville.co.kr/cme/seminar/${itemId}` : baseUrl;

    const dedupeKey = surveyId ? `id_${surveyId}` : `title_${title}_${date}`;
    if (!seenKeys.has(dedupeKey)) {
      seenKeys.add(dedupeKey);
      results.push({
        surveyId,
        surveyType,
        itemId,
        category,
        title,
        date,
        startDate,
        endDate,
        isOngoing,
        progress,
        pointText,
        point,
        surveyUrl,
        isAvailable,
        minutesLeft,
        url,
      });
    }
  });

  return results;
}
