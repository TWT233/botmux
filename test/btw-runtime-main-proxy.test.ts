import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PersistentTraeRpcProxy } from '../src/codex-rpc-session.js';
import { connectBtwRuntime } from '../src/features/btw/runtime-client.js';

const dirs: string[] = [];
const fakeCli = fileURLToPath(new URL('./fixtures/fake-codex-rpc-server.mjs', import.meta.url));

afterEach(async () => {
  for (const dataDir of dirs.splice(0)) {
    const runtime = await connectBtwRuntime({ dataDir }).catch(() => undefined);
    if (runtime) {
      await runtime.client.shutdownRuntime().catch(() => undefined);
      runtime.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('PersistentTraeRpcProxy', () => {
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
  it('keeps the app server and native thread alive across detach then attaches a new observer to the same thread', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-main-proxy-'));
    dirs.push(dataDir);
    const runtime = await connectBtwRuntime({ dataDir });
    const profile = {
      sessionId: 'managed-session-1', larkAppId: 'app-1', cliId: 'traex' as const,
      cliBin: fakeCli, cwd: '/tmp', env: { PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? '') }, appServerFeatures: [],
      configHash: 'profile-1', mcpManifest: null, mcpManifestDigest: 'none',
    };

    const ensured = await runtime.client.ensureSession(profile);
    const first = await runtime.client.attachSession({ sessionId: profile.sessionId, cursor: 0 });
    await first.detach();
    const second = await runtime.client.attachSession({ sessionId: profile.sessionId, cursor: 0 });

    expect(second.attachment.appServerUrl).toBe(ensured.attachment.appServerUrl);
    expect(second.attachment.nativeThreadId).toBe(ensured.attachment.nativeThreadId);
    await second.detach();
    runtime.close();
  }, 20_000);
});
