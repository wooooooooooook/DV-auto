import { Telegraf } from 'telegraf';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import * as logger from '../../logger';
import * as scheduler from '../../../core/scheduler';
import { inspect } from '../../../modules/inspect';
import { replyWithSplit } from '../../../modules/utils';
import { getChannelMessagesByDate, getSeoulDateString } from '../../channel_message_repository';
import { runShellCommand, runShellCommandWithAllowedExitCodes } from '../quiz_cheatsheet';

export function setupSystemCommands(adminBot: Telegraf): void {
  adminBot.command('schedules', (ctx) => {
    const tasks = scheduler.getScheduledTasks();
    if (tasks.length === 0) {
      return replyWithSplit(ctx, 'No scheduled tasks.');
    }

    let message = 'Scheduled Tasks:\n\n';
    tasks.forEach((task) => {
      message += `Name: ${task.name}\n`;
      message += `Schedule: ${task.schedule}\n`;
      message += `Timezone: ${task.timezone}\n\n`;
    });

    replyWithSplit(ctx, message);
  });

  adminBot.command('log', async (ctx) => {
    const messageText = ctx.message?.text || '';
    const args = messageText.split(' ').slice(1);

    let lineCount = 20;
    if (args.length > 0) {
      const parsedCount = parseInt(args[0], 10);
      if (!isNaN(parsedCount) && parsedCount > 0) {
        lineCount = parsedCount;
      }
    }

    logger.info(`User requested to fetch recent ${lineCount} logs`, { from: ctx.from?.username });

    try {
      await replyWithSplit(ctx, `최근 ${lineCount}개 로그를 불러옵니다... (최대 5초)`);

      const cmd = `journalctl --no-pager -u doctorville-auto.service -n ${lineCount}`;
      const { stdout, stderr, exitCode } = await runShellCommandWithAllowedExitCodes(`timeout 5s ${cmd}`, [124, 143]);

      let message = `로그 결과 (${lineCount}줄)`;
      if (exitCode) {
        message += ' (시간 제한으로 일부 로그만 표시됩니다)';
      }

      if (stdout.trim()) {
        const cleanedStdout = stdout
          .split('\n')
          .map((line) => line.replace(/([A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2})\s+[^:]+:\s*/, '$1 '))
          .join('\n')
          .trim();

        message += `\n\nstdout:\n${cleanedStdout}`;
      }
      if (stderr.trim()) {
        message += `\n\nstderr:\n${stderr.trim()}`;
      }
      if (!stdout.trim() && !stderr.trim()) {
        message += '\n\n출력된 로그가 없습니다.';
      }
      await replyWithSplit(ctx, message);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      logger.error('log fetch failed', e);
      await replyWithSplit(ctx, `로그 가져오기 실패: ${message}`);
    }
  });

  adminBot.command('update_app', async (ctx) => {
    logger.info('User requested to run update_app', { from: ctx.from?.username });
    try {
      await replyWithSplit(
        ctx,
        '🔄 앱 업데이트 및 빌드를 시작합니다...\n' +
          '1. Git Pull & 의존성 설치\n' +
          '2. TypeScript 빌드\n' +
          '3. 서비스 파일 갱신',
      );

      // 1. 빌드 및 설정 동기 실행 (재시작 제외)
      const buildCommand =
        'git pull && pnpm install --frozen-lockfile && pnpm run build && cp deploy/doctorville-auto.service /etc/systemd/system/ && systemctl daemon-reload';

      runShellCommand(buildCommand)
        .then(async ({ stdout, stderr }) => {
          let message = '✅ 앱 업데이트 및 빌드 성공!';
          if (stdout.trim()) {
            message += `\n\nstdout:\n${stdout.trim()}`;
          }
          if (stderr.trim()) {
            message += `\n\nstderr:\n${stderr.trim()}`;
          }
          message += '\n\n🚀 서비스를 재시작합니다...';
          await replyWithSplit(ctx, message);

          // 2. 서비스 재시작을 독립(detached) 프로세스로 실행하여 데드락 및 타임아웃 방지
          const restartProcess = spawn('systemctl', ['restart', 'doctorville-auto.service'], {
            detached: true,
            stdio: 'ignore',
          });
          restartProcess.unref();
        })
        .catch(async (error) => {
          const message = error instanceof Error ? error.message : String(error);
          const stdout = (error as Error & { stdout?: string }).stdout ?? '';
          const stderr = (error as Error & { stderr?: string }).stderr ?? '';
          logger.error('update_app failed', error);
          let reply = `❌ 업데이트 실패:\n${message}`;
          if (stdout.trim()) {
            reply += `\n\nstdout:\n${stdout.trim()}`;
          }
          if (stderr.trim()) {
            reply += `\n\nstderr:\n${stderr.trim()}`;
          }
          await replyWithSplit(ctx, reply);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start update_app: ${message}`);
    }
  });

  adminBot.command('inspect', async (ctx) => {
    logger.info('User requested to inspect a page', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const args = messageText.split(' ').slice(1);

    if (args.length < 2) {
      return replyWithSplit(ctx, 'Usage: /inspect <url> <selector> [waitUntil]');
    }

    const url = args[0];
    let selector: string;
    let waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit' | undefined;

    const lastArg = args[args.length - 1];
    const validWaitUntil = ['load', 'domcontentloaded', 'networkidle', 'commit'];

    if (args.length > 2 && validWaitUntil.includes(lastArg)) {
      waitUntil = lastArg as 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
      selector = args.slice(1, args.length - 1).join(' ');
    } else {
      selector = args.slice(1).join(' ');
    }

    if ((selector.startsWith('"') && selector.endsWith('"')) || (selector.startsWith("'") && selector.endsWith("'"))) {
      selector = selector.substring(1, selector.length - 1);
    }

    let screenshotPath: string | null = null;

    try {
      replyWithSplit(ctx, `Inspecting ${url} with selector "${selector}"... (waitUntil: ${waitUntil || 'load'})`);
      const result = await inspect(url, selector, { waitUntil });
      screenshotPath = result.screenshotPath;
      let message = `Found ${result.count} elements matching selector "${selector}".\n\n`;

      if (result.warnings && result.warnings.length > 0) {
        message += 'Warnings:\n';
        result.warnings.forEach((warning) => {
          message += `- ${warning}\n`;
        });
        message += '\n';
      }

      if (result.count > 0) {
        result.elements.forEach((element, i) => {
          message += `Element ${i + 1}:\n`;
          message += `  - Inner Text: ${element.innerText}\n`;
          if (element.id) message += `  - ID: ${element.id}\n`;
          if (element.className) message += `  - Class: ${element.className}\n`;
          if (element.selectorPath) message += `  - Selector Path: ${element.selectorPath}\n`;

          const otherAttributes = Object.entries(element.attributes).filter(([key]) => key !== 'id' && key !== 'class');
          if (otherAttributes.length > 0) {
            message += `  - Other Attributes:\n`;
            otherAttributes.forEach(([key, value]) => {
              message += `    - ${key}: ${value}\n`;
            });
          }
          message += '\n';
        });
      }
      await replyWithSplit(ctx, message);

      if (screenshotPath) {
        await ctx.replyWithPhoto({ source: screenshotPath });
      }
    } catch (e) {
      let errorMessage = `An error occurred while inspecting ${url}.`;
      if (e instanceof Error && e.message.includes('Timeout')) {
        errorMessage = `Navigation timeout: The page at ${url} took too long to load or was unreachable.`;
      } else if (e instanceof Error) {
        errorMessage += `\nDetails: ${e.message}`;
      }
      replyWithSplit(ctx, errorMessage);
    } finally {
      if (screenshotPath) {
        await fs
          .unlink(screenshotPath)
          .catch((err) => logger.error(`Failed to delete screenshot: ${screenshotPath}`, err));
      }
    }
  });

  adminBot.command(['channel_messages', 'list_channel_messages'], async (ctx) => {
    try {
      const parts = ctx.message.text.trim().split(/\s+/);
      const targetDate = parts[1] || getSeoulDateString();
      const messages = getChannelMessagesByDate(targetDate);

      if (messages.length === 0) {
        await replyWithSplit(ctx, `ℹ️ [${targetDate}] 공지방에 전송된 메시지 기록이 없습니다.`);
        return;
      }

      const lines: string[] = [`📢 [${targetDate}] 공지방 전송 메시지 목록 (총 ${messages.length}건):\n`];
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        const timeStr = new Date(m.createdAt).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
        const chunkInfo = m.totalChunks > 1 ? ` (${m.chunkIndex + 1}/${m.totalChunks}청크)` : '';
        const preview = (m.text || '').replace(/\n+/g, ' ').slice(0, 50);
        lines.push(
          `${i + 1}. ID: \`${m.messageId}\`${chunkInfo} [${m.mediaType}, ${m.status}] (${timeStr})\n   내용: ${preview || '(내용 없음)'}`,
        );
      }

      await replyWithSplit(ctx, lines.join('\n'));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await replyWithSplit(ctx, `❌ 공지방 메시지 목록 조회 실패: ${message}`);
    }
  });

  adminBot.command('help', (ctx) => {
    const message = `사용 가능한 명령어:

🔄 루틴 / 실행:
- /run_routine_now: 즉시 daily_routine 작업을 실행합니다.
- /today_links [날짜]: 오늘의 세미나/퀴즈/출석 링크를 가져옵니다. (날짜 지정 가능: 예 /today_links 8/20, /today_links 내일)
- /broadcast_today_links: 즉시 오늘의 링크를 채널에 공지합니다.
- /apply_seminar_now: 즉시 세미나 신청 작업(apply_seminars)을 실행합니다.
- /sync_seminars_now: 즉시 세미나 목록/포인트 동기화 작업(sync_seminars)을 실행합니다.
- /run_quiz_now: 즉시 오늘의 퀴즈 작업(today_quiz)을 실행합니다.
- /run_intermd_quiz_now: 즉시 인터엠디 오늘의 퀴즈 작업(intermd_quiz)을 실행합니다.
- /run_docple_daily_now: 즉시 닥플 일일 자동화(docple_daily)를 실행합니다.
- /run_keymedi_attendance_now: 즉시 키메디 출석체크 & 포인트 확인(keymedi_attendance)을 실행합니다.
- /run_hmp_attendance_now: 즉시 HMP 출석체크 & 보유 캡슐 확인(hmp_attendance)을 실행합니다.
- /run_medigate_apply_now: 즉시 메디게이트 심포지움 자동 신청(medigate_apply)을 실행합니다.
- /run_etc_daily_quests_now: 즉시 기타일일퀘스트(키메디/HMP/메디게이트 순차 실행)를 실행합니다.
- /monitor_lunch_seminar_now: 즉시 점심 세미나 모니터링을 시작합니다.
- /monitor_dinner_seminar_now: 즉시 저녁 세미나 모니터링을 시작합니다.

📚 세미나 & 퀴즈 족보:
- /run_seminar_quiz <seminarId> [advanced]: 특정 세미나의 설문 퀴즈를 수동 실행합니다. (advanced: 심화설문)
- /set_seminar_quiz <seminarId> <정답>: 공지방 세미나 항목의 퀴즈 정답을 수동으로 등록/수정합니다.
- /add_seminar_answer_batch: 알림 내용을 복사하여 일괄 등록 (마지막 줄에 정답번호 포함)
- /list_seminar_quiz: 등록된 족보 목록
- /delete_seminar_quiz <키워드>: 족보 삭제
- /list_quiz: quiz.json 등록 제품 목록
- /delete_quiz <제품명>: quiz.json 항목 삭제
- /seminar_detail <세미나번호>: 세미나 상세 정보 실시간 조회 (예: /seminar_detail 5566 또는 /seminar_detail 5566 5567)

💰 포인트 & 교환:
- /check_point: 현재 포인트를 확인합니다.
- /check_seminar_point <세미나번호>: 세미나 번호로 포인트 지급 확인 및 DB 동기화
- /set_seminar_point <세미나번호> [paid|unpaid] [포인트] [내용]: 세미나 포인트 지급 상태 수동 갱신 (기본: 지급완료)
- /check_advanced_seminars: 최근 2주 심화 세미나 포인트 일괄 확인 (방장 계정 기준)
- /point_exchange <URL/guid> [횟수]: 상품 URL 또는 guid로 포인트교환을 실행합니다. (기본값: 1)
- /naverpay_point_exchange [횟수]: 네이버페이포인트교환 작업을 실행합니다. (기본값: 10)
- /baemin_point_exchange [횟수]: 배민포인트교환 작업을 실행합니다. (기본값: 1)
- /kakaopay_point_exchange [횟수]: 카카오페이 1만원권 포인트교환 작업을 실행합니다. (기본값: 1)
- /kakaopay5k_point_exchange [횟수]: 카카오페이 5천원권 포인트교환 작업을 실행합니다. (기본값: 1)
- /kakaopay3k_point_exchange [횟수]: 카카오페이 3천원권 포인트교환 작업을 실행합니다. (기본값: 1)

📢 공지방 메시지 관리:
- /channel_messages [날짜]: 공지방 전송 메시지 ID 목록 조회 (기본: 오늘)

⚙️ 시스템 & 관리:
- /schedules: 스케줄된 작업 목록을 확인합니다.
- /log [수량]: 최근 로그를 가져옵니다. (기본값: 20)
- /update_app: pnpm update:app 명령어를 실행합니다. (서버 권한 필요, 재시작으로 응답 중단 가능)
- /inspect <url> <selector> [waitUntil]: 지정한 URL에서 셀렉터에 해당하는 요소를 검사하고 스크린샷을 전송합니다.

사용 예: /inspect https://example.com "div.article" networkidle`;
    replyWithSplit(ctx, message);
  });
}
