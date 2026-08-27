import assert from 'assert';
import { chromium } from 'playwright';
import { applySeminarExtraTask } from '../src/tasks/apply_seminar';
import * as seminarApiModule from '../src/modules/seminar_api';
import { describe, it, vi } from 'vitest';

describe('apply_seminar_extra execution without Playwright Browser', () => {
  it('HTTP-only 태스크 실행 시 Chromium 브라우저 미생성 검증', async () => {
    console.log('Testing apply_seminar_extra execution without Playwright Browser...');

    // Playwright chromium.launch에 가이드를 설정하여 브라우저 생성을 차단 및 감시
    let isBrowserLaunched = false;
    const originalLaunch = chromium.launch.bind(chromium);
    chromium.launch = async (..._args: Parameters<typeof originalLaunch>) => {
      isBrowserLaunched = true;
      throw new Error('Playwright chromium.launch should NOT be called in HTTP-only task!');
    };

    vi.spyOn(seminarApiModule, 'fetchMainFutureSeminars').mockResolvedValue({
      success: true,
      items: [],
      rawResponse: {},
    });

    try {
      const result = await applySeminarExtraTask.run({}, { notifyNewSeminarsToTelegram: false });
      assert.strictEqual(isBrowserLaunched, false, 'Chromium browser was launched during apply_seminar_extra!');
      assert.ok(typeof result.success === 'boolean');
      console.log('apply_seminar_extra task result:', result);
    } finally {
      chromium.launch = originalLaunch;
      vi.restoreAllMocks();
    }

    console.log('✅ apply_seminar_extra no-browser test passed (Chromium launch strictly verified)!');
  });
});
