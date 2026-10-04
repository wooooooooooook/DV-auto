import { describe, it, expect, vi, afterEach } from 'vitest';
import { enqueueLlmJob, drainLlmQueue, getPendingLlmJobCount, LLM_QUEUE_CONCURRENCY } from '../src/services/llm_queue';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('llm_queue 백그라운드 LLM 작업 큐', () => {
  afterEach(async () => {
    await drainLlmQueue();
  });

  it('enqueueLlmJob는 LLM 응답을 기다리지 않고 즉시 반환하여 호출부를 멈추지 않는다', async () => {
    let finished = false;

    enqueueLlmJob({
      label: '비차단 테스트',
      run: async () => {
        await delay(30);
        finished = true;
        return 'AI 응답';
      },
    });

    // enqueue 시점에는 응답 대기 중이어야 한다 (호출부가 await 하지 않았음)
    expect(finished).toBe(false);
    expect(getPendingLlmJobCount()).toBe(1);

    await drainLlmQueue();

    expect(finished).toBe(true);
    expect(getPendingLlmJobCount()).toBe(0);
  });

  it('동시 실행 수가 LLM_QUEUE_CONCURRENCY를 초과하지 않는다', async () => {
    let running = 0;
    let maxRunning = 0;
    const jobCount = LLM_QUEUE_CONCURRENCY + 3;

    for (let i = 0; i < jobCount; i++) {
      enqueueLlmJob({
        label: `병렬 제한 ${i}`,
        run: async () => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          await delay(10);
          running -= 1;
          return null;
        },
      });
    }

    expect(getPendingLlmJobCount()).toBe(jobCount);

    await drainLlmQueue();

    expect(maxRunning).toBeLessThanOrEqual(LLM_QUEUE_CONCURRENCY);
    expect(running).toBe(0);
    expect(getPendingLlmJobCount()).toBe(0);
  });

  it('run()이 예외를 던져도 반환 Promise가 reject되지 않고 onError를 호출한 뒤 다음 작업을 계속 실행한다', async () => {
    const onError = vi.fn();

    const failed = await enqueueLlmJob<string | null>({
      label: '실패 작업',
      run: async () => {
        throw new Error('boom');
      },
      onError,
    });

    expect(failed).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);

    const after = await enqueueLlmJob({
      label: '실패 후 작업',
      run: async () => '정상 완료',
    });

    expect(after).toBe('정상 완료');
    expect(getPendingLlmJobCount()).toBe(0);
  });

  it('onResult에 LLM 응답이 전달되며, onResult가 실패해도 작업은 완료 처리된다', async () => {
    const received: Array<string | null> = [];

    const result = await enqueueLlmJob({
      label: '결과 처리 테스트',
      run: async () => 'AI 응답',
      onResult: (answer) => {
        received.push(answer);
        throw new Error('텔레그램 발송 실패');
      },
    });

    expect(result).toBe('AI 응답');
    expect(received).toEqual(['AI 응답']);
    expect(getPendingLlmJobCount()).toBe(0);
  });

  it('작업이 하나도 없으면 drainLlmQueue는 즉시 완료된다', async () => {
    await expect(drainLlmQueue()).resolves.toBeUndefined();
  });
});
