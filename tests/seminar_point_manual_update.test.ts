import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as seminarRepo from '../src/services/seminar_repository';
import { parseSeminarPointArgs, createSeminarPointHandler } from '../src/services/telegram/seminar_point_handler';
import { syncSeminarPointResultToDb } from '../src/tasks/check_seminar_point';
import type { Context } from 'telegraf';

describe('세미나 포인트 수동 갱신 및 동기화 테스트', () => {
  const mockSeminars = [
    {
      seminarId: '9901',
      name: '테스트 세미나 1',
      url: 'https://m.doctorville.co.kr/cme/seminar/9901',
      date: '2026-09-10',
      time: '13:00~14:00',
      currentCount: '10',
      totalCount: '1000',
      nightTime: false,
      isAdvancedSurvey: false,
      pointPaid: false,
    },
    {
      seminarId: '9902',
      name: '테스트 세미나 2 (이미 지급됨)',
      url: 'https://m.doctorville.co.kr/cme/seminar/9902',
      date: '2026-09-11',
      time: '19:00~20:00',
      currentCount: '50',
      totalCount: '500',
      nightTime: true,
      isAdvancedSurvey: true,
      pointPaid: true,
      point: 3000,
      pointText: '3,000P',
      pointDate: '2026-09-11',
      pointContent: '기존 설문 포인트',
    },
  ];

  beforeEach(() => {
    seminarRepo.clearSeminars();
    seminarRepo.upsertSeminars(mockSeminars);
  });

  describe('seminar_repository: updateSeminarPointStatus', () => {
    it('미지급 세미나를 지급 완료 상태로 갱신해야 한다', async () => {
      const updated = await seminarRepo.updateSeminarPointStatus('9901', {
        pointPaid: true,
        point: 3000,
        pointText: '3,000P',
        pointDate: '2026-09-11',
        pointContent: '관리자 수동 지급',
      });

      expect(updated.pointPaid).toBe(true);
      expect(updated.point).toBe(3000);
      expect(updated.pointText).toBe('3,000P');
      expect(updated.pointDate).toBe('2026-09-11');
      expect(updated.pointContent).toBe('관리자 수동 지급');

      const reloaded = seminarRepo.getSeminarById('9901');
      expect(reloaded?.pointPaid).toBe(true);
      expect(reloaded?.point).toBe(3000);
    });

    it('지급 완료된 세미나를 명시적으로 미지급(unpaid)으로 강제 갱신할 수 있어야 한다', async () => {
      const updated = await seminarRepo.updateSeminarPointStatus('9902', {
        pointPaid: false,
      });

      expect(updated.pointPaid).toBe(false);
      expect(updated.point).toBeUndefined();
      expect(updated.pointText).toBeUndefined();
      expect(updated.pointDate).toBeUndefined();
      expect(updated.pointContent).toBeUndefined();

      const reloaded = seminarRepo.getSeminarById('9902');
      expect(reloaded?.pointPaid).toBe(false);
      expect(reloaded?.point).toBeUndefined();
    });

    it('DB에 존재하지 않는 세미나 ID인 경우 initialData를 바탕으로 신규 레코드를 생성해야 한다', async () => {
      const updated = await seminarRepo.updateSeminarPointStatus('9999', {
        pointPaid: true,
        point: 5000,
        pointText: '5,000P',
        initialData: {
          name: '신규 외부 세미나',
          date: '2026-09-15',
        },
      });

      expect(updated.seminarId).toBe('9999');
      expect(updated.pointPaid).toBe(true);
      expect(updated.point).toBe(5000);
      expect(updated.name).toBe('신규 외부 세미나');

      const reloaded = seminarRepo.getSeminarById('9999');
      expect(reloaded?.name).toBe('신규 외부 세미나');
      expect(reloaded?.pointPaid).toBe(true);
    });

    it('DB에 세미나가 존재하지 않고 initialData가 없을 때 seminar detail API로 자동 enrich되어야 한다', async () => {
      const seminarApi = await import('../src/modules/seminar_api');
      const spy = vi.spyOn(seminarApi, 'fetchSeminarDetail').mockResolvedValueOnce({
        success: true,
        rawResponse: {
          seminarDetail: {
            seminarId: 8888,
            seminarNm: '상세API로 자동 조회된 세미나',
            startDt: '2026-09-25 19:30:00',
            endDt: '2026-09-25 20:30:00',
            useDepthSurvey: 'Y',
            applyCnt: 42,
            maxPeopleCnt: 500,
          },
        },
      } as unknown as Awaited<ReturnType<typeof seminarApi.fetchSeminarDetail>>);

      const updated = await seminarRepo.updateSeminarPointStatus('8888', {
        pointPaid: true,
        point: 3000,
      });

      expect(spy).toHaveBeenCalledWith('8888');
      expect(updated.seminarId).toBe('8888');
      expect(updated.name).toBe('상세API로 자동 조회된 세미나');
      expect(updated.date).toBe('2026-09-25');
      expect(updated.time).toBe('19:30~20:30');
      expect(updated.isAdvancedSurvey).toBe(true);
      expect(updated.currentCount).toBe('42');
      expect(updated.pointPaid).toBe(true);
      expect(updated.point).toBe(3000);

      const inDb = seminarRepo.getSeminarById('8888');
      expect(inDb?.name).toBe('상세API로 자동 조회된 세미나');
      expect(inDb?.pointPaid).toBe(true);
      expect(inDb?.isAdvancedSurvey).toBe(true);

      spy.mockRestore();
    });
  });

  describe('seminar_enrichment 헬퍼 모듈 테스트', () => {
    it('enrichSeminarFromDetail이 세미나 상세 정보를 정상 파싱하여 반환해야 한다', async () => {
      const { enrichSeminarFromDetail } = await import('../src/services/seminar_enrichment');
      const seminarApi = await import('../src/modules/seminar_api');
      const spy = vi.spyOn(seminarApi, 'fetchSeminarDetail').mockResolvedValueOnce({
        success: true,
        rawResponse: {
          seminarDetail: {
            seminarId: 7777,
            seminarNm: '헬퍼 테스트 세미나',
            startDt: '2026-09-30 14:00:00',
            endDt: '2026-09-30 15:00:00',
            useDepthSurvey: 'N',
            applyCnt: 10,
            maxPeopleCnt: 100,
            intro: '포인트가 지급되지 않는 세미나입니다',
          },
        },
        isPointExcluded: true,
      } as unknown as Awaited<ReturnType<typeof seminarApi.fetchSeminarDetail>>);

      const res = await enrichSeminarFromDetail('7777');
      expect(res.name).toBe('헬퍼 테스트 세미나');
      expect(res.date).toBe('2026-09-30');
      expect(res.time).toBe('14:00~15:00');
      expect(res.isPointExcluded).toBe(true);
      expect(res.isAdvancedSurvey).toBe(false);

      spy.mockRestore();
    });

    it('getOrEnrichSeminar는 DB에 세미나가 있으면 그대로 반환하고 없으면 API로 채워 DB에 upsert해야 한다', async () => {
      const { getOrEnrichSeminar } = await import('../src/services/seminar_enrichment');
      const seminarApi = await import('../src/modules/seminar_api');

      // 1. 이미 DB에 존재하는 9901
      const existing = await getOrEnrichSeminar('9901');
      expect(existing?.seminarId).toBe('9901');
      expect(existing?.name).toBe('테스트 세미나 1');

      // 2. DB에 없는 7778
      const spy = vi.spyOn(seminarApi, 'fetchSeminarDetail').mockResolvedValueOnce({
        success: true,
        rawResponse: {
          seminarDetail: {
            seminarId: 7778,
            seminarNm: 'DB 신규 등록 세미나',
            startDt: '2026-10-01 10:00:00',
            endDt: '2026-10-01 11:00:00',
          },
        },
      } as unknown as Awaited<ReturnType<typeof seminarApi.fetchSeminarDetail>>);

      const created = await getOrEnrichSeminar('7778');
      expect(created?.seminarId).toBe('7778');
      expect(created?.name).toBe('DB 신규 등록 세미나');

      const inDb = seminarRepo.getSeminarById('7778');
      expect(inDb?.name).toBe('DB 신규 등록 세미나');

      spy.mockRestore();
    });
  });

  describe('seminar_point_handler: parseSeminarPointArgs', () => {
    it('상태를 생략하면 기본값으로 paid=true가 되어야 한다', () => {
      const res1 = parseSeminarPointArgs('/set_seminar_point 5517');
      expect('error' in res1).toBe(false);
      if (!('error' in res1)) {
        expect(res1.seminarId).toBe('5517');
        expect(res1.pointPaid).toBe(true);
      }

      const res2 = parseSeminarPointArgs('/set_seminar_point 5517 3000');
      expect('error' in res2).toBe(false);
      if (!('error' in res2)) {
        expect(res2.seminarId).toBe('5517');
        expect(res2.pointPaid).toBe(true);
        expect(res2.point).toBe(3000);
      }

      const res3 = parseSeminarPointArgs('/set_seminar_point 5517 3,000P 8/14 설문 포인트');
      expect('error' in res3).toBe(false);
      if (!('error' in res3)) {
        expect(res3.seminarId).toBe('5517');
        expect(res3.pointPaid).toBe(true);
        expect(res3.point).toBe(3000);
        expect(res3.note).toBe('8/14 설문 포인트');
      }
    });

    it('명시적으로 unpaid, 미지급, false를 입력했을 때만 paid=false가 되어야 한다', () => {
      const resUnpaid = parseSeminarPointArgs('/set_seminar_point 5517 unpaid');
      expect('error' in resUnpaid).toBe(false);
      if (!('error' in resUnpaid)) {
        expect(resUnpaid.pointPaid).toBe(false);
      }

      const resKorean = parseSeminarPointArgs('/set_seminar_point 5517 미지급');
      expect('error' in resKorean).toBe(false);
      if (!('error' in resKorean)) {
        expect(resKorean.pointPaid).toBe(false);
      }

      const resFalse = parseSeminarPointArgs('/set_seminar_point 5517 false');
      expect('error' in resFalse).toBe(false);
      if (!('error' in resFalse)) {
        expect(resFalse.pointPaid).toBe(false);
      }
    });

    it('인자가 없거나 세미나 번호가 잘못된 경우 에러 메시지를 반환해야 한다', () => {
      const emptyRes = parseSeminarPointArgs('/set_seminar_point');
      expect('error' in emptyRes).toBe(true);

      const invalidIdRes = parseSeminarPointArgs('/set_seminar_point abc paid');
      expect('error' in invalidIdRes).toBe(true);
    });
  });

  describe('seminar_point_handler: createSeminarPointHandler', () => {
    it('텔레그램 명령어를 실행하여 세미나 포인트 상태를 정상 변경하고 응답해야 한다', async () => {
      const handler = createSeminarPointHandler();
      const replies: string[] = [];
      const ctx = {
        message: { text: '/set_seminar_point 9901 3000 수동지급완료' },
        from: { username: 'admin' },
        reply: async (msg: string) => {
          replies.push(msg);
        },
      } as unknown as Context;

      await handler(ctx);
      expect(replies.length).toBeGreaterThan(0);
      expect(replies[0]).toContain('세미나 [9901] 포인트 상태 수동 갱신 완료');
      expect(replies[0]).toContain('지급 완료 (3,000P)');

      const updated = seminarRepo.getSeminarById('9901');
      expect(updated?.pointPaid).toBe(true);
      expect(updated?.point).toBe(3000);
      expect(updated?.pointContent).toBe('수동지급완료');
    });

    it('unpaid 명령어로 미지급 처리하고 응답해야 한다', async () => {
      const handler = createSeminarPointHandler();
      const replies: string[] = [];
      const ctx = {
        message: { text: '/set_seminar_point 9902 unpaid' },
        from: { username: 'admin' },
        reply: async (msg: string) => {
          replies.push(msg);
        },
      } as unknown as Context;

      await handler(ctx);
      expect(replies.length).toBeGreaterThan(0);
      expect(replies[0]).toContain('미지급');

      const updated = seminarRepo.getSeminarById('9902');
      expect(updated?.pointPaid).toBe(false);
    });
  });

  describe('check_seminar_point: syncSeminarPointResultToDb', () => {
    it('적립 결과가 확인되면 DB의 세미나 포인트 정보를 갱신해야 한다', async () => {
      const pointResult = {
        found: true,
        type: '적립' as const,
        point: 3000,
        pointText: '3,000P',
        date: '2026-09-10',
        content: '설문 포인트 9901',
      };

      const syncRes = await syncSeminarPointResultToDb('9901', pointResult);
      expect(syncRes.updated).toBe(true);
      expect(syncRes.pointPaid).toBe(true);

      const updated = seminarRepo.getSeminarById('9901');
      expect(updated?.pointPaid).toBe(true);
      expect(updated?.point).toBe(3000);
      expect(updated?.pointText).toBe('3,000P');
      expect(updated?.pointContent).toBe('설문 포인트 9901');
    });

    it('미지급 결과인 경우 기존 pointPaid는 보존하고 pointCheckedAt만 갱신해야 한다', async () => {
      const pointResult = {
        found: false,
      };

      const before = seminarRepo.getSeminarById('9902');
      expect(before?.pointPaid).toBe(true);

      const syncRes = await syncSeminarPointResultToDb('9902', pointResult);
      expect(syncRes.updated).toBe(true);
      expect(syncRes.pointPaid).toBe(true);

      const after = seminarRepo.getSeminarById('9902');
      expect(after?.pointPaid).toBe(true);
      expect(after?.pointCheckedAt).toBeDefined();
    });
  });
});
