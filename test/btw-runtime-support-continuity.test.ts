import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { connectBtwRuntime } from '../src/features/btw/runtime-client.js';
import { MCP_GATEWAY_REQUIRED_ENV, MCP_GATEWAY_SOCKET_ENV } from '../src/core/plugins/mcp/environment.js';
import { sessionMcpGatewaySocketPath } from '../src/core/plugins/mcp/host.js';
import { mcpGatewayAuthTokenPath } from '../src/core/plugins/mcp/socket-auth.js';
import type { SessionMcpRuntimeManifest } from '../src/core/plugins/mcp/session-runtime.js';
import { tsRunnerPrefix } from './helpers/ts-runner.js';
import { waitForExactRuntimeExit } from './helpers/btw-runtime-test-cleanup.js';
import type { FrozenBtwSessionProfile } from '../src/features/btw/runtime-protocol.js';

const dirs: string[] = [];
const runtimes: Array<Awaited<ReturnType<typeof connectBtwRuntime>>> = [];
const fakeCli = fileURLToPath(new URL('./fixtures/fake-codex-rpc-server.mjs', import.meta.url));
const managedTraeContract = { nativeBtw: true, structuredTerminal: true, stableParentThread: true } as const;

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    const descriptor = runtime.descriptor;
    await runtime.client.shutdownRuntime().catch(() => undefined);
    runtime.close();
    await waitForExactRuntimeExit(descriptor.pid, descriptor.startIdentity);
  }
  for (const dataDir of dirs.splice(0)) {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

async function startRuntime(dataDir: string) {
  const runtime = await connectBtwRuntime({ dataDir });
  runtimes.push(runtime);
  return runtime;
}

function profile(dataDir: string, sessionId: string, configHash: string): FrozenBtwSessionProfile {
  return {
    sessionId, larkAppId: 'app-1', cliId: 'traex', cliBin: fakeCli, cwd: '/tmp',
    env: {
      PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? ''),
      FAKE_REQUEST_USER_INPUT: '1',
      FAKE_TRACE_FILE: join(dataDir, 'fake-app-server-trace.jsonl'),
    },
    appServerFeatures: [], configHash, mcpManifest: null, mcpManifestDigest: 'digest-frozen',
    managedBtwCapabilities: managedTraeContract,
  };
}

function fixtureMcpManifest(
  sessionId: string,
  serverEnv?: Record<string, string>,
): SessionMcpRuntimeManifest {
  return {
    schemaVersion: 1, sessionId, pluginIds: ['fixture'], generatedAt: new Date().toISOString(),
    entries: [{
      pluginId: 'fixture',
      pluginDir: dirname(fakeCli),
      server: {
        name: 'fixture', transport: 'stdio',
        command: [process.execPath, fileURLToPath(new URL('./fixtures/plugin-mcp-server.mjs', import.meta.url)), 'alpha'],
        ...(serverEnv ? { env: serverEnv } : {}),
      },
    }],
  };
}

async function connectRuntimeGateway(sessionId: string, dataDir: string, socketPath: string): Promise<Client> {
  const runner = tsRunnerPrefix();
  const transport = new StdioClientTransport({
    command: runner.command,
    args: [...runner.prefixArgs, fileURLToPath(new URL('../src/cli.ts', import.meta.url)), 'mcp', 'serve'],
    cwd: process.cwd(),
    env: {
      ...process.env,
      BOTMUX_SESSION_ID: sessionId,
      SESSION_DATA_DIR: dataDir,
      [MCP_GATEWAY_SOCKET_ENV]: socketPath,
      [MCP_GATEWAY_REQUIRED_ENV]: '1',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'runtime-gateway-continuity-test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe('managed runtime support continuity', () => {
  it('keeps a pending native ask through replacement and interrupts on explicit null stop instead of replying empty answers', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-support-continuity-'));
    dirs.push(dataDir);
    const runtime = await startRuntime(dataDir);
    const sessionId = 'support-continuity-ask';
    const frozen = profile(dataDir, sessionId, 'generation-one');

    await runtime.client.ensureSession(frozen);
    const first = await runtime.client.attachSession({ sessionId, cursor: 0 });
    const firstEvents = first.notifications[Symbol.asyncIterator]();
    const submitted = runtime.client.submitMainTurn(sessionId, 'wait for operator', { turnId: 'turn-support-ask' });
    const ask = await firstEvents.next();
    expect(ask).toMatchObject({
      done: false,
      value: { kind: 'request_user_input', payload: { params: { turnId: 'turn-fake-1' } } },
    });
    const requestId = (ask.value as Extract<NonNullable<typeof ask.value>, { kind: 'request_user_input' }>).payload.requestId;

    await first.detach();
    const second = await runtime.client.attachSession({ sessionId, cursor: 0 });
    await expect(second.notifications[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      done: false, value: { kind: 'request_user_input', payload: { requestId } },
    });

    await runtime.client.answerUserInput(sessionId, requestId, null);
    await expect(submitted).resolves.toEqual({ nativeTurnId: 'turn-fake-1' });
    await new Promise(resolve => setTimeout(resolve, 25));

    const trace = readFileSync(join(dataDir, 'fake-app-server-trace.jsonl'), 'utf8');
    expect(trace).toContain('\"method\":\"turn/interrupt\"');

    await second.detach();
  }, 20_000);

  it('accepts one exact answer once and never translates it into an interrupt', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-support-answer-'));
    dirs.push(dataDir);
    const runtime = await startRuntime(dataDir);
    const sessionId = 'support-continuity-answer';

    await runtime.client.ensureSession(profile(dataDir, sessionId, 'generation-one'));
    const attached = await runtime.client.attachSession({ sessionId, cursor: 0 });
    const events = attached.notifications[Symbol.asyncIterator]();
    const submitted = runtime.client.submitMainTurn(sessionId, 'wait for answer', { turnId: 'turn-support-answer' });
    const ask = await events.next();
    const requestId = (ask.value as Extract<NonNullable<typeof ask.value>, { kind: 'request_user_input' }>).payload.requestId;
    const answer = { answers: { choice: { answers: ['Yes'] } } };

    await runtime.client.answerUserInput(sessionId, requestId, answer);
    await expect(runtime.client.answerUserInput(sessionId, requestId, answer)).rejects.toThrow('not found');
    await expect(submitted).resolves.toEqual({ nativeTurnId: 'turn-fake-1' });
    await new Promise(resolve => setTimeout(resolve, 25));

    const trace = readFileSync(join(dataDir, 'fake-app-server-trace.jsonl'), 'utf8');
    expect(trace).not.toContain('\"method\":\"turn/interrupt\"');

    await attached.detach();
  }, 20_000);

  it('reports config and independent manifest-digest drift while retaining the original runtime generation and metadata operations', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-support-drift-'));
    dirs.push(dataDir);
    const runtime = await startRuntime(dataDir);
    const sessionId = 'support-continuity-drift';

    const frozen = {
      ...profile(dataDir, sessionId, 'generation-one'),
      mcpManifest: fixtureMcpManifest(sessionId),
      mcpManifestDigest: 'digest-generation-one',
    };
    const first = await runtime.client.ensureSession(frozen);
    const gatewaySocketPath = sessionMcpGatewaySocketPath(sessionId, realpathSync(dataDir));
    const gatewayInode = statSync(gatewaySocketPath).ino;
    const replacement = await runtime.client.ensureSession({
      ...frozen,
      mcpManifestDigest: 'digest-mutated-without-config-hash-change',
    });

    expect(replacement).toMatchObject({ configDrift: true });
    expect(replacement.attachment).toMatchObject({
      appServerUrl: first.attachment?.appServerUrl,
      nativeThreadId: first.attachment?.nativeThreadId,
      configHash: 'generation-one',
      runtime: first.attachment?.runtime,
    });
    expect(statSync(gatewaySocketPath).ino).toBe(gatewayInode);

    await runtime.client.setThreadName(sessionId, 'retained title');
    await expect(runtime.client.readThreadMetadata(sessionId)).resolves.toMatchObject({ name: 'retained title' });
  }, 20_000);

  it('keeps caller, turn, and dispatch identity at the runtime-owned gateway until the native terminal', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-support-caller-'));
    dirs.push(dataDir);
    const runtime = await startRuntime(dataDir);
    const sessionId = 'support-continuity-caller';
    const frozen = {
      ...profile(dataDir, sessionId, 'generation-one'),
      env: {
        ...profile(dataDir, sessionId, 'generation-one').env,
        FAKE_REQUEST_USER_INPUT: '0',
        FAKE_DELAY_TURN_TERMINAL_MS: '2000',
      },
      mcpManifest: fixtureMcpManifest(sessionId),
      mcpManifestDigest: 'digest-caller-frozen',
    };
    await runtime.client.ensureSession(frozen);
    // The persistent runtime canonicalizes dataDir before deriving its
    // deterministic socket name. On this host /home is a symlink, so match
    // that canonical identity rather than the lexical mkdtemp path.
    const gatewaySocketPath = sessionMcpGatewaySocketPath(sessionId, realpathSync(dataDir));
    expect(existsSync(mcpGatewayAuthTokenPath(gatewaySocketPath))).toBe(true);
    const socketInode = statSync(gatewaySocketPath).ino;
    const attached = await runtime.client.attachSession({ sessionId, cursor: 0 });
    const gateway = await connectRuntimeGateway(sessionId, dataDir, gatewaySocketPath);
    const submitted = runtime.client.submitMainTurn(sessionId, 'preserve caller', {
      turnId: 'turn-caller', dispatchAttempt: 7,
      caller: { requestUserOpenId: 'ou_runtime', requestUserUnionId: 'on_runtime', requestLarkAppId: 'cli_runtime' },
    });
    await attached.detach();
    const replacement = await runtime.client.attachSession({ sessionId, cursor: 0 });
    expect(statSync(gatewaySocketPath).ino).toBe(socketInode);
    try {
      const active = await gateway.callTool({ name: 'echo', arguments: {} });
      const activeText = (active.content[0] as { text: string }).text;
      expect(activeText).toContain('\"requestUserOpenId\":\"ou_runtime\"');
      expect(activeText).toContain('\"requestUserUnionId\":\"on_runtime\"');
      expect(activeText).toContain('\"requestLarkAppId\":\"cli_runtime\"');
      expect(activeText).toContain('\"turnId\":\"turn-caller\"');
      expect(activeText).toContain('\"dispatchAttempt\":7');

      const events = replacement.notifications[Symbol.asyncIterator]();
      await expect(events.next()).resolves.toMatchObject({
        value: { kind: 'main_terminal', payload: { identity: { turnId: 'turn-caller', dispatchAttempt: 7 } } },
      });
      await expect(submitted).resolves.toEqual({ nativeTurnId: 'turn-fake-1' });
      const retired = await gateway.callTool({ name: 'echo', arguments: {} });
      const retiredText = (retired.content[0] as { text: string }).text;
      expect(retiredText).not.toContain('botmuxTrustedCaller');
      expect(retiredText).not.toContain('ou_runtime');
      expect(retiredText).not.toContain('turn-caller');
    } finally {
      await gateway.close().catch(() => undefined);
      await replacement.detach().catch(() => undefined);
    }
  }, 20_000);

  it('keeps the first frozen session environment and owner at MCP tools after attachment replacement', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-support-frozen-env-'));
    dirs.push(dataDir);
    const originalFrozenEnv = process.env.FROZEN_SESSION_ENV;
    const originalOwner = process.env.BOTMUX_OWNER_OPEN_ID;
    const originalLegacyOwner = process.env.__OWNER_OPEN_ID;
    try {
      process.env.FROZEN_SESSION_ENV = 'ambient-runtime-start';
      process.env.BOTMUX_OWNER_OPEN_ID = 'ou_ambient_runtime_owner';
      process.env.__OWNER_OPEN_ID = 'ou_ambient_runtime_legacy_owner';
      const runtime = await startRuntime(dataDir);
      const sessionId = 'support-continuity-frozen-env';
      const frozen = {
        ...profile(dataDir, sessionId, 'generation-one'),
        env: {
          ...profile(dataDir, sessionId, 'generation-one').env,
          FROZEN_SESSION_ENV: 'first-generation',
        },
        ownerOpenId: 'ou_frozen_owner',
        mcpManifest: fixtureMcpManifest(sessionId, {
          BOTMUX_OWNER_OPEN_ID: 'ou_descriptor_override',
          __OWNER_OPEN_ID: 'ou_descriptor_legacy_override',
        }),
        mcpManifestDigest: 'digest-frozen-env',
      };
      await runtime.client.ensureSession(frozen);
      process.env.FROZEN_SESSION_ENV = 'ambient-replacement';
      process.env.BOTMUX_OWNER_OPEN_ID = 'ou_ambient_override';
      process.env.__OWNER_OPEN_ID = 'ou_ambient_legacy_override';

      const first = await runtime.client.attachSession({ sessionId, cursor: 0 });
      await first.detach();
      const replacement = await runtime.client.attachSession({ sessionId, cursor: 0 });
      const gatewaySocketPath = sessionMcpGatewaySocketPath(sessionId, realpathSync(dataDir));
      const gateway = await connectRuntimeGateway(sessionId, dataDir, gatewaySocketPath);
      try {
        const result = await gateway.callTool({ name: 'echo', arguments: {} });
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('frozen=first-generation');
        expect(text).toContain('owner=ou_frozen_owner');
        expect(text).toContain('legacyOwner=ou_frozen_owner');
      } finally {
        await gateway.close().catch(() => undefined);
        await replacement.detach().catch(() => undefined);
      }
    } finally {
      if (originalFrozenEnv === undefined) delete process.env.FROZEN_SESSION_ENV;
      else process.env.FROZEN_SESSION_ENV = originalFrozenEnv;
      if (originalOwner === undefined) delete process.env.BOTMUX_OWNER_OPEN_ID;
      else process.env.BOTMUX_OWNER_OPEN_ID = originalOwner;
      if (originalLegacyOwner === undefined) delete process.env.__OWNER_OPEN_ID;
      else process.env.__OWNER_OPEN_ID = originalLegacyOwner;
    }
  }, 20_000);

  it('does not let descriptor or ambient owner values repopulate an ownerless frozen session', async () => {
    chmodSync(fakeCli, 0o755);
    const dataDir = mkdtempSync(join(tmpdir(), 'botmux-btw-support-ownerless-env-'));
    dirs.push(dataDir);
    const originalOwner = process.env.BOTMUX_OWNER_OPEN_ID;
    const originalLegacyOwner = process.env.__OWNER_OPEN_ID;
    try {
      process.env.BOTMUX_OWNER_OPEN_ID = 'ou_ambient_owner';
      process.env.__OWNER_OPEN_ID = 'ou_ambient_legacy_owner';
      const runtime = await startRuntime(dataDir);
      const sessionId = 'support-continuity-ownerless-env';
      await runtime.client.ensureSession({
        ...profile(dataDir, sessionId, 'generation-one'),
        mcpManifest: fixtureMcpManifest(sessionId, {
          BOTMUX_OWNER_OPEN_ID: 'ou_descriptor_override',
          __OWNER_OPEN_ID: 'ou_descriptor_legacy_override',
        }),
        mcpManifestDigest: 'digest-ownerless-env',
      });
      const gatewaySocketPath = sessionMcpGatewaySocketPath(sessionId, realpathSync(dataDir));
      const gateway = await connectRuntimeGateway(sessionId, dataDir, gatewaySocketPath);
      try {
        const result = await gateway.callTool({ name: 'echo', arguments: {} });
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain('owner=:legacyOwner=');
      } finally {
        await gateway.close().catch(() => undefined);
      }
    } finally {
      if (originalOwner === undefined) delete process.env.BOTMUX_OWNER_OPEN_ID;
      else process.env.BOTMUX_OWNER_OPEN_ID = originalOwner;
      if (originalLegacyOwner === undefined) delete process.env.__OWNER_OPEN_ID;
      else process.env.__OWNER_OPEN_ID = originalLegacyOwner;
    }
  }, 20_000);
});
