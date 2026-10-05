import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HmpClient, type HmpAttendanceWorkflowResult } from '../src/modules/hmp_api';
import { formatHmpAttendanceMessage, run as runHmpAttendance } from '../src/tasks/hmp_attendance';

describe('HMP Attendance & Capsules Workflow Tests', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('출석 완료 및 캡슐 보유 현황 메시지 포맷팅 테스트 (성공 시)', () => {
    const mockResult: HmpAttendanceWorkflowResult = {
      success: true,
      userInfo: {
        memId: 'test_user',
        nick: '닥터홍',
        gradNm: '전공의',
        remanGradPnt: 120,
        capsules: 5010,
        chrPnt: 5010,
        usePnt: 0,
      },
      attendance: {
        status: 'SUCCESS',
        point: 10,
        message: '출석 캡슐 받기 완료 (+10 캡슐)',
      },
      loginCount: 5,
    };

    const formatted = formatHmpAttendanceMessage(mockResult);

    expect(formatted).toContain('💊 [HMP 출석체크 & 캡슐 현황]');
    expect(formatted).toContain('닥터홍 [전공의]');
    expect(formatted).toContain('✅ 출석 완료 (+10 캡슐) (당월 연속 출석: 5일)');
    expect(formatted).toContain('5,010 캡슐');
  });

  it('이미 오늘 출석한 경우 메시지 포맷팅 테스트', () => {
    const mockResult: HmpAttendanceWorkflowResult = {
      success: true,
      userInfo: {
        memId: 'test_user',
        nick: '김의사',
        gradNm: '인턴',
        capsules: 5010,
      },
      attendance: {
        status: 'ALREADY',
        message: '오늘 이미 출석 캡슐을 수령했습니다.',
      },
      loginCount: 1,
    };

    const formatted = formatHmpAttendanceMessage(mockResult);

    expect(formatted).toContain('ℹ️ 이미 오늘 출석 캡슐 수령 완료 (당월 연속 출석: 1일)');
    expect(formatted).toContain('5,010 캡슐');
  });

  it('출석체크 실패 시 에러 메시지 포맷팅 테스트', () => {
    const mockResult: HmpAttendanceWorkflowResult = {
      success: false,
      message: '네트워크 연결 오류',
      attendance: {
        status: 'FAILED',
        message: '네트워크 연결 오류',
      },
    };

    const formatted = formatHmpAttendanceMessage(mockResult);

    expect(formatted).toContain('❌ [HMP 출석체크 실패]');
    expect(formatted).toContain('네트워크 연결 오류');
  });

  it('HmpClient API 워크플로우 정상 실행 (성공 케이스 목 테스트)', async () => {
    const client = new HmpClient();

    // Mock login
    vi.spyOn(client, 'login').mockResolvedValue(true);

    // Mock getAttendanceInfo (미출석 상태)
    vi.spyOn(client, 'getAttendanceInfo').mockResolvedValue({
      cntntCd: '09',
      cntntSeq: '6712',
      pointTitle: '출석 체크 룰렛 이벤트',
      bizGbn: '009',
      loginCount: 3,
      isAlreadyAttended: false,
    });

    // Mock submitAttendance
    vi.spyOn(client, 'submitAttendance').mockResolvedValue({
      status: 'SUCCESS',
      point: 10,
      message: '출석 캡슐 받기 완료 (+10 캡슐)',
    });

    // Mock getUserInfo
    vi.spyOn(client, 'getUserInfo').mockResolvedValue({
      memId: 'nubiz',
      nick: 'woooook',
      gradNm: '인턴',
      capsules: 5010,
    });

    const result = await client.runAttendanceWorkflow('user', 'pass');

    expect(result.success).toBe(true);
    expect(result.attendance.status).toBe('SUCCESS');
    expect(result.attendance.point).toBe(10);
    expect(result.userInfo?.capsules).toBe(5010);
    expect(result.loginCount).toBe(3);
  });

  it('HmpClient API 워크플로우 이미 출석된 경우 (중복 요청 방지)', async () => {
    const client = new HmpClient();

    vi.spyOn(client, 'login').mockResolvedValue(true);

    // 이미 출석 완료 상태
    vi.spyOn(client, 'getAttendanceInfo').mockResolvedValue({
      cntntCd: '09',
      cntntSeq: '6712',
      pointTitle: '출석 체크 룰렛 이벤트',
      bizGbn: '009',
      loginCount: 3,
      isAlreadyAttended: true,
    });

    const submitSpy = vi.spyOn(client, 'submitAttendance');

    vi.spyOn(client, 'getUserInfo').mockResolvedValue({
      memId: 'nubiz',
      nick: 'woooook',
      gradNm: '인턴',
      capsules: 5010,
    });

    const result = await client.runAttendanceWorkflow('user', 'pass');

    expect(result.success).toBe(true);
    expect(result.attendance.status).toBe('ALREADY');
    expect(submitSpy).not.toHaveBeenCalled();
    expect(result.userInfo?.capsules).toBe(5010);
  });

  it('run 태스크 실행 시 정상 결과 반환 검증', async () => {
    vi.spyOn(HmpClient.prototype, 'runAttendanceWorkflow').mockResolvedValue({
      success: true,
      userInfo: {
        memId: 'test_user',
        nick: '테스터',
        gradNm: '전문의',
        capsules: 6000,
      },
      attendance: {
        status: 'SUCCESS',
        point: 10,
        message: '출석 캡슐 받기 완료 (+10 캡슐)',
      },
      loginCount: 10,
    });

    const taskResult = await runHmpAttendance();

    expect(taskResult.success).toBe(true);
    expect(taskResult.message).toContain('💊 [HMP 출석체크 & 캡슐 현황]');
    expect(taskResult.message).toContain('테스터 [전문의]');
  });

  it('룰렛 참여 결과가 포함된 경우 메시지 포맷팅 테스트 (캡슐 및 상품 당첨)', () => {
    const mockResult: HmpAttendanceWorkflowResult = {
      success: true,
      userInfo: {
        memId: 'doctor_kim',
        nick: '김선생',
        gradNm: '전공의',
        capsules: 5110,
      },
      attendance: {
        status: 'SUCCESS',
        point: 10,
        message: '출석 캡슐 받기 완료 (+10 캡슐)',
      },
      loginCount: 20,
      roulette: {
        attempted: true,
        spins: [
          {
            step: '1',
            stepDays: 10,
            success: true,
            winNum: '8',
            prizeName: '100 캡슐',
            prizeType: 'CAPSULE',
            point: 100,
          },
          {
            step: '2',
            stepDays: 20,
            success: true,
            winNum: '5',
            prizeName: '[스타벅스] 아이스 아메리카노 Tall',
            prizeType: 'PRODUCT',
            giftiShowSent: true,
          },
        ],
      },
    };

    const formatted = formatHmpAttendanceMessage(mockResult);

    expect(formatted).toContain('🎰 룰렛 결과:');
    expect(formatted).toContain('• 연속 10일 룰렛 당첨: 100 캡슐');
    expect(formatted).toContain('• 연속 20일 룰렛 당첨: [스타벅스] 아이스 아메리카노 Tall (기프티쇼 발송 완료)');
    expect(formatted).toContain('5,110 캡슐');
  });

  describe('룰렛 참여 가능 여부(getNextAvailableRouletteStep) 판별 테스트', () => {
    const client = new HmpClient();

    it('10일 미만 출석인 경우 룰렛 참여 불가', () => {
      const step = client.getNextAvailableRouletteStep({
        cntntCd: '09',
        cntntSeq: '6712',
        pointTitle: '출석 체크 룰렛 이벤트',
        bizGbn: '009',
        loginCount: 9,
        isAlreadyAttended: true,
      });
      expect(step).toBeNull();
    });

    it('10일 이상 출석이고 10일 룰렛 미참여 시 Step 1 반환', () => {
      const step = client.getNextAvailableRouletteStep({
        cntntCd: '09',
        cntntSeq: '6712',
        pointTitle: '출석 체크 룰렛 이벤트',
        bizGbn: '009',
        loginCount: 10,
        isAlreadyAttended: true,
        rouelette10: '',
      });
      expect(step).toEqual({ step: '1', days: 10 });
    });

    it('10일 룰렛 완료 상태에서 20일 미만이면 참여 불가', () => {
      const step = client.getNextAvailableRouletteStep({
        cntntCd: '09',
        cntntSeq: '6712',
        pointTitle: '출석 체크 룰렛 이벤트',
        bizGbn: '009',
        loginCount: 15,
        isAlreadyAttended: true,
        rouelette10: 'Y',
      });
      expect(step).toBeNull();
    });

    it('20일 이상 출석이고 10일 룰렛 완료, 20일 룰렛 미참여 시 Step 2 반환', () => {
      const step = client.getNextAvailableRouletteStep({
        cntntCd: '09',
        cntntSeq: '6712',
        pointTitle: '출석 체크 룰렛 이벤트',
        bizGbn: '009',
        loginCount: 20,
        isAlreadyAttended: true,
        rouelette10: 'Y',
        rouelette20: 'N',
      });
      expect(step).toEqual({ step: '2', days: 20 });
    });

    it('30일(만근) 출석이고 20일 룰렛 완료, 30일 룰렛 미참여 시 Step 3 반환', () => {
      const step = client.getNextAvailableRouletteStep({
        cntntCd: '09',
        cntntSeq: '6712',
        pointTitle: '출석 체크 룰렛 이벤트',
        bizGbn: '009',
        loginCount: 30,
        isAlreadyAttended: true,
        month: '09',
        rouelette10: 'Y',
        rouelette20: 'Y',
        rouelette30: '',
      });
      expect(step).toEqual({ step: '3', days: 30 });
    });

    it('2월인 경우 28일 출석으로 만근 Step 3 반환', () => {
      const step = client.getNextAvailableRouletteStep({
        cntntCd: '09',
        cntntSeq: '6712',
        pointTitle: '출석 체크 룰렛 이벤트',
        bizGbn: '009',
        loginCount: 28,
        isAlreadyAttended: true,
        month: '02',
        rouelette10: 'Y',
        rouelette20: 'Y',
        rouelette30: '',
      });
      expect(step).toEqual({ step: '3', days: 28 });
    });
  });

  describe('룰렛 실행 및 기프티쇼 연동 API 테스트', () => {
    it('spinRoulette 성공 응답 파싱 검증 (캡슐 당첨)', async () => {
      const client = new HmpClient();

      // Mock fetch for rouelettePercentage.hm
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ code: '800', winNum: '8' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const res = await client.spinRoulette('1', 'test_user', '6712');

      expect(res.success).toBe(true);
      expect(res.winNum).toBe('8');
      expect(res.prizeName).toBe('100 캡슐');
      expect(res.prizeType).toBe('CAPSULE');
      expect(res.point).toBe(100);
    });

    it('spinRoulette 성공 응답 파싱 검증 (기프티쇼 상품 당첨)', async () => {
      const client = new HmpClient();

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ code: '800', winNum: '5' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const res = await client.spinRoulette('2', 'test_user', '6712');

      expect(res.success).toBe(true);
      expect(res.winNum).toBe('5');
      expect(res.prizeName).toBe('[스타벅스] 아이스 아메리카노 Tall');
      expect(res.prizeType).toBe('PRODUCT');
    });

    it('sendRouletteProduct 기프티쇼 전송 성공 검증', async () => {
      const client = new HmpClient();

      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(JSON.stringify({ rtn_code: '0000', message: '전송완료' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const res = await client.sendRouletteProduct('2', '010-1234-5678');
      expect(res.success).toBe(true);
      expect(res.message).toBe('기프티쇼 전송 완료');
    });

    it('sendRouletteProduct 전화번호 길이 불일치 시 실패 반환', async () => {
      const client = new HmpClient();
      const res = await client.sendRouletteProduct('2', '010-123');
      expect(res.success).toBe(false);
      expect(res.message).toContain('전화번호 형식');
    });
  });

  describe('runAttendanceWorkflow 룰렛 통합 워크플로우 검증', () => {
    it('출석 후 10일 달성 상태이면 자동으로 룰렛을 돌리고 결과에 포함한다', async () => {
      const client = new HmpClient();

      vi.spyOn(client, 'login').mockResolvedValue(true);

      // 1회차: 미출석 상태
      vi.spyOn(client, 'getAttendanceInfo')
        .mockResolvedValueOnce({
          cntntCd: '09',
          cntntSeq: '6712',
          pointTitle: '출석 체크 룰렛 이벤트',
          bizGbn: '009',
          loginCount: 9,
          maxLoginCount: 9,
          isAlreadyAttended: false,
        })
        // 2회차 (출석 완료 후 재조회): 10일 달성 상태
        .mockResolvedValueOnce({
          cntntCd: '09',
          cntntSeq: '6712',
          pointTitle: '출석 체크 룰렛 이벤트',
          bizGbn: '009',
          loginCount: 10,
          maxLoginCount: 10,
          isAlreadyAttended: true,
          memId: 'user',
          rouelette10: '',
          phoneNo: '01012345678',
        });

      vi.spyOn(client, 'submitAttendance').mockResolvedValue({
        status: 'SUCCESS',
        point: 10,
        message: '출석 캡슐 받기 완료 (+10 캡슐)',
      });

      const spinSpy = vi.spyOn(client, 'spinRoulette').mockResolvedValue({
        step: '1',
        stepDays: 10,
        success: true,
        winNum: '8',
        prizeName: '100 캡슐',
        prizeType: 'CAPSULE',
        point: 100,
        message: '100 캡슐 당첨',
      });

      vi.spyOn(client, 'getUserInfo').mockResolvedValue({
        memId: 'nubiz',
        nick: 'woooook',
        gradNm: '인턴',
        capsules: 5110,
      });

      const result = await client.runAttendanceWorkflow('user', 'pass');

      expect(result.success).toBe(true);
      expect(result.attendance.status).toBe('SUCCESS');
      expect(spinSpy).toHaveBeenCalledWith('1', expect.anything(), '6712');
      expect(result.roulette?.attempted).toBe(true);
      expect(result.roulette?.spins).toHaveLength(1);
      expect(result.roulette?.spins[0].prizeName).toBe('100 캡슐');
    });
  });

  describe('fetch 타임아웃 및 재시도 정책', () => {
    it('읽기 요청(사용자 정보 조회)은 3초 타임아웃을 적용한다', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ knowCommUserInfo: { memId: 'user' } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await new HmpClient().getUserInfo();

      expect(timeoutSpy).toHaveBeenCalledWith(3_000);
    });

    it('상태 변경 요청(룰렛 회전)은 10초 타임아웃을 적용한다', async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ code: '800', winNum: '8' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await new HmpClient().spinRoulette('1', 'user', '6712');

      expect(timeoutSpy).toHaveBeenCalledWith(10_000);
    });

    it('모든 요청에 AbortSignal 이 붙는다', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ code: '800', winNum: '8' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      await new HmpClient().spinRoulette('1', 'user', '6712');

      const init = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('멱등 요청은 일시적 서버 오류(HTTP 500) 후 재시도하여 성공한다', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('', { status: 500 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ knowCommUserInfo: { memId: 'user' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

      const res = await new HmpClient().getUserInfo();

      expect(res.memId).toBe('user');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('멱등 요청은 네트워크 오류 후 재시도하여 성공한다', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ knowCommUserInfo: { memId: 'user' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

      const res = await new HmpClient().getUserInfo();

      expect(res.memId).toBe('user');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('멱등 요청은 최대 3회까지만 시도하고 마지막 오류를 그대로 전달한다', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

      await expect(new HmpClient().getUserInfo()).rejects.toThrow('fetch failed');
      expect(fetchSpy).toHaveBeenCalledTimes(3);
    });

    it('멱등 요청도 HTTP 4xx(429 제외)는 재시도하지 않는다', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('', { status: 404 }));

      await expect(new HmpClient().getUserInfo()).rejects.toThrow('HTTP 404');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('멱등 요청은 HTTP 429 면 재시도한다', async () => {
      const fetchSpy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response('', { status: 429 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ knowCommUserInfo: { memId: 'user' } }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );

      const res = await new HmpClient().getUserInfo();

      expect(res.memId).toBe('user');
      expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('상태 변경 요청(룰렛 회전)은 네트워크 오류에도 재시도하지 않는다', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

      const res = await new HmpClient().spinRoulette('1', 'user', '6712');

      expect(res.success).toBe(false);
      expect(res.message).toContain('룰렛 참여 중 오류');
      // 재시도했다면 당첨 결과가 두 번 소비될 수 있다.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('상태 변경 요청(출석 캡슐 수령)은 네트워크 오류에도 재시도하지 않는다', async () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

      await expect(
        new HmpClient().submitAttendance({
          cntntCd: '09',
          cntntSeq: '6712',
          pointTitle: '출석 체크 룰렛 이벤트',
          bizGbn: '009',
          loginCount: 5,
          isAlreadyAttended: false,
          maxLoginCount: 30,
          month: '09',
          memId: 'user',
          phoneNo: '01012345678',
          rouelette10: '',
          rouelette20: '',
          rouelette30: '',
          win10: '',
          win20: '',
          win30: '',
          win10Yn: '',
          win20Yn: '',
          win30Yn: '',
        }),
      ).rejects.toThrow('fetch failed');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('재시도 대기 시간이 실패 횟수에 따라 지수적으로 증가한다', async () => {
      const delays: number[] = [];
      const delaySpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
        delays.push(ms ?? 0);
        fn();
        return 0 as unknown as NodeJS.Timeout;
      }) as typeof setTimeout);

      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
      await expect(new HmpClient().getUserInfo()).rejects.toThrow('fetch failed');

      expect(delays).toEqual([500, 1000]);
      delaySpy.mockRestore();
    });
  });

  describe('부분 성공 보존 (일일퀘스트 보고 정확도)', () => {
    const baseInfo = {
      cntntCd: '09',
      cntntSeq: '6712',
      pointTitle: '출석 체크 룰렛 이벤트',
      bizGbn: '009',
      loginCount: 5,
      isAlreadyAttended: false,
      maxLoginCount: 30,
      month: '09',
      memId: 'user',
      phoneNo: '01012345678',
      rouelette10: 'Y',
      rouelette20: 'Y',
      rouelette30: 'Y',
      win10: '',
      win20: '',
      win30: '',
      win10Yn: '',
      win20Yn: '',
      win30Yn: '',
    };

    it('출석 캡슐 수령 후 캡슐 조회가 실패해도 출석 성공으로 보고한다', async () => {
      const client = new HmpClient();
      vi.spyOn(client, 'login').mockResolvedValue(true);
      vi.spyOn(client, 'getAttendanceInfo').mockResolvedValue({ ...baseInfo });
      vi.spyOn(client, 'submitAttendance').mockResolvedValue({
        status: 'SUCCESS',
        point: 10,
        message: '출석 캡슐 받기 완료 (+10 캡슐)',
      });
      vi.spyOn(client, 'runRouletteWorkflow').mockResolvedValue({ attempted: false, spins: [] });
      vi.spyOn(client, 'getUserInfo').mockRejectedValue(new Error('The operation was aborted due to timeout'));

      const result = await client.runAttendanceWorkflow('user', 'pass');

      // 캡슐은 실제로 들어갔으므로 성공이어야 한다.
      expect(result.success).toBe(true);
      expect(result.attendance.status).toBe('SUCCESS');
      expect(result.userInfo).toBeUndefined();
      expect(result.degradedReason).toContain('캡슐 현황 조회 실패');
    });

    it('부분 성공 상태는 텔레그램 메시지에서 출석 실패로 표시되지 않는다', async () => {
      const client = new HmpClient();
      vi.spyOn(client, 'login').mockResolvedValue(true);
      vi.spyOn(client, 'getAttendanceInfo').mockResolvedValue({ ...baseInfo });
      vi.spyOn(client, 'submitAttendance').mockResolvedValue({
        status: 'SUCCESS',
        point: 10,
        message: '출석 캡슐 받기 완료 (+10 캡슐)',
      });
      vi.spyOn(client, 'runRouletteWorkflow').mockResolvedValue({ attempted: false, spins: [] });
      vi.spyOn(client, 'getUserInfo').mockRejectedValue(new Error('timeout'));

      const result = await client.runAttendanceWorkflow('user', 'pass');
      // run() 은 내부에서 새 HmpClient 를 생성하므로 프로토타입을 스파이한다.
      vi.spyOn(HmpClient.prototype, 'runAttendanceWorkflow').mockResolvedValue(result);

      const taskResult = await runHmpAttendance();

      expect(taskResult.success).toBe(true);
      expect(taskResult.message).not.toContain('❌ [HMP 출석체크 실패]');
      expect(taskResult.message).toContain('✅ 출석 완료 (+10 캡슐)');
      expect(taskResult.message).toContain('일부 처리 실패');
      expect(taskResult.message).toContain('보유 캡슐: 조회 실패');
    });

    it('출석 후 상태 재조회가 실패해도 출석 성공으로 보고한다', async () => {
      const client = new HmpClient();
      vi.spyOn(client, 'login').mockResolvedValue(true);
      vi.spyOn(client, 'getAttendanceInfo')
        .mockResolvedValueOnce({ ...baseInfo })
        .mockRejectedValue(new Error('timeout'));
      vi.spyOn(client, 'submitAttendance').mockResolvedValue({
        status: 'SUCCESS',
        point: 10,
        message: '출석 캡슐 받기 완료 (+10 캡슐)',
      });
      vi.spyOn(client, 'runRouletteWorkflow').mockResolvedValue({ attempted: false, spins: [] });
      vi.spyOn(client, 'getUserInfo').mockResolvedValue({ memId: 'user', capsules: 100 });

      const result = await client.runAttendanceWorkflow('user', 'pass');

      expect(result.success).toBe(true);
      expect(result.attendance.status).toBe('SUCCESS');
      expect(result.degradedReason).toContain('출석 후 상태 재조회 실패');
    });

    it('로그인 실패는 여전히 전체 실패로 보고한다', async () => {
      const client = new HmpClient();
      vi.spyOn(client, 'login').mockResolvedValue(false);

      const result = await client.runAttendanceWorkflow('user', 'pass');

      expect(result.success).toBe(false);
      expect(result.attendance.status).toBe('FAILED');
    });

    it('로그인 중 타임아웃은 전체 실패로 보고한다', async () => {
      const client = new HmpClient();
      vi.spyOn(client, 'login').mockRejectedValue(new Error('timeout'));

      const result = await client.runAttendanceWorkflow('user', 'pass');

      expect(result.success).toBe(false);
      expect(result.attendance.status).toBe('FAILED');
      expect(result.message).toContain('HMP 로그인 중 오류');
    });

    it('출석 캡슐 요청 자체가 실패하면 전체 실패로 보고한다', async () => {
      const client = new HmpClient();
      vi.spyOn(client, 'login').mockResolvedValue(true);
      vi.spyOn(client, 'getAttendanceInfo').mockResolvedValue({ ...baseInfo });
      vi.spyOn(client, 'submitAttendance').mockRejectedValue(new Error('timeout'));

      const result = await client.runAttendanceWorkflow('user', 'pass');

      expect(result.success).toBe(false);
      expect(result.attendance.status).toBe('FAILED');
      expect(result.message).toContain('출석 캡슐 요청 실패');
    });
  });
});
