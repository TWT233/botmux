import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { CodexRpcSession } from '../src/codex-rpc-session.js';
import { createBtwOperationStore } from '../src/features/btw/operation-store.js';
import { connectBtwRuntime } from '../src/features/btw/runtime-client.js';
import type { FrozenBtwSessionProfile } from '../src/features/btw/runtime-protocol.js';
import type { BtwOperationScope, PrepareBtwInput } from '../src/features/btw/types.js';
import { deriveBtwIdentifiers } from '../src/features/btw/types.js';
import { makeBtwPrepareInput, makeBtwScope } from './fixtures/btw-fixtures.js';
import {
  cleanupRegisteredFakeAppServers,
  liveRegisteredFakeAppServerPidsInDir,
  registeredFakeAppServerRecordCount,
} from './helpers/btw-runtime-test-cleanup.js';

const dirs: string[] = [];
const sessions = new Set<CodexRpcSession>();
const runtimePidDirs = new Map<string, string>();
const fakeCli = fileURLToPath(new URL('./fixtures/fake-codex-rpc-server.mjs', import.meta.url));
const managedTraeContract = { nativeBtw: true, structuredTerminal: true, stableParentThread: true } as const;

afterEach(async () => {
  for (const session of [...sessions]) {
    sessions.delete(session);
    try {
      session.closeOwnedProcess();
    } catch {
      // Best-effort child cleanup for failing test paths.
    }
  }
  for (const dataDir of dirs.splice(0)) {
    await cleanupRuntimeArtifacts(dataDir);
  }
});

function trackSession(session: CodexRpcSession): CodexRpcSession {
  sessions.add(session);
  return session;
}

function releaseSession(session: CodexRpcSession): void {
  if (!sessions.delete(session)) return;
  session.closeOwnedProcess();
}

function registerRuntimePidDir(dataDir: string): string {
  let pidDir = runtimePidDirs.get(dataDir);
  if (!pidDir) {
    pidDir = join(dataDir, 'fake-app-server-pids', randomUUID());
    mkdirSync(pidDir, { recursive: true });
    runtimePidDirs.set(dataDir, pidDir);
  }
  return pidDir;
}

function liveRegisteredPids(dataDir: string): number[] {
  const pidDir = runtimePidDirs.get(dataDir);
  if (!pidDir) return [];
  return liveRegisteredFakeAppServerPidsInDir({
    pidDir,
    fixturePath: fakeCli,
  });
}

function registeredPidRecordCount(dataDir: string): number {
  const pidDir = runtimePidDirs.get(dataDir);
  return pidDir ? registeredFakeAppServerRecordCount(pidDir) : 0;
}

async function shutdownAndKillRegisteredFakeServers(dataDir: string): Promise<void> {
  const runtime = await connectBtwRuntime({ dataDir }).catch(() => undefined);
  if (runtime) {
    await runtime.client.shutdownRuntime().catch(() => undefined);
    runtime.close();
  }
  const pidDir = runtimePidDirs.get(dataDir);
  if (pidDir) await cleanupRegisteredFakeAppServers({ pidDir, fixturePath: fakeCli });
}

async function cleanupRuntimeArtifacts(dataDir: string): Promise<void> {
  await shutdownAndKillRegisteredFakeServers(dataDir);
  runtimePidDirs.delete(dataDir);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 1, retryDelay: 20 });
      return;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

function profile(dataDir: string, sessionId: string): FrozenBtwSessionProfile {
  return {
    sessionId,
    larkAppId: 'cli_app',
    cliId: 'traex',
    cliBin: fakeCli,
    cwd: '/tmp',
    env: {
      PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? ''),
      FAKE_PID_DIR: registerRuntimePidDir(dataDir),
    },
    appServerFeatures: [],
    configHash: `config-${sessionId}`,
    mcpManifest: null,
    mcpManifestDigest: 'none',
    managedBtwCapabilities: managedTraeContract,
  };
}

function profileWithEnv(
  dataDir: string,
  sessionId: string,
  env: NodeJS.ProcessEnv,
): FrozenBtwSessionProfile {
  const base = profile(dataDir, sessionId);
  return {
    ...base,
    env: {
      ...base.env,
      ...env,
    },
  };
}

describe('Trae native BTW adapter', () => {
  it('sends the exact BTW payload and returns completed, failed, and cancelled terminals verbatim', async () => {
    chmodSync(fakeCli, 0o755);
    const traceFile = join(tmpdir(), `btw-adapter-trace-${Date.now()}.jsonl`);
    const session = trackSession(new CodexRpcSession({
      cliBin: fakeCli,
      cwd: '/tmp',
      env: {
        ...process.env,
        FAKE_TRACE_FILE: traceFile,
        FAKE_BTW_MAP: JSON.stringify({
          'native-completed': { answer: 'full completed answer' },
          'native-failed': {
            status: 'failed',
            errorCode: 'btw_failed_code',
            message: 'btw failed detail',
          },
          'native-cancelled': {
            status: 'cancelled',
            message: 'btw cancelled detail',
          },
        }),
      },
      sessionId: `btw-payload-${Date.now()}`,
    }));
    try {
      await session.start();
      await session.startThread();

      const mod = await import('../src/features/btw/trae-adapter.js');
      const adapter = mod.createTraeBtwAdapter({
        session,
        threadId: session.activeThreadId!,
        runtimeEpoch: 'runtime_epoch_test',
        nativeTurnIdForRequest(requestId: string) {
          if (requestId === 'btw-completed') return 'native-completed';
          if (requestId === 'btw-failed') return 'native-failed';
          return 'native-cancelled';
        },
        onFrameState: async () => undefined,
        onTerminal: async () => undefined,
      });

      await expect(adapter.run({ requestId: 'btw-completed', question: 'completed question' })).resolves.toEqual({
        status: 'completed',
        answer: 'full completed answer',
      });
      await expect(adapter.run({ requestId: 'btw-failed', question: 'failed question' })).resolves.toEqual({
        status: 'failed',
        errorCode: 'btw_failed_code',
        message: 'btw failed detail',
      });
      await expect(adapter.run({ requestId: 'btw-cancelled', question: 'cancelled question' })).resolves.toEqual({
        status: 'cancelled',
        message: 'btw cancelled detail',
      });

      const trace = readFileSync(traceFile, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as { event: string; nativeTurnId?: string; params?: Record<string, unknown> });
      const submissions = trace.filter(entry => entry.event === 'btw_submission');
      expect(submissions.map(entry => ({
        nativeTurnId: entry.nativeTurnId,
        params: entry.params,
      }))).toEqual([
        {
          nativeTurnId: 'native-completed',
          params: {
            threadId: session.activeThreadId,
            turnId: 'native-completed',
            question: 'completed question',
          },
        },
        {
          nativeTurnId: 'native-failed',
          params: {
            threadId: session.activeThreadId,
            turnId: 'native-failed',
            question: 'failed question',
          },
        },
        {
          nativeTurnId: 'native-cancelled',
          params: {
            threadId: session.activeThreadId,
            turnId: 'native-cancelled',
            question: 'cancelled question',
          },
        },
      ]);
    } finally {
      releaseSession(session);
      rmSync(traceFile, { force: true });
    }
  }, 20_000);

  it('submits a BTW turn by native turn id and resolves concurrent out-of-order terminals', async () => {
    chmodSync(fakeCli, 0o755);
    const session = trackSession(new CodexRpcSession({
      cliBin: fakeCli,
      cwd: '/tmp',
      env: {
        ...process.env,
        FAKE_BTW_MODE: 'concurrent-out-of-order',
        FAKE_BTW_MAP: JSON.stringify({
          nativeA: { answer: 'answer-a', delayMs: 80 },
          nativeB: { answer: 'answer-b', delayMs: 10 },
        }),
      },
      sessionId: `btw-concurrent-${Date.now()}`,
    }));
    try {
      await session.start();
      await session.startThread();

      const mod = await import('../src/features/btw/trae-adapter.js');
      const frameStates: Array<{ requestId: string; nativeTurnId: string; state: string }> = [];
      const terminals: Array<{ requestId: string; nativeTurnId: string; terminal: { status: string; answer?: string; errorCode?: string; message?: string } }> = [];
      const adapter = mod.createTraeBtwAdapter({
        session,
        threadId: session.activeThreadId!,
        runtimeEpoch: 'runtime_epoch_test',
        nativeTurnIdForRequest(requestId: string) {
          return requestId === 'btw-a' ? 'nativeA' : 'nativeB';
        },
        onFrameState: async event => { frameStates.push(event); },
        onTerminal: async event => { terminals.push(event); },
      });

      const [slow, fast] = await Promise.all([
        adapter.run({ requestId: 'btw-a', question: 'slow' }),
        adapter.run({ requestId: 'btw-b', question: 'fast' }),
      ]);

      expect({ slow, fast }).toEqual({
        slow: { status: 'completed', answer: 'answer-a' },
        fast: { status: 'completed', answer: 'answer-b' },
      });
      expect(frameStates.map(({ requestId, nativeTurnId, state }) => ({ requestId, nativeTurnId, state }))).toEqual([
        { requestId: 'btw-a', nativeTurnId: 'nativeA', state: 'may_have_been_sent' },
        { requestId: 'btw-b', nativeTurnId: 'nativeB', state: 'may_have_been_sent' },
        { requestId: 'btw-a', nativeTurnId: 'nativeA', state: 'acknowledged' },
        { requestId: 'btw-b', nativeTurnId: 'nativeB', state: 'acknowledged' },
      ]);
      expect(terminals.map(({ requestId, nativeTurnId, terminal }) => ({ requestId, nativeTurnId, status: terminal.status, answer: terminal.answer }))).toEqual([
        { requestId: 'btw-b', nativeTurnId: 'nativeB', status: 'completed', answer: 'answer-b' },
        { requestId: 'btw-a', nativeTurnId: 'nativeA', status: 'completed', answer: 'answer-a' },
      ]);
    } finally {
      releaseSession(session);
    }
  }, 20_000);

  it('keeps BTW-owned delta and terminal out of generic main callbacks', async () => {
    chmodSync(fakeCli, 0o755);
    const mainNotifications: unknown[] = [];
    const mainTerminals: unknown[] = [];
    const btwTerminals: unknown[] = [];
    const session = trackSession(new CodexRpcSession({
      cliBin: fakeCli,
      cwd: '/tmp',
      env: {
        ...process.env,
        FAKE_BTW_MAP: JSON.stringify({
          'native-isolated': { answer: 'isolated', delta: 'BTW delta must not reach main journal' },
        }),
      },
      sessionId: `btw-generic-filter-${Date.now()}`,
      onNotification: notification => mainNotifications.push(notification),
      onTurnTerminal: terminal => mainTerminals.push(terminal),
    }));
    try {
      await session.start();
      await session.startThread();
      const adapter = (await import('../src/features/btw/trae-adapter.js')).createTraeBtwAdapter({
        session,
        threadId: session.activeThreadId!,
        runtimeEpoch: 'runtime_epoch_test',
        nativeTurnIdForRequest: () => 'native-isolated',
        onFrameState: async () => undefined,
        onTerminal: async event => { btwTerminals.push(event); },
      });

      await expect(adapter.run({ requestId: 'btw-isolated', question: 'isolate native BTW' }))
        .resolves.toEqual({ status: 'completed', answer: 'isolated' });

      expect(mainNotifications).toEqual([]);
      expect(mainTerminals).toEqual([]);
      expect(btwTerminals).toEqual([expect.objectContaining({ nativeTurnId: 'native-isolated' })]);
    } finally {
      releaseSession(session);
    }
  }, 20_000);

  it('fails closed on any BTW tool request or execution event', async () => {
    chmodSync(fakeCli, 0o755);
    const traceFile = join(tmpdir(), `btw-tool-trace-${Date.now()}.jsonl`);
    const session = trackSession(new CodexRpcSession({
      cliBin: fakeCli,
      cwd: '/tmp',
      env: {
        ...process.env,
        FAKE_BTW_MODE: 'tool-request',
        FAKE_TRACE_FILE: traceFile,
      },
      sessionId: `btw-tool-${Date.now()}`,
    }));
    try {
      await session.start();
      await session.startThread();

      const mod = await import('../src/features/btw/trae-adapter.js');
      const terminals: Array<{ requestId: string; nativeTurnId: string; terminal: { status: string; errorCode?: string; message?: string } }> = [];
      const adapter = mod.createTraeBtwAdapter({
        session,
        threadId: session.activeThreadId!,
        runtimeEpoch: 'runtime_epoch_test',
        nativeTurnIdForRequest() { return 'native-tool'; },
        onFrameState: async () => undefined,
        onTerminal: async event => { terminals.push(event); },
      });

      await expect(adapter.run({ requestId: 'btw-tool', question: 'use a tool' })).resolves.toEqual({
        status: 'failed',
        errorCode: 'btw_tool_event_forbidden',
        message: 'Trae BTW attempted a native tool event',
      });
      expect(terminals).toEqual([{
        requestId: 'btw-tool',
        nativeTurnId: 'native-tool',
        terminal: {
          status: 'failed',
          errorCode: 'btw_tool_event_forbidden',
          message: 'Trae BTW attempted a native tool event',
        },
      }]);
      await new Promise(resolve => setTimeout(resolve, 50));
      const trace = readFileSync(traceFile, 'utf8');
      expect(trace).toContain('\"method\":\"turn/interrupt\"');
    } finally {
      releaseSession(session);
      rmSync(traceFile, { force: true });
    }
  }, 20_000);

  it('treats a pre-send throw as definitely_unsent without upgrading to submission_unknown', async () => {
    chmodSync(fakeCli, 0o755);
    const session = trackSession(new CodexRpcSession({
      cliBin: fakeCli,
      cwd: '/tmp',
      env: { ...process.env },
      sessionId: `btw-definitely-unsent-${Date.now()}`,
    }));
    try {
      await session.start();
      await session.startThread();

      const mod = await import('../src/features/btw/trae-adapter.js');
      const frameStates: Array<{ requestId: string; nativeTurnId: string; state: string }> = [];
      const terminals: Array<unknown> = [];
      const adapter = mod.createTraeBtwAdapter({
        session,
        threadId: session.activeThreadId!,
        runtimeEpoch: 'runtime_epoch_test',
        nativeTurnIdForRequest() { return 'native-pre-send'; },
        onFrameState: async event => { frameStates.push(event); },
        onTerminal: async event => { terminals.push(event); },
      });

      const original = session.requestWithDispatchBoundary.bind(session);
      session.requestWithDispatchBoundary = ((...args: Parameters<CodexRpcSession['requestWithDispatchBoundary']>) =>
        original(args[0], args[1], { ...args[2], beforeSend: () => { throw new Error('client send refused'); } })) as CodexRpcSession['requestWithDispatchBoundary'];

      await expect(adapter.run({ requestId: 'btw-pre-send', question: 'should fail before send' })).resolves.toEqual({
        status: 'submission_unknown',
        message: 'client send refused',
      });
      expect(frameStates).toEqual([
        { requestId: 'btw-pre-send', nativeTurnId: 'native-pre-send', runtimeEpoch: 'runtime_epoch_test', state: 'definitely_unsent' },
      ]);
      expect(terminals).toEqual([]);
      expect((session as any).turnOwners.has('native-pre-send')).toBe(false);
      expect((session as any).nativeBtwTurnIds.has('native-pre-send')).toBe(false);
    } finally {
      releaseSession(session);
    }
  }, 20_000);

  it('keeps terminal-before-ack and duplicate terminals idempotent without overwriting the first result', async () => {
    chmodSync(fakeCli, 0o755);
    const session = trackSession(new CodexRpcSession({
      cliBin: fakeCli,
      cwd: '/tmp',
      env: {
        ...process.env,
        FAKE_BTW_MODE: 'terminal-before-ack',
        FAKE_DUPLICATE_TERMINAL: '1',
        FAKE_BTW_MAP: JSON.stringify({
          'native-before-ack': { answer: 'terminal won before ack', ackDelayMs: 20 },
        }),
      },
      sessionId: `btw-before-ack-${Date.now()}`,
    }));
    try {
      await session.start();
      await session.startThread();

      const mod = await import('../src/features/btw/trae-adapter.js');
      const frameStates: Array<{ requestId: string; nativeTurnId: string; state: string }> = [];
      const terminals: Array<{ requestId: string; nativeTurnId: string; terminal: { status: string; answer?: string } }> = [];
      const adapter = mod.createTraeBtwAdapter({
        session,
        threadId: session.activeThreadId!,
        runtimeEpoch: 'runtime_epoch_test',
        nativeTurnIdForRequest() { return 'native-before-ack'; },
        onFrameState: async event => { frameStates.push(event); },
        onTerminal: async event => { terminals.push(event); },
      });

      await expect(adapter.run({ requestId: 'btw-before-ack', question: 'race me' })).resolves.toEqual({
        status: 'completed',
        answer: 'terminal won before ack',
      });
      await new Promise(resolve => setTimeout(resolve, 60));

      expect(frameStates).toEqual([
        { requestId: 'btw-before-ack', nativeTurnId: 'native-before-ack', runtimeEpoch: 'runtime_epoch_test', state: 'may_have_been_sent' },
      ]);
      expect(terminals).toEqual([{
        requestId: 'btw-before-ack',
        nativeTurnId: 'native-before-ack',
        terminal: { status: 'completed', answer: 'terminal won before ack' },
      }]);
    } finally {
      releaseSession(session);
    }
  }, 20_000);

  it('waits for the first terminal persistence before reporting duplicate terminal evidence', async () => {
    chmodSync(fakeCli, 0o755);
    const session = trackSession(new CodexRpcSession({
      cliBin: fakeCli,
      cwd: '/tmp',
      env: {
        ...process.env,
        FAKE_BTW_MODE: 'terminal-before-ack',
        FAKE_CONFLICTING_TERMINAL: '1',
        FAKE_BTW_MAP: JSON.stringify({
          'native-serial-terminal': { answer: 'first terminal', ackDelayMs: 20 },
        }),
      },
      sessionId: `btw-serial-terminal-${Date.now()}`,
    }));
    try {
      await session.start();
      await session.startThread();

      const mod = await import('../src/features/btw/trae-adapter.js');
      const terminalOrder: string[] = [];
      let releaseFirstTerminal!: () => void;
      const firstTerminalPersisted = new Promise<void>(resolve => { releaseFirstTerminal = resolve; });
      const adapter = mod.createTraeBtwAdapter({
        session,
        threadId: session.activeThreadId!,
        runtimeEpoch: 'runtime_epoch_test',
        nativeTurnIdForRequest() { return 'native-serial-terminal'; },
        onFrameState: async () => undefined,
        onTerminal: async event => {
          terminalOrder.push(`start:${event.terminal.status}`);
          if (event.terminal.status === 'completed') await firstTerminalPersisted;
          terminalOrder.push(`done:${event.terminal.status}`);
        },
      });

      const run = adapter.run({ requestId: 'btw-serial-terminal', question: 'race persistence' });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(terminalOrder).toEqual(['start:completed']);

      releaseFirstTerminal();
      await expect(run).resolves.toEqual({ status: 'completed', answer: 'first terminal' });
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(terminalOrder).toEqual(['start:completed', 'done:completed', 'start:failed', 'done:failed']);
    } finally {
      releaseSession(session);
    }
  }, 20_000);

  it('treats post-send disconnect as submission_unknown and still forbids tool execution notifications', async () => {
    chmodSync(fakeCli, 0o755);
    const session = trackSession(new CodexRpcSession({
      cliBin: fakeCli,
      cwd: '/tmp',
      env: {
        ...process.env,
        FAKE_BTW_MODE: 'tool-execution',
      },
      sessionId: `btw-tool-execution-${Date.now()}`,
    }));
    try {
      await session.start();
      await session.startThread();

      const mod = await import('../src/features/btw/trae-adapter.js');
      const terminals: Array<{ requestId: string; nativeTurnId: string; terminal: { status: string; errorCode?: string; message?: string } }> = [];
      const adapter = mod.createTraeBtwAdapter({
        session,
        threadId: session.activeThreadId!,
        runtimeEpoch: 'runtime_epoch_test',
        nativeTurnIdForRequest() { return 'native-tool-execution'; },
        onFrameState: async () => undefined,
        onTerminal: async event => { terminals.push(event); },
      });

      await expect(adapter.run({ requestId: 'btw-tool-execution', question: 'tool result is forbidden' })).resolves.toEqual({
        status: 'failed',
        errorCode: 'btw_tool_event_forbidden',
        message: 'Trae BTW attempted a native tool event',
      });
      expect(terminals).toEqual([{
        requestId: 'btw-tool-execution',
        nativeTurnId: 'native-tool-execution',
        terminal: {
          status: 'failed',
          errorCode: 'btw_tool_event_forbidden',
          message: 'Trae BTW attempted a native tool event',
        },
      }]);
    } finally {
      releaseSession(session);
    }
  }, 20_000);

  it('classifies a disconnect after WebSocket send as submission_unknown without replacing it with engine-dead', async () => {
    chmodSync(fakeCli, 0o755);
    const session = trackSession(new CodexRpcSession({
      cliBin: fakeCli,
      cwd: '/tmp',
      env: {
        ...process.env,
        FAKE_BTW_MODE: 'post-send-disconnect',
        FAKE_BTW_MAP: JSON.stringify({
          'native-post-send-disconnect': { delayMs: 1000, disconnectDelayMs: 10 },
        }),
      },
      sessionId: `btw-post-send-disconnect-${Date.now()}`,
      requestTimeoutMs: 500,
    }));
    try {
      await session.start();
      await session.startThread();

      const mod = await import('../src/features/btw/trae-adapter.js');
      const frameStates: Array<{ requestId: string; nativeTurnId: string; state: string }> = [];
      const terminals: Array<unknown> = [];
      const adapter = mod.createTraeBtwAdapter({
        session,
        threadId: session.activeThreadId!,
        runtimeEpoch: 'runtime_epoch_test',
        nativeTurnIdForRequest() { return 'native-post-send-disconnect'; },
        onFrameState: async event => { frameStates.push(event); },
        onTerminal: async event => { terminals.push(event); },
      });

      await expect(adapter.run({ requestId: 'btw-post-send-disconnect', question: 'drop after send' })).resolves.toEqual({
        status: 'submission_unknown',
        message: 'ws closed',
      });
      expect(frameStates).toEqual([
        { requestId: 'btw-post-send-disconnect', nativeTurnId: 'native-post-send-disconnect', runtimeEpoch: 'runtime_epoch_test', state: 'may_have_been_sent' },
      ]);
      expect(terminals).toEqual([]);
    } finally {
      releaseSession(session);
    }
  }, 20_000);

  it('releases the adapter observer on explicit close so later duplicate frames do not hit stale adapter caches', async () => {
    chmodSync(fakeCli, 0o755);
    const session = trackSession(new CodexRpcSession({
      cliBin: fakeCli,
      cwd: '/tmp',
      env: {
        ...process.env,
        FAKE_BTW_MAP: JSON.stringify({
          'native-old': { answer: 'old answer' },
          'native-new': {
            answer: 'new answer',
            replayTerminalTurnId: 'native-old',
            replayAnswer: 'late duplicate old answer',
          },
        }),
      },
      sessionId: `btw-observer-release-${Date.now()}`,
    }));
    try {
      await session.start();
      await session.startThread();

      const mod = await import('../src/features/btw/trae-adapter.js');
      const oldTerminals: unknown[] = [];
      const oldAdapter = mod.createTraeBtwAdapter({
        session,
        threadId: session.activeThreadId!,
        runtimeEpoch: 'runtime_epoch_test',
        nativeTurnIdForRequest() { return 'native-old'; },
        onFrameState: async () => undefined,
        onTerminal: async event => { oldTerminals.push(event); },
      });
      await expect(oldAdapter.run({ requestId: 'btw-old', question: 'old' })).resolves.toEqual({
        status: 'completed',
        answer: 'old answer',
      });
      expect(oldTerminals).toHaveLength(1);
      oldAdapter.close();

      const newAdapter = mod.createTraeBtwAdapter({
        session,
        threadId: session.activeThreadId!,
        runtimeEpoch: 'runtime_epoch_test',
        nativeTurnIdForRequest() { return 'native-new'; },
        onFrameState: async () => undefined,
        onTerminal: async () => undefined,
      });
      await expect(newAdapter.run({ requestId: 'btw-new', question: 'new' })).resolves.toEqual({
        status: 'completed',
        answer: 'new answer',
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(oldTerminals).toHaveLength(1);
    } finally {
      releaseSession(session);
    }
  }, 20_000);
});

describe('Trae native BTW runtime executor', () => {
  function runtimeInput(
    ensured: NonNullable<Awaited<ReturnType<ReturnType<typeof connectBtwRuntime>['client']['ensureSession']>>['attachment']>,
    sessionId: string,
    requestId = makeBtwPrepareInput().requestId,
  ): { input: PrepareBtwInput; scope: BtwOperationScope; nativeTurnId: string } {
    const scope: BtwOperationScope = {
      ...makeBtwScope(),
      botmuxSessionId: sessionId,
    };
    const baseInput = {
      ...makeBtwPrepareInput(),
      requestId,
    };
    const nativeTurnId = deriveBtwIdentifiers(scope, baseInput.requestId).nativeTurnId;
    return {
      scope,
      nativeTurnId,
      input: {
        ...baseInput,
        parent: {
          botmuxSessionId: sessionId,
          cliId: 'traex',
          nativeThreadId: ensured.nativeThreadId,
          runtimeEpoch: ensured.runtime.epoch,
          configHash: ensured.configHash,
          cwd: '/tmp',
        },
      },
    };
  }

  it('auto-submits an accepted BTW after record_card and persists a late authoritative terminal after submission_unknown', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-trae-runtime-'));
    dirs.push(dataDir);
    const runtime = await connectBtwRuntime({ dataDir });
    try {
      const sessionId = 'managed-btw-auto-submit';
      const requestId = 'om_request_auto_submit';
      const nativeTurnId = deriveBtwIdentifiers({ ...makeBtwScope(), botmuxSessionId: sessionId }, requestId).nativeTurnId;
      const ensured = await runtime.client.ensureSession(profileWithEnv(dataDir, sessionId, {
          FAKE_BTW_MODE: 'post-send-error-then-terminal',
          FAKE_BTW_MAP: JSON.stringify({
            [nativeTurnId]: { answer: 'late authoritative answer', delayMs: 120 },
          }),
      }));
      const { input, scope } = runtimeInput(ensured.attachment!, sessionId, requestId);
      const prepared = await runtime.client.prepareBtw(input);
      await runtime.client.recordCard(scope, prepared.operation.btwOpId, 'om_card_auto_submit');
      // The caller dies at the durable record_card boundary. The runtime owns
      // the wake queue and must execute without a submit_btw follow-up.
      runtime.close();

      const finalStore = createBtwOperationStore({ dataDir });
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(finalStore.getBtwOperation(scope, prepared.operation.btwOpId)?.execution).toMatchObject({
        state: 'completed',
        answer: 'late authoritative answer',
      });
    } finally {
      await cleanupRuntimeArtifacts(dataDir);
    }
  }, 20_000);

  it('leaves an accepted BTW durable when no matching live generation resolver exists', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-trae-runtime-mismatch-'));
    dirs.push(dataDir);
    const runtime = await connectBtwRuntime({ dataDir });
    try {
      const ensured = await runtime.client.ensureSession(profile(dataDir, 'managed-btw-mismatch'));
      const { input, scope } = runtimeInput(ensured.attachment!, 'other-session-id');
      const prepared = await runtime.client.prepareBtw(input);
      const opId = prepared.operation.btwOpId;
      await runtime.client.recordCard(scope, opId, 'om_card_mismatch');

      await expect(runtime.client.submitBtw(scope, opId)).resolves.toMatchObject({
        execution: { state: 'accepted' },
      });

      const finalStore = createBtwOperationStore({ dataDir });
      await new Promise(resolve => setTimeout(resolve, 300));
      expect(finalStore.getBtwOperation(scope, opId)?.execution).toMatchObject({
        state: 'accepted',
      });
    } finally {
      await cleanupRuntimeArtifacts(dataDir);
    }
  }, 20_000);

  it('auto-submits an accepted BTW when the matching Trae generation attaches later', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-trae-runtime-late-attach-'));
    dirs.push(dataDir);
    const runtime = await connectBtwRuntime({ dataDir });
    try {
      const sessionId = 'managed-btw-late-attach';
      const scope: BtwOperationScope = {
        ...makeBtwScope(),
        botmuxSessionId: sessionId,
      };
      const requestId = 'om_request_late_attach';
      const runtimeEpoch = runtime.descriptor.epoch;
      const nativeTurnId = deriveBtwIdentifiers(scope, requestId).nativeTurnId;
      const input: PrepareBtwInput = {
        ...makeBtwPrepareInput(),
        requestId,
        parent: {
          botmuxSessionId: sessionId,
          cliId: 'traex',
          nativeThreadId: 'thread-fake-1',
          runtimeEpoch,
          configHash: `config-${sessionId}`,
          cwd: '/tmp',
        },
      };
      const prepared = await runtime.client.prepareBtw(input);
      await runtime.client.recordCard(scope, prepared.operation.btwOpId, 'om_card_late_attach');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(createBtwOperationStore({ dataDir }).getBtwOperation(scope, prepared.operation.btwOpId)?.execution.state).toBe('accepted');

      const traceFile = join(dataDir, 'late-attach.jsonl');
      await runtime.client.ensureSession(profileWithEnv(dataDir, sessionId, {
        FAKE_TRACE_FILE: traceFile,
        FAKE_BTW_MAP: JSON.stringify({ [nativeTurnId]: { answer: 'late attach answer' } }),
      }));

      await new Promise(resolve => setTimeout(resolve, 300));
      expect(createBtwOperationStore({ dataDir }).getBtwOperation(scope, prepared.operation.btwOpId)?.execution).toMatchObject({
        state: 'completed',
        answer: 'late attach answer',
        nativeTurnId,
      });
      expect(readFileSync(traceFile, 'utf8')).toContain(`\"nativeTurnId\":\"${nativeTurnId}\"`);
    } finally {
      await cleanupRuntimeArtifacts(dataDir);
    }
  }, 20_000);

  it('proves mismatch runtime cleanup leaves zero registered live fake app-server pids', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-trae-runtime-interrupted-'));
    dirs.push(dataDir);
    const runtime = await connectBtwRuntime({ dataDir });
    try {
      const sessionId = 'managed-btw-interrupted';
      const ensured = await runtime.client.ensureSession(profile(dataDir, sessionId));
      const { input, scope } = runtimeInput(ensured.attachment!, sessionId, 'om_request_interrupted');
      const prepared = await runtime.client.prepareBtw(input);
      const opId = prepared.operation.btwOpId;
      await runtime.client.recordCard(scope, opId, 'om_card_interrupted');

      expect(opId).toBeTruthy();
    } finally {
      await shutdownAndKillRegisteredFakeServers(dataDir);
    }
    expect(liveRegisteredPids(dataDir)).toEqual([]);
    expect(registeredPidRecordCount(dataDir)).toBe(0);
    runtimePidDirs.delete(dataDir);
    rmSync(dataDir, { recursive: true, force: true });
  }, 20_000);

  it('reconciles accepted BTW to interrupted when its live generation disappears before submission', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-trae-runtime-interrupted-'));
    dirs.push(dataDir);
    const runtime = await connectBtwRuntime({ dataDir });
    try {
      const sessionId = 'managed-btw-interrupted';
      const ensured = await runtime.client.ensureSession(profile(dataDir, sessionId));
      const { input, scope } = runtimeInput(ensured.attachment!, 'missing-live-session', 'om_request_interrupted');
      const prepared = await runtime.client.prepareBtw(input);
      const opId = prepared.operation.btwOpId;
      await runtime.client.recordCard(scope, opId, 'om_card_interrupted');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(createBtwOperationStore({ dataDir }).getBtwOperation(scope, opId)?.execution.state).toBe('accepted');
      await shutdownAndKillRegisteredFakeServers(dataDir);
      runtime.close();

      const restarted = await connectBtwRuntime({ dataDir });
      try {
        await new Promise(resolve => setTimeout(resolve, 200));
        const finalStore = createBtwOperationStore({ dataDir });
        expect(finalStore.getBtwOperation(scope, opId)?.execution).toMatchObject({
          state: 'interrupted',
          message: expect.stringContaining('runtime no longer owns accepted btw operation'),
        });
      } finally {
        await shutdownAndKillRegisteredFakeServers(dataDir);
      }
    } finally {
      await cleanupRuntimeArtifacts(dataDir);
    }
  }, 20_000);

  it('coalesces concurrent submit wakes so one accepted BTW is submitted once', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-trae-runtime-coalesce-'));
    const traceFile = join(dataDir, 'coalesce-trace.jsonl');
    dirs.push(dataDir);
    const runtime = await connectBtwRuntime({ dataDir });
    try {
      const sessionId = 'managed-btw-coalesce';
      const ensured = await runtime.client.ensureSession(profileWithEnv(dataDir, sessionId, {
          FAKE_TRACE_FILE: traceFile,
          FAKE_BTW_MAP: JSON.stringify({
            [deriveBtwIdentifiers({ ...makeBtwScope(), botmuxSessionId: sessionId }, 'om_request_coalesce').nativeTurnId]: {
              answer: 'coalesced answer',
            },
          }),
      }));
      const { input, scope } = runtimeInput(ensured.attachment!, sessionId, 'om_request_coalesce');
      const prepared = await runtime.client.prepareBtw(input);
      const opId = prepared.operation.btwOpId;
      await runtime.client.recordCard(scope, opId, 'om_card_coalesce');

      const submitted = await Promise.all([
        runtime.client.submitBtw(scope, opId),
        runtime.client.submitBtw(scope, opId),
        runtime.client.submitBtw(scope, opId),
      ]);
      expect(submitted.every(operation => ['accepted', 'submit_prepared', 'running', 'completed'].includes(operation.execution.state))).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 200));
      const trace = readFileSync(traceFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as { event: string });
      expect(trace.filter(entry => entry.event === 'btw_submission')).toHaveLength(1);
      await shutdownAndKillRegisteredFakeServers(dataDir);
      expect(liveRegisteredPids(dataDir)).toEqual([]);
      expect(registeredPidRecordCount(dataDir)).toBe(0);
    } finally {
      await cleanupRuntimeArtifacts(dataDir);
      rmSync(traceFile, { force: true });
    }
  }, 20_000);

  it('drains executor wake records after a successful auto-submit', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-trae-runtime-drain-'));
    dirs.push(dataDir);
    const runtime = await connectBtwRuntime({ dataDir });
    try {
      const sessionId = 'managed-btw-drain';
      const ensured = await runtime.client.ensureSession(profile(dataDir, sessionId));
      const { input, scope } = runtimeInput(ensured.attachment!, sessionId, 'om_request_drain');
      const prepared = await runtime.client.prepareBtw(input);
      const opId = prepared.operation.btwOpId;
      await runtime.client.recordCard(scope, opId, 'om_card_drain');

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(createBtwOperationStore({ dataDir }).getBtwOperation(scope, opId)?.execution.state).toBe('completed');
      expect((await import('../src/features/btw/runtime-server.js')).consumeBtwExecutorWakes({ dataDir })).toEqual([]);
    } finally {
      await cleanupRuntimeArtifacts(dataDir);
    }
  }, 20_000);

  it('records terminal conflicts without overwriting the first authoritative terminal', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-trae-runtime-conflict-'));
    dirs.push(dataDir);
    const runtime = await connectBtwRuntime({ dataDir });
    try {
      const sessionId = 'managed-btw-conflict';
      const requestId = 'om_request_conflict';
      const nativeTurnId = deriveBtwIdentifiers({ ...makeBtwScope(), botmuxSessionId: sessionId }, requestId).nativeTurnId;
      const ensured = await runtime.client.ensureSession(profileWithEnv(dataDir, sessionId, {
          FAKE_BTW_MODE: 'terminal-before-ack',
          FAKE_CONFLICTING_TERMINAL: '1',
          FAKE_BTW_MAP: JSON.stringify({ [nativeTurnId]: { answer: 'first answer wins', ackDelayMs: 60 } }),
      }));
      const { input, scope } = runtimeInput(ensured.attachment!, sessionId, requestId);
      const prepared = await runtime.client.prepareBtw(input);
      const opId = prepared.operation.btwOpId;
      await runtime.client.recordCard(scope, opId, 'om_card_conflict');
      await new Promise(resolve => setTimeout(resolve, 200));

      const store = createBtwOperationStore({ dataDir });

      expect(store.getBtwOperation(scope, opId)?.execution).toMatchObject({
        state: 'completed',
        answer: 'first answer wins',
        nativeTurnId,
      });
      const conflictFiles = readdirSync(dirname(store.pathFor(scope, opId)))
        .filter(name => name.includes('.terminal-conflict.'));
      expect(conflictFiles).toHaveLength(1);
    } finally {
      await cleanupRuntimeArtifacts(dataDir);
    }
  }, 20_000);
});
