import { describe, it, expect, beforeEach } from 'vitest';
import { createSeminarDeleteHandler } from '../src/services/telegram/seminar_delete_handler';
import * as seminarRepo from '../src/services/seminar_repository';
import type { Context } from 'telegraf';

describe('seminar_delete_handler 단위 테스트', () => {
  const mockSeminars = [
    {
      seminarId: '8801',
      name: '테스트 세미나 1',
      url: 'https://m.doctorville.co.kr/cme/seminar/8801',
      date: '2026-09-10',
      time: '13:00~14:00',
      currentCount: '10',
      totalCount: '1000',
      nightTime: false,
      isAdvancedSurvey: false,
    },
    {
      seminarId: '8802',
      name: '테스트 세미나 2',
      url: 'https://m.doctorville.co.kr/cme/seminar/8802',
      date: '2026-09-11',
      time: '19:00~20:00',
      currentCount: '50',
      totalCount: '500',
      nightTime: true,
      isAdvancedSurvey: false,
    },
  ];

  beforeEach(() => {
    seminarRepo.clearSeminars();
    seminarRepo.upsertSeminars(mockSeminars);
  });

  it('세미나 ID가 없는 경우 사용법을 안내해야 한다', async () => {
    const handler = createSeminarDeleteHandler();
    const replies: string[] = [];
    const ctx = {
      message: { text: '/delete_seminar' },
      from: { username: 'admin' },
      reply: async (msg: string) => {
        replies.push(msg);
      },
    } as unknown as Context;

    await handler(ctx);
    expect(replies[0]).toContain('사용법: /delete_seminar <세미나번호>');
  });

  it('단일 세미나 삭제가 정상 동작하고 결과 메시지를 반환해야 한다', async () => {
    const handler = createSeminarDeleteHandler();
    const replies: string[] = [];
    const ctx = {
      message: { text: '/delete_seminar 8801' },
      from: { username: 'admin' },
      reply: async (msg: string) => {
        replies.push(msg);
      },
    } as unknown as Context;

    await handler(ctx);
    expect(replies[0]).toContain('세미나 DB 삭제 결과 (총 1/1개 삭제)');
    expect(replies[0]).toContain('<code>8801</code> - 테스트 세미나 1 (2026-09-10): 삭제 완료');
    expect(seminarRepo.getSeminarById('8801')).toBeNull();
    expect(seminarRepo.getSeminarById('8802')).not.toBeNull();
  });

  it('복수 세미나 삭제 및 존재하지 않는 세미나 처리가 정상 동작해야 한다', async () => {
    const handler = createSeminarDeleteHandler();
    const replies: string[] = [];
    const ctx = {
      message: { text: '/delete_seminar 8801 8802 9999' },
      from: { username: 'admin' },
      reply: async (msg: string) => {
        replies.push(msg);
      },
    } as unknown as Context;

    await handler(ctx);
    expect(replies[0]).toContain('세미나 DB 삭제 결과 (총 2/3개 삭제)');
    expect(replies[0]).toContain('<code>8801</code> - 테스트 세미나 1 (2026-09-10): 삭제 완료');
    expect(replies[0]).toContain('<code>8802</code> - 테스트 세미나 2 (2026-09-11): 삭제 완료');
    expect(replies[0]).toContain('<code>9999</code>: DB에 존재하지 않음');
    expect(seminarRepo.getSeminarById('8801')).toBeNull();
    expect(seminarRepo.getSeminarById('8802')).toBeNull();
  });
});
