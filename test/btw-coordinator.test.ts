import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { handleBtwInvocation } from '../src/features/btw/coordinator.js';
import { ALL_BTW_CAPABILITY_COMBINATIONS, makeBtwParent, makeBtwReplyTarget } from './fixtures/btw-fixtures.js';
import type { DaemonSession } from '../src/core/types.js';

const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
const typesSource = readFileSync(new URL('../src/types.ts', import.meta.url), 'utf8');
const passthroughSource = readFileSync(new URL('../src/core/passthrough-commands.ts', import.meta.url), 'utf8');

describe('Task 11 BTW coordinator seam', () => {
  it('moves /btw off the generic passthrough list', () => {
    expect(passthroughSource).not.toContain("'/btw'");
    expect(passthroughSource).not.toContain('"/btw"');
  });

  it('adds a dedicated coordinator module and daemon entrypoint', () => {
    const coordinatorPath = new URL('../src/features/btw/coordinator.ts', import.meta.url);
    expect(() => readFileSync(coordinatorPath, 'utf8')).not.toThrow();
    const coordinatorSource = readFileSync(coordinatorPath, 'utf8');
    expect(coordinatorSource).toContain("Promise<'managed' | 'legacy' | 'unsupported' | 'usage'>");
    expect(coordinatorSource).toContain('handleBtwInvocation');
  });

  it('defines a legacy_btw_raw_input worker event with no turn lifecycle payload', () => {
    expect(typesSource).toContain("{ type: 'legacy_btw_raw_input'; content: string }");
    expect(typesSource).not.toContain("type: 'legacy_btw_raw_input'; content: string; turnId");
    expect(typesSource).not.toContain("type: 'legacy_btw_raw_input'; content: string; followUpContent");
  });

  it('routes legacy BTW through its dedicated worker message instead of raw_input', () => {
    expect(daemonSource).toContain("type: 'legacy_btw_raw_input'");
    const regionStart = daemonSource.indexOf('async function handleDedicatedBtwCommand(');
    const regionEnd = daemonSource.indexOf('function shouldAcceptSlashFromExternalBot', regionStart);
    const region = daemonSource.slice(regionStart, regionEnd > regionStart ? regionEnd : regionStart + 4000);
    expect(region).not.toContain("type: 'raw_input'");
  });

  it('keeps dedicated BTW delivery out of main-turn lifecycle and UI helpers', () => {
    const regionStart = daemonSource.indexOf('async function handleDedicatedBtwCommand(');
    const regionEnd = daemonSource.indexOf('function shouldAcceptSlashFromExternalBot', regionStart);
    const region = daemonSource.slice(regionStart, regionEnd > regionStart ? regionEnd : regionStart + 4000);
    expect(region).not.toContain('beginNewTurn(');
    expect(region).not.toContain('beginReplyTargetTurn(');
    expect(region).not.toContain('markSessionActivity(');
    expect(region).not.toContain('sendMessage(');
    expect(region).not.toContain('updateMessage(');
    expect(region).not.toContain('addReaction(');
    expect(region).not.toContain('removeReaction(');
    expect(region).not.toContain('scheduleCardPatch(');
    expect(region).not.toContain('setTimeout(');
    expect(region).not.toContain('final_output');
  });

  it('adds a worker handler dedicated to legacy BTW raw writes', () => {
    expect(workerSource).toContain("case 'legacy_btw_raw_input':");
    expect(workerSource).toContain('deliverLegacyBtwRawInput');
  });
});

function makeDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: {
      sessionId: 'sess-btw-1',
      chatId: 'oc_chat_1',
      rootMessageId: 'om_root_1',
      title: 'BTW test session',
      status: 'active',
      createdAt: new Date('2026-09-02T00:00:00.000Z').toISOString(),
      cliId: 'traex',
      cliSessionId: 'thread_parent_1',
      btwRuntime: {
        socket: '/tmp/btw.sock',
        epoch: 'runtime_epoch_1',
        protocolVersion: 1,
        buildId: 'build-1',
        configHash: `sha256:${'a'.repeat(64)}`,
        notificationCursor: 0,
      },
      workingDir: '/repo/botmux',
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'cli_app',
    chatId: 'oc_chat_1',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1.0.0',
    lastMessageAt: Date.now(),
    hasHistory: true,
    workingDir: '/repo/botmux',
    initConfig: { cliId: 'traex', brand: 'feishu' } as DaemonSession['initConfig'],
    ...overrides,
  } as DaemonSession;
}

describe('handleBtwInvocation behavior', () => {
  it.each(['managed', 'legacy', 'unsupported', 'usage'] as const)('keeps representative main-turn state untouched for %s outcomes', async outcome => {
    const ds = makeDs() as any;
    ds.session.replyTargets = { om_main: { replyRootId: 'om_root_1' } };
    ds.session.pendingInput = 'main input';
    ds.session.cardMessageId = 'om_main_card';
    if (outcome === 'unsupported') ds.session.cliId = 'codex-app';
    const before = structuredClone({
      session: ds.session, lastMessageAt: ds.lastMessageAt, hasHistory: ds.hasHistory, workingDir: ds.workingDir,
    });
    const capabilities = outcome === 'managed'
      ? { nativeBtw: true, persistentRuntime: true, structuredTerminal: true, stableParentThread: true }
      : { nativeBtw: false, persistentRuntime: false, structuredTerminal: false, stableParentThread: false };
    const commandContent = outcome === 'usage' ? '/btw' : '/btw isolated question';
    const operation = { btwOpId: 'btwop_isolated', replyTarget: makeBtwReplyTarget(), parent: makeBtwParent() };
    await handleBtwInvocation({
      ds, commandContent, requestId: `om_${outcome}`, capabilities, replyTarget: makeBtwReplyTarget(), parent: makeBtwParent(),
      deps: {
        runtime: { prepareBtw: vi.fn(async () => ({ kind: 'created', operation })), submitBtw: vi.fn(async () => operation) },
        projector: { ensureInitialCard: vi.fn(async () => ({ kind: 'recorded', operation })) },
        reply: vi.fn(async () => 'om_notice'), sendLegacy: vi.fn(() => true),
      },
    } as any);
    expect({ session: ds.session, lastMessageAt: ds.lastMessageAt, hasHistory: ds.hasHistory, workingDir: ds.workingDir }).toEqual(before);
  });

  it('shares a prepared operation/card across duplicate inbound and recovery, while the runtime submit is idempotent', async () => {
    const ds = makeDs();
    const operation = { btwOpId: 'btwop_duplicate', replyTarget: makeBtwReplyTarget(), parent: makeBtwParent() };
    const operations = new Map<string, typeof operation>();
    let adapterSubmissions = 0;
    const runtime = {
      prepareBtw: vi.fn(async ({ requestId }: { requestId: string }) => {
        const existing = operations.get(requestId);
        if (existing) return { kind: 'duplicate' as const, operation: existing };
        operations.set(requestId, operation);
        return { kind: 'created' as const, operation };
      }),
      submitBtw: vi.fn(async () => { if (adapterSubmissions === 0) adapterSubmissions += 1; return operation; }),
    };
    const cards = new Set<string>();
    const projector = { ensureInitialCard: vi.fn(async (candidate: typeof operation) => { cards.add(candidate.btwOpId); return { kind: 'recorded' as const, operation: candidate }; }) };
    const input = { ds, commandContent: '/btw duplicate', requestId: 'om_duplicate', capabilities: { nativeBtw: true, persistentRuntime: true, structuredTerminal: true, stableParentThread: true }, replyTarget: makeBtwReplyTarget(), parent: makeBtwParent(), deps: { runtime, projector, reply: vi.fn(async () => 'om'), sendLegacy: vi.fn(() => true) } };
    const before = structuredClone({ session: ds.session, lastMessageAt: ds.lastMessageAt, hasHistory: ds.hasHistory, workingDir: ds.workingDir });
    await Promise.all([handleBtwInvocation(input as any), handleBtwInvocation(input as any), projector.ensureInitialCard(operation)]);
    expect(operations).toHaveLength(1);
    expect(cards).toEqual(new Set(['btwop_duplicate']));
    expect(adapterSubmissions).toBe(1);
    expect({ session: ds.session, lastMessageAt: ds.lastMessageAt, hasHistory: ds.hasHistory, workingDir: ds.workingDir }).toEqual(before);
  });

  it('orders managed preparation, card recording, and submit without touching legacy delivery', async () => {
    const order: string[] = [];
    const deps = {
      runtime: {
        prepareBtw: vi.fn(async () => {
          order.push('prepare_btw');
          return { kind: 'created' as const, operation: { btwOpId: 'btwop_order', replyTarget: makeBtwReplyTarget(), parent: makeBtwParent() } };
        }),
        submitBtw: vi.fn(async () => { order.push('submit_btw'); return {} as any; }),
      },
      projector: {
        ensureInitialCard: vi.fn(async operation => { order.push('ensure_initial_card'); return { kind: 'recorded' as const, operation }; }),
      },
      reply: vi.fn(async () => 'om_reply'),
      sendLegacy: vi.fn(() => true),
    };

    await expect(handleBtwInvocation({
      ds: makeDs(), commandContent: '/btw explain this', requestId: 'om_order',
      capabilities: { nativeBtw: true, persistentRuntime: true, structuredTerminal: true, stableParentThread: true },
      replyTarget: makeBtwReplyTarget(), parent: makeBtwParent(), deps,
    } as any)).resolves.toBe('managed');

    expect(order).toEqual(['prepare_btw', 'ensure_initial_card', 'submit_btw']);
    expect(deps.sendLegacy).not.toHaveBeenCalled();
    expect(deps.reply).not.toHaveBeenCalled();
  });

  it.each(ALL_BTW_CAPABILITY_COMBINATIONS.filter(row => !row.managed))('uses the isolated legacy event whenever managed capability is incomplete: %o', async ({ capabilities }) => {
    const prepareBtw = vi.fn();
    const sendLegacy = vi.fn(() => true);
    const reply = vi.fn(async () => 'om_reply');
    await expect(handleBtwInvocation({
      ds: makeDs(), commandContent: '/btw legacy question', requestId: 'om_legacy', capabilities,
      replyTarget: makeBtwReplyTarget(), parent: makeBtwParent(),
      deps: { runtime: { prepareBtw, submitBtw: vi.fn() }, projector: { ensureInitialCard: vi.fn() }, reply, sendLegacy },
    } as any)).resolves.toBe('legacy');
    expect(prepareBtw).not.toHaveBeenCalled();
    expect(sendLegacy).toHaveBeenCalledWith({ type: 'legacy_btw_raw_input', content: '/btw legacy question' });
    expect(reply).toHaveBeenCalledOnce();
  });

  it('settles empty /btw as usage without runtime or terminal delivery', async () => {
    const prepareBtw = vi.fn();
    const sendLegacy = vi.fn(() => true);
    const reply = vi.fn(async () => 'om_reply');
    await expect(handleBtwInvocation({
      ds: makeDs(), commandContent: '/btw', requestId: 'om_empty',
      capabilities: { nativeBtw: true, persistentRuntime: true, structuredTerminal: true, stableParentThread: true },
      replyTarget: makeBtwReplyTarget(), parent: makeBtwParent(),
      deps: { runtime: { prepareBtw, submitBtw: vi.fn() }, projector: { ensureInitialCard: vi.fn() }, reply, sendLegacy },
    } as any)).resolves.toBe('usage');
    expect(prepareBtw).not.toHaveBeenCalled();
    expect(sendLegacy).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
  });

  it('uses the inbound Lark message id as the stable managed requestId', async () => {
    const ds = makeDs();
    const prepareBtw = vi.fn(async () => ({
      kind: 'created' as const,
      operation: {
        btwOpId: 'btwop_1',
        requestId: 'om_btw_request_1',
        question: 'explain this diff',
        parent: makeBtwParent(),
        replyTarget: makeBtwReplyTarget(),
      },
    }));
    const ensureInitialCard = vi.fn(async (operation: any) => ({
      kind: 'recorded' as const,
      operation,
    }));
    const submitBtw = vi.fn(async () => ({
      btwOpId: 'btwop_1',
    }));

    await handleBtwInvocation({
      ds,
      commandContent: '/btw explain this diff',
      requestId: 'om_btw_request_1',
      capabilities: {
        nativeBtw: true,
        persistentRuntime: true,
        structuredTerminal: true,
        stableParentThread: true,
      },
      replyTarget: makeBtwReplyTarget(),
      parent: makeBtwParent(),
      deps: {
        runtime: { prepareBtw, submitBtw },
        projector: { ensureInitialCard },
        reply: vi.fn(async () => 'om_reply'),
        sendLegacy: vi.fn(() => true),
      },
    } as any);

    expect(prepareBtw).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'om_btw_request_1',
      question: 'explain this diff',
    }));
  });
});
