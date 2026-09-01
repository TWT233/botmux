import { describe, expect, it } from 'vitest';

import { buildBtwCard } from '../src/features/btw/card.js';
import type { BtwOperation } from '../src/features/btw/types.js';
import { makeBtwOperation } from './fixtures/btw-fixtures.js';

function operationFor(
  state: BtwOperation['execution']['state'],
  extra: Partial<BtwOperation['execution']> = {},
): BtwOperation {
  const base = makeBtwOperation();
  return {
    ...base,
    execution: { ...base.execution, state, ...extra },
  };
}

function parsedCard(operation: BtwOperation, locale: 'zh' | 'en') {
  return JSON.parse(buildBtwCard(operation, locale));
}

describe('buildBtwCard', () => {
  it.each([
    ['zh', 'card_pending', '旁问已接收', 'yellow', '**状态**\n旁问已接收'],
    ['zh', 'running', '旁问进行中', 'blue', '**状态**\n旁问进行中'],
    ['zh', 'completed', '旁问已完成', 'green', '**完整答案**\n完整答案'],
    ['zh', 'failed', '旁问失败', 'red', '**详情**\nprovider failed'],
    ['zh', 'cancelled', '旁问已取消', 'grey', '**详情**\n已取消'],
    ['zh', 'interrupted', '旁问已中断', 'orange', '**详情**\n运行时已退出'],
    ['zh', 'submission_unknown', '旁问提交状态未知', 'orange', '**详情**\n提交结果未知'],
    ['zh', 'card_unknown', '旁问卡片状态未知', 'red', '**详情**\n卡片创建结果未知'],
    ['en', 'card_pending', 'Side question received', 'yellow', '**Status**\nSide question received'],
    ['en', 'running', 'Side question running', 'blue', '**Status**\nSide question running'],
    ['en', 'completed', 'Side question completed', 'green', '**Full answer**\n完整答案'],
    ['en', 'failed', 'Side question failed', 'red', '**Details**\nprovider failed'],
    ['en', 'cancelled', 'Side question cancelled', 'grey', '**Details**\nCancelled'],
    ['en', 'interrupted', 'Side question interrupted', 'orange', '**Details**\nRuntime exited'],
    ['en', 'submission_unknown', 'Side question submission unknown', 'orange', '**Details**\nSubmission result is unknown'],
    ['en', 'card_unknown', 'Side question card status unknown', 'red', '**Details**\nCard creation result is unknown'],
  ] as const)('renders the exact %s %s display card', (locale, state, status, template, resultBody) => {
    const detailByState: Partial<Record<BtwOperation['execution']['state'], Partial<BtwOperation['execution']>>> = {
      completed: { answer: '完整答案' },
      failed: { message: 'provider failed' },
      cancelled: { message: locale === 'zh' ? '已取消' : 'Cancelled' },
      interrupted: { message: locale === 'zh' ? '运行时已退出' : 'Runtime exited' },
      submission_unknown: { message: locale === 'zh' ? '提交结果未知' : 'Submission result is unknown' },
      card_unknown: { message: locale === 'zh' ? '卡片创建结果未知' : 'Card creation result is unknown' },
    };
    const card = parsedCard(operationFor(state, detailByState[state]), locale);

    expect(card).toEqual({
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: `💬 ${locale === 'zh' ? '旁问' : 'Side question'} · ${status}` },
        template,
      },
      elements: [
        { tag: 'markdown', content: `**${locale === 'zh' ? '问题' : 'Question'}**\nWhat changed in the upstream delivery path?` },
        { tag: 'markdown', content: resultBody },
      ],
    });
  });

  it('renders the durable delivery failure instead of the oversized answer', () => {
    const base = operationFor('completed', { answer: 'DO_NOT_RENDER'.repeat(20_000) });
    const operation: BtwOperation = {
      ...base,
      projection: {
        ...base.projection,
        deliveryFailure: {
          kind: 'visible_fallback',
          errorCode: 'payload_too_large',
          message: '完整答案超过飞书卡片大小限制',
        },
      },
    };

    const card = parsedCard(operation, 'zh');
    expect(card).toEqual({
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '💬 旁问 · 旁问结果投递失败' },
        template: 'red',
      },
      elements: [
        { tag: 'markdown', content: '**问题**\nWhat changed in the upstream delivery path?' },
        { tag: 'markdown', content: '**详情**\n完整答案超过飞书卡片大小限制' },
      ],
    });
    expect(JSON.stringify(card)).not.toContain('DO_NOT_RENDER');
  });

  it('renders the exact English delivery-failed view', () => {
    const base = operationFor('completed', { answer: 'DO_NOT_RENDER' });
    const card = parsedCard({
      ...base,
      projection: {
        ...base.projection,
        deliveryFailure: {
          kind: 'visible_fallback',
          errorCode: 'payload_too_large',
          message: 'The full answer exceeds the Lark card size limit',
        },
      },
    }, 'en');

    expect(card).toEqual({
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '💬 Side question · Side question delivery failed' },
        template: 'red',
      },
      elements: [
        { tag: 'markdown', content: '**Question**\nWhat changed in the upstream delivery path?' },
        { tag: 'markdown', content: '**Details**\nThe full answer exceeds the Lark card size limit' },
      ],
    });
  });

  it('contains no session action, lifecycle action, or pin request', () => {
    const json = buildBtwCard(operationFor('completed', { answer: 'done' }), 'zh');
    const card = JSON.parse(json);

    expect(card.elements.every((element: { tag: string }) => element.tag === 'markdown')).toBe(true);
    expect(json).not.toMatch(/action|button|session_id|open_terminal|close_session|pin/i);
  });
});
