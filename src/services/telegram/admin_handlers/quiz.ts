import { Telegraf, type Context } from 'telegraf';
import fsSync from 'fs';
import fs from 'fs/promises';
import * as logger from '../../logger';
import * as runner from '../../../core/runner';
import * as taskRegistry from '../../../core/taskRegistry';
import { replyWithSplit } from '../../../modules/utils';
import { syncChannelSeminarStatusOnQuizRegister, setSeminarQuizAnswer } from '../../../tasks/monitor_seminars_notice';
import {
  loginDocple,
  getDocpleActiveQuizzes,
  getDocpleQuizDetail,
  submitDocpleQuiz,
  matchDocpleQuizAnswersWithCheatsheet,
} from '../../../modules/docple_api';
import {
  SEMINAR_QUIZ_CHEATSHEET_FILE,
  QUIZ_FILE,
  loadSeminarQuizCheatsheet,
  saveSeminarQuizCheatsheet,
  loadQuizMapping,
  saveQuizMapping,
  parseQuizQuestionsFromText,
  registerQuizAnswersToCheatsheet,
  commitAndPushIfChanged,
} from '../quiz_cheatsheet';

export function setupQuizCommands(adminBot: Telegraf): void {
  // /run_seminar_quiz <seminarId> [advanced] — 수동 세미나 퀴즈 실행
  adminBot.command('run_seminar_quiz', async (ctx) => {
    logger.info('User requested to run seminar_quiz manually', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const parts = messageText.split(/\s+/).slice(1);
    const seminarId = parts[0]?.trim() || '';
    const isAdvancedSurvey = parts[1]?.toLowerCase() === 'advanced' || parts[1]?.toLowerCase() === '심화';

    if (!seminarId) {
      return replyWithSplit(
        ctx,
        '사용법: /run_seminar_quiz <seminarId> [advanced]\n예) /run_seminar_quiz 12345\n     /run_seminar_quiz 12345 advanced',
      );
    }

    const task = taskRegistry.getByName('run_seminar_quiz');
    if (!task) {
      logger.error('run_seminar_quiz task not found, cannot run');
      return replyWithSplit(ctx, 'run_seminar_quiz task not found!');
    }

    try {
      await replyWithSplit(
        ctx,
        `Starting run_seminar_quiz (seminarId=${seminarId}${isAdvancedSurvey ? ', 심화설문' : ''})... (백그라운드 실행)`,
      );
      const args: Record<string, string> = { seminarId };
      if (isAdvancedSurvey) args.isAdvancedSurvey = 'true';
      runner
        .runTask(task, { args })
        .then(async (result) => {
          if (result && typeof result === 'object' && (result as { message?: string }).message) {
            await replyWithSplit(
              ctx,
              (result as { message: string }).message,
              (result as { options?: Record<string, unknown> }).options as Parameters<Context['reply']>[1],
            );
            if (
              (result as { imagePath?: string }).imagePath &&
              fsSync.existsSync((result as { imagePath: string }).imagePath)
            ) {
              await ctx.replyWithPhoto({ source: (result as { imagePath: string }).imagePath });
              await fs.unlink((result as { imagePath: string }).imagePath).catch(() => {});
            } else {
              const shotPaths = (result as { screenshotPaths?: string[] }).screenshotPaths;
              if (shotPaths) {
                for (const p of shotPaths) {
                  await ctx.replyWithPhoto({ source: p });
                  await fs.unlink(p).catch(() => {});
                }
              }
            }
          } else if (typeof result === 'string') {
            await replyWithSplit(ctx, result);
          } else if (result === true) {
            await replyWithSplit(ctx, 'run_seminar_quiz finished successfully.');
          } else {
            await replyWithSplit(ctx, 'run_seminar_quiz finished.');
          }
        })
        .catch((e) => {
          const message = e instanceof Error ? e.message : String(e);
          replyWithSplit(ctx, `run_seminar_quiz failed: ${message}`);
        });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      replyWithSplit(ctx, `Failed to start run_seminar_quiz: ${message}`);
    }
  });

  // /set_seminar_quiz <seminarId> <정답텍스트> — 공지방 세미나 항목의 퀴즈 정답 수동 등록/수정
  adminBot.command('set_seminar_quiz', async (ctx) => {
    logger.info('User requested set_seminar_quiz', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const content = messageText.replace(/^\/set_seminar_quiz(@\w+)?\s*/, '').trim();

    if (!content) {
      return replyWithSplit(
        ctx,
        '사용법: /set_seminar_quiz <seminarId> <정답텍스트>\n' +
          '예시 1) /set_seminar_quiz 12345 1번 O, 2번 X\n' +
          '예시 2) /set_seminar_quiz 12345 112',
      );
    }

    const firstSpaceIdx = content.search(/\s/);
    if (firstSpaceIdx === -1) {
      return replyWithSplit(
        ctx,
        '❌ 정답 텍스트를 함께 입력해주세요.\n사용법: /set_seminar_quiz <seminarId> <정답텍스트>\n예: /set_seminar_quiz 12345 112',
      );
    }

    const seminarId = content.substring(0, firstSpaceIdx).trim();
    const rawAnswer = content.substring(firstSpaceIdx + 1).trim();

    if (!seminarId || !rawAnswer) {
      return replyWithSplit(ctx, '❌ 세미나 번호와 정답 텍스트를 모두 입력해주세요.\n예: /set_seminar_quiz 12345 112');
    }

    try {
      const result = await setSeminarQuizAnswer(seminarId, rawAnswer);
      await replyWithSplit(ctx, result.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('/set_seminar_quiz 처리 중 오류 발생', error);
      await replyWithSplit(ctx, `❌ 퀴즈 정답 등록/수정 실패: ${message}`);
    }
  });

  adminBot.command('add_seminar_answer_batch', async (ctx) => {
    logger.info('User requested batch seminar quiz registration', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const content = messageText.replace(/^\/add_seminar_answer_batch\s*/, '').trim();

    if (!content) {
      return replyWithSplit(ctx, '사용법: /add_seminar_answer_batch <퀴즈 알림 내용 + 마지막 줄에 정답번호>');
    }

    const lines = content.split('\n').map((l) => l.trim());
    const lastLine = lines[lines.length - 1];

    let answers: number[] = [];
    if (/^\d+$/.test(lastLine)) {
      answers = lastLine.split('').map(Number);
    } else if (/^[\d\s,-]+$/.test(lastLine)) {
      const digits = lastLine.match(/\d/g);
      if (digits) answers = digits.map(Number);
    }

    if (answers.length === 0) {
      return replyWithSplit(ctx, '❌ 마지막 줄에 숫자 형식의 정답(예: 3313 또는 3 3 1 3)이 포함되어야 합니다.');
    }

    const questions = parseQuizQuestionsFromText(content);

    if (questions.length === 0) {
      return replyWithSplit(ctx, '❌ 퀴즈 내용을 파싱하지 못했습니다. 형식을 확인해주세요.');
    }

    if (questions.length !== answers.length) {
      return replyWithSplit(
        ctx,
        `❌ 퀴즈 개수(${questions.length})와 정답 개수(${answers.length})가 일치하지 않습니다.`,
      );
    }

    try {
      const { registered, gitNotice } = await registerQuizAnswersToCheatsheet(questions, answers);

      // 공지 채널에 전송된 세미나 현황 메시지가 있다면 정답 내용 자동 수정 (Edit)
      let syncNotice = '';
      try {
        const syncRes = await syncChannelSeminarStatusOnQuizRegister(questions.map((q) => q.keyword));
        if (syncRes.modified) {
          syncNotice = '\n\n📢 공지 채널의 세미나 현황 메시지 정답이 자동으로 수정되었습니다.';
        }
      } catch (syncErr) {
        logger.error('공지 채널 세미나 메시지 동기화 실패:', syncErr);
      }

      await replyWithSplit(
        ctx,
        `✅ 세미나 퀴즈 ${registered.length}개 일괄 등록 완료\n\n${registered.join('\n')}${gitNotice}${syncNotice}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('세미나 퀴즈 족보 일괄 등록 실패', error);
      await replyWithSplit(ctx, `❌ 일괄 등록 실패: ${message}`);
    }
  });

  // 답장(Reply)을 통한 퀴즈 정답 번호 일괄 등록 핸들러
  adminBot.on('text', async (ctx, next) => {
    const messageText = ctx.message.text.trim();
    // 명령어인 경우 telegraf command 핸들러에 위임
    if (messageText.startsWith('/')) {
      return next();
    }

    const replyToMessage = ctx.message.reply_to_message;
    if (!replyToMessage) {
      return next();
    }

    const replyText =
      'text' in replyToMessage && replyToMessage.text
        ? replyToMessage.text
        : 'caption' in replyToMessage && replyToMessage.caption
          ? replyToMessage.caption
          : '';

    if (!replyText) {
      return next();
    }

    // 숫자로만 구성되어 있는지 확인 (예: "234", "1 2 3", "1, 2, 3", "1-2-3")
    let answers: number[] = [];
    if (/^\d+$/.test(messageText)) {
      answers = messageText.split('').map(Number);
    } else if (/^[\d\s,-]+$/.test(messageText)) {
      const digits = messageText.match(/\d/g);
      if (digits) {
        answers = digits.map(Number);
      }
    }

    if (answers.length === 0) {
      return next();
    }

    // 답장 대상 메시지가 퀴즈 문제인지 파싱
    const questions = parseQuizQuestionsFromText(replyText);
    if (questions.length === 0) {
      return next();
    }

    if (questions.length !== answers.length) {
      return replyWithSplit(
        ctx,
        `❌ 퀴즈 개수(${questions.length}개)와 전송한 정답 개수(${answers.length}개)가 일치하지 않습니다.\n확인 후 다시 답장을 보내주세요.`,
      );
    }

    try {
      logger.info('Registering quiz cheatsheet via reply', {
        from: ctx.from?.username,
        questionCount: questions.length,
        answers,
      });
      const { registered, gitNotice } = await registerQuizAnswersToCheatsheet(questions, answers);

      // 공지 채널에 전송된 세미나 현황 메시지가 있다면 정답 내용 자동 수정 (Edit)
      let syncNotice = '';
      try {
        const syncRes = await syncChannelSeminarStatusOnQuizRegister(questions.map((q) => q.keyword));
        if (syncRes.modified) {
          syncNotice = '\n\n📢 공지 채널의 세미나 현황 메시지 정답이 자동으로 수정되었습니다.';
        }
      } catch (syncErr) {
        logger.error('공지 채널 세미나 메시지 동기화 실패:', syncErr);
      }

      // 닥플 e-디테일링 퀴즈 메시지인 경우 닥플 API로 퀴즈 정답 자동 제출 수행
      let docpleSubmitNotice = '';
      const isDocpleQuiz =
        replyText.includes('닥플 e-디테일링') ||
        replyText.includes('docple-plus.com/e-detailing') ||
        replyText.includes('💊 [닥플');

      if (isDocpleQuiz) {
        try {
          const docpleUser = process.env.DOCPLE_USER;
          const docplePass = process.env.DOCPLE_PASS;
          if (docpleUser && docplePass) {
            const loginRes = await loginDocple(docpleUser, docplePass);
            const accessToken = loginRes.data?.accessToken;
            if (loginRes.success && accessToken) {
              const activeQuizzes = await getDocpleActiveQuizzes(accessToken);
              const cheatsheet = await loadSeminarQuizCheatsheet();

              let submittedCount = 0;
              let totalGrantedCash = 0;
              const submitDetails: string[] = [];

              for (const q of activeQuizzes) {
                const quizDetail = await getDocpleQuizDetail(accessToken, q.quizId);
                if (!quizDetail || quizDetail.hasPassedBefore) continue;

                const matchResult = matchDocpleQuizAnswersWithCheatsheet(quizDetail, cheatsheet);
                if (matchResult.isFullyMatched && quizDetail.canAttempt !== false) {
                  const submitRes = await submitDocpleQuiz(
                    accessToken,
                    q.quizId,
                    matchResult.answers.map((a) => ({
                      questionId: a.questionId,
                      selectedOptionId: a.selectedOptionId,
                    })),
                  );

                  if (submitRes.success && submitRes.isPassed) {
                    submittedCount++;
                    const cash = submitRes.grantedCash ?? 0;
                    totalGrantedCash += cash;
                    submitDetails.push(`• ${q.quizName}: 정답 통과 (+${cash.toLocaleString()} 캐시)`);
                  } else {
                    submitDetails.push(`• ${q.quizName}: 제출 실패 (${submitRes.message || '오답'})`);
                  }
                }
              }

              if (submittedCount > 0) {
                docpleSubmitNotice = `\n\n🎉 [닥플 e-디테일링] 퀴즈 정답 자동 제출 성공!\n${submitDetails.join('\n')}\n총 적립: +${totalGrantedCash.toLocaleString()} 캐시`;
              } else if (submitDetails.length > 0) {
                docpleSubmitNotice = `\n\n⚠️ [닥플 e-디테일링] 퀴즈 제출 결과:\n${submitDetails.join('\n')}`;
              }
            } else {
              docpleSubmitNotice = `\n\n⚠️ [닥플 자동 제출 실패] 로그인 실패: ${loginRes.message}`;
            }
          }
        } catch (docpleErr) {
          logger.error('닥플 퀴즈 답장 자동 제출 실패', docpleErr);
          docpleSubmitNotice = `\n\n⚠️ [닥플 자동 제출 오류] ${docpleErr instanceof Error ? docpleErr.message : String(docpleErr)}`;
        }
      }

      await replyWithSplit(
        ctx,
        `✅ 퀴즈 ${registered.length}개 족보 등록 완료 (답장 등록)\n\n${registered.join('\n')}${gitNotice}${syncNotice}${docpleSubmitNotice}\n\n재실행: /run_quiz_now`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('답장을 통한 퀴즈 족보 등록 실패', error);
      await replyWithSplit(ctx, `❌ 족보 등록 실패: ${message}`);
    }
  });

  adminBot.command('list_seminar_quiz', async (ctx) => {
    logger.info('User requested to list seminar quiz cheatsheet', { from: ctx.from?.username });

    const messageText = ctx.message?.text || '';
    const searchKeyword = messageText.replace(/^\/list_seminar_quiz\s*/, '').trim();

    try {
      const data = await loadSeminarQuizCheatsheet();
      let entries = Object.entries(data);

      if (searchKeyword) {
        entries = entries.filter(([k, a]) => k.includes(searchKeyword) || String(a).includes(searchKeyword));
      }

      if (entries.length === 0) {
        if (searchKeyword) {
          return replyWithSplit(ctx, `📋 "${searchKeyword}" 검색 결과가 없습니다.`);
        } else {
          return replyWithSplit(ctx, '📋 등록된 세미나 퀴즈 족보가 없습니다.');
        }
      }

      let message = searchKeyword
        ? `📋 "${searchKeyword}" 검색 결과 (${entries.length}개)\n\n`
        : `📋 세미나 퀴즈 족보 (${entries.length}개)\n\n`;

      for (const [keyword, answer] of entries) {
        message += `• ${keyword} → ${answer}\n`;
      }

      await replyWithSplit(ctx, message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await replyWithSplit(ctx, `❌ 족보 조회 실패: ${message}`);
    }
  });

  adminBot.command('delete_seminar_quiz', async (ctx) => {
    logger.info('User requested to delete seminar quiz answer', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const keyword = messageText.replace(/^\/delete_seminar_quiz\s*/, '').trim();

    if (!keyword) {
      return replyWithSplit(
        ctx,
        '사용법: /delete_seminar_quiz <문제 키워드>\n예) /delete_seminar_quiz 펙수클루의 적응증이 아닌',
      );
    }

    try {
      const data = await loadSeminarQuizCheatsheet();
      if (!(keyword in data)) {
        return replyWithSplit(ctx, `❌ 해당 키워드가 족보에 없습니다: ${keyword}`);
      }

      const deletedAnswer = data[keyword];
      delete data[keyword];
      await saveSeminarQuizCheatsheet(data);
      let gitNotice = '';
      try {
        const result = await commitAndPushIfChanged([SEMINAR_QUIZ_CHEATSHEET_FILE], 'update seminar quiz cheatsheet');
        gitNotice = `\n\n${result.notice}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('세미나 퀴즈 족보 삭제 Git 커밋/푸시 실패', error);
        gitNotice = `\n\n⚠️ Git 커밋/푸시 실패: ${message}`;
      }

      await replyWithSplit(
        ctx,
        `🗑️ 세미나 퀴즈 족보 삭제 완료\n\n키워드: ${keyword}\n정답: ${deletedAnswer}${gitNotice}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('세미나 퀴즈 족보 삭제 실패', error);
      await replyWithSplit(ctx, `❌ 족보 삭제 실패: ${message}`);
    }
  });

  adminBot.command('list_quiz', async (ctx) => {
    logger.info('User requested to list quiz.json', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const searchKeyword = messageText.replace(/^\/list_quiz\s*/, '').trim();

    try {
      const data = await loadQuizMapping();
      let entries = Object.entries(data);

      if (searchKeyword) {
        entries = entries.filter(
          ([product, answers]) => product.includes(searchKeyword) || JSON.stringify(answers).includes(searchKeyword),
        );
      }

      if (entries.length === 0) {
        if (searchKeyword) {
          return replyWithSplit(ctx, `📋 quiz.json "${searchKeyword}" 검색 결과가 없습니다.`);
        } else {
          return replyWithSplit(ctx, '📋 quiz.json에 등록된 항목이 없습니다.');
        }
      }

      let message = searchKeyword
        ? `📋 quiz.json "${searchKeyword}" 검색 결과 (${entries.length}개)\n\n`
        : `📋 quiz.json 목록 (${entries.length}개)\n\n`;

      for (const [product, answers] of entries) {
        message += `• ${product} → [${answers.join(', ')}]\n`;
      }

      await replyWithSplit(ctx, message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await replyWithSplit(ctx, `❌ quiz.json 목록 조회 실패: ${message}`);
    }
  });

  adminBot.command('delete_quiz', async (ctx) => {
    logger.info('User requested to delete quiz mapping', { from: ctx.from?.username });
    const messageText = ctx.message?.text || '';
    const target = messageText.replace(/^\/delete_quiz\s*/, '').trim();

    if (!target) {
      return replyWithSplit(ctx, '사용법: /delete_quiz <제품명>\n예) /delete_quiz 글리아타민');
    }

    try {
      const data = await loadQuizMapping();

      if (!(target in data)) {
        return replyWithSplit(ctx, `❌ "${target}" 제품이 quiz.json에 없습니다.`);
      }

      const deletedAnswer = data[target];
      delete data[target];
      await saveQuizMapping(data);
      let gitNotice = '';
      try {
        const result = await commitAndPushIfChanged([QUIZ_FILE], `delete ${target} from quiz.json`);
        gitNotice = `\n\n${result.notice}`;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('quiz.json 삭제 Git 커밋/푸시 실패', error);
        gitNotice = `\n\n⚠️ Git 커밋/푸시 실패: ${message}`;
      }

      await replyWithSplit(
        ctx,
        `🗑️ quiz.json 항목 삭제 완료\n\n제품: ${target}\n정답: ${JSON.stringify(deletedAnswer)}${gitNotice}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error('quiz.json 삭제 실패', error);
      await replyWithSplit(ctx, `❌ quiz.json 삭제 실패: ${message}`);
    }
  });
}
