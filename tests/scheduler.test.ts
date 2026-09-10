import { describe, it, expect, vi } from 'vitest';
import * as scheduler from '../src/core/scheduler';
import type { Task } from '../src/types';

describe('scheduler - scheduleTaskCron', () => {
  it('should register 6-digit cron expression without errors', () => {
    const task: Task = {
      name: 'test_staggered_task',
      schedule: '5 0 9 * * *',
      timezone: 'Asia/Seoul',
      run: vi.fn().mockResolvedValue(true),
    };

    const job = scheduler.scheduleTaskCron(task);
    expect(job).toBeDefined();

    const scheduled = scheduler.getScheduledTasks();
    const found = scheduled.find((t) => t.name === 'test_staggered_task');
    expect(found).toBeDefined();
    expect(found?.schedule).toBe('5 0 9 * * *');

    // Clean up
    job.stop();
  });
});
