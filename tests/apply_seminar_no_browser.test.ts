import assert from 'assert';
import { chromium } from 'playwright';
import { applySeminarExtraTask } from '../src/tasks/apply_seminar';

async function testApplySeminarExtraNoBrowser() {
  console.log('Testing apply_seminar_extra execution without Playwright Browser...');

  // Playwright chromium.launch에 가이드를 설정하여 브라우저 생성을 차단 및 감시
  let isBrowserLaunched = false;
  const originalLaunch = chromium.launch.bind(chromium);
  chromium.launch = async (..._args: Parameters<typeof originalLaunch>) => {
    isBrowserLaunched = true;
    throw new Error('Playwright chromium.launch should NOT be called in HTTP-only task!');
  };

  try {
    const result = await applySeminarExtraTask.run({}, { notifyNewSeminarsToTelegram: false });
    assert.strictEqual(isBrowserLaunched, false, 'Chromium browser was launched during apply_seminar_extra!');
    assert.ok(typeof result.success === 'boolean');
    console.log('apply_seminar_extra task result:', result);
  } finally {
    chromium.launch = originalLaunch;
  }

  console.log('✅ apply_seminar_extra no-browser test passed (Chromium launch strictly verified)!');
}

testApplySeminarExtraNoBrowser().catch((err) => {
  console.error('❌ apply_seminar_extra no-browser test failed:', err);
  process.exit(1);
});
