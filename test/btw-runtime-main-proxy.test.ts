import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PersistentTraeRpcProxy } from '../src/codex-rpc-session.js';
import { connectBtwRuntime } from '../src/features/btw/runtime-client.js';
import type { FrozenBtwSessionProfile } from '../src/features/btw/runtime-protocol.js';
import { waitForExactRuntimeExit } from './helpers/btw-runtime-test-cleanup.js';

const dirs: string[] = [];
const fakeCli = fileURLToPath(new URL('./fixtures/fake-codex-rpc-server.mjs', import.meta.url));
const managedTraeContract = { nativeBtw: true, structuredTerminal: true, stableParentThread: true } as const;

afterEach(async () => {
  for (const dataDir of dirs.splice(0)) {
    const runtime = await connectBtwRuntime({ dataDir }).catch(() => undefined);
    if (runtime) {
      const descriptor = runtime.descriptor;
      await runtime.client.shutdownRuntime().catch(() => undefined);
      runtime.close();
      await waitForExactRuntimeExit(descriptor.pid, descriptor.startIdentity);
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('PersistentTraeRpcProxy', () => {
  it('synchronously invalidates its observer without closing the daemon-owned app server', () => {
    const runtime = {
      detachSession: vi.fn(async () => undefined),
      submitFirstTurn: vi.fn(), submitMainTurn: vi.fn(), readThreadMetadata: vi.fn(), setThreadName: vi.fn(),
    };
    const closeSubscription = vi.fn();
    const proxy = new PersistentTraeRpcProxy({
      runtime, sessionId: 'session-sync-close', appServerUrl: 'ws://runtime:9000', nativeThreadId: 'thread-1', closeSubscription,
    });

    proxy.closeObserver();

    expect(closeSubscription).toHaveBeenCalledOnce();
    expect(runtime.detachSession).not.toHaveBeenCalled();
    expect(proxy.wsUrl).toBe('ws://runtime:9000');
    expect(proxy.activeThreadId).toBe('thread-1');
  });

  it('detaches its observer without closing the runtime-owned app server or native thread', async () => {
    const runtime = {
      detachSession: vi.fn(async () => undefined),
      closeSession: vi.fn(async () => undefined),
      submitFirstTurn: vi.fn(async () => ({ outcome: 'accepted' as const, nativeTurnId: 'turn-1' })),
      submitMainTurn: vi.fn(async () => ({ nativeTurnId: 'turn-2' })),
      readThreadMetadata: vi.fn(async () => ({ name: 'original', preview: 'hello', updatedAt: 7 })),
      setThreadName: vi.fn(async () => undefined),
    };
    const closeSubscription = vi.fn(async () => undefined);
    const proxy = new PersistentTraeRpcProxy({ runtime, sessionId: 'session-1', appServerUrl: 'ws://runtime:9000', nativeThreadId: 'thread-1', closeSubscription });

    await expect(proxy.sendFirstTurn('first', { turnId: 'opening-1' }, async () => false))
      .resolves.toEqual({ outcome: 'accepted', nativeTurnId: 'turn-1' });
    await expect(proxy.sendTurn('next', { turnId: 'followup-1' })).resolves.toEqual({ nativeTurnId: 'turn-2' });
    await proxy.stop();

    expect(proxy.wsUrl).toBe('ws://runtime:9000');
    expect(closeSubscription).toHaveBeenCalledOnce();
    expect(runtime.detachSession).toHaveBeenCalledWith('session-1');
    expect(runtime.closeSession).not.toHaveBeenCalled();
    expect(await proxy.readThreadMetadata()).toEqual({ name: 'original', preview: 'hello', updatedAt: 7 });
  });
});

describe('managed BTW runtime session commands', () => {
  it('waits for the exact runtime identity to exit after shutdown acknowledgement', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-runtime-shutdown-ack-'));
    dirs.push(dataDir);
    const runtime = await connectBtwRuntime({ dataDir });
    try {
      const descriptor = runtime.descriptor;
      await runtime.client.shutdownRuntime();
      runtime.close();

      await waitForExactRuntimeExit(descriptor.pid, descriptor.startIdentity);
    } finally {
      runtime.close();
    }
  }, 20_000);

  it('rejects a Trae launch contract missing a managed capability before retaining an app server or attachment', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-capability-denial-'));
    dirs.push(dataDir);
    const traceFile = join(dataDir, 'fake-app-server-trace.jsonl');
    const runtime = await connectBtwRuntime({ dataDir });
    const profile = {
      sessionId: 'managed-capability-denied', larkAppId: 'app-1', cliId: 'traex' as const,
      cliBin: fakeCli, cwd: '/tmp',
      env: { PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? ''), FAKE_TRACE_FILE: traceFile },
      appServerFeatures: [], configHash: 'profile-capability-denied', mcpManifest: null, mcpManifestDigest: 'none',
      managedBtwCapabilities: { ...managedTraeContract, stableParentThread: false },
    } satisfies FrozenBtwSessionProfile;

    await expect(runtime.client.ensureSession(profile)).resolves.toMatchObject({
      attachment: null,
      capabilities: { stableParentThread: false },
    });
    expect(existsSync(traceFile)).toBe(false);
    await expect(runtime.client.attachSession({ sessionId: profile.sessionId, cursor: 0 }))
      .rejects.toThrow('btw session attachment was not acknowledged');

    runtime.close();
  }, 20_000);

  it('keeps the app server and native thread alive when a worker closes its observer then a new cursor attachment takes over', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-main-proxy-'));
    dirs.push(dataDir);
    const runtime = await connectBtwRuntime({ dataDir });
    const profile = {
      sessionId: 'managed-session-1', larkAppId: 'app-1', cliId: 'traex' as const,
      cliBin: fakeCli, cwd: '/tmp', env: { PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? '') }, appServerFeatures: [],
      configHash: 'profile-1', mcpManifest: null, mcpManifestDigest: 'none', managedBtwCapabilities: managedTraeContract,
    } satisfies FrozenBtwSessionProfile;

    const ensured = await runtime.client.ensureSession(profile);
    const first = await runtime.client.attachSession({ sessionId: profile.sessionId, cursor: 0 });
    const proxy = new PersistentTraeRpcProxy({
      runtime: runtime.client, sessionId: profile.sessionId,
      appServerUrl: first.attachment.appServerUrl, nativeThreadId: first.attachment.nativeThreadId,
      closeSubscription: () => first.notifications[Symbol.asyncIterator]().return?.(),
    });
    // Mirrors controlled worker teardown: observer invalidation is immediate,
    // while the explicit detach bookkeeping may finish asynchronously.
    proxy.closeObserver();
    await proxy.stop();
    const second = await runtime.client.attachSession({ sessionId: profile.sessionId, cursor: 0 });

    expect(second.attachment.appServerUrl).toBe(ensured.attachment.appServerUrl);
    expect(second.attachment.nativeThreadId).toBe(ensured.attachment.nativeThreadId);
    await second.detach();
    await runtime.client.shutdownRuntime();
    runtime.close();
  }, 20_000);

  it('retains a request_user_input ask through observer detach until its exact answer resolves the native turn', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-pending-ask-'));
    dirs.push(dataDir);
    const runtime = await connectBtwRuntime({ dataDir });
    const profile = {
      sessionId: 'managed-pending-ask', larkAppId: 'app-1', cliId: 'traex' as const,
      cliBin: fakeCli, cwd: '/tmp',
      env: {
        PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? ''),
        FAKE_REQUEST_USER_INPUT: '1',
      },
      appServerFeatures: [], configHash: 'profile-pending-ask', mcpManifest: null, mcpManifestDigest: 'none', managedBtwCapabilities: managedTraeContract,
    } satisfies FrozenBtwSessionProfile;

    await runtime.client.ensureSession(profile);
    const first = await runtime.client.attachSession({ sessionId: profile.sessionId, cursor: 0 });
    const firstNotifications = first.notifications[Symbol.asyncIterator]();
    const submitted = runtime.client.submitMainTurn(profile.sessionId, 'ask before continuing', { turnId: 'turn-pending-ask' });

    const ask = await firstNotifications.next();
    expect(ask).toMatchObject({
      done: false,
      value: {
        kind: 'request_user_input',
        payload: { params: { questions: [{ id: 'choice', question: 'Continue?' }] } },
      },
    });
    const requestId = (ask.value as Extract<NonNullable<typeof ask.value>, { kind: 'request_user_input' }>).payload.requestId;

    const beforeAnswer = firstNotifications.next().then(result => ({ kind: 'notification' as const, result }));
    const noTerminalYet = await Promise.race([
      beforeAnswer,
      new Promise<{ kind: 'timeout' }>(resolve => setTimeout(() => resolve({ kind: 'timeout' }), 150)),
    ]);
    expect(noTerminalYet).toEqual({ kind: 'timeout' });

    await first.detach();
    const second = await runtime.client.attachSession({ sessionId: profile.sessionId, cursor: 0 });
    const secondNotifications = second.notifications[Symbol.asyncIterator]();
    await expect(secondNotifications.next()).resolves.toMatchObject({
      done: false,
      value: { kind: 'request_user_input', payload: { requestId } },
    });

    await expect(runtime.client.answerUserInput(profile.sessionId, 'unknown-request', { answers: {} }))
      .rejects.toThrow('managed Trae user input request not found');
    await runtime.client.answerUserInput(profile.sessionId, requestId, {
      answers: { choice: { answers: ['Yes'] } },
    });
    await expect(runtime.client.answerUserInput(profile.sessionId, requestId, {
      answers: { choice: { answers: ['Yes'] } },
    })).rejects.toThrow('managed Trae user input request not found');
    await expect(submitted).resolves.toEqual({ nativeTurnId: 'turn-fake-1' });
    await expect(secondNotifications.next()).resolves.toMatchObject({
      done: false,
      value: { kind: 'main_terminal', payload: { nativeTurnId: 'turn-fake-1', status: 'completed' } },
    });

    await second.detach();
    await runtime.client.shutdownRuntime();
    runtime.close();
  }, 20_000);
});
