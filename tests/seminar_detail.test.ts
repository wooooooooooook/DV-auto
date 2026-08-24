import {
  formatStatus,
  formatSurveyStatus,
  formatMyParticipation,
  formatSeminarDetail,
  type SeminarDetail,
  type SeminarDetailResponse,
} from '../src/tasks/seminar_detail';
import { ProcessState, SurveyState } from '../src/modules/seminar_api';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

export async function runTests() {
  console.log('\n===========================================================');
  console.log('  seminar_detail 단위 테스트: 상태값 및 포맷팅 검증');
  console.log('===========================================================');

  // Case 1: 세미나 5574 (이미 끝난 세미나, 설문참여 완료, 입장완료)
  console.log('\n--- Case 1: 세미나 5574 (진행 완료, 설문 참여 완료) 검증 ---');
  const mock5574Detail: SeminarDetail = {
    seminarId: 5574,
    seminarTy: 1,
    seminarNm: '[재] ALL 4 ONE Symposium',
    regUsn: 0,
    startDt: '2026-08-21 17:00:00.0',
    endDt: '2026-08-21 18:30:00.0',
    maxPeopleCnt: 7000,
    intro: '소개',
    tutorId: 0,
    tutorNm: '강사명',
    surveyId: 3343,
    categoryCd: 1,
    createDt: '2026-08-18 12:10:43.0',
    updateDt: null,
    introImg: '',
    attachFileOrigin: '',
    viewCnt: 0,
    applyCnt: 6274,
    scrapId: null,
    userTy: 4,
    memberCreateDt: null,
    broadcastUrl: '',
    broadcastUrl2: '',
    broadcastTy: 10,
    broadcastTy2: 10,
    diseaseCategoryNm: '심혈관질환',
    diseaseCategoryCd: 'SI000',
    hiddenYn: 'N',
    allowUsn: null,
    chattingRoom: '23523395',
    payPoint: null,
    seminarVod: null,
    seminarVodReplay: null,
    seminarTutor: null,
    regUser: null,
    survey: {
      surveyId: 3343,
      surveyType: null,
      title: '',
      point: 1000,
      pointTy: null,
      pointPayDt: null,
      startDt: '2026-08-21 18:02:54.0',
      endDt: '2026-08-21 19:03:54.0',
      surveyResultImg: null,
      surveyQuizPass: null,
      hasQuiz: 1,
      infoAgreeUse: 1,
      infoReceiver: '(주)대웅제약',
      infoRange: '회원정보',
      infoPurpose: '마케팅',
      createDt: '2026-08-18 12:18:00.0',
      updateDt: null,
      availabiliTy: null,
      targetRangeList: null,
      surveyUrl: null,
      callbackParam: null,
      nowMemberCount: null,
      surveyTarget: null,
      usePick: null,
      useLimitUser: null,
      useEnterCount: null,
      pickStartDt: null,
      pickEndDt: null,
      validRangeStartDt: null,
      validRangeEndDt: null,
      itemCount: 0,
      limitUserCount: 0,
      limitEnterCount: 0,
      isMember: 0,
      surveyCode: null,
      seminarId: 5574,
      useTy: 1,
      encryptSurveyResultImg: '',
      surveyTypeNm: '',
      fromToFormat1: '',
      payDtFormat1: '',
      ablePick: false,
      surveyMinutesLeft: 0,
    },
    seminarMember: {
      app: null,
      method: null,
      api: null,
      smId: 14377073,
      seminarId: 5574,
      applyUsn: 2038400,
      applyTy: 1,
      shortUrl: null,
      fullUrl: null,
      createDt: '2026-08-18 12:20:12.0',
      joinDt: '2026-08-21 16:01:01.0',
      userTy: 4,
      surveyApplyTy: 1,
      surveyRewardPaid: null,
      surveyQuizPass: null,
      provideAgree: 0,
      surveyJoinDt: null,
      isAggree: null,
    },
    tag: null,
    regChk: 0,
    showFg: null,
    vodMarkerList: null,
    seminarCompleted: 1,
    useSurvey: 'Y',
    useDepthSurvey: 'Y',
    useVod: 'N',
    useVodNotify: 'N',
    keyMessage: '',
    encIntroImg: '',
    encAttachFilePath: '',
    categoryCdNm: '의료학술',
    processState: 8,
    cancelProcessState: -1,
    startMonthAndDay: '8/21',
    startDayOfWeek: 'Fri',
    endTime: '18:30',
    startTime: '17:00',
  };

  const mock5574Raw: SeminarDetailResponse = {
    seminarDetail: mock5574Detail,
    termsInfo: null,
    timeDiff: -235461000,
    isScraped: false,
    seminarNotifyMember: {} as any,
    accessAllowed: true,
    replyCnt: 0,
    seminarAggreeInfo: {} as any,
    surveyState: SurveyState.SURVEY_COMPLETED, // 2
    isExistVod: false,
  };

  const output5574 = formatSeminarDetail(mock5574Detail, mock5574Raw);
  assert(output5574.includes('*상태:* 진행 완료'), '5574 상태가 진행 완료여야 함');
  assert(
    output5574.includes('*내 참여:* 입장/시청 완료 (입장: 08-21 16:01), 설문완료'),
    '5574 내 참여 정보가 정확해야 함',
  );
  assert(output5574.includes('*설문:* 설문 참여 완료 (1,000P) [심화설문]'), '5574 설문 정보가 정확해야 함');
  assert(output5574.includes('*포인트:* 1,000P 지급'), '5574 포인트 정보가 정확해야 함');
  console.log('  ✓ [Pass] 5574 포맷팅 검증 성공');

  // Case 2: 세미나 5572 (4000/4000 신청마감, 진행 예정, 신청 완료 상태)
  console.log('\n--- Case 2: 세미나 5572 (진행 예정, 신청 완료) 검증 ---');
  const mock5572Detail: SeminarDetail = {
    seminarId: 5572,
    seminarTy: 1,
    seminarNm: '척수성 근위축증(SMA) 조기 진단과 전원',
    regUsn: 0,
    startDt: '2026-09-01 13:00:00.0',
    endDt: '2026-09-01 13:40:00.0',
    maxPeopleCnt: 4000,
    intro: '소개',
    tutorId: 0,
    tutorNm: '강사명',
    surveyId: null,
    categoryCd: 1,
    createDt: '2026-08-13 13:13:05.0',
    updateDt: null,
    introImg: '',
    attachFileOrigin: '',
    viewCnt: 0,
    applyCnt: 4000,
    scrapId: null,
    userTy: 4,
    memberCreateDt: null,
    broadcastUrl: '',
    broadcastUrl2: '',
    broadcastTy: 10,
    broadcastTy2: 10,
    diseaseCategoryNm: '신경질환',
    diseaseCategoryCd: 'SG000',
    hiddenYn: 'N',
    allowUsn: null,
    chattingRoom: '23873014',
    payPoint: null,
    seminarVod: null,
    seminarVodReplay: null,
    seminarTutor: null,
    regUser: null,
    survey: null,
    seminarMember: {
      app: null,
      method: null,
      api: null,
      smId: 14347720,
      seminarId: 5572,
      applyUsn: 2038400,
      applyTy: 0,
      shortUrl: null,
      fullUrl: null,
      createDt: '2026-08-13 13:20:07.0',
      joinDt: null as any,
      userTy: 4,
      surveyApplyTy: 0,
      surveyRewardPaid: null,
      surveyQuizPass: null,
      provideAgree: 0,
      surveyJoinDt: null,
      isAggree: null,
    },
    tag: null,
    regChk: 0,
    showFg: null,
    vodMarkerList: null,
    seminarCompleted: 0,
    useSurvey: 'N',
    useDepthSurvey: 'N',
    useVod: 'Y',
    useVodNotify: 'N',
    keyMessage: '',
    encIntroImg: '',
    encAttachFilePath: '',
    categoryCdNm: '의료학술',
    processState: 3, // PROCESS_CANCEL (신청완료)
    cancelProcessState: -1,
    startMonthAndDay: '9/1',
    startDayOfWeek: 'Tue',
    endTime: '13:40',
    startTime: '13:00',
  };

  const mock5572Raw: SeminarDetailResponse = {
    seminarDetail: mock5572Detail,
    termsInfo: null,
    timeDiff: 700547000,
    isScraped: false,
    seminarNotifyMember: {} as any,
    accessAllowed: true,
    replyCnt: 0,
    seminarAggreeInfo: {} as any,
    surveyState: SurveyState.SURVEY_UNOPENED, // 5
    isExistVod: false,
  };

  const output5572 = formatSeminarDetail(mock5572Detail, mock5572Raw);
  assert(output5572.includes('*인원:* 4000 / 4000'), '5572 정원 마감 인원 정보 확인');
  assert(output5572.includes('*상태:* 신청 완료 (진행 예정)'), '5572 상태가 신청 완료 (진행 예정)이어야 함');
  assert(
    output5572.includes('*내 참여:* 신청 완료 (신청: 08-13 13:20), 설문미참여'),
    '5572 내 참여 정보가 정확해야 함',
  );
  assert(output5572.includes('*설문:* 설문 없음'), '5572 설문 없음 확인');
  assert(output5572.includes('*포인트:* 미지급'), '5572 포인트 미지급 확인');
  console.log('  ✓ [Pass] 5572 포맷팅 검증 성공');

  // Case 3: ProcessState 매핑 함수 검증
  console.log('\n--- Case 3: ProcessState 매핑 검증 ---');
  assert(formatStatus(ProcessState.PROCESS_ENTER, 0) === '입장 가능 (LIVE)', 'PROCESS_ENTER 매핑');
  assert(formatStatus(ProcessState.PROCESS_APPLY, 0) === '신청 가능', 'PROCESS_APPLY 매핑');
  assert(formatStatus(ProcessState.PROCESS_CANCEL, 0) === '신청 완료 (진행 예정)', 'PROCESS_CANCEL 매핑');
  assert(formatStatus(ProcessState.PROCESS_PREPARING, 0) === '방송 준비 중', 'PROCESS_PREPARING 매핑');
  assert(formatStatus(ProcessState.PROCESS_EXCESS, 0) === '신청 마감 (정원 초과)', 'PROCESS_EXCESS 매핑');
  assert(formatStatus(ProcessState.PROCESS_STARTED, 0) === '방송 진행 중 (OnAir)', 'PROCESS_STARTED 매핑');
  assert(formatStatus(ProcessState.PROCESS_END, 0) === '방송 종료', 'PROCESS_END 매핑');
  assert(formatStatus(ProcessState.PROCESS_COMPLETED, 0) === '진행 완료', 'PROCESS_COMPLETED 매핑');
  assert(formatStatus(3, 1) === '진행 완료', 'seminarCompleted=1이면 진행 완료');
  console.log('  ✓ [Pass] 모든 ProcessState 매핑 검증 성공');

  // Case 4: SurveyState 매핑 함수 검증
  console.log('\n--- Case 4: SurveyState 매핑 검증 ---');
  assert(
    formatSurveyStatus('Y', SurveyState.SURVEY_PROGRESS, { point: 1000 } as any, 0) ===
      '설문 진행 중 (참여 가능) (1,000P)',
    'SURVEY_PROGRESS 매핑',
  );
  assert(
    formatSurveyStatus('Y', SurveyState.SURVEY_COMPLETED, { point: 1000 } as any, 1) === '설문 참여 완료 (1,000P)',
    'SURVEY_COMPLETED 매핑',
  );
  assert(
    formatSurveyStatus('Y', SurveyState.SURVEY_CLOSED, { point: 1000 } as any, 0) === '설문 마감 / 미제공 (1,000P)',
    'SURVEY_CLOSED 매핑',
  );
  assert(
    formatSurveyStatus('Y', SurveyState.SURVEY_UNOPENED, { point: 1000 } as any, 0) ===
      '설문 미오픈 (진행 예정) (1,000P)',
    'SURVEY_UNOPENED 매핑',
  );
  assert(formatSurveyStatus('N', SurveyState.SURVEY_UNOPENED, null, 0) === '설문 없음', 'useSurvey=N 일 때 설문 없음');
  console.log('  ✓ [Pass] 모든 SurveyState 매핑 검증 성공');

  // Case 5: 내 참여 현황 매핑 검증
  console.log('\n--- Case 5: 내 참여 현황 매핑 검증 ---');
  assert(formatMyParticipation(null) === '미신청', 'null일 때 미신청');
  assert(
    formatMyParticipation({ applyTy: 0, surveyApplyTy: 0, createDt: '2026-08-24 10:00:00.0', joinDt: null } as any) ===
      '신청 완료 (신청: 08-24 10:00), 설문미참여',
    '사전신청 완료, 미입장',
  );
  assert(
    formatMyParticipation({
      applyTy: 1,
      surveyApplyTy: 1,
      createDt: '2026-08-24 10:00:00.0',
      joinDt: '2026-08-24 13:05:00.0',
    } as any) === '입장/시청 완료 (입장: 08-24 13:05), 설문완료',
    '입장완료 및 설문완료',
  );
  console.log('  ✓ [Pass] 내 참여 현황 매핑 검증 성공');

  console.log('\n🎉 모든 seminar_detail 단위 테스트 성공!\n');
}

if (require.main === module) {
  runTests().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
