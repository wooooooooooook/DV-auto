import type { BrowserContext, Page } from 'playwright';
import { sendNotificationToChannel, safeGoto, getSeminarIdFromUrl, ensureLoggedIn, sleep } from '../modules/utils';
import * as storage from '../storage';

const KEY = 'key_message_seminars';

async function getKeyMessages(page: Page): Promise<string[]> {
  const messages = await page.locator('.key_message .txt').allInnerTexts();
  return messages.map((m) => m.trim()).filter((m) => m.length > 0);
}

/**
 * Monitors a single seminar for key messages.
 */
async function monitor(
  { page, context }: { page: Page; context: BrowserContext },
  seminarUrl: string,
  seminarName: string,
): Promise<void> {
  const seminarId = getSeminarIdFromUrl(seminarUrl);
  if (!seminarId) {
    console.error(`monitor_key_messages: Invalid seminar URL, cannot get seminarId: ${seminarUrl}`);
    return;
  }

  console.log(`monitor_key_messages: Starting monitor for "${seminarName}" (ID: ${seminarId})`);

  await ensureLoggedIn({ page, context });

  const intervalMs = 30 * 1000; // 30 seconds
  const durationMs = 2 * 60 * 60 * 1000; // 2 hours
  const maxChecks = durationMs / intervalMs;
  let checks = 0;

  while (checks < maxChecks) {
    checks++;
    try {
      await safeGoto(page, seminarUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }, 1);

      const newMessages = await getKeyMessages(page);

      const allStoredMessages = storage.get<Record<string, { name: string; messages: string[] }>>(KEY, {}) || {};
      const seminarData = allStoredMessages[seminarId] || { name: seminarName, messages: [] as string[] };
      const oldMessages: string[] = seminarData.messages;

      if (newMessages.length > 0) {
        const newMessagesStr = JSON.stringify(newMessages);
        const oldMessagesStr = JSON.stringify(oldMessages);

        if (oldMessages.length === 0) {
          // First time seeing messages for this seminar
          console.log(`monitor_key_messages: [${seminarName}] Storing initial messages.`);
          seminarData.messages = newMessages;
          allStoredMessages[seminarId] = seminarData;
          storage.set(KEY, allStoredMessages);

          // Notify with the first message
          const notificationText = `🔔 [${seminarName}] 첫번째 키 메시지:\n\n${newMessages[0]}`;
          await sendNotificationToChannel(notificationText);
        } else if (newMessagesStr !== oldMessagesStr) {
          // Messages have changed
          console.log(`monitor_key_messages: [${seminarName}] Change detected, sending notification.`);
          seminarData.messages = newMessages;
          allStoredMessages[seminarId] = seminarData;
          storage.set(KEY, allStoredMessages);

          // Notify with all current messages
          const allMessagesText = newMessages.join('\n');
          const notificationText = `🔔 [${seminarName}] 키 메시지 변경:\n\n${allMessagesText}`;
          await sendNotificationToChannel(notificationText.substring(0, 4000));
        }
      }
    } catch (e) {
      // If page is closed or navigation fails, it might mean the seminar has ended.
      if (e instanceof Error && e.message.includes('Target page, context or browser has been closed')) {
        console.log(`monitor_key_messages: [${seminarName}] Page closed, ending monitoring.`);
        break;
      }
      console.error(
        `monitor_key_messages: [${seminarName}] Error during check`,
        e && typeof e === 'object' && 'stack' in e ? (e as Error).stack : e,
      );
    }

    await sleep(intervalMs);
  }

  console.log(
    `monitor_key_messages: Finished monitoring for "${seminarName}" (ID: ${seminarId}) after ${checks} checks.`,
  );
}

export { monitor, getKeyMessages };
