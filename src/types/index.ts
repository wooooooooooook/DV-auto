import type { BrowserContext, Page } from 'playwright';

export interface TaskContext {
  page?: Page;
  context?: BrowserContext;
  notifyAdminOnSuccess?: boolean;
}

export interface PlaywrightTaskContext extends TaskContext {
  page: Page;
  context: BrowserContext;
}

export type PlaywrightRunArgs = TaskContext & { page: Page; context?: BrowserContext };

export interface TaskResult {
  success?: boolean;
  message?: string;
  imagePath?: string;
  screenshotPaths?: string[];
  options?: Record<string, unknown>;
  silent?: boolean;
}

export interface Task {
  name: string;
  run: (
    ctx: TaskContext,
    options?: Record<string, unknown>,
  ) => Promise<TaskResult | boolean | string | void> | TaskResult | boolean | string | void;
  schedule?: string;
  timezone?: string;
  lockTtlMs?: number;
  type?: string;
  options?: Record<string, unknown>;
}
