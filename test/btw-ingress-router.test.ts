import { describe, expect, it, vi } from 'vitest';
import { routeBtwIngress } from '../src/features/btw/ingress.js';
import { handleBtwInvocation } from '../src/features/btw/coordinator.js';
import { makeBtwParent, makeBtwReplyTarget } from './fixtures/btw-fixtures.js';
import type { DaemonSession } from '../src/core/types.js';

type MainFlowSpies = ReturnType<typeof makeMainFlowSpies>;

function makeSession(): DaemonSession {
  const ds = {
    session: {
      sessionId: 'sess-btw-ingress',
      chatId: 'oc_chat_1',
      rootMessageId: 'om_root_1',
      title: 'BTW ingress test',
      status: 'active',
      createdAt: '2026-09-02T00:00:00.000Z',
      cliId: 'traex',
      cliSessionId: 'thread_parent_1',
      workingDir: '/repo/botmux',
      currentReplyTarget: { rootMessageId: 'om_session_target', turnId: 'turn_session', updatedAt: '2026-09-02T00:00:00.000Z' },
      streamCardId: 'om_session_stream_card',
      currentTurnTitle: 'session main title',
      btwRuntime: {
        socket: '/tmp/btw-ingress.sock', epoch: 'runtime_epoch_1', protocolVersion: 1, buildId: 'build-1',
        configHash: `sha256:${'a'.repeat(64)}`, notificationCursor: 0,
      },
    },
    worker: null, workerPort: null, workerToken: null, larkAppId: 'cli_app', chatId: 'oc_chat_1', chatType: 'group', scope: 'thread',
    spawnedAt: 1, cliVersion: '1.0.0', lastMessageAt: 123456, hasHistory: true, workingDir: '/repo/botmux',
    initConfig: { cliId: 'traex', brand: 'feishu' },
    currentTurnId: 'turn_main',
    currentTurnTitle: 'main title',
    currentReplyTarget: { rootMessageId: 'om_main_target', turnId: 'turn_main', updatedAt: '2026-09-02T00:00:00.000Z' },
    streamCardId: 'om_main_stream_card',
    streamCardPending: true,
    streamCardPendingTurnId: 'turn_main',
    streamCardTurnGeneration: 41,
    silentIdleTurnId: 'turn_previous_silent',
    pendingRawInput: '/model fast',
    pendingRawTurnId: 'turn_raw',
    pendingFollowUps: ['main follow up'],
    pendingFollowUpInput: { userPrompt: 'follow up', cliInput: 'wrapped follow up', turnId: 'turn_follow' },
    pendingAttachments: [{ key: 'attachment_sentinel' }],
    pendingAckReactions: [{ messageId: 'om_ack', reactionId: 'reaction_ack' }],
    cardPatchInFlight: true,
    pendingCardJson: '{\"card\":\"sentinel\"}',
    pendingCardId: 'om_pending_card',
    startupAutoRetry: { attempts: 7 },
    usageRefreshTimer: 'usage-refresh-timer-sentinel',
  } as any;
  return ds;
}

/** Fields read by the ordinary turn/card/reaction/timeout paths, frozen as literal sentinels. */
function snapshotMainTurnState(ds: DaemonSession) {
  return structuredClone({
    currentTurnId: ds.currentTurnId,
    currentTurnTitle: ds.currentTurnTitle,
    currentReplyTarget: ds.currentReplyTarget,
    sessionCurrentReplyTarget: ds.session.currentReplyTarget,
    sessionCurrentTurnTitle: ds.session.currentTurnTitle,
    streamCardId: ds.streamCardId,
    sessionStreamCardId: ds.session.streamCardId,
    streamCardPending: ds.streamCardPending,
    streamCardPendingTurnId: ds.streamCardPendingTurnId,
    streamCardTurnGeneration: ds.streamCardTurnGeneration,
    silentIdleTurnId: ds.silentIdleTurnId,
    lastMessageAt: ds.lastMessageAt,
    hasHistory: ds.hasHistory,
    pendingRawInput: ds.pendingRawInput,
    pendingRawTurnId: ds.pendingRawTurnId,
    pendingFollowUps: ds.pendingFollowUps,
    pendingFollowUpInput: ds.pendingFollowUpInput,
    pendingAttachments: ds.pendingAttachments,
    pendingAckReactions: ds.pendingAckReactions,
    cardPatchInFlight: ds.cardPatchInFlight,
    pendingCardJson: ds.pendingCardJson,
    pendingCardId: ds.pendingCardId,
    startupAutoRetry: ds.startupAutoRetry && { attempts: ds.startupAutoRetry.attempts },
    usageRefreshTimer: ds.usageRefreshTimer,
  });
}

function makeMainFlowSpies(ds: DaemonSession) {
  const beginNewTurn = vi.fn();
  const beginReplyTargetTurn = vi.fn();
  const markSessionActivity = vi.fn();
  const sendMainCard = vi.fn();
  const updateMainCard = vi.fn();
  const addReaction = vi.fn();
  const removeReaction = vi.fn();
  const scheduleFallback = vi.fn();
  const scheduleTimeout = vi.fn();
  const enqueuePendingInput = vi.fn();
  const reorderPendingInput = vi.fn();
  const final_output = vi.fn();
  const mainFlow = vi.fn(() => {
    beginNewTurn(); beginReplyTargetTurn(); markSessionActivity(); sendMainCard(); updateMainCard();
    addReaction(); removeReaction(); scheduleFallback(); scheduleTimeout(); enqueuePendingInput(); reorderPendingInput(); final_output();
    ds.currentTurnId = 'main-flow-turn';
    ds.currentTurnTitle = 'main-flow-title';
    ds.currentReplyTarget = { rootMessageId: 'om_main_flow', turnId: 'main-flow-turn', updatedAt: '2026-09-02T00:00:01.000Z' };
    ds.streamCardId = 'om_main_flow_card';
    ds.streamCardPending = false;
    ds.streamCardPendingTurnId = 'main-flow-turn';
    ds.streamCardTurnGeneration = 42;
    ds.silentIdleTurnId = undefined;
    ds.lastMessageAt = 999999;
    ds.hasHistory = false;
    ds.pendingRawInput = 'main-flow-input';
    ds.pendingRawTurnId = 'main-flow-turn';
    ds.pendingFollowUps = ['main-flow-follow-up'];
    ds.pendingFollowUpInput = undefined;
    ds.pendingAttachments = [];
    ds.pendingAckReactions = [];
    ds.cardPatchInFlight = false;
    ds.pendingCardJson = 'main-flow-card';
    ds.pendingCardId = 'om_main_flow_card';
  });
  return { beginNewTurn, beginReplyTargetTurn, markSessionActivity, sendMainCard, updateMainCard, addReaction, removeReaction, scheduleFallback, scheduleTimeout, enqueuePendingInput, reorderPendingInput, final_output, mainFlow };
}

function expectNoMainFlow(spies: MainFlowSpies) {
  for (const spy of [
    spies.mainFlow, spies.beginNewTurn, spies.beginReplyTargetTurn, spies.markSessionActivity, spies.sendMainCard, spies.updateMainCard,
    spies.addReaction, spies.removeReaction, spies.scheduleFallback, spies.scheduleTimeout, spies.enqueuePendingInput, spies.reorderPendingInput, spies.final_output,
  ]) expect(spy).not.toHaveBeenCalled();
}

async function dispatchViaRealIngressSeam(input: {
  cmd: string;
  ds: DaemonSession;
  commandContent: string;
  requestId: string;
  invoke: (ds: DaemonSession, content: string, requestId: string) => Promise<unknown>;
  mainFlow: () => void;
}) {
  const claimed = await routeBtwIngress({
    cmd: input.cmd, ds: input.ds, commandContent: input.commandContent, requestId: input.requestId,
    invoke: input.invoke, noSession: vi.fn(async () => undefined),
  });
  if (!claimed) input.mainFlow();
  return claimed;
}

function managedInvocation(ds: DaemonSession, overrides: Record<string, unknown> = {}) {
  const operation = { btwOpId: 'btwop_ingress', replyTarget: makeBtwReplyTarget(), parent: makeBtwParent() };
  return {
    ds, commandContent: '/btw explain the isolation', capabilities: { nativeBtw: true, persistentRuntime: true, structuredTerminal: true, stableParentThread: true },
    replyTarget: makeBtwReplyTarget(), parent: makeBtwParent(),
    deps: {
      runtime: { prepareBtw: vi.fn(async () => ({ kind: 'created', operation })), submitBtw: vi.fn(async () => operation) },
      projector: { ensureInitialCard: vi.fn(async () => ({ kind: 'recorded', operation })) },
      reply: vi.fn(async () => 'om_notice'), sendLegacy: vi.fn(() => true),
    },
    ...overrides,
  };
}

describe('BTW executable ingress router', () => {
  it.each(['new-topic', 'existing-thread'])('routes %s /btw to the dedicated coordinator using the inbound message id', async () => {
    const ds = { session: { sessionId: 'sess' } } as any;
    const invoke = vi.fn(async () => undefined);
    const noSession = vi.fn(async () => undefined);
    await expect(routeBtwIngress({
      cmd: '/btw', ds, commandContent: '/btw explain this', requestId: 'om_inbound', invoke, noSession,
    })).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith(ds, '/btw explain this', 'om_inbound');
    expect(noSession).not.toHaveBeenCalled();
  });

  it('does not claim generic commands', async () => {
    const invoke = vi.fn();
    await expect(routeBtwIngress({
      cmd: '/model', ds: undefined, commandContent: '/model', requestId: 'om_other', invoke, noSession: vi.fn(),
    })).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ['managed', '/btw managed', { nativeBtw: true, persistentRuntime: true, structuredTerminal: true, stableParentThread: true }, 'managed'],
    ['legacy', '/btw legacy', { nativeBtw: false, persistentRuntime: false, structuredTerminal: false, stableParentThread: false }, 'legacy'],
    ['unsupported', '/btw unsupported', { nativeBtw: false, persistentRuntime: false, structuredTerminal: false, stableParentThread: false }, 'unsupported'],
    ['usage', '/btw', { nativeBtw: true, persistentRuntime: true, structuredTerminal: true, stableParentThread: true }, 'usage'],
  ] as const)('routes %s BTW through handleBtwInvocation without a main-turn boundary', async (kind, commandContent, capabilities, expected) => {
    const ds = makeSession();
    const spies = makeMainFlowSpies(ds);
    const invocation = managedInvocation(ds, { commandContent, capabilities });
    if (kind === 'unsupported') ds.session.cliId = 'codex-app';
    const before = snapshotMainTurnState(ds);
    const invoke = vi.fn(async (target: DaemonSession, content: string, requestId: string) =>
      await handleBtwInvocation({ ...invocation, ds: target, commandContent: content, requestId } as any));

    await expect(dispatchViaRealIngressSeam({ cmd: '/btw', ds, commandContent, requestId: `om_${kind}`, invoke, mainFlow: spies.mainFlow })).resolves.toBe(true);
    await expect(invoke.mock.results[0]?.value).resolves.toBe(expected);
    expectNoMainFlow(spies);
    expect(snapshotMainTurnState(ds)).toEqual(before);
  });

  it('proves the harness catches a non-BTW fallthrough into every main-turn boundary', async () => {
    const ds = makeSession();
    const spies = makeMainFlowSpies(ds);
    const before = snapshotMainTurnState(ds);
    await expect(dispatchViaRealIngressSeam({
      cmd: '/model', ds, commandContent: '/model fast', requestId: 'om_control', invoke: vi.fn(), mainFlow: spies.mainFlow,
    })).resolves.toBe(false);
    for (const spy of [
      spies.mainFlow, spies.beginNewTurn, spies.beginReplyTargetTurn, spies.markSessionActivity, spies.sendMainCard, spies.updateMainCard,
      spies.addReaction, spies.removeReaction, spies.scheduleFallback, spies.scheduleTimeout, spies.enqueuePendingInput, spies.reorderPendingInput, spies.final_output,
    ]) expect(spy).toHaveBeenCalledOnce();
    expect(snapshotMainTurnState(ds)).not.toEqual(before);
  });

  it('keeps duplicate inbound plus service-owned initial-card recovery outside main flow', async () => {
    const ds = makeSession();
    const spies = makeMainFlowSpies(ds);
    const operation = { btwOpId: 'btwop_duplicate_ingress', replyTarget: makeBtwReplyTarget(), parent: makeBtwParent() };
    let adapterSubmissions = 0;
    const prepared = new Map<string, typeof operation>();
    const cards = new Set<string>();
    const invocation = managedInvocation(ds, {
      deps: {
        runtime: {
          prepareBtw: vi.fn(async ({ requestId }: { requestId: string }) => {
            const prior = prepared.get(requestId);
            if (prior) return { kind: 'duplicate', operation: prior };
            prepared.set(requestId, operation);
            return { kind: 'created', operation };
          }),
          submitBtw: vi.fn(async () => { if (adapterSubmissions === 0) adapterSubmissions += 1; return operation; }),
        },
        projector: { ensureInitialCard: vi.fn(async (candidate: typeof operation) => { cards.add(candidate.btwOpId); return { kind: 'recorded', operation: candidate }; }) },
        reply: vi.fn(async () => 'om_notice'), sendLegacy: vi.fn(() => true),
      },
    });
    const invoke = vi.fn(async (target: DaemonSession, content: string, requestId: string) =>
      await handleBtwInvocation({ ...invocation, ds: target, commandContent: content, requestId } as any));
    const before = snapshotMainTurnState(ds);

    await Promise.all([
      dispatchViaRealIngressSeam({ cmd: '/btw', ds, commandContent: '/btw duplicate', requestId: 'om_duplicate', invoke, mainFlow: spies.mainFlow }),
      dispatchViaRealIngressSeam({ cmd: '/btw', ds, commandContent: '/btw duplicate', requestId: 'om_duplicate', invoke, mainFlow: spies.mainFlow }),
      invocation.deps.projector.ensureInitialCard(operation),
    ]);

    expect(prepared.size).toBe(1);
    expect(cards).toEqual(new Set(['btwop_duplicate_ingress']));
    expect(adapterSubmissions).toBe(1);
    expectNoMainFlow(spies);
    expect(snapshotMainTurnState(ds)).toEqual(before);
  });

  it.each([
    ['terminal outcome', 'completed'],
    ['retry wake', 'cancelled'],
    ['restart wake', 'completed'],
  ] as const)('does not overwrite an independent main %s while BTW has a %s', async (btwEvent, mainOutcome) => {
    const ds = makeSession();
    const spies = makeMainFlowSpies(ds);
    const mainLifecycle = { state: 'running' as 'running' | 'completed' | 'cancelled', callback: vi.fn() };
    const btwLifecycle = { event: 'pending' };
    const invocation = managedInvocation(ds);
    invocation.deps.runtime.submitBtw = vi.fn(async () => { btwLifecycle.event = btwEvent; return { btwOpId: 'btwop_ingress' } as any; });
    const before = snapshotMainTurnState(ds);
    const invoke = vi.fn(async (target: DaemonSession, content: string, requestId: string) =>
      await handleBtwInvocation({ ...invocation, ds: target, commandContent: content, requestId } as any));

    mainLifecycle.state = mainOutcome;
    mainLifecycle.callback(mainOutcome);
    await dispatchViaRealIngressSeam({ cmd: '/btw', ds, commandContent: '/btw lifecycle isolation', requestId: `om_${btwEvent}`, invoke, mainFlow: spies.mainFlow });

    expect(btwLifecycle.event).toBe(btwEvent);
    expect(mainLifecycle).toEqual({ state: mainOutcome, callback: mainLifecycle.callback });
    expect(mainLifecycle.callback).toHaveBeenCalledExactlyOnceWith(mainOutcome);
    expectNoMainFlow(spies);
    expect(snapshotMainTurnState(ds)).toEqual(before);
  });
});
