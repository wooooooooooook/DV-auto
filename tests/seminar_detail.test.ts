/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  formatStatus,
  formatSurveyStatus,
  formatMyParticipation,
  formatSeminarDetail,
  formatStoredSeminarDetail,
  isForceRefresh,
  convertDetailToSeminarListItem,
  updateStoredSeminarFromDetail,
  extractSeminarIds,
  run,
  type SeminarDetail,
  type SeminarDetailResponse,
} from '../src/tasks/seminar_detail';
import { ProcessState, SurveyState } from '../src/modules/seminar_api';
import * as seminarRepo from '../src/services/seminar_repository';
import type { SeminarListItem } from '../src/tasks/apply_seminar';
import * as httpClient from '../src/modules/http_client';
import { createSeminarDetailHandler } from '../src/services/telegram';
import type { Context } from 'telegraf';
import { describe, it, vi } from 'vitest';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new Error(`Assertion failed: ${msg}`);
  }
}

describe('seminar_detail 단위 테스트', () => {
  it('상태값 및 포맷팅 검증', async () => {
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
      intro: '해당 라이브세미나는 설문 포인트가 지급되지 않는 세미나 입니다.',
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
    assert(
      formatSurveyStatus('N', SurveyState.SURVEY_UNOPENED, null, 0) === '설문 없음',
      'useSurvey=N 일 때 설문 없음',
    );
    console.log('  ✓ [Pass] 모든 SurveyState 매핑 검증 성공');

    // Case 5: 내 참여 현황 매핑 검증
    console.log('\n--- Case 5: 내 참여 현황 매핑 검증 ---');
    assert(formatMyParticipation(null) === '미신청', 'null일 때 미신청');
    assert(
      formatMyParticipation({
        applyTy: 0,
        surveyApplyTy: 0,
        createDt: '2026-08-24 10:00:00.0',
        joinDt: null,
      } as any) === '신청 완료 (신청: 08-24 10:00), 설문미참여',
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

    // Case 6: convertDetailToSeminarListItem 변환 검증
    console.log('\n--- Case 6: convertDetailToSeminarListItem 변환 검증 ---');
    const converted5574 = convertDetailToSeminarListItem(mock5574Detail, mock5574Raw);
    assert(converted5574.seminarId === '5574', '5574 seminarId 일치');
    assert(converted5574.name === '[재] ALL 4 ONE Symposium', '5574 name 일치');
    assert(converted5574.date === '2026-08-21', '5574 date 일치');
    assert(converted5574.time === '17:00~18:30', '5574 time 일치');
    assert(converted5574.nightTime === true, '5574 17시는 nightTime=true');
    assert(converted5574.isAdvancedSurvey === true, '5574 useDepthSurvey=Y 심화설문');
    assert(converted5574.isPointExcluded === false, '5574 point 1000P 지급 세미나');
    assert(converted5574.processState === 8, '5574 processState=8');
    assert(converted5574.seminarCompleted === 1, '5574 seminarCompleted=1');
    assert(converted5574.currentCount === '6274', '5574 currentCount 일치');
    assert(converted5574.totalCount === '7000', '5574 totalCount 일치');
    assert(converted5574.detectedDate === '2026-08-18', '5574 createDt 기준 detectedDate');
    // hiddenYn=N → isClosed=false
    assert(converted5574.isClosed === false, '5574 hiddenYn=N → isClosed=false');
    assert(converted5574.hiddenYn === 'N', '5574 hiddenYn 필드 보존');
    assert(converted5574.diseaseCategoryNm === '심혈관질환', '5574 diseaseCategoryNm 변환');

    const converted5572 = convertDetailToSeminarListItem(mock5572Detail, mock5572Raw);
    assert(converted5572.seminarId === '5572', '5572 seminarId 일치');
    assert(converted5572.date === '2026-09-01', '5572 date 일치');
    assert(converted5572.time === '13:00~13:40', '5572 time 일치');
    assert(converted5572.nightTime === false, '5572 13시는 nightTime=false');
    assert(converted5572.isPointExcluded === true, '5572 survey 없음 (포인트 미지급)');
    assert(converted5572.processState === 3, '5572 processState=3 (신청완료)');
    // hiddenYn=N → isClosed=false
    assert(converted5572.isClosed === false, '5572 hiddenYn=N → isClosed=false');
    assert(converted5572.diseaseCategoryNm === '신경질환', '5572 diseaseCategoryNm 변환');

    // hiddenYn=Y 비공개 세미나 변환 검증
    const mockPrivateDetail: SeminarDetail = {
      ...mock5574Detail,
      seminarId: 9900,
      seminarNm: '내과 전용 비공개 세미나',
      hiddenYn: 'Y',
      diseaseCategoryNm: '내분비질환',
    };
    const convertedPrivate = convertDetailToSeminarListItem(mockPrivateDetail);
    assert(convertedPrivate.isClosed === true, '비공개 세미나: hiddenYn=Y → isClosed=true');
    assert(convertedPrivate.hiddenYn === 'Y', '비공개 세미나: hiddenYn 필드 보존');
    assert(convertedPrivate.diseaseCategoryNm === '내분비질환', '비공개 세미나: diseaseCategoryNm 변환');
    console.log('  ✓ [Pass] convertDetailToSeminarListItem 변환 검증 성공');

    // Case 7: updateStoredSeminarFromDetail 신규 세미나 추가 검증
    console.log('\n--- Case 7: updateStoredSeminarFromDetail 신규 세미나 추가 검증 ---');
    const backupList = seminarRepo.getAllSeminars();
    try {
      seminarRepo.clearSeminars(); // 초기화
      const updated1 = updateStoredSeminarFromDetail(mock5574Detail, mock5574Raw);
      assert(updated1.length === 1, '리스트에 1개 추가됨');
      assert(updated1[0].seminarId === '5574', '추가된 세미나 ID 5574');
      assert(updated1[0].name === '[재] ALL 4 ONE Symposium', '추가된 세미나 명 일치');

      const updated2 = updateStoredSeminarFromDetail(mock5572Detail, mock5572Raw);
      assert(updated2.length === 2, '리스트에 2개 추가됨');
      assert(
        updated2.some((s) => s.seminarId === '5572'),
        '추가된 세미나 ID 5572',
      );
      console.log('  ✓ [Pass] updateStoredSeminarFromDetail 신규 세미나 추가 검증 성공');

      // Case 8: updateStoredSeminarFromDetail 기존 세미나 정보 갱신 및 포인트 상태 보존 검증
      console.log('\n--- Case 8: updateStoredSeminarFromDetail 기존 세미나 merge 검증 ---');
      // 세미나 5574에 이미 포인트 지급 완료 정보가 있는 상태로 설정
      seminarRepo.setAllSeminars([
        {
          seminarId: '5574',
          name: '구 세미나명',
          url: 'https://m.doctorville.co.kr/cme/seminar/5574',
          date: '2026-08-21',
          time: '17:00~18:30',
          currentCount: '1000',
          totalCount: '7000',
          nightTime: true,
          isAdvancedSurvey: false,
          pointPaid: true,
          point: 1000,
          pointText: '1,000P',
          pointDate: '2026-08-21',
          pointCheckedAt: '2026-08-21T18:30:00Z',
          detectedDate: '2026-08-15',
          detectedAt: '2026-08-15T00:00:00Z',
        },
      ]);

      const merged = updateStoredSeminarFromDetail(mock5574Detail, mock5574Raw);
      assert(merged.length === 1, '동일 ID 세미나는 병합되어 1개 유지');
      const item = merged[0];
      assert(item.name === '[재] ALL 4 ONE Symposium', '최신 이름으로 갱신');
      assert(item.currentCount === '6274', '최신 신청자 수(6274)로 갱신');
      assert(item.isAdvancedSurvey === true, '최신 심화설문 여부(true)로 갱신');
      assert(item.pointPaid === true, '기존 포인트 지급 상태(true) 보존');
      assert(item.point === 1000, '기존 포인트 금액(1000) 보존');
      assert(item.detectedDate === '2026-08-15', '기존 detectedDate 보존');
      assert(item.detectedAt === '2026-08-15T00:00:00Z', '기존 detectedAt 보존');
      console.log('  ✓ [Pass] updateStoredSeminarFromDetail 기존 세미나 merge 검증 성공');

      // Case 9: run() 실행 시 리스트 자동 업데이트 통합 검증
      console.log('\n--- Case 9: run() 실행 시 리스트 자동 업데이트 통합 검증 ---');
      seminarRepo.clearSeminars();
      const httpGetJsonSpy = vi.spyOn(httpClient, 'httpGetJson').mockImplementation(async (url: string) => {
        if (url.includes('5574')) {
          return mock5574Raw;
        }
        throw new Error('Not found');
      });

      const runResult = await run({ args: { seminarId: '5574' } });
      assert(runResult.success === true, 'run() 실행 성공');
      const listAfterRun = seminarRepo.getAllSeminars();
      assert(listAfterRun.length === 1, 'run() 실행 후 리스트에 1개 항목 등록됨');
      assert(listAfterRun[0].seminarId === '5574', '등록된 항목 ID가 5574여야 함');
      console.log('  ✓ [Pass] run() 실행 시 리스트 자동 업데이트 통합 검증 성공');

      // Case 10: extractSeminarIds 다양한 형식 파싱 검증
      console.log('\n--- Case 10: extractSeminarIds 다양한 형식 파싱 검증 ---');
      assert(extractSeminarIds('5566').join(',') === '5566', '단일 ID 파싱');
      assert(extractSeminarIds('5566 5567 5568').join(',') === '5566,5567,5568', '공백 구분 여러 ID 파싱');
      assert(extractSeminarIds('5566, 5567,5568').join(',') === '5566,5567,5568', '쉼표 구분 ID 파싱');
      assert(extractSeminarIds('/seminar_detail 5566 5567').join(',') === '5566,5567', '명령어 포함 문자열 파싱');
      assert(
        extractSeminarIds('8/12 5525\n8/13 5526 5527').join(',') === '5525,5526,5527',
        '줄바꿈 및 날짜 텍스트 포함 파싱',
      );
      assert(extractSeminarIds({ seminarId: '5566' }).join(',') === '5566', '객체 seminarId 파싱');
      assert(extractSeminarIds({ seminarIds: '5566, 5567' }).join(',') === '5566,5567', '객체 seminarIds 문자열 파싱');
      assert(
        extractSeminarIds({ seminarIds: ['5566', '5567'] }).join(',') === '5566,5567',
        '객체 seminarIds 배열 파싱',
      );
      assert(extractSeminarIds('5566 5566 5567').join(',') === '5566,5567', '중복 ID 제거 확인');
      console.log('  ✓ [Pass] extractSeminarIds 파싱 검증 성공');

      // Case 11: 복수 세미나 ID 조회 시 run() 실행 및 다중 세미나 리스트 업데이트 통합 검증
      console.log('\n--- Case 11: 복수 세미나 ID 조회 시 run() 통합 검증 ---');
      seminarRepo.clearSeminars();
      httpGetJsonSpy.mockImplementation(async (url: string) => {
        if (url.includes('5574')) return mock5574Raw;
        if (url.includes('5572')) return mock5572Raw;
        throw new Error('Not found');
      });

      const multiRunResult = await run({ args: { seminarIds: '5574 5572' } });
      assert(multiRunResult.success === true, '복수 조회 run() 성공');
      assert(Boolean(multiRunResult.messages && multiRunResult.messages.length === 2), '2개의 메시지 반환');
      assert(Boolean(multiRunResult.results && multiRunResult.results.length === 2), '2개의 결과 아이템 반환');
      assert(multiRunResult.results?.[0]?.seminarId === '5574', '첫번째 결과 5574');
      assert(multiRunResult.results?.[1]?.seminarId === '5572', '두번째 결과 5572');

      const listAfterMultiRun = seminarRepo.getAllSeminars();
      assert(listAfterMultiRun.length === 2, '복수 조회 후 리스트에 2개 항목 모두 등록됨');
      const idsInStorage = listAfterMultiRun.map((s) => s.seminarId).sort();
      assert(idsInStorage.join(',') === '5572,5574', '저장된 세미나 ID 목록 일치');
      console.log('  ✓ [Pass] 복수 세미나 ID 조회 시 run() 통합 검증 성공');

      // Case 12: preferStored = true 시 list에 저장된 값 우선 반환 검증 (API 호출 없음)
      console.log('\n--- Case 12: list 저장값 우선 반환 (API 미호출) 검증 ---');
      const mockStoredItem: SeminarListItem = {
        seminarId: '8888',
        name: '골다공증 치료 가이드라인',
        url: 'https://m.doctorville.co.kr/cme/seminar/8888',
        date: '2026-08-25',
        time: '13:00~14:00',
        currentCount: '250',
        totalCount: '500',
        nightTime: false,
        isAdvancedSurvey: true,
        isPointExcluded: false,
        processState: 2, // 신청 가능
        pointPaid: true,
        point: 3000,
        pointText: '3,000P',
      };
      seminarRepo.setAllSeminars([mockStoredItem]);

      let apiCalled = false;
      httpGetJsonSpy.mockImplementation(async () => {
        apiCalled = true;
        throw new Error('API should not be called when item exists in stored list');
      });

      const storedRunResult = await run({ args: { seminarId: '8888' } });
      assert(storedRunResult.success === true, '저장된 세미나 우선 반환 성공');
      assert(!apiCalled, '저장된 세미나 조회 시 API가 호출되지 않아야 함');
      assert(storedRunResult.message.includes('골다공증 치료 가이드라인'), '저장된 세미나명 포함');
      assert(storedRunResult.message.includes('3,000P 지급됨'), '포인트 지급 상태 포함');
      assert(storedRunResult.message.includes('심화설문'), '심화설문 정보 포함');
      console.log('  ✓ [Pass] list 저장값 우선 반환 및 API 미호출 검증 성공');

      // Case 13: formatStoredSeminarDetail 포맷팅 검증
      console.log('\n--- Case 13: formatStoredSeminarDetail 포맷팅 검증 ---');
      const formattedStored = formatStoredSeminarDetail(mockStoredItem);
      assert(formattedStored.includes('*세미나 상세* (ID: 8888)'), 'ID 헤더 포함');
      assert(formattedStored.includes('*제목:* 골다공증 치료 가이드라인'), '제목 포함');
      assert(formattedStored.includes('*일시:* 2026-08-25 13:00~14:00'), '일시 포함');
      assert(formattedStored.includes('*인원:* 250 / 500'), '인원 정보 포함');
      assert(formattedStored.includes('*상태:* 신청 가능'), '상태 매핑 확인');
      assert(formattedStored.includes('*포인트:* ✅ 3,000P 지급됨'), '포인트 상태 확인');
      // Case 14: force 옵션 및 isForceRefresh 검증
      console.log('\n--- Case 14: force 옵션 및 isForceRefresh 검증 ---');
      assert(isForceRefresh('5566 force') === true, 'force 문자열 감지');
      assert(isForceRefresh('5566 refresh') === true, 'refresh 문자열 감지');
      assert(isForceRefresh('5566 -f') === true, '-f 문자열 감지');
      assert(isForceRefresh('5566') === false, '일반 문자열은 false');

      let forceApiCalled: boolean = false;
      httpGetJsonSpy.mockImplementation(async (url: string) => {
        forceApiCalled = true;
        if (url.includes('8888')) {
          return {
            ...mock5574Raw,
            seminarDetail: {
              ...mock5574Detail,
              seminarId: 8888,
              seminarNm: '골다공증 최신 치료 (API 실시간 갱신)',
            },
          };
        }
        throw new Error('Not found');
      });

      const forceResult = await run('/seminar_detail 8888 force');
      assert(forceResult.success === true, 'force 실행 성공');
      assert(forceApiCalled, 'force 입력 시 API가 반드시 호출되어야 함');
      assert(forceResult.message.includes('API 실시간 갱신'), 'API에서 갱신된 세미나명 반영 확인');
      console.log('  ✓ [Pass] force 옵션으로 API 강제 호출 및 최신 정보 갱신 검증 성공');
      // Case 15: 신규 미래 세미나 (survey: null, useSurvey: 'Y', intro: 정상 소개) 포맷팅 및 변환 검증
      console.log('\n--- Case 15: 신규 미래 세미나 (survey: null, useSurvey: Y) 검증 ---');
      const mock5608Detail: SeminarDetail = {
        seminarId: 5608,
        seminarTy: 1,
        seminarNm: 'BEYOND Web Symposium',
        regUsn: 0,
        startDt: '2026-08-27 13:00:00.0',
        endDt: '2026-08-27 14:00:00.0',
        maxPeopleCnt: 3000,
        intro: 'BEYOND 심포지엄에 초대합니다.',
        tutorId: 0,
        tutorNm: '강사명',
        surveyId: null,
        categoryCd: 1,
        createDt: '2026-08-25 10:00:00.0',
        updateDt: null,
        introImg: '',
        attachFileOrigin: '',
        viewCnt: 0,
        applyCnt: 100,
        scrapId: null,
        userTy: 4,
        memberCreateDt: null,
        broadcastUrl: '',
        broadcastUrl2: '',
        broadcastTy: 10,
        broadcastTy2: 10,
        diseaseCategoryNm: '내과',
        diseaseCategoryCd: 'IM000',
        hiddenYn: 'N',
        allowUsn: null,
        chattingRoom: '23999999',
        payPoint: null,
        seminarVod: null,
        seminarVodReplay: null,
        seminarTutor: null,
        regUser: null,
        survey: null,
        seminarMember: null,
        tag: null,
        regChk: 0,
        showFg: null,
        vodMarkerList: null,
        seminarCompleted: 0,
        useSurvey: 'Y',
        useDepthSurvey: 'N',
        useVod: 'N',
        useVodNotify: 'N',
        keyMessage: '',
        encIntroImg: '',
        encAttachFilePath: '',
        categoryCdNm: '의료학술',
        processState: 2,
        cancelProcessState: -1,
        startMonthAndDay: '8/27',
        startDayOfWeek: 'Thu',
        endTime: '14:00',
        startTime: '13:00',
      };

      const listItem5608 = convertDetailToSeminarListItem(mock5608Detail);
      assert(listItem5608.isPointExcluded === false, '미래 세미나는 isPointExcluded가 false여야 함');

      const formatted5608 = formatSeminarDetail(mock5608Detail);
      assert(formatted5608.includes('*포인트:* 지급 대상'), 'survey.point가 없을 때 지급 대상으로 포맷팅');
      console.log('  ✓ [Pass] 신규 미래 세미나 isPointExcluded=false 및 포맷팅 검증 성공');

      // Case 16: 텔레그램 핸들러 - 관리자봇(alwaysRefresh=true)은 항상 실시간 API 호출, 공지봇(alwaysRefresh=false)은 캐시 우선 검증
      console.log('\n--- Case 16: 관리자봇 항상 실시간 조회 및 공지봇 캐시 우선 검증 ---');
      const mockAdminStoredItem: SeminarListItem = {
        seminarId: '8888',
        name: '저장소에 있던 구 세미나명 8888',
        url: 'https://m.doctorville.co.kr/cme/seminar/8888',
        date: '2026-08-25',
        time: '13:00~14:00',
        currentCount: '100',
        totalCount: '500',
        nightTime: false,
        isAdvancedSurvey: false,
      };
      const mockNoticeStoredItem: SeminarListItem = {
        seminarId: '9999',
        name: '공지봇 캐시 세미나 9999',
        url: 'https://m.doctorville.co.kr/cme/seminar/9999',
        date: '2026-08-26',
        time: '14:00~15:00',
        currentCount: '200',
        totalCount: '500',
        nightTime: false,
        isAdvancedSurvey: false,
      };
      seminarRepo.setAllSeminars([mockAdminStoredItem, mockNoticeStoredItem]);

      const adminApiState = { called: false };
      httpGetJsonSpy.mockImplementation(async (url: string) => {
        if (url.includes('8888')) {
          adminApiState.called = true;
          return {
            ...mock5574Raw,
            seminarDetail: {
              ...mock5574Detail,
              seminarId: 8888,
              seminarNm: '관리자 실시간 최신 세미나 정보 8888',
            },
          };
        }
        throw new Error('Not found');
      });

      try {
        // 16-1. 관리자봇 핸들러 실행 (저장소에 항목이 있어도 force 없이 항상 실시간 API 조회)
        const adminReplies: string[] = [];
        const adminCtx = {
          message: { text: '/seminar_detail 8888' },
          reply: async (msg: string) => {
            adminReplies.push(msg);
          },
        } as unknown as Context;

        const adminHandler = createSeminarDetailHandler({ alwaysRefresh: true, showRawMessages: true });
        await adminHandler(adminCtx);

        assert(adminApiState.called, '관리자봇은 force 키워드 없이도 항상 실시간 API를 호출해야 함');
        assert(
          adminReplies.some((msg) => msg.includes('관리자 실시간 최신 세미나 정보 8888')),
          '관리자봇 응답에 실시간 최신 데이터가 반영되어야 함',
        );
        assert(
          adminReplies.some((msg) => msg.includes('Raw API Response')),
          '관리자봇은 rawMessages(실시간 API 응답)를 수신해야 함',
        );
        console.log('  ✓ [Pass] 관리자봇 항상 새로 응답 및 Raw Response 전달 검증 성공');

        // 16-2. 공지봇 핸들러 실행 (저장된 데이터 우선 반환, API 미호출, Raw Response 미전송)
        const noticeApiState = { called: false };
        httpGetJsonSpy.mockImplementation(async () => {
          noticeApiState.called = true;
          throw new Error('공지봇은 저장된 목록이 있을 때 API를 호출하면 안 됨');
        });

        const noticeReplies: string[] = [];
        const noticeCtx = {
          message: { text: '/seminar_detail 9999' },
          reply: async (msg: string) => {
            noticeReplies.push(msg);
          },
        } as unknown as Context;

        const noticeHandler = createSeminarDetailHandler({ alwaysRefresh: false, showRawMessages: false });
        await noticeHandler(noticeCtx);

        assert(!noticeApiState.called, '공지봇은 저장된 목록이 있을 때 API를 호출하지 않아야 함');
        assert(
          noticeReplies.some((msg) => msg.includes('공지봇 캐시 세미나 9999')),
          '공지봇은 저장소의 세미나 데이터를 반환해야 함',
        );
        assert(
          !noticeReplies.some((msg) => msg.includes('Raw API Response')),
          '공지봇은 Raw Response를 전달하지 않아야 함',
        );
        console.log('  ✓ [Pass] 공지봇 캐시 우선 반환 및 Raw Response 제외 검증 성공');
      } finally {
        vi.restoreAllMocks();
      }
    } finally {
      seminarRepo.setAllSeminars(backupList);
    }

    console.log('\n🎉 모든 seminar_detail 단위 테스트 성공!\n');
  });
});
