import { describe, expect, it, vi } from 'vitest';

import { createBtwProjector } from '../src/features/btw/projector.js';
import type { BtwRuntimeClient } from '../src/features/btw/runtime-protocol.js';
import type { BtwOperation, BtwProjectionItem, FrozenBtwReplyTarget } from '../src/features/btw/types.js';
import { MessageWithdrawnError } from '../src/im/lark/client.js';
import { makeBtwOperation, makeBtwScope } from './fixtures/btw-fixtures.js';

const NOW = new Date('2026-09-01T12:00:00.000Z');

function withTarget(target: Partial<FrozenBtwReplyTarget>): BtwOperation {
  const operation = makeBtwOperation();
  return {
    ...operation,
    replyTarget: { ...operation.replyTarget, ...target },
  };
}

function projectedOperation(overrides: Partial<BtwOperation> = {}): BtwOperation {
  const base = makeBtwOperation();
  return {
    ...base,
    revision: 7,
    card: { ...base.card, messageId: 'om_card_1' },
    execution: {
      ...base.execution,
      state: 'completed',
      answer: '完整答案',
      frameState: 'acknowledged',
    },
    projection: {
      ...base.projection,
      desiredRevision: 4,
      patchedRevision: 2,
    },
    ...overrides,
  };
}

function projectionItem(operation: BtwOperation): BtwProjectionItem {
  return {
    larkAppId: operation.replyTarget.larkAppId,
    botmuxSessionId: operation.parent.botmuxSessionId,
    btwOpId: operation.btwOpId,
    expectedOperationRevision: operation.revision,
    projectionRevision: operation.projection.desiredRevision,
    operation,
  };
}

function harness(listings: BtwProjectionItem[][] = []) {
  const runtime = {
    recordInitialCardAttempt: vi.fn(),
    recordCard: vi.fn(),
    listPendingProjections: vi.fn(),
    recordProjectionFailure: vi.fn(),
    ackProjection: vi.fn(),
  };
  for (const listing of listings) runtime.listPendingProjections.mockResolvedValueOnce(listing);
  runtime.listPendingProjections.mockResolvedValue([]);
  runtime.recordCard.mockImplementation(async (_scope, _opId, _messageId) => ({
    ...makeBtwOperation(),
    revision: 2,
    execution: { ...makeBtwOperation().execution, state: 'accepted' },
    card: { ...makeBtwOperation().card, messageId: _messageId },
  }));
  runtime.recordInitialCardAttempt.mockImplementation(async (_scope, _opId, outcome) => ({
    ...makeBtwOperation(),
    revision: 2,
    card: { ...makeBtwOperation().card, createAttempt: 1, nextCreateAttemptAt: outcome.retryAt },
  }));
  runtime.ackProjection.mockImplementation(async (_scope, _opId, _expected, outcome) => ({
    kind: 'applied',
    operation: projectedOperation({
      revision: 8,
      projection: {
        ...projectedOperation().projection,
        patchedRevision: outcome.kind === 'patched' || outcome.kind === 'replacement_created' ? 4 : 2,
        reminderState: outcome.kind === 'patched' || outcome.kind === 'replacement_created' ? 'pending' : 'none',
      },
    }),
  }));
  runtime.recordProjectionFailure.mockImplementation(async (_scope, _opId, _expected, failure) => ({
    kind: 'applied',
    operation: projectedOperation({
      revision: 8,
      projection: {
        ...projectedOperation().projection,
        desiredRevision: failure.kind === 'visible_fallback' ? 5 : 4,
        deliveryFailure: failure,
      },
    }),
  }));

  const sendMessage = vi.fn(async () => 'om_sent');
  const replyMessage = vi.fn(async () => 'om_reply');
  const updateMessage = vi.fn(async () => undefined);
  const projector = createBtwProjector({
    runtime: runtime as unknown as BtwRuntimeClient,
    sendMessage,
    replyMessage,
    updateMessage,
    localeForApp: () => 'zh',
    now: () => NOW,
  });
  return { projector, runtime, sendMessage, replyMessage, updateMessage };
}

describe('BTW initial card projection', () => {
  it.each([
    ['group topic', { chatType: 'group', chatId: 'oc_group', rootMessageId: 'om_root', replyToMessageId: 'om_parent' }, 'reply', true],
    ['regular group', { chatType: 'group', chatId: 'oc_group', rootMessageId: null, replyToMessageId: 'om_parent' }, 'reply', false],
    ['p2p thread', { chatType: 'p2p', chatId: 'oc_p2p', rootMessageId: 'om_root', replyToMessageId: 'om_parent' }, 'reply', true],
    ['p2p chat', { chatType: 'p2p', chatId: 'oc_p2p', rootMessageId: null, replyToMessageId: null }, 'send', false],
  ] as const)('uses only the frozen %s target', async (_name, target, route, replyInThread) => {
    const { projector, runtime, sendMessage, replyMessage } = harness();
    const operation = withTarget(target);

    await expect(projector.ensureInitialCard(operation)).resolves.toMatchObject({ kind: 'recorded' });

    if (route === 'reply') {
      expect(replyMessage).toHaveBeenCalledWith(
        operation.replyTarget.larkAppId,
        operation.replyTarget.replyToMessageId,
        expect.stringContaining('旁问已接收'),
        'interactive',
        replyInThread,
        operation.card.createUuid,
      );
      expect(sendMessage).not.toHaveBeenCalled();
    } else {
      expect(sendMessage).toHaveBeenCalledWith(
        operation.replyTarget.larkAppId,
        operation.replyTarget.chatId,
        expect.stringContaining('旁问已接收'),
        'interactive',
        operation.card.createUuid,
      );
      expect(replyMessage).not.toHaveBeenCalled();
    }
    expect(runtime.recordCard).toHaveBeenCalledWith(makeBtwScope(), operation.btwOpId, route === 'reply' ? 'om_reply' : 'om_sent');
    expect(runtime.ackProjection).not.toHaveBeenCalled();
  });

  it('single-flights duplicate ingress and recovery creates by operation', async () => {
    const { projector, replyMessage } = harness();
    let release!: (messageId: string) => void;
    replyMessage.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const operation = makeBtwOperation();

    const first = projector.ensureInitialCard(operation);
    const second = projector.ensureInitialCard(operation);
    await vi.waitFor(() => expect(replyMessage).toHaveBeenCalledTimes(1));
    release('om_one_card');

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ kind: 'recorded' }),
      expect.objectContaining({ kind: 'recorded' }),
    ]);
    expect(replyMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ isAxiosError: true, response: { status: 503, data: { msg: 'unavailable' } }, message: 'unavailable' }, 'pending', 'definitely_unsent'],
    [{ isAxiosError: true, config: {}, message: 'socket timeout', code: 'ETIMEDOUT' }, 'unknown', 'unknown'],
  ] as const)('durably records initial create outcomes without generic ACK', async (error, resultKind, outcomeKind) => {
    const { projector, runtime, replyMessage } = harness();
    replyMessage.mockRejectedValueOnce(error);

    await expect(projector.ensureInitialCard(makeBtwOperation())).resolves.toMatchObject({ kind: resultKind });
    expect(runtime.recordInitialCardAttempt).toHaveBeenCalledWith(
      makeBtwScope(),
      makeBtwOperation().btwOpId,
      expect.objectContaining({ kind: outcomeKind, retryAt: '2026-09-01T12:00:01.000Z' }),
    );
    expect(runtime.recordCard).not.toHaveBeenCalled();
    expect(runtime.ackProjection).not.toHaveBeenCalled();
  });
});

describe('BTW terminal card projection', () => {
  it('PATCHes the original card with the complete answer, ACKs the exact revision, then sends one stable reminder', async () => {
    const terminal = projectedOperation();
    const reminder = projectedOperation({
      revision: 8,
      projection: { ...terminal.projection, patchedRevision: 4, reminderState: 'pending' },
    });
    const { projector, runtime, updateMessage, replyMessage } = harness([[projectionItem(terminal)], [projectionItem(reminder)]]);

    await projector.drainApp('cli_app');

    expect(updateMessage).toHaveBeenCalledWith('cli_app', 'om_card_1', expect.stringContaining('完整答案'));
    expect(runtime.ackProjection).toHaveBeenCalledWith(
      makeBtwScope(), terminal.btwOpId,
      { operationRevision: 7, projectionRevision: 4 },
      { kind: 'patched' },
    );
    expect(replyMessage).toHaveBeenCalledWith(
      'cli_app', 'om_reply_1', '旁问已完成', 'text', true, terminal.projection.reminderUuid,
    );
    expect(runtime.ackProjection).toHaveBeenCalledWith(
      makeBtwScope(), terminal.btwOpId,
      { operationRevision: 8, projectionRevision: 4 },
      { kind: 'reminder_sent' },
    );
  });

  it.each([429, 503])('keeps HTTP %s PATCH failures on the same target with a durable retry', async status => {
    const operation = projectedOperation();
    const { projector, runtime, updateMessage, sendMessage, replyMessage } = harness([[projectionItem(operation)]]);
    updateMessage.mockRejectedValueOnce({ isAxiosError: true, response: { status, data: { msg: 'later' } }, message: 'later' });

    await projector.drainApp('cli_app');

    expect(updateMessage).toHaveBeenCalledWith('cli_app', 'om_card_1', expect.any(String));
    expect(runtime.ackProjection).toHaveBeenCalledWith(
      makeBtwScope(), operation.btwOpId,
      { operationRevision: 7, projectionRevision: 4 },
      expect.objectContaining({ kind: 'retryable_failure', retryAt: '2026-09-01T12:00:01.000Z' }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(replyMessage).not.toHaveBeenCalled();
  });

  it('treats an ambiguous PATCH failure as retryable and never creates a replacement', async () => {
    const operation = projectedOperation();
    const { projector, runtime, updateMessage, sendMessage, replyMessage } = harness([[projectionItem(operation)]]);
    updateMessage.mockRejectedValueOnce({ isAxiosError: true, config: {}, message: 'timeout', code: 'ETIMEDOUT' });

    await projector.drainApp('cli_app');

    expect(runtime.ackProjection).toHaveBeenCalledWith(
      makeBtwScope(), operation.btwOpId,
      { operationRevision: 7, projectionRevision: 4 },
      expect.objectContaining({ kind: 'retryable_failure' }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(replyMessage).not.toHaveBeenCalled();
  });

  it('persists withdrawal intent before creating one stable replacement and later revisions PATCH it', async () => {
    const withdrawn = projectedOperation();
    const replacementPending = projectedOperation({
      revision: 8,
      card: {
        ...withdrawn.card, replacementState: 'pending', replacementForRevision: 4,
      },
    });
    const later = projectedOperation({
      revision: 11,
      card: {
        ...withdrawn.card, replacementState: 'created', replacementForRevision: 4, replacementMessageId: 'om_replacement',
      },
      execution: { ...withdrawn.execution, answer: 'later answer' },
      projection: { ...withdrawn.projection, desiredRevision: 5, patchedRevision: 4 },
    });
    const { projector, runtime, updateMessage, replyMessage } = harness([
      [projectionItem(withdrawn)], [projectionItem(replacementPending)], [projectionItem(later)],
    ]);
    updateMessage.mockRejectedValueOnce(new MessageWithdrawnError('om_card_1'));
    replyMessage.mockResolvedValueOnce('om_replacement');

    await projector.drainApp('cli_app');
    await projector.drainApp('cli_app');
    await projector.drainApp('cli_app');

    const calls = runtime.ackProjection.mock.calls;
    const withdrawalIndex = calls.findIndex(call => call[3].kind === 'withdrawn');
    const replacementIndex = calls.findIndex(call => call[3].kind === 'replacement_created');
    expect(withdrawalIndex).toBeGreaterThanOrEqual(0);
    expect(replacementIndex).toBeGreaterThan(withdrawalIndex);
    expect(replyMessage).toHaveBeenCalledWith(
      'cli_app', 'om_reply_1', expect.stringContaining('完整答案'), 'interactive', true, withdrawn.card.replacementUuid,
    );
    expect(updateMessage).toHaveBeenLastCalledWith('cli_app', 'om_replacement', expect.stringContaining('later answer'));
    expect(replyMessage.mock.calls.filter(call => call[3] === 'interactive')).toHaveLength(1);
  });

  it('records local overflow, re-lists the bounded failure revision, PATCHes it, and never truncates durable answer into fan-out', async () => {
    const huge = projectedOperation({
      execution: { ...projectedOperation().execution, answer: `FULL:${'界'.repeat(50_000)}:END` },
    });
    const fallback = projectedOperation({
      revision: 8,
      projection: {
        ...projectedOperation().projection,
        desiredRevision: 5,
        deliveryFailure: {
          kind: 'visible_fallback', errorCode: 'payload_too_large', message: '完整答案超过飞书卡片大小限制',
        },
      },
    });
    const { projector, runtime, updateMessage, sendMessage, replyMessage } = harness([
      [projectionItem(huge)], [projectionItem(fallback)],
    ]);

    await projector.drainApp('cli_app');

    expect(runtime.recordProjectionFailure).toHaveBeenCalledWith(
      makeBtwScope(), huge.btwOpId,
      { operationRevision: 7, projectionRevision: 4 },
      { kind: 'visible_fallback', errorCode: 'payload_too_large', message: '完整答案超过飞书卡片大小限制' },
    );
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage).toHaveBeenCalledWith('cli_app', 'om_card_1', expect.stringContaining('旁问结果投递失败'));
    expect(updateMessage.mock.calls[0][2]).not.toContain('FULL:');
    expect(runtime.ackProjection).toHaveBeenCalledWith(
      makeBtwScope(), huge.btwOpId,
      { operationRevision: 8, projectionRevision: 5 },
      { kind: 'patched' },
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(replyMessage).not.toHaveBeenCalled();
  });

  it('blocks deterministic provider rejection without advancing the patched revision', async () => {
    const operation = projectedOperation();
    const { projector, runtime, updateMessage } = harness([[projectionItem(operation)]]);
    updateMessage.mockRejectedValueOnce({
      isAxiosError: true, response: { status: 400, data: { code: 230001, msg: 'invalid card' } }, message: 'invalid card',
    });

    await projector.drainApp('cli_app');

    expect(runtime.recordProjectionFailure).toHaveBeenCalledWith(
      makeBtwScope(), operation.btwOpId,
      { operationRevision: 7, projectionRevision: 4 },
      expect.objectContaining({ kind: 'provider_permanent', errorCode: 'provider_rejected' }),
    );
    expect(runtime.ackProjection).not.toHaveBeenCalled();
    expect(runtime.listPendingProjections).toHaveBeenCalledTimes(2);
  });

  it('records an ambiguous reminder as unknown and never resends it', async () => {
    const reminder = projectedOperation({
      revision: 8,
      projection: { ...projectedOperation().projection, patchedRevision: 4, reminderState: 'pending' },
    });
    const { projector, runtime, replyMessage } = harness([[projectionItem(reminder)], []]);
    replyMessage.mockRejectedValueOnce({ isAxiosError: true, config: {}, message: 'timeout' });

    await projector.drainApp('cli_app');
    await projector.drainApp('cli_app');

    expect(runtime.ackProjection).toHaveBeenCalledWith(
      makeBtwScope(), reminder.btwOpId,
      { operationRevision: 8, projectionRevision: 4 },
      { kind: 'reminder_unknown' },
    );
    expect(replyMessage).toHaveBeenCalledTimes(1);
  });

  it('stops processing a stale ACK snapshot so it cannot suppress a newer revision', async () => {
    const operation = projectedOperation();
    const { projector, runtime, replyMessage } = harness([[projectionItem(operation)]]);
    runtime.ackProjection.mockResolvedValueOnce({
      kind: 'stale',
      operation: projectedOperation({
        revision: 8,
        projection: { ...operation.projection, desiredRevision: 5 },
      }),
    });

    await projector.drainApp('cli_app');

    expect(runtime.ackProjection).toHaveBeenCalledTimes(1);
    expect(replyMessage).not.toHaveBeenCalled();
  });

  it('single-flights concurrent drain scans by operation', async () => {
    const operation = projectedOperation();
    const { projector, updateMessage } = harness([[projectionItem(operation)], [projectionItem(operation)]]);
    let release!: () => void;
    updateMessage.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));

    const first = projector.drainApp('cli_app');
    const second = projector.drainApp('cli_app');
    await vi.waitFor(() => expect(updateMessage).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);

    expect(updateMessage).toHaveBeenCalledTimes(1);
  });
});
