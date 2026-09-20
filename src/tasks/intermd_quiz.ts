import { InterMDClient, type InterMDTodayQuiz, type InterMDSubmitResult } from '../modules/intermd_api';
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

export function formatInterMDQuizMessage(
  quiz: InterMDTodayQuiz,
  submitResult?: InterMDSubmitResult | null,
  pointInfo?: { memberPoint?: number; memberPointExpire?: number } | null,
): string {
  const parts: string[] = [];

  parts.push(`📋 [인터엠디 오늘의 퀴즈]`);
  parts.push(`📌 ${quiz.quiz_title} (${quiz.date})`);

  const answerTexts: string[] = [];
  for (const q of quiz.questions) {
    const found = q.items.find((it) => it.is_answer_hint);
    if (found) {
      answerTexts.push(`${found.order}. ${found.title}`);
    }
  }
  if (answerTexts.length > 0) {
    parts.push(`정답: ${answerTexts.join(', ')}`);
  }

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

  if (pointInfo && typeof pointInfo.memberPoint === 'number') {
    parts.push('');
    let pointText = `💰 보유 포인트: ${pointInfo.memberPoint.toLocaleString()} P`;
    if (pointInfo.memberPointExpire !== undefined && pointInfo.memberPointExpire > 0) {
      pointText += ` (소멸예정: ${pointInfo.memberPointExpire.toLocaleString()}P)`;
    }
    parts.push(pointText);
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
      return { success: false, message: errMsg };
    }

    const quiz = await client.getTodayQuiz();
    if (!quiz) {
      let memberPoint: number | undefined = undefined;
      try {
        if (typeof client.getPointInfo === 'function') {
          const ptData = await client.getPointInfo();
          if (ptData && typeof ptData.memberPoint === 'number') {
            memberPoint = ptData.memberPoint;
          }
        }
        if (memberPoint === undefined && typeof client.memberInfo?.memberPoint === 'number') {
          memberPoint = client.memberInfo.memberPoint;
        }
      } catch (_e) {
        /* ignore */
      }

      const noQuizMsg = 'ℹ️ [인터엠디 오늘의 퀴즈] 오늘 출제된 퀴즈가 없습니다.';
      logger.info('intermd_quiz no quiz found today');
      // 퀴즈가 없는 날은 스케줄 실행 결과 silent: true (관리자봇 및 공지봇 모두 silent)
      return {
        success: true,
        silent: true,
        message: noQuizMsg,
        options: {
          memberPoint,
          point: memberPoint,
        },
      };
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

    // 포인트 정보 조회 (퀴즈 제출 후 최신 보유 포인트 반영)
    let memberPoint: number | undefined = undefined;
    let memberPointExpire: number | undefined = undefined;
    try {
      if (typeof client.getPointInfo === 'function') {
        const ptData = await client.getPointInfo();
        if (ptData && typeof ptData.memberPoint === 'number') {
          memberPoint = ptData.memberPoint;
          memberPointExpire = ptData.memberPointExpire;
        }
      }
      if (memberPoint === undefined && typeof client.memberInfo?.memberPoint === 'number') {
        memberPoint = client.memberInfo.memberPoint;
        if (typeof client.memberInfo?.memberPointExpire === 'number') {
          memberPointExpire = client.memberInfo.memberPointExpire;
        }
      }
    } catch (e) {
      logger.warn('intermd_quiz: failed to fetch point info', e);
    }

    // 순수 퀴즈 정보 메시지 (공지봇 및 캐시용: 상태정보 및 개인 포인트 제외)
    const quizInfoMessage = formatInterMDQuizMessage(quiz);

    // 관리자용 메시지 (상태정보 및 포인트 포함)
    const adminMessage = formatInterMDQuizMessage(quiz, submitResult, {
      memberPoint,
      memberPointExpire,
    });

    // 정답 항목 탐색
    let answerItem: { order: number; title: string } | undefined = undefined;
    if (quiz.questions && quiz.questions.length > 0) {
      const firstQ = quiz.questions[0];
      const found = firstQ.items.find((it) => it.is_answer_hint);
      if (found) {
        answerItem = { order: found.order, title: found.title };
      }
    }

    // 퀴즈 및 정답 정보 캐싱 (TTL 1일 - 공지봇 조회용 formattedMessage는 상태정보 없는 순수 퀴즈 정보)
    const cacheData: InterMDQuizCache = {
      date: getSeoulDateString(),
      timestamp: Date.now(),
      quizTitle: quiz.quiz_title,
      dateText: quiz.date,
      hint: quiz.hint || undefined,
      guide: quiz.guide || undefined,
      questions: quiz.questions,
      answerItem,
      formattedMessage: quizInfoMessage,
    };
    setInterMDQuizCache(cacheData);

    // 공지봇 구독자들에게는 순수 퀴즈 정보만 발송 (상태정보 제외)
    if (explicitNotify !== false) {
      await sendInterMDQuizToSubscribers(quizInfoMessage).catch((err) => {
        logger.error('Failed to send InterMD quiz to subscribers:', err);
      });
    }

    // 관리자 봇으로 상태정보 포함 메시지 반환 (스케줄러/수동 실행 시 관리자에게 전달)
    return {
      success: submitResult.success,
      message: adminMessage,
      options: {
        memberPoint,
        point: memberPoint,
      },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('intermd_quiz task error:', error);
    const errMsg = `❗ [인터엠디 오늘의 퀴즈] 작업 중 오류가 발생했습니다: ${message}`;
    return {
      success: false,
      message: errMsg,
    };
  }
}
