import path from 'path';
import fs from 'fs/promises';
import type { PlaywrightRunArgs, TaskResult } from '../types';
import {
  safeGoto,
  sendNotificationToChannel,
  sendTelegram,
  getSeminarIdFromUrl,
  isSurveyPointExcludedSeminar,
} from '../modules/utils';
import * as storage from '../services/storage';

const SEMINAR_PAGE = 'https://www.doctorville.co.kr/seminar/main';
const SEMINAR_DETAIL_PAGE = 'https://m.doctorville.co.kr/cme/seminar/';
const SEMINAR_LIST_KEY = 'apply_seminar:seminar_list';
const NEW_SEMINAR_KEY = 'apply_seminar:new_seminars';

type SeminarListItem = {
  name: string;
  url: string;
  date?: string;
  time?: string;
  isPointExcluded?: boolean;
};

type StoredNewSeminars = {
  date: string;
  seminars: Array<SeminarListItem & { seminarId: string | null; isPointExcluded?: boolean }>;
};

type ApplySeminarOptions = {
  notifyNewSeminarsToChannel?: boolean;
  notifyNewSeminarsToTelegram?: boolean;
  silentIfNoNew?: boolean;
};

async function run({ page }: PlaywrightRunArgs, options: ApplySeminarOptions = {}): Promise<TaskResult> {
  let screenshotPath: string | null = null;
  const { notifyNewSeminarsToChannel = false, notifyNewSeminarsToTelegram = true } = options;
  try {
    await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 }, 1);

    const totalSeminarLinks = await page.locator('a.list_detail');
    // totalCount can be different from items.length if some seminars are not applyable
    const totalSeminarsAvailable = await totalSeminarLinks.count();
    console.log('Total seminar links found:', totalSeminarsAvailable);

    const closedCount = await page.locator('.ico_finish').count();

    const applyLocator = page.locator('a:has(.ico_apply)');
    const items = await applyLocator.evaluateAll((nodes) =>
      nodes.map((n) => ({ href: n.getAttribute('href'), text: (n.textContent || '').trim() })),
    );
    const attemptedApplyCount = items.length;

    for (const item of items) {
      console.log('Applying for seminar:', item.text, item.href);
      await safeGoto(page, item.href, { waitUntil: 'load', timeout: 30000 }, 1);

      try {
        await page.click('a#applyLiveSeminarMemberBtn', { timeout: 5000 }).catch((_e) => {
          console.error('Error clicking apply button:', _e);
        });
      } catch (_e) {
        console.error('apply button click threw:', _e && _e.message ? _e.message : _e);
      }

      try {
        await page.waitForSelector('.agg_confirm', { timeout: 2000 });
        await page.click('.agg_confirm').catch((_e) => {
          console.error('Error clicking agree checkbox(.agg_confirm):', _e);
        });
        await page.waitForSelector('#seminarAgree', { timeout: 2000 });
        await page.click('#seminarAgree').catch((_e) => {
          console.error('Error clicking agree checkbox(#seminarAgree):', _e);
        });
      } catch (_e) {
        // Not present within 2s — continue without blocking
      }

      try {
        const nextTerms = page.locator('.agg_next_terms');
        if (await nextTerms.isVisible({ timeout: 1000 })) {
          await nextTerms.click();
          await page.waitForSelector('#terms_confirm', { timeout: 2000 });
          await page.click('#terms_confirm');
          console.log('Clicked .agg_next_terms and #terms_confirm');
        }
      } catch (_e) {
        // Optional step, ignore if elements are not found
      }
      await page.waitForTimeout(500);
      console.log('success applied for seminar');
    }

    await safeGoto(page, SEMINAR_PAGE, { waitUntil: 'domcontentloaded', timeout: 30000 }, 1);

    const currentSeminars = await page.locator('.list_cont').evaluateAll((nodes) => {
      const results: { url: string; name: string; date: string; time: string }[] = [];
      nodes.forEach((node) => {
        const date = node.querySelector('.seminar_day .date')?.textContent?.trim() || '';
        const links = node.querySelectorAll('a.list_detail');
        links.forEach((link) => {
          const href = link.getAttribute('href') || '';
          const title =
            link.querySelector('.list_tit .tit')?.textContent?.trim() || link.textContent?.trim() || '세미나';
          const time = link.querySelector('.txt_num.time')?.textContent?.replace(/\n/g, '').trim() || '';
          if (href) {
            results.push({ url: href, name: title, date: date, time: time });
          }
        });
      });
      return results;
    });

    const normalizedCurrentSeminars: SeminarListItem[] = currentSeminars.map((item) => ({
      name: item.name,
      url: new URL(item.url, SEMINAR_PAGE).toString(),
      date: item.date,
    }));

    const storedSeminars = storage.get<SeminarListItem[]>(SEMINAR_LIST_KEY, []) || [];
    let newlyAddedCount = 0;
    let newlyAddedWithFlags: Array<SeminarListItem & { seminarId: string | null; isPointExcluded?: boolean }> = [];
    if (storedSeminars.length > 0) {
      const storedUrls = new Set(storedSeminars.map((item) => item.url));
      const newlyAdded = normalizedCurrentSeminars.filter((item) => !storedUrls.has(item.url));
      newlyAddedCount = newlyAdded.length;
      if (newlyAdded.length > 0) {
        newlyAddedWithFlags = await Promise.all(
          newlyAdded.map(async (item) => {
            const seminarId = getSeminarIdFromUrl(item.url);
            const link = seminarId ? `${SEMINAR_DETAIL_PAGE}${seminarId}` : item.url;
            const isPointExcluded = await isSurveyPointExcludedSeminar(page.context(), link);
            return { ...item, seminarId, isPointExcluded };
          }),
        );

        const newSeminarMessage = newlyAdded
          .map((item, _index) => {
            const matched = newlyAddedWithFlags.find((flagged) => flagged.url === item.url);
            const pointExcludedSuffix = matched?.isPointExcluded ? ' [포인트미지급]' : '';
            const dateTimePrefix = item.date || item.time ? `[${item.date}${item.time ? ' ' + item.time : ''}] ` : '';
            return `${dateTimePrefix}${item.name}${pointExcludedSuffix}\n${item.url}`;
          })
          .join('\n\n');

        const noticeMessage = `🆕 새로 추가된 세미나 ${newlyAdded.length}건 발견\n\n${newSeminarMessage}`;
        if (notifyNewSeminarsToTelegram) {
          await sendTelegram(noticeMessage);
        }
        if (notifyNewSeminarsToChannel) {
          await sendNotificationToChannel(noticeMessage);
        }
        const todayIso = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
        const storedNew = storage.get<StoredNewSeminars>(NEW_SEMINAR_KEY);
        const baseSeminars = storedNew?.date === todayIso ? storedNew.seminars : [];
        const merged = [...baseSeminars];
        const existingUrls = new Set(baseSeminars.map((item) => item.url));
        for (const item of newlyAddedWithFlags) {
          if (existingUrls.has(item.url)) continue;
          merged.push(item);
          existingUrls.add(item.url);
        }
        storage.set(NEW_SEMINAR_KEY, {
          date: todayIso,
          seminars: merged,
        });
      }
    }
    const finalSeminarsToStore: SeminarListItem[] = normalizedCurrentSeminars.map((item) => {
      const stored = storedSeminars.find((s) => s.url === item.url);
      const isPointExcluded =
        stored?.isPointExcluded ?? newlyAddedWithFlags.find((n) => n.url === item.url)?.isPointExcluded;
      return { ...item, isPointExcluded };
    });
    storage.set(SEMINAR_LIST_KEY, finalSeminarsToStore);

    const appliedCount = await page.locator('a:has(.ico_completion)').count();
    let message = `✅ ${appliedCount}개 세미나 신청 완료! (${appliedCount}/${totalSeminarsAvailable})`;

    const failedToApplyCount = attemptedApplyCount - appliedCount;
    if (failedToApplyCount > 0) {
      message += `\n (${failedToApplyCount}개는 마감 등의 사유로 신청 실패)`;
    }
    if (closedCount > 0) {
      message += `\n ${closedCount}개는 신청 마감되어 신청하지 못했습니다.`;
    }

    const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
    await fs.mkdir(baseScreenshotDir, { recursive: true });
    screenshotPath = path.join(baseScreenshotDir, `apply_seminar_result.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    message += `\n${SEMINAR_DETAIL_PAGE}`;
    const result: TaskResult = { success: true, message: message, imagePath: screenshotPath };
    if (options.silentIfNoNew && newlyAddedCount === 0) {
      result.silent = true;
    }
    return result;
  } catch (error) {
    console.error(
      'seminar task error',
      error && typeof error === 'object' && 'stack' in error ? (error as Error).stack : error,
    );
    if (!screenshotPath) {
      const baseScreenshotDir = path.join(process.cwd(), 'screenshot');
      await fs.mkdir(baseScreenshotDir, { recursive: true });
      screenshotPath = path.join(baseScreenshotDir, `apply_seminar_error.png`);
      await page
        .screenshot({ path: screenshotPath, fullPage: false })
        .catch((err: unknown) => console.error('Failed to capture error screenshot:', err));
    }
    const message = error instanceof Error ? error.message : String(error);
    await sendTelegram(`❗ 세미나 신청 작업 오류: ${message}`, screenshotPath).catch(() => {});
    return {
      success: false,
      message: `세미나 신청 작업 오류: ${message}`,
      imagePath: screenshotPath,
    };
  }
}

export { run };
