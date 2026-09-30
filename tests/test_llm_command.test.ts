import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Telegraf, type Context } from 'telegraf';
import { setupSystemCommands } from '../src/services/telegram/admin_handlers/system';
import * as seminarQuizModule from '../src/tasks/seminar_quiz';
import * as utilsModule from '../src/modules/utils';

type CommandHandler = (ctx: unknown) => Promise<unknown> | unknown;

describe('test_llm 텔레그램 명령어 단위 테스트', () => {
  let adminBot: Telegraf;
  let commandHandlers: Map<string, CommandHandler>;

  beforeEach(() => {
    vi.restoreAllMocks();
    commandHandlers = new Map();

    adminBot = {
      command: vi.fn().mockImplementation((commands: string | string[], handler: CommandHandler) => {
        const cmdList = Array.isArray(commands) ? commands : [commands];
        for (const cmd of cmdList) {
          commandHandlers.set(cmd, handler);
        }
      }),
    } as unknown as Telegraf;

    setupSystemCommands(adminBot);
  });

  it('test_llm 및 llm 명령어가 등록되어 있어야 한다', () => {
    expect(commandHandlers.has('test_llm')).toBe(true);
    expect(commandHandlers.has('llm')).toBe(true);
  });

  it('인자 없이 호출 시 기본 프롬프트로 Hermes AI에 질의하고 결과를 성공 응답한다', async () => {
    const handler = commandHandlers.get('test_llm')!;
    const replyMock = vi.spyOn(utilsModule, 'replyWithSplit').mockResolvedValue(undefined);
    const requestSpy = vi
      .spyOn(seminarQuizModule, 'requestHermesAiSurveyAnswer')
      .mockResolvedValue('안녕하세요! Hermes LLM 정상 동작 중입니다.');

    const ctx = {
      message: {
        text: '/test_llm',
      },
      from: { username: 'testadmin' },
    } as unknown as Context;

    await handler(ctx);

    expect(requestSpy).toHaveBeenCalledWith(
      '안녕하세요! 연결 및 응답 테스트입니다. 1줄 이내로 간단하게 자기소개와 현재 상태를 응답해주세요.',
      'Hermes LLM 테스트',
      false,
    );
    expect(replyMock).toHaveBeenCalledTimes(2);

    // 1차 요청 중 메시지
    expect(replyMock.mock.calls[0][1]).toContain('⏳ [Hermes AI 질의 중...]');

    // 2차 성공 메시지
    const successMsg = replyMock.mock.calls[1][1] as string;
    expect(successMsg).toContain('🤖 [Hermes AI 테스트 성공]');
    expect(successMsg).toContain('안녕하세요! Hermes LLM 정상 동작 중입니다.');
  });

  it('사용자 지정 프롬프트가 주어지면 해당 프롬프트로 질의한다', async () => {
    const handler = commandHandlers.get('llm')!;
    const replyMock = vi.spyOn(utilsModule, 'replyWithSplit').mockResolvedValue(undefined);
    const requestSpy = vi
      .spyOn(seminarQuizModule, 'requestHermesAiSurveyAnswer')
      .mockResolvedValue('고혈압 치료제에 대한 설명입니다.');

    const ctx = {
      message: {
        text: '/llm 고혈압 치료제의 최신 가이드라인을 요약해줘',
      },
      from: { username: 'testadmin' },
    } as unknown as Context;

    await handler(ctx);

    expect(requestSpy).toHaveBeenCalledWith('고혈압 치료제의 최신 가이드라인을 요약해줘', 'Hermes LLM 테스트', false);
    expect(replyMock).toHaveBeenCalledTimes(2);

    const successMsg = replyMock.mock.calls[1][1] as string;
    expect(successMsg).toContain('고혈압 치료제의 최신 가이드라인을 요약해줘');
    expect(successMsg).toContain('고혈압 치료제에 대한 설명입니다.');
  });

  it('Hermes AI 응답이 실패(null)하면 에러 안내 메시지를 회신한다', async () => {
    const handler = commandHandlers.get('test_llm')!;
    const replyMock = vi.spyOn(utilsModule, 'replyWithSplit').mockResolvedValue(undefined);
    vi.spyOn(seminarQuizModule, 'requestHermesAiSurveyAnswer').mockResolvedValue(null);

    const ctx = {
      message: {
        text: '/test_llm 헬스체크',
      },
      from: { username: 'testadmin' },
    } as unknown as Context;

    await handler(ctx);

    expect(replyMock).toHaveBeenCalledTimes(2);
    const failMsg = replyMock.mock.calls[1][1] as string;
    expect(failMsg).toContain('❌ [Hermes AI 테스트 실패]');
  });

  it('답장(reply_to_message)으로 호출 시 답장 메시지 내용을 프롬프트로 활용한다', async () => {
    const handler = commandHandlers.get('test_llm')!;
    const replyMock = vi.spyOn(utilsModule, 'replyWithSplit').mockResolvedValue(undefined);
    const requestSpy = vi
      .spyOn(seminarQuizModule, 'requestHermesAiSurveyAnswer')
      .mockResolvedValue('Q1: 1번이 정답입니다.');

    const ctx = {
      message: {
        text: '/test_llm',
        reply_to_message: {
          text: 'Q1: 다음 중 올바른 약제 복용법은 무엇인가요?\n1) 식후 30분\n2) 취침 전',
        },
      },
      from: { username: 'testadmin' },
    } as unknown as Context;

    await handler(ctx);

    expect(requestSpy).toHaveBeenCalledWith(
      'Q1: 다음 중 올바른 약제 복용법은 무엇인가요?\n1) 식후 30분\n2) 취침 전',
      'Hermes LLM 테스트',
      false,
    );
    expect(replyMock).toHaveBeenCalledTimes(2);

    const successMsg = replyMock.mock.calls[1][1] as string;
    expect(successMsg).toContain('Q1: 1번이 정답입니다.');
  });
});
