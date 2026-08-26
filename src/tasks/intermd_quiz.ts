import { InterMDClient, type InterMDTodayQuiz, type InterMDSubmitResult } from '../modules/intermd_api';
import { sendTelegram } from '../modules/utils';
import * as logger from '../services/logger';
import * as storage from '../services/storage';
import { sendInterMDQuizToSubscribers } from '../services/intermd_quiz_subscribers';
import type { TaskContext, TaskResult } from '../types';

export const INTERMD_QUIZ_CACHE_KEY = 'intermd_quiz:today_cache';
export const INTERMD_QUIZ_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1일 TTL

export interface InterMDQuizCache {
  date: string; // YYYY-MM-DD (KST)
  timestamp: number;
  quizTitle: string;
  dateText: string;
  hint?: string;
  guide?: string;
  questions: Array<{
    ques_pseq: number;
    title: string;
    items: Array<{
      item_pseq: number;
      title: string;
      order: number;
      is_answer_hint: boolean;
    }>;
  }>;
  answerItem?: {
    order: number;
    title: string;
  };
  formattedMessage: string;
}

export function getSeoulDateString(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const year = parts.find((p) => p.type === 'year')?.value || '1970';
  const month = parts.find((p) => p.type === 'month')?.value || '01';
  const day = parts.find((p) => p.type === 'day')?.value || '01';
  return `${year}-${month}-${day}`;
}

export function getInterMDQuizCache(): InterMDQuizCache | null {
  const cache = storage.get<InterMDQuizCache>(INTERMD_QUIZ_CACHE_KEY, null);
  if (!cache) return null;

  const now = Date.now();
  if (now - cache.timestamp > INTERMD_QUIZ_CACHE_TTL_MS) {
    return null;
  }
  return cache;
}

export function setInterMDQuizCache(cache: InterMDQuizCache): void {
  storage.set(INTERMD_QUIZ_CACHE_KEY, cache);
}

export function clearInterMDQuizCache(): void {
  storage.deleteKey(INTERMD_QUIZ_CACHE_KEY);
}

export function stripHtmlTags(html: string): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/&middot;/g, '·')
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&lsquo;|&rsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function formatInterMDQuizMessage(quiz: InterMDTodayQuiz, submitResult?: InterMDSubmitResult | null): string {
  const parts: string[] = [];

  parts.push(`📋 [인터엠디 오늘의 퀴즈]`);
  parts.push(`📌 ${quiz.quiz_title} (${quiz.date})`);

  if (quiz.hint && quiz.hint.trim()) {
    parts.push(`💡 힌트: ${quiz.hint.trim()}`);
  }

  for (let i = 0; i < quiz.questions.length; i++) {
    const q = quiz.questions[i];
    parts.push('');
    parts.push(`❓ Q${i + 1}. ${q.title}`);
    for (const opt of q.items) {
      const isAnswer = opt.is_answer_hint;
      const tag = isAnswer ? ' (★ 정답)' : '';
      parts.push(`  ${opt.order}. ${opt.title}${tag}`);
    }
  }

  if (submitResult) {
    parts.push('');
    if (submitResult.already_submitted) {
      parts.push(`ℹ️ 상태: 이미 참여 완료된 퀴즈입니다.`);
    } else if (submitResult.success) {
      const itemTitle = submitResult.submitted_item
        ? `${submitResult.submitted_item.order}. ${submitResult.submitted_item.title}`
        : '정답';
      parts.push(`🎯 제출 결과: ✅ 정답 제출 완료 (선택: ${itemTitle})`);
    } else {
      parts.push(`🎯 제출 결과: ❌ 답안 제출 실패 (${submitResult.message})`);
    }
  }

  if (quiz.guide && quiz.guide.trim()) {
    const cleanGuide = stripHtmlTags(quiz.guide);
    if (cleanGuide) {
      parts.push('');
      parts.push(`📖 [해설]\n${cleanGuide}`);
    }
  }

  return parts.join('\n');
}

export async function run(
  _ctx: TaskContext = {},
  options: { client?: InterMDClient; notify?: boolean } = {},
): Promise<TaskResult> {
  const client = options.client || new InterMDClient();
  const explicitNotify = options.notify;

  logger.info('intermd_quiz task started');

  try {
    const authOk = await client.ensureAuthenticated();
    if (!authOk) {
      const errMsg = '❗ [인터엠디 오늘의 퀴즈] 로그인/인증에 실패했습니다. 계정 정보를 확인해주세요.';
      logger.error('intermd_quiz auth failed');
      if (explicitNotify !== false) {
        await sendTelegram(errMsg).catch(() => {});
      }
      return { success: false, message: errMsg };
    }

    const quiz = await client.getTodayQuiz();
    if (!quiz) {
      const noQuizMsg = 'ℹ️ [인터엠디 오늘의 퀴즈] 오늘 출제된 퀴즈가 없습니다.';
      logger.info('intermd_quiz no quiz found today');
      // 퀴즈가 없는 날은 스케줄 실행 결과 silent: true (관리자봇 및 공지봇 모두 silent)
      if (explicitNotify === true) {
        await sendTelegram(noQuizMsg).catch(() => {});
      }
      return { success: true, silent: true, message: noQuizMsg };
    }

    let submitResult: InterMDSubmitResult;
    if (quiz.already_submitted) {
      submitResult = {
        success: true,
        already_submitted: true,
        message: '이미 참여 완료된 퀴즈입니다.',
        quiz_title: quiz.quiz_title,
      };
    } else {
      logger.info(`intermd_quiz submitting answer for ${quiz.quiz_title}`);
      submitResult = await client.submitTodayQuiz(quiz);
    }

    const message = formatInterMDQuizMessage(quiz, submitResult);

    // 정답 항목 탐색
    let answerItem: { order: number; title: string } | undefined = undefined;
    if (quiz.questions && quiz.questions.length > 0) {
      const firstQ = quiz.questions[0];
      const found = firstQ.items.find((it) => it.is_answer_hint);
      if (found) {
        answerItem = { order: found.order, title: found.title };
      }
    }

    // 퀴즈 및 정답 정보 캐싱 (TTL 1일)
    const cacheData: InterMDQuizCache = {
      date: getSeoulDateString(),
      timestamp: Date.now(),
      quizTitle: quiz.quiz_title,
      dateText: quiz.date,
      hint: quiz.hint || undefined,
      guide: quiz.guide || undefined,
      questions: quiz.questions,
      answerItem,
      formattedMessage: message,
    };
    setInterMDQuizCache(cacheData);

    // 1. 관리자 봇으로 알림 전송
    if (explicitNotify !== false) {
      await sendTelegram(message).catch((err) => {
        logger.error('Failed to send Telegram message for intermd_quiz:', err);
      });
    }

    // 2. 공지봇 구독자들에게 캐싱한 정보 함께 발송
    if (explicitNotify !== false) {
      await sendInterMDQuizToSubscribers(message).catch((err) => {
        logger.error('Failed to send InterMD quiz to subscribers:', err);
      });
    }

    return {
      success: submitResult.success,
      message,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('intermd_quiz task error:', error);
    const errMsg = `❗ [인터엠디 오늘의 퀴즈] 작업 중 오류가 발생했습니다: ${message}`;
    if (explicitNotify !== false) {
      await sendTelegram(errMsg).catch(() => {});
    }
    return {
      success: false,
      message: errMsg,
    };
  }
}
