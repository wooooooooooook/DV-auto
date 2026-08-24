import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

console.log('===========================================================');
console.log('  전체 단위/통합 테스트 실행 시작');
console.log('===========================================================\n');

const testFiles = [
  'seminar_api.test.ts',
  'seminar_detail.test.ts',
  'monitor_seminars_api.test.ts',
  'apply_seminar_changes.test.ts',
  'apply_seminar_http_precheck.test.ts',
  'apply_seminar_no_browser.test.ts',
  'today_links_format.test.ts',
  'seminar_main_tasks.test.ts',
  'html_parser.test.ts',
  'login_check.test.ts',
  'http_session_expiry.test.ts',
  'telegram_notification.test.ts',
];

let failedCount = 0;

for (const file of testFiles) {
  const filePath = path.join(__dirname, file);
  if (!fs.existsSync(filePath)) continue;

  console.log(`\n▶ [Executing] ${file}`);
  try {
    execSync(`pnpm exec ts-node "${filePath}"`, {
      stdio: 'inherit',
      cwd: path.resolve(__dirname, '..'),
    });
  } catch (_e) {
    console.error(`❌ [Failed] ${file}`);
    failedCount++;
  }
}

if (failedCount > 0) {
  console.error(`\n❌ 총 ${failedCount}개 테스트 파일 실패`);
  process.exit(1);
} else {
  console.log('\n🎉 모든 테스트 슈트(전체 테스트) 성공!');
}
