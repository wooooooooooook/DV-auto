import { TaskContext } from '../types';
import type { BrowserContext, Page } from 'playwright';
import { monitorSeminars } from './monitor_seminars';

async function run(ctx: TaskContext & { page?: Page; context?: BrowserContext }) {
  const { page, context, isAutoResume } = ctx;
  //                      periodName, startHour, endHour
  return monitorSeminars('저녁', 17, 22, { isAutoResume, page, context });
}

export { run };
