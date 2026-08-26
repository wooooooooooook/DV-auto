import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

process.env.NODE_ENV = 'test';
const testDbPath = path.join(__dirname, '..', 'data', 'test_runner.db');
process.env.SQLITE_DB_PATH = testDbPath;

console.log('===========================================================');
console.log('  전체 단위/통합 테스트 실행 시작');
console.log(`  (테스트 DB 경로: ${testDbPath})`);
console.log('===========================================================\n');

const testFiles = [
  'storage_sqlite.test.ts',
  'seminar_repository.test.ts',
  'seminar_api.test.ts',
  'seminar_detail.test.ts',
  'monitor_seminars_api.test.ts',
  'apply_seminar_changes.test.ts',
  'apply_seminar_combined_notice.test.ts',
  'point_only_seminar_detail.test.ts',
  'apply_seminar_api.test.ts',
  'apply_seminar_http_precheck.test.ts',
  'apply_seminar_result_count.test.ts',
  'apply_seminar_no_browser.test.ts',
  'apply_seminar_direct_entry.test.ts',
  'today_links_format.test.ts',
  'seminar_main_tasks.test.ts',
  'check_advanced_seminars_cache.test.ts',
  'seminar_change_subscription.test.ts',
  'today_links_cache.test.ts',
  'notice_rate_limit_and_retention.test.ts',
  'html_parser.test.ts',
  'login_check.test.ts',
  'http_session_expiry.test.ts',
  'telegram_notification.test.ts',
  'telegram_truncation.test.ts',
  'telegram_splitting.test.ts',
  'channel_messages.test.ts',
  'broadcast_today_links.test.ts',
  'intermd_quiz.test.ts',
];

let failedCount = 0;
const pnpmCmd = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

for (const file of testFiles) {
  const filePath = path.join(__dirname, file);
  if (!fs.existsSync(filePath)) continue;

  console.log(`\n▶ [Executing] ${file}`);
  try {
    execSync(`${pnpmCmd} exec ts-node "${filePath}"`, {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        SQLITE_DB_PATH: testDbPath,
      },
    });
  } catch (_e) {
    console.error(`❌ [Failed] ${file}:`, _e);
    failedCount++;
  }
}

if (failedCount > 0) {
  console.error(`\n❌ 총 ${failedCount}개 테스트 파일 실패`);
  process.exit(1);
} else {
  console.log('\n🎉 모든 테스트 슈트(전체 테스트) 성공!');
}
