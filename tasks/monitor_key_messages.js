const { sendNotificationToChannel, safeGoto, getSeminarIdFromUrl } = require('../modules/utils');

async function getKeyMessages(page) {
    const messages = await page.locator('.key_message .txt').allInnerTexts();
    return messages.map(m => m.trim()).filter(m => m.length > 0);
}

/**
 * Monitors a single seminar for key messages.
 * @param {{ page: import('playwright').Page, context: import('playwright').BrowserContext }} browserObjects
 * @param {string} seminarUrl - The URL of the seminar to monitor.
 * @param {string} seminarName - The name of the seminar.
 */
async function monitor({ page, context }, seminarUrl, seminarName) {
    const seminarId = getSeminarIdFromUrl(seminarUrl);
    if (!seminarId) {
        console.error(`monitor_key_messages: Invalid seminar URL, cannot get seminarId: ${seminarUrl}`);
        return;
    }

    console.log(`monitor_key_messages: Starting monitor for "${seminarName}" (ID: ${seminarId})`);

    const intervalMs = 30 * 1000; // 30 seconds
    const durationMs = 2 * 60 * 60 * 1000; // 2 hours
    const maxChecks = durationMs / intervalMs;
    let checks = 0;

    while (checks < maxChecks) {
        checks++;
        try {
            await safeGoto(page, seminarUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }, 1);

            const newMessages = await getKeyMessages(page);

            const allStoredMessages = storage.get(KEY, {});
            const seminarData = allStoredMessages[seminarId] || { name: seminarName, messages: [] };
            const oldMessages = seminarData.messages;

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
            if (e.message.includes('Target page, context or browser has been closed')) {
                console.log(`monitor_key_messages: [${seminarName}] Page closed, ending monitoring.`);
                break;
            }
            console.error(`monitor_key_messages: [${seminarName}] Error during check`, e && e.stack ? e.stack : e);
        }

        await new Promise(r => setTimeout(r, intervalMs));
    }

    console.log(`monitor_key_messages: Finished monitoring for "${seminarName}" (ID: ${seminarId}) after ${checks} checks.`);
}

module.exports = { monitor, getKeyMessages };
