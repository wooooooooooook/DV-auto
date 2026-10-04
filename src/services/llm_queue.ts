import * as logger from './logger';

/**
 * LLM(Hermes) 요청 백그라운드 큐
 *
 * AI 응답 대기(최대 200초) 때문에 호출한 작업이 멈추지 않도록,
 * LLM 요청과 그 결과 처리(텔레그램 발송 등)를 백그라운드에서 실행한다.
 * 호출부는 enqueueLlmJob() 결과를 await 하지 않고 바로 다음 작업을 진행하며,
 * 예외는 큐가 모두 잡아서 로그로 남긴다.
 */
export type LlmJob<T> = {
  /** 로그에 표시할 작업 이름 */
  label: string;
  /** 실제 LLM 요청 (예: requestHermesAiSurveyAnswer) */
  run: () => Promise<T>;
  /** LLM 응답 도착 후 실행할 후속 처리 (예: 텔레그램 발송). 생략 가능 */
  onResult?: (result: T) => void | Promise<void>;
  /** run()이 예외를 던진 경우 실행할 오류 처리. 생략 가능 */
  onError?: (err: unknown) => void | Promise<void>;
};

/** 동시에 실행 가능한 백그라운드 LLM 작업 수 */
export const LLM_QUEUE_CONCURRENCY = 2;

type QueuedItem = {
  label: string;
  start: () => void;
};

const queue: QueuedItem[] = [];
let runningCount = 0;
let pendingCount = 0;
let idleWaiters: Array<() => void> = [];

function notifyIdleIfEmpty(): void {
  if (pendingCount > 0 || runningCount > 0 || queue.length > 0) return;
  const waiters = idleWaiters;
  idleWaiters = [];
  for (const resolve of waiters) resolve();
}

function pump(): void {
  while (runningCount < LLM_QUEUE_CONCURRENCY && queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    runningCount += 1;
    logger.info('llm_queue: background job start', next.label);
    next.start();
  }
}

/**
 * LLM 작업을 백그라운드 큐에 넣는다.
 *
 * 반환 Promise는 await 하지 않아도 되며(오류는 큐가 처리),
 * 테스트에서는 drainLlmQueue()로 완료를 기다릴 수 있다.
 */
export function enqueueLlmJob<T>(job: LlmJob<T>): Promise<T | null> {
  pendingCount += 1;

  let start!: () => void;
  const slot = new Promise<void>((resolve) => {
    start = resolve;
  });

  const promise = (async (): Promise<T | null> => {
    await slot;
    try {
      const result = await job.run();
      try {
        await job.onResult?.(result);
      } catch (resultErr) {
        logger.error(
          'llm_queue: background job result handling failed',
          job.label,
          resultErr instanceof Error ? resultErr.stack : resultErr,
        );
      }
      return result;
    } catch (err) {
      logger.error('llm_queue: background job failed', job.label, err instanceof Error ? err.stack : err);
      try {
        await job.onError?.(err);
      } catch (onErr) {
        logger.error(
          'llm_queue: background job onError failed',
          job.label,
          onErr instanceof Error ? onErr.stack : onErr,
        );
      }
      return null;
    } finally {
      runningCount -= 1;
      pendingCount -= 1;
      pump();
      notifyIdleIfEmpty();
    }
  })();

  queue.push({ label: job.label, start });
  pump();
  return promise;
}

/** 실행 중/대기 중인 백그라운드 LLM 작업 수 */
export function getPendingLlmJobCount(): number {
  return pendingCount;
}

/**
 * 큐의 모든 백그라운드 LLM 작업이 끝날 때까지 대기한다. (테스트/디버깅용)
 */
export function drainLlmQueue(): Promise<void> {
  if (pendingCount === 0 && runningCount === 0 && queue.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    idleWaiters.push(resolve);
  });
}
