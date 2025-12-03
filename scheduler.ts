import cron from 'node-cron';
import * as logger from './logger';
import * as runner from './runner';
import type { Task } from './types';

type ScheduledTask = Task & { job: cron.ScheduledTask };

const scheduledTasks: ScheduledTask[] = [];

function scheduleTaskCron(task: Task): cron.ScheduledTask {
  if (!task || !task.schedule) throw new Error('task.schedule is required for cron scheduling');
  const opts: cron.ScheduleOptions = { scheduled: true };
  // Allow explicit timezone on the task, or fall back to process TZ env
  if (task.timezone) opts.timezone = task.timezone;
  else if (process.env.TZ) opts.timezone = process.env.TZ;

  const job = cron.schedule(
    task.schedule,
    async () => {
      try {
        logger.info('scheduler: triggering task', task.name);
        // For scheduled runs, ask runner to notify admin on success
        await runner.runTask(task, { notifyAdminOnSuccess: true });
      } catch (e) {
        logger.error('scheduler: task error', task.name, e && e.stack ? e.stack : e);
      }
    },
    opts,
  );

  scheduledTasks.push({ ...(task as Task), job });
  return job;
}

function getScheduledTasks(): ScheduledTask[] {
  return scheduledTasks;
}

export { scheduleTaskCron, getScheduledTasks };
