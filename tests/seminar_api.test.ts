import assert from 'node:assert';
import {
  parseSeminarDateTime,
  checkIsAdvancedSurvey,
  checkIsPointExcluded,
  checkHasEntryHistory,
  convertApiItemToRawSeminar,
  convertApiItemToSeminarListItem,
  fetchMainFutureSeminars,
  fetchSeminarDetail,
  type FutureSeminarApiItem,
  type MainFutureSeminarsApiResponse,
} from '../src/modules/seminar_api';
import * as httpClientModule from '../src/modules/http_client';
import { refreshStoredSeminarList, type SeminarListItem } from '../src/tasks/apply_seminar';

async function testSeminarApiConversion() {
  console.log('===========================================================');
  console.log('  seminar_api 단위 테스트: 데이터 변환 및 플래그 판별');
  console.log('===========================================================\n');

  // Case 1: 기본 변환 및 시간, 심화설문, 포인트 지급 테스트 (낮 세미나)
  const item1: FutureSeminarApiItem = {
    seminarId: 5565,
    seminarNm: '눈에서 시작하는 심혈관 위험 평가와 AI의 미래',
    startDt: '2026-08-24 13:00:00',
    endDt: '2026-08-24 14:00:00',
    tutorNm: '홍길동',
    categoryCdNm: '내과',
    diseaseCategoryNm: '순환기',
    maxPeopleCnt: 5000,
    applyCnt: 1234,
    useSurvey: 'Y',
    useDepthSurvey: 'Y',
    survey: {
      surveyId: 101,
      point: 1000,
    },
    processState: 2, // PROCESS_APPLY
    cancelProcessState: -1,
    seminarCompleted: 0,
  };

  const dt1 = parseSeminarDateTime(item1.startDt, item1.endDt);
  assert.strictEqual(dt1.date, '2026-08-24');
  assert.strictEqual(dt1.time, '13:00~14:00');
  assert.strictEqual(dt1.nightTime, false);
  assert.strictEqual(checkIsAdvancedSurvey(item1.useDepthSurvey), true);
  assert.strictEqual(checkIsPointExcluded(item1.survey), false);

  const converted1 = convertApiItemToSeminarListItem(item1, '2026-08-24');
  assert.strictEqual(converted1.seminarId, '5565');
  assert.strictEqual(converted1.name, '눈에서 시작하는 심혈관 위험 평가와 AI의 미래');
  assert.strictEqual(converted1.url, 'https://m.doctorville.co.kr/cme/seminar/5565');
  assert.strictEqual(converted1.date, '2026-08-24');
  assert.strictEqual(converted1.time, '13:00~14:00');
  assert.strictEqual(converted1.currentCount, '1234');
  assert.strictEqual(converted1.totalCount, '5000');
  assert.strictEqual(converted1.nightTime, false);
  assert.strictEqual(converted1.isAdvancedSurvey, true);
  assert.strictEqual(converted1.processState, 2);
  assert.strictEqual(converted1.cancelProcessState, -1);
  assert.strictEqual(converted1.seminarCompleted, 0);

  const raw1 = convertApiItemToRawSeminar(item1);
  assert.strictEqual(raw1.hasIcoApply, true);
  assert.strictEqual(raw1.processState, 2);
  console.log('  ✓ [Pass] Case 1: 점심 세미나 변환 (심화설문, processState=2 -> hasIcoApply=true)');

  // Case 2: 저녁 세미나(17:00), 포인트 미지급(survey: null), 일반설문
  const item2: FutureSeminarApiItem = {
    seminarId: 5538,
    seminarNm: '입시를 몰라도 자녀와 대화가 통하게 되는 50분',
    startDt: '2026-08-24 17:00:00',
    endDt: '2026-08-24 17:50:00',
    maxPeopleCnt: 3000,
    applyCnt: 2900,
    useSurvey: 'Y',
    useDepthSurvey: 'N',
    survey: null,
  };

  const dt2 = parseSeminarDateTime(item2.startDt, item2.endDt);
  assert.strictEqual(dt2.date, '2026-08-24');
  assert.strictEqual(dt2.time, '17:00~17:50');
  assert.strictEqual(dt2.nightTime, true);
  assert.strictEqual(checkIsAdvancedSurvey(item2.useDepthSurvey), false);
  assert.strictEqual(checkIsPointExcluded(item2.survey), true);

  const converted2 = convertApiItemToSeminarListItem(item2, '2026-08-24');
  assert.strictEqual(converted2.seminarId, '5538');
  assert.strictEqual(converted2.nightTime, true);
  assert.strictEqual(converted2.isAdvancedSurvey, false);
  console.log('  ✓ [Pass] Case 2: 저녁 세미나 변환 (일반설문)');

  // Case 3: survey.point가 0인 경우 포인트 미지급 판별
  const item3: FutureSeminarApiItem = {
    seminarId: 5539,
    seminarNm: '포인트 0원 세미나',
    startDt: '2026-08-24 19:00:00',
    useDepthSurvey: false,
    survey: {
      point: 0,
    },
  };
  assert.strictEqual(checkIsPointExcluded(item3.survey), true);
  console.log('  ✓ [Pass] Case 3: point: 0 일 때 포인트 미지급 판별');

  // Case 4: ISO T 포맷 및 boolean useDepthSurvey
  const item4: FutureSeminarApiItem = {
    seminarId: 5540,
    seminarNm: 'ISO 일시 포맷 세미나',
    startDt: '2026-08-25T20:00:00',
    endDt: '2026-08-25T21:30:00',
    useDepthSurvey: true,
    survey: {
      point: '500',
    },
  };
  const dt4 = parseSeminarDateTime(item4.startDt, item4.endDt);
  assert.strictEqual(dt4.date, '2026-08-25');
  assert.strictEqual(dt4.time, '20:00~21:30');
  assert.strictEqual(dt4.nightTime, true);
  assert.strictEqual(checkIsAdvancedSurvey(item4.useDepthSurvey), true);
  assert.strictEqual(checkIsPointExcluded(item4.survey), false);
  console.log('  ✓ [Pass] Case 4: ISO-T 포맷 및 boolean 심화설문 판별');

  // Case 5: RawSeminarData 변환 테스트
  const raw = convertApiItemToRawSeminar(item1);
  assert.strictEqual(raw.name, '눈에서 시작하는 심혈관 위험 평가와 AI의 미래');
  assert.strictEqual(raw.url, 'https://m.doctorville.co.kr/cme/seminar/5565');
  assert.strictEqual(raw.date, '2026-08-24');
  assert.strictEqual(raw.time, '13:00~14:00');
  assert.strictEqual(raw.currentCount, '1234');
  assert.strictEqual(raw.totalCount, '5000');
  assert.strictEqual(raw.nightTime, false);
  assert.strictEqual(raw.isAdvancedSurvey, true);
  console.log('  ✓ [Pass] Case 5: RawSeminarData 변환 테스트');

  // Case 6: API 아이템들로부터 refreshStoredSeminarList 연계 테스트
  const apiItems: FutureSeminarApiItem[] = [item1, item2, item4];
  const referenceDate = '2026-08-24';
  const currentList: SeminarListItem[] = apiItems.map((item) => convertApiItemToSeminarListItem(item, referenceDate));

  const existingList: SeminarListItem[] = [
    {
      seminarId: '5565',
      name: '기존 이름',
      url: 'https://m.doctorville.co.kr/cme/seminar/5565',
      date: '2026-08-24',
      time: '13:00~14:00',
      currentCount: '1000',
      totalCount: '5000',
      nightTime: false,
      isPointExcluded: false,
      isAdvancedSurvey: false,
    },
  ];

  const { seminars, newlyAdded, infoChanges } = refreshStoredSeminarList(currentList, existingList, referenceDate);

  assert.strictEqual(seminars.length, 3);
  assert.strictEqual(newlyAdded.length, 2);
  assert.strictEqual(infoChanges.length, 1);
  assert.strictEqual(infoChanges[0].seminarId, '5565');
  // name 변경 및 isAdvancedSurvey 변경 감지
  const nameChange = infoChanges[0].changes.find((c) => c.field === 'name');
  const advChange = infoChanges[0].changes.find((c) => c.field === 'isAdvancedSurvey');
  assert.ok(nameChange);
  assert.ok(advChange);
  console.log('  ✓ [Pass] Case 6: API 기반 SeminarListItem 목록과 refreshStoredSeminarList 연동 검증');

  // Case 7: fetchSeminarDetail 모킹 테스트 - 포인트 지급 세미나
  const originalHttpGet = httpClientModule.httpGet;
  (httpClientModule as unknown as { httpGet: unknown }).httpGet = async (url: string) => {
    if (url.includes('/5587')) {
      return {
        status: 200,
        statusText: '200',
        headers: {},
        body: JSON.stringify({
          surveyState: 2,
          seminarDetail: {
            seminarId: 5587,
            seminarNm: '전공의를 위한 응급실 증례강의',
            survey: {
              surveyId: 3383,
              point: 1000,
            },
          },
        }),
        url,
        redirected: false,
        resultType: 'SUCCESS' as const,
      };
    } else if (url.includes('/5576')) {
      return {
        status: 200,
        statusText: '200',
        headers: {},
        body: JSON.stringify({
          surveyState: 5,
          seminarDetail: {
            seminarId: 5576,
            seminarNm: '오피스요가',
            survey: null,
          },
        }),
        url,
        redirected: false,
        resultType: 'SUCCESS' as const,
      };
    }
    return {
      status: 404,
      statusText: '404',
      headers: {},
      body: '',
      url,
      redirected: false,
      resultType: 'HTTP_ERROR' as const,
    };
  };

  const detail5587 = await fetchSeminarDetail(5587);
  assert.strictEqual(detail5587.success, true);
  assert.strictEqual(detail5587.isPointExcluded, false);
  assert.strictEqual(detail5587.survey?.point, 1000);
  assert.strictEqual(detail5587.surveyState, 2);
  console.log('  ✓ [Pass] Case 7: fetchSeminarDetail - 포인트 1000P 지급 및 surveyState=2 세미나 판정');

  const detail5576 = await fetchSeminarDetail(5576);
  assert.strictEqual(detail5576.success, true);
  assert.strictEqual(detail5576.isPointExcluded, true);
  assert.strictEqual(detail5576.surveyState, 5);
  console.log('  ✓ [Pass] Case 8: fetchSeminarDetail - survey: null 및 surveyState=5 판정');

  // Case 9: checkHasEntryHistory 및 fetchSeminarDetail 입장이력 판별 테스트
  const memberWithJoinDt = { joinDt: '2026-08-24 13:05:00.0', applyTy: 0 };
  const memberWithApplyTy = { joinDt: null, applyTy: 1 };
  const memberNoEntry = { joinDt: null, applyTy: 0 };
  assert.strictEqual(checkHasEntryHistory({ seminarMember: memberWithJoinDt }), true);
  assert.strictEqual(checkHasEntryHistory({ seminarMember: memberWithApplyTy }), true);
  assert.strictEqual(checkHasEntryHistory({ seminarMember: memberNoEntry }), false);
  assert.strictEqual(checkHasEntryHistory(null, null), false);

  (httpClientModule as unknown as { httpGet: unknown }).httpGet = async (url: string) => {
    if (url.includes('/5599')) {
      return {
        status: 200,
        statusText: '200',
        headers: {},
        body: JSON.stringify({
          surveyState: 5,
          seminarDetail: {
            seminarId: 5599,
            seminarNm: '입장이력 있는 세미나',
            survey: { point: 1000 },
            seminarMember: {
              joinDt: '2026-08-24 13:01:23.0',
              applyTy: 1,
            },
          },
        }),
        url,
        redirected: false,
        resultType: 'SUCCESS' as const,
      };
    }
    return {
      status: 404,
      statusText: '404',
      headers: {},
      body: '',
      url,
      redirected: false,
      resultType: 'HTTP_ERROR' as const,
    };
  };

  const detail5599 = await fetchSeminarDetail(5599);
  assert.strictEqual(detail5599.success, true);
  assert.strictEqual(detail5599.hasEntryHistory, true);
  console.log('  ✓ [Pass] Case 9: checkHasEntryHistory 및 fetchSeminarDetail 입장이력(hasEntryHistory) 판정');

  (httpClientModule as unknown as { httpGet: unknown }).httpGet = originalHttpGet;

  console.log('\n🎉 모든 seminar_api 단위 테스트 통과!');
}

testSeminarApiConversion().catch((err) => {
  console.error('테스트 실패:', err);
  process.exit(1);
});
