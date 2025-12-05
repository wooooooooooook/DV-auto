import type { BrowserContext, Page } from 'playwright';
import { monitorSeminars } from './monitor_seminars';

async function run({ page, context }: { page: Page; context: BrowserContext }) {
  //                      periodName, startHour, endHour
  return monitorSeminars({ page, context }, '저녁', 17, 22);
}

export { run };
