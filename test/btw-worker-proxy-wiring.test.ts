import { describe, expect, it, vi } from 'vitest';

import { isPersistentTraeRpcColdStart } from '../src/codex-rpc-lifecycle.js';
import { ManagedTraeNotificationBridge } from '../src/features/btw/managed-notification-bridge.js';
import type { BtwRuntimeNotification } from '../src/features/btw/runtime-protocol.js';
import type { BtwCursorCommitAck } from '../src/types.js';
import type { DaemonToWorker } from '../src/types.js';

type InitCfg = Extract<DaemonToWorker, { type: 'init' }>;

function cfg(over: Partial<InitCfg> = {}): InitCfg {
  return {
    type: 'init', sessionId: 'session-1', chatId: 'chat-1', rootMessageId: 'root-1', workingDir: '/tmp',
    cliId: 'traex', backendType: 'tmux', prompt: 'first', codexRpcInput: true,
    larkAppId: 'app-1', larkAppSecret: 'secret-1',
    btwRuntime: { socket: '/tmp/btw.sock', epoch: 'epoch-1', protocolVersion: 1, buildId: 'build-1', configHash: 'frozen-1', notificationCursor: 0 },
    ...over,
  } as InitCfg;
}

describe('managed Trae worker selection', () => {
  it('uses persistent ownership only for a Trae generation carrying a persisted attachment', () => {
    expect(isPersistentTraeRpcColdStart(cfg())).toBe(true);
    expect(isPersistentTraeRpcColdStart(cfg({ cliId: 'codex' }))).toBe(false);
    expect(isPersistentTraeRpcColdStart(cfg({ btwRuntime: undefined }))).toBe(false);
    // Replacement workers reconnect to the persisted attachment rather than
    // starting a local owner, even though their viewer resumes the native thread.
    expect(isPersistentTraeRpcColdStart(cfg({ resume: true }))).toBe(true);
  });
});

function notification(seq: number): BtwRuntimeNotification {
  return {
    sessionId: 'session-1', fromSeq: seq, throughSeq: seq, kind: 'main_event',
    payload: { type: 'delta', text: `delta-${seq}` },
  };
}

function notifications(values: BtwRuntimeNotification[]): AsyncIterable<BtwRuntimeNotification> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* values;
    },
  };
}

function persisted(request: { requestId: string; fromSeq: number; throughSeq: number }, extra: Partial<BtwCursorCommitAck> = {}): BtwCursorCommitAck {
  return {
    type: 'btw_notification_cursor_persisted', requestId: request.requestId,
    sessionId: 'session-1', workerGeneration: 7, runtimeEpoch: 'epoch-1',
    fromSeq: request.fromSeq, throughSeq: request.throughSeq, ok: true,
    persistedSeq: request.throughSeq, ...extra,
  };
}

describe('managed Trae notification bridge', () => {
  it('applies an interval, persists it, then cumulatively ACKs runtime last', async () => {
    const order: string[] = [];
    let commit: { requestId: string; fromSeq: number; throughSeq: number } | undefined;
    const bridge = new ManagedTraeNotificationBridge({
      sessionId: 'session-1', workerGeneration: 7, runtimeEpoch: 'epoch-1', cursor: 0,
      notifications: notifications([notification(1)]),
      apply: async event => { order.push(`apply:${event.throughSeq}`); },
      requestCommit: request => { order.push(`commit:${request.throughSeq}`); commit = request; },
      ackEvents: async seq => { order.push(`ack:${seq}`); },
      detach: async () => { order.push('detach'); },
      requestId: () => 'request-1',
    });

    const running = bridge.run();
    await vi.waitFor(() => expect(commit).toBeDefined());
    bridge.onCursorPersisted(persisted(commit!));
    await running;

    expect(order).toEqual(['apply:1', 'commit:1', 'ack:1']);
    expect(bridge.cursor).toBe(1);
  });

  it('does not ACK the runtime and detaches on a mismatching daemon acknowledgement', async () => {
    const ackEvents = vi.fn(async () => undefined);
    const detach = vi.fn(async () => undefined);
    let commit: { requestId: string; fromSeq: number; throughSeq: number } | undefined;
    const bridge = new ManagedTraeNotificationBridge({
      sessionId: 'session-1', workerGeneration: 7, runtimeEpoch: 'epoch-1', cursor: 0,
      notifications: notifications([notification(1)]), apply: async () => undefined,
      requestCommit: request => { commit = request; }, ackEvents, detach, requestId: () => 'request-1',
    });

    const running = bridge.run();
    await vi.waitFor(() => expect(commit).toBeDefined());
    bridge.onCursorPersisted(persisted(commit!, { runtimeEpoch: 'wrong-epoch' }));
    await running;

    expect(ackEvents).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledOnce();
  });

  it('positively commits an exact durable duplicate without applying it twice', async () => {
    const apply = vi.fn(async () => undefined);
    const ackEvents = vi.fn(async () => undefined);
    let commit: { requestId: string; fromSeq: number; throughSeq: number } | undefined;
    const bridge = new ManagedTraeNotificationBridge({
      sessionId: 'session-1', workerGeneration: 7, runtimeEpoch: 'epoch-1', cursor: 3,
      notifications: notifications([notification(3)]), apply,
      requestCommit: request => { commit = request; }, ackEvents, detach: async () => undefined, requestId: () => 'request-3',
    });

    const running = bridge.run();
    await vi.waitFor(() => expect(commit).toBeDefined());
    bridge.onCursorPersisted(persisted(commit!));
    await running;

    expect(apply).not.toHaveBeenCalled();
    expect(ackEvents).toHaveBeenCalledWith(3);
  });

  it.each([
    ['gap', { ...notification(4), fromSeq: 4, throughSeq: 4 }],
    ['advancing overlap', { ...notification(2), fromSeq: 2, throughSeq: 3 }],
    ['regression', notification(1)],
  ])('detaches without committing or ACKing a %s interval', async (_name, event) => {
    const requestCommit = vi.fn();
    const ackEvents = vi.fn(async () => undefined);
    const detach = vi.fn(async () => undefined);
    const bridge = new ManagedTraeNotificationBridge({
      sessionId: 'session-1', workerGeneration: 7, runtimeEpoch: 'epoch-1', cursor: 2,
      notifications: notifications([event]), apply: async () => undefined, requestCommit, ackEvents, detach, requestId: () => 'unused',
    });

    await bridge.run();

    expect(requestCommit).not.toHaveBeenCalled();
    expect(ackEvents).not.toHaveBeenCalled();
    expect(detach).toHaveBeenCalledOnce();
  });
});
