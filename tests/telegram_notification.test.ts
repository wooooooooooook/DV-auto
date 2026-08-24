import assert from 'assert';
import path from 'path';
import fs from 'fs';
import { sendTelegram, sendNotificationToChannel } from '../src/modules/utils';
import { setBot } from '../src/services/bot_instance';

async function testTelegramNotification() {
  console.log('Testing Telegram notification image existence check...');

  let sentMessageType = '';
  let sentPhotoSource = '';

  const mockBot = {
    command: () => {},

    telegram: {
      sendMessage: async (_chatId: string, _text: string) => {
        sentMessageType = 'text';
        return { message_id: 100 };
      },
      sendPhoto: async (_chatId: string, source: { source: string }, _options?: unknown) => {
        sentMessageType = 'photo';
        sentPhotoSource = source.source;
        return { message_id: 200 };
      },
    },
  } as unknown as Parameters<typeof setBot>[1];

  setBot('admin', mockBot);
  setBot('notice', mockBot);
  process.env.TELEGRAM_CHAT_ID = '12345';
  process.env.NOTICE_CHANNEL_ID = '67890';

  // Case 1: 존재하지 않는 imagePath 전달 시 text 메시지로 전송되어야 함 (ENOENT 방지)
  const nonExistentPath = path.join(process.cwd(), 'screenshot', 'non_existent_file.png');
  await sendTelegram('테스트 메시지', nonExistentPath);
  assert.strictEqual(sentMessageType, 'text', 'Non-existent image path should send text message, not photo!');

  await sendNotificationToChannel('채널 테스트 메시지', nonExistentPath);
  assert.strictEqual(
    sentMessageType,
    'text',
    'Non-existent image path to channel should send text message, not photo!',
  );

  // Case 2: 실제 존재하는 파일 전달 시 photo 메시지로 전송되어야 함
  const existingPath = path.join(process.cwd(), 'tests', 'test_dummy_image.png');
  fs.writeFileSync(existingPath, 'dummy image data');

  try {
    await sendTelegram('사진 테스트 메시지', existingPath);
    assert.strictEqual(sentMessageType, 'photo', 'Existing image path should send photo!');
    assert.strictEqual(sentPhotoSource, existingPath);

    await sendNotificationToChannel('채널 사진 테스트 메시지', existingPath);
    assert.strictEqual(sentMessageType, 'photo', 'Existing image path to channel should send photo!');
  } finally {
    if (fs.existsSync(existingPath)) {
      fs.unlinkSync(existingPath);
    }
  }

  console.log('✅ Telegram notification image existence test passed!');
}

testTelegramNotification().catch((err) => {
  console.error('❌ Telegram notification image existence test failed:', err);
  process.exit(1);
});
