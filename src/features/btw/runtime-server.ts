import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveEntrySpawn, isStandaloneBinary } from '../../core/self-spawn.js';
import { readProcessStartIdentity } from '../../core/session-marker.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLock } from '../../utils/file-lock.js';
import { runtimeBuildIdentity } from '../../utils/runtime-build-id.js';
import { createBtwOperationStore } from './operation-store.js';
import {
  BTW_RUNTIME_PROTOCOL_VERSION,
  type BtwProjectionWake,
  type BtwRuntimeCommand,
  type BtwRuntimeDescriptor,
  type BtwRuntimeEnvelope,
  type BtwRuntimeFrame,
  type BtwRuntimeResultMap,
} from './runtime-protocol.js';

const AUTH_TIMEOUT_MS = 2_000;
const MAX_AUTH_BYTES = 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_PENDING_REQUESTS_PER_SOCKET = 64;
const SOCKET_PATH_MAX_BYTES = process.platform === 'darwin' ? 96 : 100;

interface RuntimePaths {
  runtimeDir: string;
  lockPath: string;
  descriptorPath: string;
  tokenPath: string;
  socketPath: string;
  startupPath: string;
}

interface RuntimeStartupMarker {
  pid: number;
  startIdentity: string;
  buildId: string;
}

interface EnsureRuntimeInput {
  dataDir: string;
}

interface ConnectRuntimeInput {
  dataDir: string;
  expectedEpoch?: string;
}

interface AuthRequest {
  kind: 'auth';
  token: string;
  protocolVersion: number;
  runtimeEpoch: string;
}

interface AuthOkFrame {
  kind: 'auth_ok';
}

interface AuthErrorFrame {
  kind: 'auth_error';
  error: { code: string; message: string };
}

interface ProjectionSubscription {
  socket: Socket;
  larkAppId: string;
}

interface RuntimeState {
  dataDir: string;
  server: Server;
  store: ReturnType<typeof createBtwOperationStore>;
  descriptor: BtwRuntimeDescriptor;
  token: string;
  projectionSubscribers: Set<ProjectionSubscription>;
  authenticatedSockets: Set<Socket>;
  projectionWakeQueue: Set<string>;
  projectionWakeScheduled: boolean;
}

const runtimeStates = new Map<string, RuntimeState>();

function runtimePaths(dataDir: string): RuntimePaths {
  const parentDir = join(canonicalDataDir(dataDir), 'btw');
  mkdirSync(parentDir, { recursive: true, mode: 0o700 });
  chmodSync(parentDir, 0o700);
  return {
    runtimeDir: parentDir,
    lockPath: join(parentDir, 'runtime.lock'),
    descriptorPath: join(parentDir, 'runtime.json'),
    tokenPath: join(parentDir, 'runtime.token'),
    socketPath: btwRuntimeSocketPath(dataDir),
    startupPath: join(parentDir, 'runtime.starting.json'),
  };
}

function canonicalDataDir(dataDir: string): string {
  return resolve(dataDir);
}

function stableSocketSlug(dataDir: string): string {
  // A prefix is not unique: all data directories under /tmp share it.  Hashing
  // the canonical path gives a short, deterministic and collision-resistant
  // Unix-socket name without leaking the data-dir contents.
  return createHash('sha256').update(canonicalDataDir(dataDir)).digest('hex').slice(0, 16);
}

function btwRuntimeSocketPath(dataDir: string): string {
  mkdirSync(join(homedir(), '.botmux'), { recursive: true, mode: 0o700 });
  const base = join(homedir(), '.botmux', `btwrt-${stableSocketSlug(dataDir)}-${process.getuid?.() ?? 'nouid'}.sock`);
  if (Buffer.byteLength(base) <= SOCKET_PATH_MAX_BYTES) return base;
  const fallback = join(homedir(), '.botmux', `btwrt-${randomBytes(6).toString('hex')}.sock`);
  if (Buffer.byteLength(fallback) > SOCKET_PATH_MAX_BYTES) {
    throw new Error('btw runtime socket path exceeds platform limit');
  }
  return fallback;
}

function assertRuntimeBuildIdKnown(): string {
  const identity = runtimeBuildIdentity();
  if (identity.status !== 'known') {
    throw new Error(`btw runtime build identity unavailable: ${identity.reason}`);
  }
  return identity.id;
}

function randomToken(): string {
  return randomBytes(32).toString('hex');
}

function randomEpoch(): string {
  return `btwrt_${randomBytes(16).toString('hex')}`;
}

function isSameToken(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function writeDescriptor(paths: RuntimePaths, descriptor: BtwRuntimeDescriptor): void {
  atomicWriteFileSync(paths.descriptorPath, `${JSON.stringify(descriptor)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

function writeToken(paths: RuntimePaths, token: string): void {
  atomicWriteFileSync(paths.tokenPath, `${token}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

function readToken(paths: RuntimePaths): string {
  return readFileSync(paths.tokenPath, 'utf8').trim();
}

function writeStartupMarker(paths: RuntimePaths, marker: RuntimeStartupMarker): void {
  atomicWriteFileSync(paths.startupPath, `${JSON.stringify(marker)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

function readStartupMarker(paths: RuntimePaths): RuntimeStartupMarker | undefined {
  try {
    const value = JSON.parse(readFileSync(paths.startupPath, 'utf8')) as Partial<RuntimeStartupMarker>;
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.startIdentity !== 'string' || !value.startIdentity
      || typeof value.buildId !== 'string' || !value.buildId) return undefined;
    return value as RuntimeStartupMarker;
  } catch {
    return undefined;
  }
}

function removeStartupMarker(paths: RuntimePaths): void {
  try { unlinkSync(paths.startupPath); } catch { /* absent or concurrently removed */ }
}

function readDescriptor(paths: RuntimePaths): BtwRuntimeDescriptor {
  const raw = JSON.parse(readFileSync(paths.descriptorPath, 'utf8')) as Record<string, unknown>;
  const descriptor = {
    pid: requiredNumber(raw.pid, 'pid'),
    startIdentity: requiredString(raw.startIdentity, 'startIdentity'),
    socket: requiredString(raw.socket, 'socket'),
    protocolVersion: requiredNumber(raw.protocolVersion, 'protocolVersion'),
    buildId: requiredString(raw.buildId, 'buildId'),
    epoch: requiredString(raw.epoch, 'epoch'),
  } satisfies BtwRuntimeDescriptor;
  const keys = Object.keys(raw).sort();
  if (keys.join(',') !== ['buildId', 'epoch', 'pid', 'protocolVersion', 'socket', 'startIdentity'].join(',')) {
    throw new Error('invalid btw runtime descriptor fields');
  }
  return descriptor;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`invalid ${name}`);
  return value;
}

function requiredNumber(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`invalid ${name}`);
  return value as number;
}

function pidIsLive(descriptor: BtwRuntimeDescriptor): boolean {
  const liveStart = readProcessStartIdentity(descriptor.pid);
  return liveStart !== undefined && liveStart === descriptor.startIdentity;
}

function canReuseDescriptor(descriptor: BtwRuntimeDescriptor): boolean {
  return descriptor.protocolVersion === BTW_RUNTIME_PROTOCOL_VERSION && pidIsLive(descriptor);
}

function runtimeHasDurableOperations(paths: RuntimePaths): boolean {
  const operationsDir = join(paths.runtimeDir, 'operations');
  try { return readdirSync(operationsDir, { recursive: true }).some(item => String(item).endsWith('.json')); } catch { return false; }
}

async function stopEmptyIncompatibleRuntime(paths: RuntimePaths, descriptor: BtwRuntimeDescriptor): Promise<void> {
  // Never signal a PID unless its start identity still matches.  A protocol
  // replacement may only retire an empty runtime; durable work is preserved.
  if (!pidIsLive(descriptor) || runtimeHasDurableOperations(paths)) return;
  try { process.kill(descriptor.pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline && pidIsLive(descriptor)) {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  // Loaders may install their own signal handlers.  We already proved this is
  // the exact empty runtime identity, so a bounded SIGKILL backstop is safe.
  if (pidIsLive(descriptor)) {
    try { process.kill(descriptor.pid, 'SIGKILL'); } catch { return; }
    const killDeadline = Date.now() + 2_000;
    while (Date.now() < killDeadline && pidIsLive(descriptor)) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
  }
}

function cleanupSocketFile(socketPath: string): void {
  try {
    if (statSync(socketPath).isSocket()) unlinkSync(socketPath);
  } catch {
    // absent or not ours
  }
}

async function readLine(socket: Socket, maxBytes: number, timeoutMs: number): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      rejectPromise(new Error('timeout'));
    }, timeoutMs);
    timer.unref?.();

    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };
    const onClose = () => {
      cleanup();
      rejectPromise(new Error('socket closed'));
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length > maxBytes) {
        cleanup();
        rejectPromise(new Error('frame too large'));
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      cleanup();
      const remainder = buffer.subarray(newline + 1);
      if (remainder.length > 0) socket.unshift(remainder);
      resolvePromise(buffer.subarray(0, newline).toString('utf8').replace(/\r$/, ''));
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function authenticatePublishedRuntime(paths: RuntimePaths, descriptor: BtwRuntimeDescriptor): Promise<boolean> {
  let socket: Socket | undefined;
  try {
    socket = await new Promise<Socket>((resolvePromise, rejectPromise) => {
      const candidate = createConnection(descriptor.socket);
      candidate.once('connect', () => resolvePromise(candidate));
      candidate.once('error', rejectPromise);
    });
    socket.write(`${JSON.stringify({
      kind: 'auth', token: readToken(paths), protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION, runtimeEpoch: descriptor.epoch,
    })}\n`);
    const reply = JSON.parse(await readLine(socket, MAX_AUTH_BYTES, AUTH_TIMEOUT_MS)) as { kind?: unknown };
    return reply.kind === 'auth_ok';
  } catch {
    return false;
  } finally {
    socket?.destroy();
  }
}

function writeFrame(socket: Socket, frame: AuthOkFrame | AuthErrorFrame | BtwRuntimeFrame): void {
  socket.write(`${JSON.stringify(frame)}\n`);
}

function publishProjectionWake(state: RuntimeState, larkAppId: string): void {
  state.projectionWakeQueue.add(larkAppId);
  if (state.projectionWakeScheduled) return;
  state.projectionWakeScheduled = true;
  queueMicrotask(() => {
    state.projectionWakeScheduled = false;
    const appIds = [...state.projectionWakeQueue];
    state.projectionWakeQueue.clear();
    for (const appId of appIds) {
      for (const subscriber of [...state.projectionSubscribers]) {
        if (subscriber.larkAppId !== appId || subscriber.socket.destroyed) continue;
        writeFrame(subscriber.socket, {
          kind: 'projection_wake',
          larkAppId: appId,
          wake: { kind: 'btw_projection_wake' } satisfies BtwProjectionWake,
        });
      }
    }
  });
}

async function handleRuntimeCommand(
  state: RuntimeState,
  command: BtwRuntimeCommand,
): Promise<BtwRuntimeResultMap[keyof BtwRuntimeResultMap]> {
  switch (command.type) {
    case 'prepare_btw':
      return state.store.prepareBtw(command.input);
    case 'record_initial_card_attempt': {
      const operation = state.store.recordInitialCardAttempt(command.scope, command.btwOpId, command.outcome);
      publishProjectionWake(state, command.scope.larkAppId);
      return operation;
    }
    case 'record_card': {
      const operation = state.store.recordBtwCard(command.scope, command.btwOpId, command.messageId);
      publishProjectionWake(state, command.scope.larkAppId);
      return operation;
    }
    case 'submit_btw': {
      const operation = state.store.getBtwOperation(command.scope, command.btwOpId);
      if (!operation) throw new Error(`btw operation not found: ${command.btwOpId}`);
      publishProjectionWake(state, command.scope.larkAppId);
      return operation;
    }
    case 'list_pending_initial_cards':
      return state.store.listPendingInitialCards(command.larkAppId);
    case 'list_pending_projections':
      return state.store.listPendingBtwProjections(command.larkAppId);
    case 'record_projection_failure': {
      const result = state.store.recordBtwProjectionFailure(command.scope, command.btwOpId, command.expected, command.failure);
      publishProjectionWake(state, command.scope.larkAppId);
      return result;
    }
    case 'ack_projection': {
      const result = state.store.ackBtwProjection(command.scope, command.btwOpId, command.expected, command.outcome);
      publishProjectionWake(state, command.scope.larkAppId);
      return result;
    }
    case 'watch_projection_wakes':
      return { subscribed: true };
    case 'quiesce_all':
      return { affectedAppIds: [], projectionWatermarks: [] };
    case 'shutdown_runtime':
      setImmediate(() => {
        void shutdownRuntime({ dataDir: state.dataDir }).finally(() => {
          process.exit(0);
        });
      });
      return { done: true };
    default:
      throw new Error(`unsupported btw runtime command: ${command.type}`);
  }
}

async function authenticateSocket(state: RuntimeState, socket: Socket): Promise<boolean> {
  try {
    const line = await readLine(socket, MAX_AUTH_BYTES, AUTH_TIMEOUT_MS);
    const request = JSON.parse(line) as Partial<AuthRequest>;
    if (
      request.kind !== 'auth'
      || !isSameToken(typeof request.token === 'string' ? request.token : '', state.token)
    ) {
      writeFrame(socket, { kind: 'auth_error', error: { code: 'AUTH_FAILED', message: 'invalid token' } });
      socket.end();
      return false;
    }
    if (request.protocolVersion !== BTW_RUNTIME_PROTOCOL_VERSION) {
      writeFrame(socket, { kind: 'auth_error', error: { code: 'PROTOCOL_MISMATCH', message: 'protocol mismatch' } });
      socket.end();
      return false;
    }
    if (request.runtimeEpoch !== state.descriptor.epoch) {
      writeFrame(socket, { kind: 'auth_error', error: { code: 'STALE_EPOCH', message: 'stale runtime epoch' } });
      socket.end();
      return false;
    }
    writeFrame(socket, { kind: 'auth_ok' });
    return true;
  } catch {
    socket.destroy();
    return false;
  }
}

async function handleAuthedSocket(state: RuntimeState, socket: Socket): Promise<void> {
  let pending = 0;
  let buffer = Buffer.alloc(0);
  const dispatch = (envelope: BtwRuntimeEnvelope) => {
    // Account synchronously while parsing each received batch.  This is a true
    // bounded frame queue: a flood cannot be hidden by quick command handlers.
    if (pending >= MAX_PENDING_REQUESTS_PER_SOCKET) {
      socket.end();
      return;
    }
    pending += 1;
    setImmediate(async () => {
      try {
        if (envelope.protocolVersion !== BTW_RUNTIME_PROTOCOL_VERSION || envelope.runtimeEpoch !== state.descriptor.epoch) {
          writeFrame(socket, {
            kind: 'reply',
            ok: false,
            requestId: envelope.requestId,
            commandType: envelope.command.type,
            error: { code: 'INVALID_RUNTIME', message: 'protocol or epoch mismatch' },
          });
          return;
        }
        const result = await handleRuntimeCommand(state, envelope.command);
        if (envelope.command.type === 'watch_projection_wakes') {
          state.projectionSubscribers.add({ socket, larkAppId: envelope.command.larkAppId });
          socket.once('close', () => {
            for (const entry of [...state.projectionSubscribers]) {
              if (entry.socket === socket) state.projectionSubscribers.delete(entry);
            }
          });
        }
        writeFrame(socket, {
          kind: 'reply',
          ok: true,
          requestId: envelope.requestId,
          commandType: envelope.command.type,
          result: result as never,
        });
      } catch (error) {
        writeFrame(socket, {
          kind: 'reply',
          ok: false,
          requestId: envelope.requestId,
          commandType: envelope.command.type,
          error: {
            code: 'RUNTIME_ERROR',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      } finally {
        pending -= 1;
      }
    });
  };
  socket.on('data', (chunk: Buffer | string) => {
    if (socket.destroyed) return;
    buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    if (buffer.length > MAX_FRAME_BYTES) {
      socket.destroy();
      return;
    }
    while (!socket.destroyed) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      buffer = buffer.subarray(newline + 1);
      let envelope: BtwRuntimeEnvelope;
      try { envelope = JSON.parse(line) as BtwRuntimeEnvelope; } catch { socket.destroy(); return; }
      dispatch(envelope);
    }
  });
  socket.once('error', () => socket.destroy());
}

function childSpawn(): { command: string; args: string[] } {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const distDir = join(projectRoot, 'dist');
  if (isStandaloneBinary() || existsSync(join(distDir, 'index-btw-runtime.js'))) {
    return resolveEntrySpawn('btw-runtime', distDir);
  }
  // Source-mode tests run under Node/Vitest, while `bun run` can execute the
  // TypeScript entry directly.  Preserve the appropriate loader instead of
  // spawning Node with a .ts argv[0] that exits before publishing.
  if (process.versions.bun) {
    return { command: process.execPath, args: [join(projectRoot, 'src', 'index-btw-runtime.ts')] };
  }
  const loaderArgs: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const current = process.execArgv[index];
    if (current === '--import' && process.execArgv[index + 1] === 'tsx') {
      loaderArgs.push('--import', 'tsx');
      index += 1;
    }
  }
  return {
    command: process.execPath,
    args: loaderArgs.length > 0
      ? [...loaderArgs, join(projectRoot, 'src', 'index-btw-runtime.ts')]
      : ['--import', 'tsx', join(projectRoot, 'src', 'index-btw-runtime.ts')],
  };
}

export async function ensureBtwRuntime(input: EnsureRuntimeInput): Promise<BtwRuntimeDescriptor> {
  const dataDir = canonicalDataDir(input.dataDir);
  const paths = runtimePaths(dataDir);
  const buildId = assertRuntimeBuildIdKnown();
  await withFileLock(paths.lockPath, async () => {
    let live: BtwRuntimeDescriptor | undefined;
    try {
      live = readDescriptor(paths);
    } catch {
      // no valid descriptor: create fresh runtime below
    }
    if (live) {
      if (canReuseDescriptor(live)) {
        // A live PID is not enough to reuse a published runtime.  The socket
        // must prove possession of the descriptor token and epoch while we
        // still hold the singleton lock.  Otherwise a stale socket pathname
        // would make callers wait for a publication that can never occur, or
        // tempt a later change to replace a process we have not authenticated.
        if (await authenticatePublishedRuntime(paths, live)) return;
        throw new Error('btw runtime is live but unavailable or unauthenticated');
      }
      // A marker is only an in-flight-publication lease while no descriptor
      // exists.  Once we have rejected a published descriptor (especially
      // after retiring an empty incompatible runtime), its matching marker
      // must not suppress the replacement spawn while the old PID is still
      // briefly visible during process exit.
      removeStartupMarker(paths);
      if (live.protocolVersion !== BTW_RUNTIME_PROTOCOL_VERSION) {
        await stopEmptyIncompatibleRuntime(paths, live);
        if (pidIsLive(live)) throw new Error('incompatible btw runtime has durable operations');
      }
    }
    const starting = readStartupMarker(paths);
    if (starting && starting.buildId === buildId
      && readProcessStartIdentity(starting.pid) === starting.startIdentity) return;
    removeStartupMarker(paths);

    cleanupSocketFile(paths.socketPath);
    const { spawn } = await import('node:child_process');
    const childRuntime = childSpawn();
    const child = spawn(childRuntime.command, childRuntime.args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SESSION_DATA_DIR: dataDir,
        BOTMUX_BTW_RUNTIME_CHILD: '1',
      },
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    const startIdentity = child.pid === undefined ? undefined : readProcessStartIdentity(child.pid);
    if (!child.pid || !startIdentity) throw new Error('cannot determine spawned btw runtime identity');
    writeStartupMarker(paths, { pid: child.pid, startIdentity, buildId });
  });

  // Publication is intentionally outside the singleton lock.  The marker above
  // lets every concurrent caller converge on the one spawn decision instead of
  // timing out while the child initializes its socket and durable store.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const descriptor = readDescriptor(paths);
      // Build IDs are diagnostic, not a runtime compatibility boundary.  A
      // protocol-compatible descriptor can legitimately have been rewritten
      // by a newer caller and must still reuse its authenticated live process.
      if (canReuseDescriptor(descriptor)
        && await authenticatePublishedRuntime(paths, descriptor)) {
        removeStartupMarker(paths);
        return descriptor;
      }
    } catch {
      // child has not atomically published both descriptor and token yet
    }
    await new Promise(resolvePromise => {
      const timer = setTimeout(resolvePromise, 50);
      timer.unref?.();
    });
  }
  throw new Error('btw runtime failed to publish an authenticated descriptor');
}

export async function connectBtwRuntime(input: ConnectRuntimeInput): Promise<{
  descriptor: BtwRuntimeDescriptor;
  close(): void;
  client: import('./runtime-client.js').BtwRuntimeClientImpl;
}> {
  const descriptor = await ensureBtwRuntime({ dataDir: input.dataDir });
  if (input.expectedEpoch && descriptor.epoch !== input.expectedEpoch) {
    throw new Error(`btw runtime epoch mismatch: expected ${input.expectedEpoch}, got ${descriptor.epoch}`);
  }
  const { BtwRuntimeClientImpl } = await import('./runtime-client.js');
  const client = new BtwRuntimeClientImpl({
    descriptor,
    token: readToken(runtimePaths(input.dataDir)),
  });
  await client.connect();
  return {
    descriptor,
    client,
    close: () => client.close(),
  };
}

export async function shutdownRuntime(input: { dataDir: string }): Promise<void> {
  const state = runtimeStates.get(canonicalDataDir(input.dataDir));
  if (!state) return;
  // `server.close()` waits for open connections.  In particular the
  // shutdown_runtime command arrives on one of them, so close the sockets
  // first instead of waiting on the request that asked us to shut down.
  for (const socket of [...state.authenticatedSockets]) socket.destroy();
  await new Promise<void>((resolvePromise) => {
    state.server.close(() => resolvePromise());
  });
  runtimeStates.delete(canonicalDataDir(input.dataDir));
}

export async function runBtwRuntime(input: { dataDir: string }): Promise<void> {
  const dataDir = canonicalDataDir(input.dataDir);
  const paths = runtimePaths(dataDir);
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });
  cleanupSocketFile(paths.socketPath);

  const buildId = assertRuntimeBuildIdKnown();
  const pid = process.pid;
  const startIdentity = readProcessStartIdentity(pid);
  if (!startIdentity) throw new Error('cannot determine btw runtime process identity');
  const descriptor = {
    pid,
    startIdentity,
    socket: paths.socketPath,
    protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION,
    buildId,
    epoch: randomEpoch(),
  } satisfies BtwRuntimeDescriptor;
  const token = randomToken();
  const store = createBtwOperationStore({ dataDir });

  const server = createServer(async (socket) => {
    const state = runtimeStates.get(dataDir);
    if (!state) {
      socket.destroy();
      return;
    }
    if (!(await authenticateSocket(state, socket))) return;
    state.authenticatedSockets.add(socket);
    socket.once('close', () => state.authenticatedSockets.delete(socket));
    await handleAuthedSocket(state, socket);
  });

  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(paths.socketPath, () => resolvePromise());
  });
  await import('node:fs').then(({ chmodSync }) => chmodSync(paths.socketPath, 0o600));

  writeToken(paths, token);
  writeDescriptor(paths, descriptor);
  runtimeStates.set(dataDir, {
    dataDir,
    server,
    store,
    descriptor,
    token,
    projectionSubscribers: new Set(),
    authenticatedSockets: new Set(),
    projectionWakeQueue: new Set(),
    projectionWakeScheduled: false,
  });
}
