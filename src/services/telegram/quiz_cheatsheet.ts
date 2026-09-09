import fs from 'fs/promises';
import path from 'path';
import { exec } from 'child_process';
import * as logger from '../logger';

export const SEMINAR_QUIZ_CHEATSHEET_FILE = 'data/seminar_quiz_cheatsheet.json';
export const SEMINAR_QUIZ_CHEATSHEET_PATH = path.join(process.cwd(), SEMINAR_QUIZ_CHEATSHEET_FILE);
export const QUIZ_FILE = 'data/quiz.json';
export const QUIZ_PATH = path.join(process.cwd(), QUIZ_FILE);

export type SeminarQuizCheatsheet = Record<string, string>;
export type QuizMapping = Record<string, Array<string | number>>;
export type CommandResult = { stdout: string; stderr: string };
export type CommandResultWithExitCode = CommandResult & { exitCode?: number };

export function runShellCommand(command: string): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const wrappedError = new Error(error.message);
        (wrappedError as Error & { stdout?: string; stderr?: string }).stdout = stdout;
        (wrappedError as Error & { stdout?: string; stderr?: string }).stderr = stderr;
        return reject(wrappedError);
      }
      resolve({ stdout, stderr });
    });
  });
}

export function runShellCommandWithAllowedExitCodes(
  command: string,
  allowedExitCodes: number[] = [],
): Promise<CommandResultWithExitCode> {
  return new Promise((resolve, reject) => {
    exec(command, { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const rawExitCode = (error as unknown as NodeJS.ErrnoException & { code?: number | string }).code;
        const exitCode = typeof rawExitCode === 'number' ? rawExitCode : Number.parseInt(String(rawExitCode), 10);
        if (!Number.isNaN(exitCode) && allowedExitCodes.includes(exitCode)) {
          return resolve({ stdout, stderr, exitCode });
        }
        const wrappedError = new Error(error.message);
        (wrappedError as Error & { stdout?: string; stderr?: string }).stdout = stdout;
        (wrappedError as Error & { stderr?: string }).stderr = stderr;
        return reject(wrappedError);
      }
      resolve({ stdout, stderr });
    });
  });
}

export function buildShellArgs(values: string[]): string {
  return values.map((value) => `'${value.replace(/'/g, "'\\''")}'`).join(' ');
}

export async function commitAndPushIfChanged(
  files: string[],
  message: string,
): Promise<{ performed: boolean; notice: string }> {
  const fileArgs = buildShellArgs(files);
  const { stdout: statusOutput } = await runShellCommand(`git status --porcelain -- ${fileArgs}`);
  if (!statusOutput.trim()) {
    return { performed: false, notice: 'ℹ️ Git 변경사항 없음' };
  }

  await runShellCommand(`git add ${fileArgs}`);
  await runShellCommand(`git commit -m ${buildShellArgs([message])}`);
  const { stdout: pushStdout, stderr: pushStderr } = await runShellCommand('git push');

  let notice = '✅ Git 커밋/푸시 완료';
  if (pushStdout.trim() || pushStderr.trim()) {
    const output = `${pushStdout}${pushStderr}`.trim();
    notice = `${notice}\n${output}`;
  }
  return { performed: true, notice };
}

// --- Seminar Quiz Cheatsheet Functions ---
export async function loadSeminarQuizCheatsheet(): Promise<SeminarQuizCheatsheet> {
  try {
    const raw = await fs.readFile(SEMINAR_QUIZ_CHEATSHEET_PATH, 'utf8');
    return JSON.parse(raw) as SeminarQuizCheatsheet;
  } catch (error) {
    logger.warn('세미나 퀴즈 족보 로드 실패, 빈 객체 반환', error);
    return {};
  }
}

export async function saveSeminarQuizCheatsheet(data: SeminarQuizCheatsheet): Promise<void> {
  try {
    await fs.writeFile(SEMINAR_QUIZ_CHEATSHEET_PATH, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch (error) {
    logger.error('세미나 퀴즈 족보 저장 실패', error);
    throw new Error('세미나 퀴즈 족보 파일을 저장할 수 없습니다.');
  }
}

// --- Quiz Mapping (quiz.json) Functions ---
export async function loadQuizMapping(): Promise<QuizMapping> {
  try {
    const raw = await fs.readFile(QUIZ_PATH, 'utf8');
    return JSON.parse(raw) as QuizMapping;
  } catch (error) {
    logger.warn('quiz.json 로드 실패, 빈 객체 반환', error);
    return {};
  }
}

export async function saveQuizMapping(data: QuizMapping): Promise<void> {
  try {
    await fs.writeFile(QUIZ_PATH, `${JSON.stringify(data, null, 4)}\n`, 'utf8');
  } catch (error) {
    logger.error('quiz.json 저장 실패', error);
    throw new Error('quiz.json 파일을 저장할 수 없습니다.');
  }
}

export type ParsedQuizQuestion = { keyword: string; options: string[] };

export function parseQuizQuestionsFromText(content: string): ParsedQuizQuestion[] {
  const lines = content.split('\n').map((l) => l.trim());
  const questions: ParsedQuizQuestion[] = [];
  let currentQuestion: ParsedQuizQuestion | null = null;

  for (const line of lines) {
    // 퀴즈 문제 헤더 인식: "Q1:", "Q1.", "[Q1]", "❓ [Q1]", "❓ [Q1] 문제", "Q1: [퀴즈] 문제" 등
    const qMatch = line.match(/^(?:❓\s*)?\[?Q(\d+)\]?[:.]?\s*(?:\[퀴즈\]\s*)?(.*)$/i);
    if (qMatch && qMatch[1]) {
      const rawKeyword = (qMatch[2] || '').trim();
      const normalizedKeyword = rawKeyword
        .replace(/^["'“”]/, '')
        .replace(/["'“”]$/, '')
        .replace(/\.\.\.$/, '')
        .trim();

      if (normalizedKeyword) {
        currentQuestion = { keyword: normalizedKeyword, options: [] };
        questions.push(currentQuestion);
      } else {
        currentQuestion = { keyword: `Q${qMatch[1]}`, options: [] };
        questions.push(currentQuestion);
      }
      continue;
    }

    // 퀴즈 보기 인식: "1. 보기", "1) 보기", "(1) 보기", "1️⃣ 보기", "1️⃣보기" 등
    if (currentQuestion) {
      const isOption = line.match(/^(?:(?:\d+[.)])|(?:\(\d+\))|(?:\d\uFE0F?\u20E3)|(?:🔟))\s*(.*)$/u);
      if (isOption) {
        const optionText = isOption[1].trim();
        currentQuestion.options.push(optionText);
      }
    }
  }

  return questions;
}

export async function registerQuizAnswersToCheatsheet(
  questions: ParsedQuizQuestion[],
  answers: number[],
): Promise<{ registered: string[]; gitNotice: string }> {
  const data = await loadSeminarQuizCheatsheet();
  const registered: string[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const answerIndex = answers[i];
    const selectedOption = q.options[answerIndex - 1];

    if (selectedOption) {
      data[q.keyword] = selectedOption;
      registered.push(`• ${q.keyword} → ${selectedOption}`);
    }
  }

  await saveSeminarQuizCheatsheet(data);

  let gitNotice = '';
  try {
    const result = await commitAndPushIfChanged(
      [SEMINAR_QUIZ_CHEATSHEET_FILE],
      'update seminar quiz cheatsheet (batch)',
    );
    gitNotice = `\n\n${result.notice}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('세미나 퀴즈 족보 Git 커밋/푸시 실패', error);
    gitNotice = `\n\n⚠️ Git 커밋/푸시 실패: ${message}`;
  }

  return { registered, gitNotice };
}
