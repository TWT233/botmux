import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Socket, createConnection, createServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { BTW_RUNTIME_PROTOCOL_VERSION, type BtwRuntimeDescriptor, type BtwRuntimeEnvelope, type BtwRuntimeFrame } from '../src/features/btw/runtime-protocol.js';
import { BtwRuntimeClientImpl, connectBtwRuntime, ensureBtwRuntime } from '../src/features/btw/runtime-client.js';
import { readProcessStartIdentity } from '../src/core/session-marker.js';
import { deriveBtwIdentifiers } from '../src/features/btw/types.js';
import { makeBtwPrepareInput, makeBtwScope } from './fixtures/btw-fixtures.js';

const tempDirs: string[] = [];
const staleSocketPaths: string[] = [];
const exactRuntimes = new Map<string, Array<{ descriptor: BtwRuntimeDescriptor; token: string }>>();

function newDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-btw-runtime-auth-'));
  tempDirs.push(dir);
  return dir;
}

function runtimeFiles(dataDir: string): {
  runtimeDir: string;
  descriptorPath: string;
  tokenPath: string;
  startupPath: string;
} {
  const runtimeDir = join(dataDir, 'btw');
  return {
    runtimeDir,
    descriptorPath: join(runtimeDir, 'runtime.json'),
    tokenPath: join(runtimeDir, 'runtime.token'),
    startupPath: join(runtimeDir, 'runtime.starting.json'),
  };
}

function trackRuntime(dataDir: string, descriptor: BtwRuntimeDescriptor): BtwRuntimeDescriptor {
  const token = readFileSync(runtimeFiles(dataDir).tokenPath, 'utf8').trim();
  const entries = exactRuntimes.get(dataDir) ?? [];
  if (!entries.some(entry => entry.descriptor.pid === descriptor.pid && entry.descriptor.startIdentity === descriptor.startIdentity)) {
    entries.push({ descriptor, token });
  }
  exactRuntimes.set(dataDir, entries);
  return descriptor;
}

async function ensureTestRuntime(dataDir: string): Promise<BtwRuntimeDescriptor> {
  return trackRuntime(dataDir, await ensureBtwRuntime({ dataDir }));
}

async function connectTestRuntime(dataDir: string) {
  const connected = await connectBtwRuntime({ dataDir });
  trackRuntime(dataDir, connected.descriptor);
  return connected;
}

async function connectRaw(socketPath: string): Promise<Socket> {
  return await new Promise<Socket>((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function readLine(socket: Socket): Promise<string> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      buffer = Buffer.concat([buffer, bytes]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      cleanup();
      const rest = buffer.subarray(newline + 1);
      if (rest.length > 0) socket.unshift(rest);
      resolve(buffer.subarray(0, newline).toString('utf8').replace(/\r$/, ''));
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('socket closed')); };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function authenticateRaw(input: {
  descriptor: BtwRuntimeDescriptor;
  token: string;
  epoch?: string;
}): Promise<Socket> {
  const socket = await connectRaw(input.descriptor.socket);
  socket.write(JSON.stringify({
    kind: 'auth',
    token: input.token,
    protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION,
    runtimeEpoch: input.epoch ?? input.descriptor.epoch,
  }) + '\n');
  const line = await readLine(socket);
  expect(JSON.parse(line)).toEqual({ kind: 'auth_ok' });
  return socket;
}

async function waitForExactExit(descriptor: BtwRuntimeDescriptor, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (readProcessStartIdentity(descriptor.pid) !== descriptor.startIdentity) return true;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return readProcessStartIdentity(descriptor.pid) !== descriptor.startIdentity;
}

async function stopExactRuntime(entry: { descriptor: BtwRuntimeDescriptor; token: string }): Promise<void> {
  const { descriptor, token } = entry;
  if (readProcessStartIdentity(descriptor.pid) !== descriptor.startIdentity) return;
  try {
    const socket = await authenticateRaw({ descriptor, token });
    socket.write(`${requestFrame('teardown', descriptor.epoch).replace('\"quiesce_all\"', '\"shutdown_runtime\"')}\n`);
    socket.destroy();
  } catch {
    // The transport may already be gone; the identity-bound signal below is
    // still confined to the exact runtime that this test spawned.
  }
  if (await waitForExactExit(descriptor)) return;
  if (readProcessStartIdentity(descriptor.pid) === descriptor.startIdentity) {
    process.kill(descriptor.pid, 'SIGTERM');
  }
  if (await waitForExactExit(descriptor)) return;
  if (readProcessStartIdentity(descriptor.pid) === descriptor.startIdentity) {
    process.kill(descriptor.pid, 'SIGKILL');
  }
  expect(await waitForExactExit(descriptor)).toBe(true);
}

function requestFrame(requestId: string, epoch: string): string {
  const frame = {
    requestId,
    protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION,
    runtimeEpoch: epoch,
    command: { type: 'quiesce_all' },
  } satisfies BtwRuntimeEnvelope;
  return JSON.stringify(frame);
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    try {
      for (const runtime of exactRuntimes.get(dir) ?? []) {
        await stopExactRuntime(runtime);
      }
    } finally {
      exactRuntimes.delete(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  for (const socketPath of staleSocketPaths.splice(0)) {
    try { unlinkSync(socketPath); } catch { /* already absent */ }
  }
});

describe('BTW runtime auth and singleton boot', () => {
  it('converges twenty concurrent ensures to one PID/epoch and writes only the six-field descriptor', async () => {
    const dataDir = newDataDir();
    const descriptors = await Promise.all(
      Array.from({ length: 20 }, () => ensureTestRuntime(dataDir)),
    );
    expect(new Set(descriptors.map(value => `${value.pid}:${value.epoch}`)).size).toBe(1);
    expect(Object.keys(descriptors[0]!).sort()).toEqual(
      ['buildId', 'epoch', 'pid', 'protocolVersion', 'socket', 'startIdentity'],
    );
  });

  it('pins 0700/0600 permissions for the runtime dir, descriptor, token, and socket', async () => {
    const dataDir = newDataDir();
    const descriptor = await ensureTestRuntime(dataDir);
    const { runtimeDir, descriptorPath, tokenPath } = runtimeFiles(dataDir);

    expect(statSync(runtimeDir).mode & 0o777).toBe(0o700);
    expect(statSync(descriptorPath).mode & 0o777).toBe(0o600);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    expect(statSync(descriptor.socket).mode & 0o777).toBe(0o600);
  });

  it('rejects wrong token and stale epoch during authentication', async () => {
    const dataDir = newDataDir();
    const descriptor = await ensureTestRuntime(dataDir);
    const { tokenPath } = runtimeFiles(dataDir);
    const token = readFileSync(tokenPath, 'utf8').trim();

    const wrongTokenSocket = await connectRaw(descriptor.socket);
    wrongTokenSocket.write(JSON.stringify({
      kind: 'auth',
      token: `${token}x`,
      protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION,
      runtimeEpoch: descriptor.epoch,
    }) + '\n');
    expect(JSON.parse(await readLine(wrongTokenSocket))).toMatchObject({
      kind: 'auth_error',
      error: { code: 'AUTH_FAILED' },
    });
    wrongTokenSocket.destroy();

    const staleEpochSocket = await connectRaw(descriptor.socket);
    staleEpochSocket.write(JSON.stringify({
      kind: 'auth',
      token,
      protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION,
      runtimeEpoch: `${descriptor.epoch}-stale`,
    }) + '\n');
    expect(JSON.parse(await readLine(staleEpochSocket))).toMatchObject({
      kind: 'auth_error',
      error: { code: 'STALE_EPOCH' },
    });
    staleEpochSocket.destroy();
  });

  it('fails closed on malformed and oversized frames after a valid handshake', async () => {
    const dataDir = newDataDir();
    const descriptor = await ensureTestRuntime(dataDir);
    const { tokenPath } = runtimeFiles(dataDir);
    const token = readFileSync(tokenPath, 'utf8').trim();

    const malformedSocket = await authenticateRaw({ descriptor, token });
    malformedSocket.write('{bad json\n');
    await expect(new Promise<void>((resolve, reject) => {
      malformedSocket.once('close', () => resolve());
      malformedSocket.once('error', reject);
    })).resolves.toBeUndefined();

    const oversizedSocket = await authenticateRaw({ descriptor, token });
    oversizedSocket.write(`${'x'.repeat(70_000)}\n`);
    await expect(new Promise<void>((resolve, reject) => {
      oversizedSocket.once('close', () => resolve());
      oversizedSocket.once('error', reject);
    })).resolves.toBeUndefined();
  });

  it('fails closed when one client floods a connection past the request queue bound', async () => {
    const dataDir = newDataDir();
    const descriptor = await ensureTestRuntime(dataDir);
    const { tokenPath } = runtimeFiles(dataDir);
    const token = readFileSync(tokenPath, 'utf8').trim();
    const socket = await authenticateRaw({ descriptor, token });

    for (let index = 0; index < 128; index += 1) {
      socket.write(`${requestFrame(`req-${index}`, descriptor.epoch)}\n`);
    }

    await expect(new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.once('error', () => resolve());
    })).resolves.toBeUndefined();
  });

  it('reuses a live process across a compatible descriptor rewrite and replaces an incompatible protocol descriptor', async () => {
    const dataDir = newDataDir();
    const first = await ensureTestRuntime(dataDir);
    const { descriptorPath } = runtimeFiles(dataDir);

    writeFileSync(descriptorPath, `${JSON.stringify({ ...first, buildId: 'rewritten-build-id' })}\n`, 'utf8');
    chmodSync(descriptorPath, 0o600);
    const reused = await ensureTestRuntime(dataDir);
    expect(`${reused.pid}:${reused.epoch}`).toBe(`${first.pid}:${first.epoch}`);

    writeFileSync(descriptorPath, `${JSON.stringify({ ...reused, protocolVersion: 999 })}\n`, 'utf8');
    chmodSync(descriptorPath, 0o600);
    const replaced = await ensureTestRuntime(dataDir);
    expect(`${replaced.pid}:${replaced.epoch}`).not.toBe(`${reused.pid}:${reused.epoch}`);
  });

  it('never kills an unrelated process when a stale descriptor points at its PID', async () => {
    const dataDir = newDataDir();
    const descriptor = await ensureTestRuntime(dataDir);
    const { descriptorPath } = runtimeFiles(dataDir);

    const outsiderDir = mkdtempSync(join(tmpdir(), 'botmux-btw-runtime-outsider-'));
    tempDirs.push(outsiderDir);
    const outsiderScript = join(outsiderDir, 'outsider.js');
    writeFileSync(outsiderScript, 'setInterval(() => {}, 1000);\n', 'utf8');

    const outsider = await new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn(process.execPath, [outsiderScript], {
        detached: true,
        stdio: 'ignore',
      });
      child.once('spawn', () => {
        child.unref();
        resolve(child);
      });
      child.once('error', reject);
    });

    writeFileSync(descriptorPath, `${JSON.stringify({
      ...descriptor,
      pid: outsider.pid,
      startIdentity: 'stale-start',
      socket: join(dirname(descriptor.socket), 'missing.sock'),
    })}\n`);
    chmodSync(descriptorPath, 0o600);
    const refreshed = await ensureTestRuntime(dataDir);
    expect(`${refreshed.pid}:${refreshed.epoch}`).not.toBe(`${descriptor.pid}:${descriptor.epoch}`);
    expect(() => process.kill(outsider.pid!, 0)).not.toThrow();
    process.kill(outsider.pid!, 'SIGKILL');
  });

  it('preserves a live non-empty incompatible runtime without replacing it', async () => {
    const dataDir = newDataDir();
    const runtime = await connectTestRuntime(dataDir);
    const input = makeBtwPrepareInput();
    const scope = makeBtwScope();
    await runtime.client.prepareBtw(input);
    const operationId = deriveBtwIdentifiers(scope, input.requestId).btwOpId;
    await runtime.client.recordCard(scope, operationId, 'om_card_kept');
    runtime.close();

    const descriptor = await ensureTestRuntime(dataDir);
    const { descriptorPath, tokenPath } = runtimeFiles(dataDir);
    const token = readFileSync(tokenPath, 'utf8').trim();
    writeFileSync(descriptorPath, `${JSON.stringify({ ...descriptor, protocolVersion: 999 })}\n`, 'utf8');
    chmodSync(descriptorPath, 0o600);

    await expect(ensureBtwRuntime({ dataDir })).rejects.toThrow('incompatible btw runtime has durable operations');
    expect(readProcessStartIdentity(descriptor.pid)).toBe(descriptor.startIdentity);
    const reachable = await authenticateRaw({ descriptor, token });
    reachable.destroy();
  });

  it('fails closed and preserves the live runtime when a compatible descriptor names a stale socket', async () => {
    const dataDir = newDataDir();
    const descriptor = await ensureTestRuntime(dataDir);
    const { descriptorPath } = runtimeFiles(dataDir);
    const staleSocket = `/tmp/btw-stale-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`;
    staleSocketPaths.push(staleSocket);
    const listener = await new Promise<ChildProcess>((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', `
        const net = require('node:net');
        const server = net.createServer();
        server.listen(${JSON.stringify(staleSocket)}, () => process.stdout.write('ready\\n'));
      `], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let errorOutput = '';
      child.stdout?.on('data', chunk => {
        output += String(chunk);
        if (output.includes('ready\n')) resolve(child);
      });
      child.stderr?.on('data', chunk => { errorOutput += String(chunk); });
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`stale socket listener exited ${code}: ${errorOutput}`)));
    });
    process.kill(listener.pid!, 'SIGKILL');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(existsSync(staleSocket)).toBe(true);

    writeFileSync(descriptorPath, `${JSON.stringify({ ...descriptor, socket: staleSocket })}\n`, 'utf8');
    chmodSync(descriptorPath, 0o600);
    await expect(ensureBtwRuntime({ dataDir })).rejects.toThrow('unavailable or unauthenticated');
    expect(readProcessStartIdentity(descriptor.pid)).toBe(descriptor.startIdentity);
    expect(existsSync(staleSocket)).toBe(true);
  });

  it('rejects a symlinked runtime directory instead of writing through it', async () => {
    const dataDir = newDataDir();
    const redirected = mkdtempSync(join(tmpdir(), 'botmux-btw-runtime-redirect-'));
    tempDirs.push(redirected);
    symlinkSync(redirected, join(dataDir, 'btw'));

    await expect(ensureBtwRuntime({ dataDir })).rejects.toThrow('symlink');
    expect(existsSync(join(redirected, 'runtime.json'))).toBe(false);
  });

  it('reclaims a dead parent startup reservation before spawning one runtime', async () => {
    const dataDir = newDataDir();
    const runtimeDir = join(dataDir, 'btw');
    mkdirSync(runtimeDir, { mode: 0o700 });
    writeFileSync(join(runtimeDir, 'runtime.starting.json'), JSON.stringify({
      claim: 'dead-parent-reservation', ownerPid: 999999, ownerStartIdentity: 'never-live', buildId: 'stale',
    }));

    const descriptor = await ensureTestRuntime(dataDir);
    expect(descriptor.pid).toBeGreaterThan(1);
    expect(readProcessStartIdentity(descriptor.pid)).toBe(descriptor.startIdentity);
  });


  it('closes a connection that sends an envelope outside the runtime command union', async () => {
    const dataDir = newDataDir();
    const descriptor = await ensureTestRuntime(dataDir);
    const token = readFileSync(runtimeFiles(dataDir).tokenPath, 'utf8').trim();
    const socket = await authenticateRaw({ descriptor, token });
    const closed = new Promise<void>((resolve, reject) => {
      socket.once('close', () => resolve());
      socket.once('error', reject);
    });
    socket.write(`${JSON.stringify({
      requestId: 'invalid-command',
      protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION,
      runtimeEpoch: descriptor.epoch,
      command: { type: 'not_a_runtime_command' },
    })}\n`);

    await expect(closed).resolves.toBeUndefined();
  });

  it('routes out-of-order concurrent RPC replies through one decoder', async () => {
    const socketPath = `/tmp/btw-runtime-client-${process.pid}-${Date.now()}.sock`;
    staleSocketPaths.push(socketPath);
    const server = createServer(socket => {
      let buffer = '';
      const requests: Array<{ requestId: string; commandType: string }> = [];
      socket.on('data', chunk => {
        buffer += String(chunk);
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          const frame = JSON.parse(line) as { kind?: string; requestId?: string; command?: { type?: string } };
          if (frame.kind === 'auth') {
            socket.write('{"kind":"auth_ok"}\n');
            continue;
          }
          requests.push({ requestId: frame.requestId!, commandType: frame.command!.type! });
          if (requests.length === 2) {
            for (const request of [...requests].reverse()) {
              socket.write(`${JSON.stringify({
                kind: 'reply', ok: true, requestId: request.requestId, commandType: request.commandType,
                result: { affectedAppIds: [], projectionWatermarks: [] },
              })}\n`);
            }
          }
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => resolve());
    });
    const client = new BtwRuntimeClientImpl({
      descriptor: { pid: 1, startIdentity: 'test', socket: socketPath, protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION, buildId: 'test', epoch: 'epoch' },
      token: 'test-token',
    });

    await expect(Promise.all([client.quiesceAll(), client.quiesceAll()])).resolves.toEqual([
      { affectedAppIds: [], projectionWatermarks: [] },
      { affectedAppIds: [], projectionWatermarks: [] },
    ]);
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('rejects a reply whose result does not match its command contract', async () => {
    const socketPath = `/tmp/btw-runtime-invalid-result-${process.pid}-${Date.now()}.sock`;
    staleSocketPaths.push(socketPath);
    const server = createServer(socket => {
      let count = 0;
      socket.on('data', chunk => {
        for (const line of String(chunk).trim().split('\n')) {
          const frame = JSON.parse(line) as { kind?: string; requestId?: string; command?: { type?: string } };
          if (frame.kind === 'auth') socket.write('{"kind":"auth_ok"}\n');
          else if (++count === 1) socket.write(`${JSON.stringify({ kind: 'reply', ok: true, requestId: frame.requestId, commandType: frame.command!.type, result: { done: true } })}\n`);
        }
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    const client = new BtwRuntimeClientImpl({ descriptor: { pid: 1, startIdentity: 'test', socket: socketPath, protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION, buildId: 'test', epoch: 'epoch' }, token: 'token' });
    await expect(client.quiesceAll()).rejects.toThrow('invalid btw runtime reply result');
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('serves typed replies through connectBtwRuntime after the second authenticated handshake', async () => {
    const dataDir = newDataDir();
    const runtime = await connectTestRuntime(dataDir);
    const result = await runtime.client.quiesceAll();
    runtime.close();

    expect(result).toEqual({
      affectedAppIds: [],
      projectionWatermarks: [],
    });
  });
});
