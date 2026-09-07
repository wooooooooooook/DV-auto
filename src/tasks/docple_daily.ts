import fs from 'fs/promises';
import path from 'path';
import type { TaskContext, TaskResult } from '../types';
import {
  loginDocple,
  getDocpleCash,
  getDocpleAttendanceCalendar,
  checkDocpleAttendance,
  getDocpleEdetailingMedicines,
  extractDocpleQuizUrls,
  getDocpleActiveQuizzes,
  getDocpleQuizDetail,
  getDocpleMedicineDetail,
  formatDocpleQuizTelegramMessage,
  submitDocpleQuiz,
  matchDocpleQuizAnswersWithCheatsheet,
  authDocpleCommunityPassword,
  getDocpleCommunityPosts,
  recommendDocpleCommunityPost,
  type DocpleAttendanceResult,
} from '../modules/docple_api';
import { sendTelegram } from '../modules/utils';
import * as logger from '../services/logger';

const SEMINAR_QUIZ_CHEATSHEET_PATH = path.join(process.cwd(), 'data/seminar_quiz_cheatsheet.json');

async function loadCheatsheet(): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(SEMINAR_QUIZ_CHEATSHEET_PATH, 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

export interface DocpleDailyWorkflowResult {
  success: boolean;
  message: string;
  startCash: number;
  endCash: number;
  cashDiff: number;
  attendance: DocpleAttendanceResult;
  quizList: Array<{ id: number | string; name: string; url: string; status?: string }>;
  recommendedPosts: Array<{
    tid: number;
    title: string;
    subCode?: string;
    success: boolean;
    message: string;
  }>;
  errors: string[];
}

export function formatDocpleDailyReport(res: DocpleDailyWorkflowResult): string {
  const now = new Date();
  const kstDateStr = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(now);

  const lines: string[] = [
    '📋 [닥플 플러스 일일 자동화 리포트]',
    `📅 일시: ${kstDateStr}`,
    `💰 캐시: ${res.startCash.toLocaleString()}원 → ${res.endCash.toLocaleString()}원 (${res.cashDiff >= 0 ? `+${res.cashDiff.toLocaleString()}` : `${res.cashDiff.toLocaleString()}`}원)`,
  ];

  // 1. 출석체크
  if (res.attendance.status === 'SUCCESS') {
    lines.push(`✅ 출석체크: 완료 (+${res.attendance.rewardCash ?? 0}원)`);
  } else if (res.attendance.status === 'ALREADY') {
    lines.push('ℹ️ 출석체크: 이미 오늘 출석 완료');
  } else {
    lines.push(`⚠️ 출석체크 실패: ${res.attendance.message}`);
  }

  // 2. 퀴즈 URL
  lines.push(`\n💊 e-디테일링 Quiz (${res.quizList.length}건):`);
  if (res.quizList.length > 0) {
    res.quizList.forEach((q, idx) => {
      const statusText = q.status ? ` (${q.status})` : '';
      lines.push(`  ${idx + 1}. [${q.name}]${statusText}\n     URL: ${q.url}`);
    });
  } else {
    lines.push('  • 진행 중인 퀴즈 대상 의약품이 없습니다.');
  }

  // 3. 커뮤니티 추천
  lines.push(`\n👍 커뮤니티 추천 (${res.recommendedPosts.length}건):`);
  if (res.recommendedPosts.length > 0) {
    res.recommendedPosts.forEach((p, idx) => {
      const statusIcon = p.success ? '✅' : '❌';
      lines.push(`  ${idx + 1}. ${statusIcon} [${p.tid}] ${p.title} (${p.message})`);
    });
  } else {
    lines.push('  • 추천 가능한 최신 일반 게시글이 없습니다.');
  }

  // 4. 오류 내역
  if (res.errors.length > 0) {
    lines.push(`\n⚠️ 기타 오류/경고 (${res.errors.length}건):`);
    res.errors.forEach((err) => lines.push(`  • ${err}`));
  }

  return lines.join('\n');
}

export async function executeDocpleDaily(
  customUser?: string,
  customPass?: string,
  customCommPass?: string,
): Promise<DocpleDailyWorkflowResult> {
  const username = customUser || process.env.DOCPLE_USER || '';
  const password = customPass || process.env.DOCPLE_PASS || '';
  const commPass = customCommPass || process.env.DOCPLE_COMM_PASS || password;

  const errors: string[] = [];

  if (!username || !password) {
    throw new Error('닥플 로그인 자격 증명이 설정되지 않았습니다 (DOCPLE_USER, DOCPLE_PASS).');
  }

  logger.info('Docple daily: Step 1. Logging in...');
  const loginRes = await loginDocple(username, password);
  if (!loginRes.success || !loginRes.data?.accessToken) {
    throw new Error(`닥플 로그인 실패: ${loginRes.message}`);
  }

  const accessToken = loginRes.data.accessToken;

  // 시작 캐시 확인
  logger.info('Docple daily: Step 2. Checking initial cash balance...');
  const initialCashInfo = await getDocpleCash(accessToken);
  const startCash = initialCashInfo?.totalCash ?? 0;

  // 출석체크 상태 확인 및 실행
  logger.info('Docple daily: Step 3. Checking attendance...');
  const cal = await getDocpleAttendanceCalendar(accessToken);
  let attendanceRes: DocpleAttendanceResult;
  if (cal.attendedToday) {
    attendanceRes = {
      status: 'ALREADY',
      message: '이미 오늘 출석 완료',
    };
  } else {
    attendanceRes = await checkDocpleAttendance(accessToken);
  }

  // e-디테일링 퀴즈 처리 (족보 확인 -> 자동 제출 또는 텔레그램 알림)
  logger.info('Docple daily: Step 4. Processing e-detailing quizzes with cheatsheet...');
  const quizList: Array<{ id: number | string; name: string; url: string; status?: string }> = [];
  try {
    const cheatsheet = await loadCheatsheet();
    const activeQuizzes = await getDocpleActiveQuizzes(accessToken);

    if (activeQuizzes.length > 0) {
      for (const q of activeQuizzes) {
        const medId = q.medicineId || 0;
        const [quizDetail, medDetail] = await Promise.all([
          getDocpleQuizDetail(accessToken, q.quizId),
          medId ? getDocpleMedicineDetail(accessToken, medId) : Promise.resolve(null),
        ]);

        const medName = medDetail?.medicineName || q.quizName;
        const quizUrl = `https://docple-plus.com/e-detailing/${medId || ''}`;

        if (!quizDetail) {
          quizList.push({ id: medId || q.quizId, name: medName, url: quizUrl });
          continue;
        }

        // 1. 이미 퀴즈를 통과한 경우
        if (quizDetail.hasPassedBefore) {
          quizList.push({ id: medId || q.quizId, name: medName, url: quizUrl, status: '이미 참여 완료' });
          continue;
        }

        // 2. 족보 매칭 시도
        const matchResult = matchDocpleQuizAnswersWithCheatsheet(quizDetail, cheatsheet);
        if (matchResult.isFullyMatched && quizDetail.canAttempt !== false) {
          logger.info(`Docple daily: Submitting quiz ${q.quizId} using cheatsheet...`);
          const submitRes = await submitDocpleQuiz(
            accessToken,
            q.quizId,
            matchResult.answers.map((a) => ({
              questionId: a.questionId,
              selectedOptionId: a.selectedOptionId,
            })),
          );

          if (submitRes.isPassed) {
            const rewardMsg = submitRes.grantedCash ? ` (+${submitRes.grantedCash} 캐시)` : '';
            quizList.push({
              id: medId || q.quizId,
              name: medName,
              url: quizUrl,
              status: `족보 자동 제출 완료${rewardMsg}`,
            });

            await sendTelegram(
              `✅ [닥플 퀴즈 정답 자동 제출 완료]\n\n• 의약품: ${medName}\n• 결과: 정답${rewardMsg}\n• 제출 정답:\n${matchResult.answers.map((a, i) => `  Q${i + 1}: ${a.optionText}`).join('\n')}`,
            ).catch((sendErr) => {
              logger.warn('Failed to send quiz success message', sendErr);
            });
            continue;
          }
        }

        // 3. 족보가 없거나 미매칭인 경우 관리자 봇으로 문제/보기/상세정보 안내 메시지 발송
        const quizMsg = formatDocpleQuizTelegramMessage({
          quiz: quizDetail,
          medicine: medDetail,
          medicineId: medId,
        });

        await sendTelegram(quizMsg).catch((sendErr) => {
          logger.warn('Failed to send Docple quiz message to admin bot', sendErr);
        });

        quizList.push({
          id: medId || q.quizId,
          name: medName,
          url: quizUrl,
          status: '정답 족보 필요 (텔레그램 답장 대기)',
        });
      }
    } else {
      const medicines = await getDocpleEdetailingMedicines(accessToken, { size: 50 });
      const extracted = extractDocpleQuizUrls(medicines);
      quizList.push(...extracted);
    }
  } catch (err) {
    const msg = `퀴즈 처리 오류: ${err instanceof Error ? err.message : String(err)}`;
    logger.error('Docple daily quiz error', err);
    errors.push(msg);
  }

  // 커뮤니티 인증 및 최신 일반글 5건 추천
  logger.info('Docple daily: Step 5. Community auth and recommending posts...');
  const recommendedPosts: Array<{
    tid: number;
    title: string;
    subCode?: string;
    success: boolean;
    message: string;
  }> = [];

  if (!commPass) {
    errors.push('커뮤니티 비밀번호가 설정되지 않아 커뮤니티 추천을 건너뜁니다.');
  } else {
    try {
      const commAuthRes = await authDocpleCommunityPassword(accessToken, commPass);
      if (!commAuthRes.success) {
        errors.push(`커뮤니티 비밀번호 인증 실패: ${commAuthRes.message}`);
      } else {
        const commToken = commAuthRes.communityToken;
        const posts = await getDocpleCommunityPosts(accessToken, {
          grpCode: 'NI',
          subCode: '',
          page: 1,
          size: 30,
          communityToken: commToken,
        });

        // 공지, 이벤트, SOS, 삭제글, 이미 추천한 글 제외하고 최신순 정렬
        const eligiblePosts = posts.filter(
          (p) => !p.isNotice && !p.isEvent && !p.isSOS && !p.isDeleted && !p.isRecommended,
        );

        const targetPosts = eligiblePosts.slice(0, 5);
        for (const post of targetPosts) {
          const recRes = await recommendDocpleCommunityPost(accessToken, {
            bid: post.bid || post.tid,
            no: post.no,
            grpCode: post.grpCode || 'NI',
            subCode: post.subCode || '',
            communityToken: commToken,
          });

          recommendedPosts.push({
            tid: post.bid || post.tid,
            title: post.title,
            subCode: post.subCode,
            success: recRes.success,
            message: recRes.message,
          });
        }
      }
    } catch (err) {
      const msg = `커뮤니티 추천 프로세스 오류: ${err instanceof Error ? err.message : String(err)}`;
      logger.error('Docple daily community error', err);
      errors.push(msg);
    }
  }

  // 종료 캐시 확인
  logger.info('Docple daily: Step 6. Checking final cash balance...');
  const finalCashInfo = await getDocpleCash(accessToken);
  const endCash = finalCashInfo?.totalCash ?? startCash;
  const cashDiff = endCash - startCash;

  const result: DocpleDailyWorkflowResult = {
    success: true,
    message: '닥플 일일 자동화 완료',
    startCash,
    endCash,
    cashDiff,
    attendance: attendanceRes,
    quizList,
    recommendedPosts,
    errors,
  };

  return result;
}

export async function run(ctx?: TaskContext): Promise<TaskResult> {
  try {
    const customUser = ctx?.args?.user;
    const customPass = ctx?.args?.password;
    const customCommPass = ctx?.args?.communityPassword;

    const result = await executeDocpleDaily(customUser, customPass, customCommPass);
    const reportText = formatDocpleDailyReport(result);

    return {
      success: result.success && result.attendance.status !== 'FAILED',
      message: reportText,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('docple_daily task error:', err);
    return {
      success: false,
      message: `❌ [닥플 일일 자동화 실패]\n사유: ${errorMsg}`,
    };
  }
}
