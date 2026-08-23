import assert from 'assert';
import { applySeminarExtraTask } from '../src/tasks/apply_seminar';

async function testApplySeminarExtraNoBrowser() {
  console.log('Testing apply_seminar_extra execution without Playwright Browser...');

  // Mock httpGet inside test if needed or rely on fallback gracefully handling network
  // applySeminarExtraTask.run should complete and return TaskResult without requiring page/context
  const result = await applySeminarExtraTask.run({}, { notifyNewSeminarsToTelegram: false });
  assert.ok(typeof result.success === 'boolean');
  console.log('apply_seminar_extra task result:', result);

  console.log('✅ apply_seminar_extra no-browser test passed!');
}

testApplySeminarExtraNoBrowser().catch((err) => {
  console.error('❌ apply_seminar_extra no-browser test failed:', err);
  process.exit(1);
});
