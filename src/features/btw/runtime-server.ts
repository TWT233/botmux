import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveEntrySpawn, isStandaloneBinary } from '../../core/self-spawn.js';
import { readProcessStartIdentity } from '../../core/session-marker.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLock } from '../../utils/file-lock.js';
import { runtimeBuildIdentity } from '../../utils/runtime-build-id.js';
import { createBtwOperationStore } from './operation-store.js';
import { CodexRpcSession } from '../../codex-rpc-session.js';
import { supportsManagedBtw, type BtwCapabilities } from '../../adapters/cli/btw.js';
import type { CodexRpcTurnIdentity } from '../../codex-rpc-engine.js';
import { startSessionMcpGatewayHost, type SessionMcpGatewayHost } from '../../core/plugins/mcp/host.js';
import { MCP_GATEWAY_REQUIRED_ENV, MCP_GATEWAY_SOCKET_ENV } from '../../core/plugins/mcp/environment.js';
import { applySessionOwnerEnv } from '../../utils/child-env.js';
import { createTraeBtwAdapter, type TraeBtwAdapter } from './trae-adapter.js';
import {
  BTW_RUNTIME_PROTOCOL_VERSION,
  type BtwProjectionWake,
  type BtwRuntimeCommand,
  type BtwRuntimeDescriptor,
  type BtwRuntimeEnvelope,
  type BtwRuntimeFrame,
  type BtwRuntimeResultMap,
  type BtwRuntimeNotification,
} from './runtime-protocol.js';
import type { BtwAdapter, BtwNativeTerminalOutcome } from '../../adapters/cli/btw.js';
import { deriveBtwIdentifiers, type BtwOperation, type BtwOperationScope } from './types.js';

const AUTH_TIMEOUT_MS = 2_000;
const MAX_AUTH_BYTES = 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_PENDING_REQUESTS_PER_SOCKET = 64;
const SOCKET_PATH_MAX_BYTES = process.platform === 'darwin' ? 96 : 100;
const STARTUP_CLAIM_LEASE_MS = 5_000;
const STARTUP_PUBLICATION_TIMEOUT_MS = 10_000;
const STARTUP_POLL_MS = 50;

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

interface RuntimeStartupClaim {
  claim: string;
  ownerPid: number;
  ownerStartIdentity: string;
  buildId: string;
  leaseExpiresAt: number;
}

interface EnsureRuntimeInput {
  dataDir: string;
}

interface ConnectRuntimeInput {
  dataDir: string;
  expectedEpoch?: string;
}

type RuntimeDescriptorOnDisk = Omit<BtwRuntimeDescriptor, 'protocolVersion'> & {
  protocolVersion: number;
};

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
  executorWakeQueue: BtwExecutorWakeQueue;
  executorWakeScheduled: boolean;
  executorInFlight: Set<string>;
  shuttingDown: boolean;
  managedSessions: Map<string, ManagedSession>;
}

interface ManagedSession {
  profile: import('./runtime-protocol.js').FrozenBtwSessionProfile;
  engine: CodexRpcSession;
  appServerUrl: string;
  nativeThreadId: string;
  nextSeq: number;
  journal: BtwRuntimeNotification[];
  subscribers: Set<Socket>;
  pendingUserInputs: Map<string, { resolve(result: unknown): void; reject(error: Error): void }>;
  mcpGatewayHost: SessionMcpGatewayHost | null;
  btwAdapter?: TraeBtwAdapter;
  activeTurnIdentity?: CodexRpcTurnIdentity;
}

const MANAGED_JOURNAL_MAX_ENTRIES = 1024;

function admissionCapabilities(profile: import('./runtime-protocol.js').FrozenBtwSessionProfile, persistentRuntime: boolean): BtwCapabilities {
  return { ...profile.managedBtwCapabilities, persistentRuntime };
}

function managedAttachment(state: RuntimeState, managed: ManagedSession) {
  return {
    runtime: state.descriptor,
    appServerUrl: managed.appServerUrl,
    nativeThreadId: managed.nativeThreadId,
    configHash: managed.profile.configHash,
    notificationCursor: managed.nextSeq,
  };
}

function publishManagedNotification(
  managed: ManagedSession,
  notification: Omit<BtwRuntimeNotification, 'sessionId' | 'fromSeq' | 'throughSeq'>,
): void {
  if (managed.journal.length >= MANAGED_JOURNAL_MAX_ENTRIES) {
    throw new Error('managed Trae journal is full; durable worker acknowledgement required');
  }
  const seq = ++managed.nextSeq;
  const sequenced = { ...notification, sessionId: managed.profile.sessionId, fromSeq: seq, throughSeq: seq } as BtwRuntimeNotification;
  managed.journal.push(sequenced);
  // A journal entry can only be discarded by the worker's durable ACK. Never
  // silently evict replay evidence. Capacity was checked before assigning a
  // sequence, so an overflow cannot create an un-replayable notification.
  for (const socket of [...managed.subscribers]) {
    if (socket.destroyed) { managed.subscribers.delete(socket); continue; }
    writeFrame(socket, { kind: 'session_notification', notification: sequenced });
  }
}

async function ensureManagedSession(
  state: RuntimeState,
  profile: import('./runtime-protocol.js').FrozenBtwSessionProfile,
): Promise<import('./runtime-protocol.js').BtwRuntimeResultMap['ensure_session']> {
  const existing = state.managedSessions.get(profile.sessionId);
  if (existing) {
    return {
      attachment: managedAttachment(state, existing),
      capabilities: admissionCapabilities(existing.profile, true),
      // The MCP digest is an independently frozen generation boundary. Keep
      // the original runtime even if a caller accidentally reuses its broader
      // launch-config hash while the plugin manifest changed.
      configDrift: existing.profile.configHash !== profile.configHash
        || existing.profile.mcpManifestDigest !== profile.mcpManifestDigest,
    };
  }
  // This is a frozen adapter launch contract, not a self-asserted runtime
  // constant. Do not spawn an app-server merely to discover it: a missing bit
  // is an admission denial and must leave no runtime-owned session behind.
  const declared = admissionCapabilities(profile, false);
  if (!declared.nativeBtw || !declared.structuredTerminal || !declared.stableParentThread) {
    return { attachment: null, capabilities: declared, configDrift: false };
  }
  let managed!: ManagedSession;
  // The App Server executes model tools, so its gateway must exist before the
  // server starts.  This is the frozen session generation, never a read of
  // current plugin configuration.
  // The profile's env is already sanitized by the daemon.  Freeze all
  // config-controlled values before installing the host-owned owner identity;
  // neither the bot env nor a stale inherited environment may override it.
  const env: NodeJS.ProcessEnv = { ...process.env, ...profile.env, BOTMUX_SESSION_ID: profile.sessionId };
  applySessionOwnerEnv(env, profile.ownerOpenId);
  const mcpGatewayHost = profile.mcpManifest?.entries.length
    ? await startSessionMcpGatewayHost({
      sessionId: profile.sessionId,
      dataDir: state.dataDir,
      env,
      manifest: profile.mcpManifest,
      trustedTurnIdentity: () => managed.activeTurnIdentity
        ? {
          ...(managed.activeTurnIdentity.caller ? { caller: managed.activeTurnIdentity.caller } : {}),
          turnId: managed.activeTurnIdentity.turnId,
          ...(managed.activeTurnIdentity.dispatchAttempt !== undefined
            ? { dispatchAttempt: managed.activeTurnIdentity.dispatchAttempt }
            : {}),
        }
        : undefined,
    })
    : null;
  if (mcpGatewayHost) {
    env[MCP_GATEWAY_SOCKET_ENV] = mcpGatewayHost.socketPath;
    env[MCP_GATEWAY_REQUIRED_ENV] = '1';
  } else {
    delete env[MCP_GATEWAY_SOCKET_ENV];
    delete env[MCP_GATEWAY_REQUIRED_ENV];
  }
  const engine = new CodexRpcSession({
    cliBin: profile.cliBin,
    cwd: profile.cwd,
    env,
    sessionId: profile.sessionId,
    model: profile.model,
    reasoningEffort: profile.reasoningEffort,
    appServerFeatures: profile.appServerFeatures,
    onNotification: notification => publishManagedNotification(managed, {
      kind: 'main_event',
      payload: { type: 'delta', text: typeof notification.params === 'string' ? notification.params : JSON.stringify(notification.params) },
    }),
    onTurnTerminal: terminal => {
      if (managed.activeTurnIdentity?.turnId === terminal.identity.turnId
        && managed.activeTurnIdentity.dispatchAttempt === terminal.identity.dispatchAttempt) {
        managed.activeTurnIdentity = undefined;
      }
      publishManagedNotification(managed, { kind: 'main_terminal', payload: terminal });
    },
    onRequestUserInput: async params => {
      const requestId = randomToken();
      return await new Promise<unknown>((resolveInput, rejectInput) => {
        try {
          managed.pendingUserInputs.set(requestId, { resolve: resolveInput, reject: rejectInput });
          publishManagedNotification(managed, { kind: 'request_user_input', payload: { requestId, params } });
        } catch (error) {
          managed.pendingUserInputs.delete(requestId);
          rejectInput(error);
        }
      });
    },
    onDead: () => {
      publishManagedNotification(managed, {
        kind: 'app_server_dead', payload: { errorCode: 'app_server_dead', message: 'Trae app server exited' },
      });
      managed.btwAdapter?.close();
      managed.btwAdapter = undefined;
      state.managedSessions.delete(profile.sessionId);
      reconcileBtwForLiveSessions(state);
    },
  });
  managed = {
    profile, engine, appServerUrl: '', nativeThreadId: '', nextSeq: 0, journal: [], subscribers: new Set(), pendingUserInputs: new Map(), mcpGatewayHost,
  };
  try {
    await engine.start();
    managed.nativeThreadId = profile.nativeThreadId
      ? await engine.resumeThread(profile.nativeThreadId)
      : await engine.startThread();
    managed.appServerUrl = engine.wsUrl;
    state.managedSessions.set(profile.sessionId, managed);
    for (const operation of state.store.listExecutableBtwOperations(state.descriptor.epoch)) {
      if (operation.parent.botmuxSessionId === profile.sessionId) scheduleExecutorWake(state, operation.btwOpId);
    }
    return { attachment: managedAttachment(state, managed), capabilities: admissionCapabilities(profile, true), configDrift: false };
  } catch (error) {
    await mcpGatewayHost?.close().catch(() => undefined);
    throw error;
  }
}

function assertManagedJournalCapacity(managed: ManagedSession): void {
  if (managed.journal.length >= MANAGED_JOURNAL_MAX_ENTRIES) {
    throw new Error('managed Trae journal is full; durable worker acknowledgement required');
  }
}

const runtimeStates = new Map<string, RuntimeState>();

/** Deterministic startup-handoff interleaving seam; never set by production code. */
export interface BtwRuntimeTestHooks {
  afterChildClaimLockAcquired?: () => void | Promise<void>;
  onStartupClaimLeaseWait?: () => void | Promise<void>;
}
let runtimeTestHooks: BtwRuntimeTestHooks | undefined;
export function __testOnly_setBtwRuntimeHooks(hooks?: BtwRuntimeTestHooks): void { runtimeTestHooks = hooks; }

export interface BtwExecutorWakeQueue {
  enqueue(btwOpId: string): void;
  consume(): string[];
  readonly size: number;
}

class RetainedBtwExecutorWakeQueue implements BtwExecutorWakeQueue {
  private readonly entries = new Set<string>();
  enqueue(btwOpId: string): void { this.entries.add(btwOpId); }
  consume(): string[] { const values = [...this.entries]; this.entries.clear(); return values; }
  get size(): number { return this.entries.size; }
}

/**
 * Task 9's runtime-side executor installs a consumer through this narrow
 * surface. No RPC frame or generic event bus is introduced. Pending wake IDs
 * remain retained until this consumer explicitly drains them.
 */
export function consumeBtwExecutorWakes(input: { dataDir: string }): string[] {
  return runtimeStates.get(canonicalDataDir(input.dataDir))?.executorWakeQueue.consume() ?? [];
}

function runtimePaths(dataDir: string): RuntimePaths {
  const parentDir = join(canonicalDataDir(dataDir), 'btw');
  securePrivateDirectory(parentDir);
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
  return realpathSync(resolve(dataDir));
}

function securePrivateDirectory(path: string): void {
  const parent = dirname(path);
  const parentStats = lstatSync(parent);
  if (parentStats.isSymbolicLink()) throw new Error(`btw runtime directory parent is a symlink: ${parent}`);
  // System temp roots such as /tmp are normally root-owned and sticky. They
  // are acceptable only as a real parent; the child below remains private.
  const stickySystemParent = parentStats.uid === 0 && (parentStats.mode & 0o1000) !== 0;
  if (parentStats.uid !== process.getuid?.() && !stickySystemParent) throw new Error(`btw runtime directory parent is not owned by the current uid: ${parent}`);
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`btw runtime directory is a symlink: ${path}`);
  if (!stats.isDirectory() || stats.uid !== process.getuid?.()) throw new Error(`btw runtime directory is not a current-uid directory: ${path}`);
  chmodSync(path, 0o700);
  if ((statSync(path).mode & 0o777) !== 0o700) throw new Error(`btw runtime directory mode is not 0700: ${path}`);
}

function stableSocketSlug(dataDir: string): string {
  // A prefix is not unique: all data directories under /tmp share it.  Hashing
  // the canonical path gives a short, deterministic and collision-resistant
  // Unix-socket name without leaking the data-dir contents.
  return createHash('sha256').update(canonicalDataDir(dataDir)).digest('hex').slice(0, 16);
}

function btwRuntimeSocketPath(dataDir: string): string {
  // A real home path can exceed Unix socket limits on managed hosts.  Keep the
  // socket directory short, but make it private and UID-owned before use.
  const socketDir = join(realpathSync(tmpdir()), `botmux-btw-${process.getuid?.() ?? 'nouid'}`);
  securePrivateDirectory(socketDir);
  const base = join(socketDir, `btwrt-${stableSocketSlug(dataDir)}-${process.getuid?.() ?? 'nouid'}.sock`);
  if (Buffer.byteLength(base) <= SOCKET_PATH_MAX_BYTES) return base;
  throw new Error('btw runtime socket path exceeds platform limit');
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

function writeStartupMarker(paths: RuntimePaths, marker: RuntimeStartupMarker | RuntimeStartupClaim): void {
  atomicWriteFileSync(paths.startupPath, `${JSON.stringify(marker)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

function readStartupMarker(paths: RuntimePaths): RuntimeStartupMarker | RuntimeStartupClaim | undefined {
  try {
    const value = JSON.parse(readFileSync(paths.startupPath, 'utf8')) as Partial<RuntimeStartupMarker>;
    if (typeof (value as Partial<RuntimeStartupClaim>).claim === 'string'
      && typeof (value as Partial<RuntimeStartupClaim>).ownerPid === 'number'
      && typeof (value as Partial<RuntimeStartupClaim>).ownerStartIdentity === 'string'
      && typeof value.buildId === 'string'
      && typeof (value as Partial<RuntimeStartupClaim>).leaseExpiresAt === 'number') return value as RuntimeStartupClaim;
    if (typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.startIdentity !== 'string' || !value.startIdentity
      || typeof value.buildId !== 'string' || !value.buildId) return undefined;
    return value as RuntimeStartupMarker;
  } catch {
    return undefined;
  }
}

function isStartupClaim(marker: RuntimeStartupMarker | RuntimeStartupClaim): marker is RuntimeStartupClaim {
  return 'claim' in marker;
}

function removeStartupMarker(paths: RuntimePaths): void {
  try { unlinkSync(paths.startupPath); } catch { /* absent or concurrently removed */ }
}

function removePublishedDescriptor(paths: RuntimePaths): void {
  try { unlinkSync(paths.descriptorPath); } catch { /* absent or concurrently removed */ }
}

function removePublishedToken(paths: RuntimePaths): void {
  try { unlinkSync(paths.tokenPath); } catch { /* absent or concurrently removed */ }
}

function readDescriptor(paths: RuntimePaths): RuntimeDescriptorOnDisk {
  const raw = JSON.parse(readFileSync(paths.descriptorPath, 'utf8')) as Record<string, unknown>;
  const descriptor = {
    pid: requiredNumber(raw.pid, 'pid'),
    startIdentity: requiredString(raw.startIdentity, 'startIdentity'),
    socket: requiredString(raw.socket, 'socket'),
    protocolVersion: requiredNumber(raw.protocolVersion, 'protocolVersion'),
    buildId: requiredString(raw.buildId, 'buildId'),
    epoch: requiredString(raw.epoch, 'epoch'),
  } satisfies RuntimeDescriptorOnDisk;
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

function pidIsLive(descriptor: RuntimeDescriptorOnDisk): boolean {
  const liveStart = readProcessStartIdentity(descriptor.pid);
  return liveStart !== undefined && liveStart === descriptor.startIdentity;
}

function canReuseDescriptor(descriptor: RuntimeDescriptorOnDisk): descriptor is BtwRuntimeDescriptor {
  return descriptor.protocolVersion === BTW_RUNTIME_PROTOCOL_VERSION && pidIsLive(descriptor);
}

function runtimeHasDurableOperations(paths: RuntimePaths): boolean {
  const operationsDir = join(paths.runtimeDir, 'operations');
  try { return readdirSync(operationsDir, { recursive: true }).some(item => String(item).endsWith('.json')); } catch { return false; }
}

async function stopEmptyIncompatibleRuntime(paths: RuntimePaths, descriptor: RuntimeDescriptorOnDisk): Promise<void> {
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

function writeFrame(socket: Socket, frame: AuthOkFrame | AuthErrorFrame | BtwRuntimeFrame, callback?: () => void): void {
  socket.write(`${JSON.stringify(frame)}\n`, callback);
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

function scheduleExecutorWake(state: RuntimeState, btwOpId: string): void {
  if (state.shuttingDown) return;
  state.executorWakeQueue.enqueue(btwOpId);
  if (state.executorWakeScheduled) return;
  state.executorWakeScheduled = true;
  const timer = setTimeout(() => {
    state.executorWakeScheduled = false;
    void drainExecutorQueue(state);
  }, 0);
  timer.unref?.();
}

function operationScope(operation: BtwOperation) {
  return {
    larkAppId: operation.replyTarget.larkAppId,
    botmuxSessionId: operation.parent.botmuxSessionId,
  };
}

function executorKey(operation: BtwOperation): string {
  return `${operation.replyTarget.larkAppId}\0${operation.parent.botmuxSessionId}\0${operation.btwOpId}`;
}

function scopeKey(scope: BtwOperationScope): string {
  return `${scope.larkAppId}\0${scope.botmuxSessionId}`;
}

function findBtwOperationByNativeTurnId(
  state: RuntimeState,
  scope: BtwOperationScope,
  requestId: string,
  nativeTurnId: string,
): BtwOperation | undefined {
  const btwOpId = deriveBtwIdentifiers(scope, requestId).btwOpId;
  const operation = state.store.getBtwOperation(scope, btwOpId);
  if (!operation || operation.execution.nativeTurnId !== nativeTurnId) return undefined;
  return operation;
}

function findBtwOperationByRequestId(
  state: RuntimeState,
  scope: BtwOperationScope,
  requestId: string,
): BtwOperation | undefined {
  return state.store.getBtwOperation(scope, deriveBtwIdentifiers(scope, requestId).btwOpId);
}

function resolveBtwAdapter(state: RuntimeState, operation: BtwOperation): BtwAdapter | undefined {
  const managed = state.managedSessions.get(operation.parent.botmuxSessionId);
  if (!managed) return undefined;
  if (managed.profile.cliId !== 'traex') return undefined;
  if (!supportsManagedBtw(admissionCapabilities(managed.profile, true))) return undefined;
  if (managed.profile.configHash !== operation.parent.configHash) return undefined;
  if (managed.nativeThreadId !== operation.parent.nativeThreadId) return undefined;
  if (state.descriptor.epoch !== operation.parent.runtimeEpoch) return undefined;
  if (managed.btwAdapter) return managed.btwAdapter;
  const frozenScope: BtwOperationScope = {
    larkAppId: managed.profile.larkAppId,
    botmuxSessionId: managed.profile.sessionId,
  };
  managed.btwAdapter = createTraeBtwAdapter({
    session: managed.engine,
    threadId: managed.nativeThreadId,
    runtimeEpoch: state.descriptor.epoch,
    nativeTurnIdForRequest: (requestId) => {
      // `prepareBtwSubmission` intentionally removes this operation from the
      // executable scan before adapter.run() asks for its durable native ID.
      // The frozen request scope deterministically derives the operation key.
      const current = findBtwOperationByRequestId(state, frozenScope, requestId);
      if (!current) throw new Error(`btw operation not found for request: ${requestId}`);
      return current.execution.nativeTurnId;
    },
    onFrameState: async event => {
      const current = findBtwOperationByNativeTurnId(state, frozenScope, event.requestId, event.nativeTurnId);
      if (!current) return;
      const scope = operationScope(current);
      if (event.state === 'acknowledged') {
        state.store.recordBtwRunning(scope, current.btwOpId, event.nativeTurnId);
        return;
      }
      if (event.state === 'definitely_unsent') {
        state.store.recordBtwDefinitelyUnsent(scope, current.btwOpId, event.runtimeEpoch);
        return;
      }
      if (event.state === 'may_have_been_sent') return;
    },
    onTerminal: async event => {
      const current = findBtwOperationByNativeTurnId(state, frozenScope, event.requestId, event.nativeTurnId);
      if (!current) return;
      const scope = operationScope(current);
      state.store.recordBtwTerminal(scope, current.btwOpId, event.terminal);
      publishProjectionWake(state, scope.larkAppId);
    },
  });
  return managed.btwAdapter;
}

function reconcileBtwForLiveSessions(state: RuntimeState): void {
  for (const operation of state.store.reconcileBtwOperations({
    runtimeEpoch: state.descriptor.epoch,
    liveSessionIds: new Set(state.managedSessions.keys()),
  })) {
    publishProjectionWake(state, operation.replyTarget.larkAppId);
  }
}

async function executeBtwOperation(state: RuntimeState, operation: BtwOperation): Promise<void> {
  if (state.shuttingDown) return;
  const adapter = resolveBtwAdapter(state, operation);
  if (!adapter) return;
  const scope = operationScope(operation);
  const prepared = state.store.prepareBtwSubmission(scope, operation.btwOpId, state.descriptor.epoch);
  publishProjectionWake(state, scope.larkAppId);
  const outcome = await adapter.run({
    requestId: prepared.requestId,
    question: prepared.question,
  });
  const latest = state.store.getBtwOperation(scope, operation.btwOpId);
  if (!latest || latest.execution.state === 'submit_prepared' && latest.execution.frameState === 'definitely_unsent') {
    scheduleExecutorWake(state, operation.btwOpId);
    return;
  }
  if (outcome.status === 'submission_unknown') {
    state.store.recordBtwSubmissionUnknown(scope, operation.btwOpId, outcome.message ?? 'btw submission result unknown');
    publishProjectionWake(state, scope.larkAppId);
  } else if (outcome.status === 'failed' || outcome.status === 'cancelled' || outcome.status === 'completed') {
    state.store.recordBtwTerminal(scope, operation.btwOpId, outcome as BtwNativeTerminalOutcome);
    publishProjectionWake(state, scope.larkAppId);
  }
}

function recordBtwExecutorFailure(state: RuntimeState, operation: BtwOperation, error: unknown): void {
  const scope = operationScope(operation);
  const message = error instanceof Error ? error.message : String(error);
  const latest = state.store.getBtwOperation(scope, operation.btwOpId);
  if (!latest) return;
  if (latest.execution.state === 'submit_prepared' && latest.execution.frameState === 'definitely_unsent') {
    scheduleExecutorWake(state, operation.btwOpId);
    return;
  }
  if (latest.execution.state === 'submit_prepared' && latest.execution.frameState === 'may_have_been_sent') {
    state.store.recordBtwSubmissionUnknown(scope, operation.btwOpId, message);
    publishProjectionWake(state, scope.larkAppId);
    return;
  }
  if (latest.execution.state === 'running' || latest.execution.state === 'submission_unknown') {
    state.store.recordBtwTerminal(scope, operation.btwOpId, {
      status: 'failed',
      errorCode: 'btw_executor_error',
      message,
    });
    publishProjectionWake(state, scope.larkAppId);
  }
}

async function drainExecutorQueue(state: RuntimeState): Promise<void> {
  if (state.shuttingDown) return;
  state.executorWakeQueue.consume();
  const executable = state.store.listExecutableBtwOperations(state.descriptor.epoch);
  for (const operation of executable) {
    const key = executorKey(operation);
    if (state.executorInFlight.has(key)) continue;
    state.executorInFlight.add(key);
    void executeBtwOperation(state, operation)
      .catch(error => {
        try { recordBtwExecutorFailure(state, operation, error); }
        catch { /* the runtime keeps running; a later reconcile handles the record */ }
      })
      .finally(() => {
        state.executorInFlight.delete(key);
        if (state.executorWakeQueue.size > 0) scheduleExecutorWake(state, operation.btwOpId);
      });
  }
}

async function handleRuntimeCommand(
  state: RuntimeState,
  command: BtwRuntimeCommand,
): Promise<BtwRuntimeResultMap[keyof BtwRuntimeResultMap]> {
  switch (command.type) {
    case 'ensure_session':
      return await ensureManagedSession(state, command.profile);
    case 'attach_session': {
      const managed = state.managedSessions.get(command.sessionId);
      if (!managed) throw new Error('managed btw session not found');
      if (!Number.isSafeInteger(command.cursor) || command.cursor < 0 || command.cursor > managed.nextSeq) {
        throw new Error('stale managed btw notification cursor');
      }
      return { attachment: managedAttachment(state, managed) };
    }
    case 'detach_session':
      return { done: true };
    case 'submit_first_turn': {
      const managed = state.managedSessions.get(command.sessionId);
      if (!managed) throw new Error('managed btw session not found');
      assertManagedJournalCapacity(managed);
      managed.activeTurnIdentity = command.identity;
      try { return await managed.engine.sendFirstTurn(command.content, command.identity, async () => false); }
      catch (error) { managed.activeTurnIdentity = undefined; throw error; }
    }
    case 'submit_main_turn': {
      const managed = state.managedSessions.get(command.sessionId);
      if (!managed) throw new Error('managed btw session not found');
      assertManagedJournalCapacity(managed);
      managed.activeTurnIdentity = command.identity;
      try { return await managed.engine.sendTurn(command.content, command.identity); }
      catch (error) { managed.activeTurnIdentity = undefined; throw error; }
    }
    case 'read_thread_metadata': {
      const managed = state.managedSessions.get(command.sessionId);
      if (!managed) throw new Error('managed btw session not found');
      return await managed.engine.readThreadMetadata(command.timeoutMs);
    }
    case 'set_thread_name': {
      const managed = state.managedSessions.get(command.sessionId);
      if (!managed) throw new Error('managed btw session not found');
      await managed.engine.setThreadName(command.name);
      return { done: true };
    }
    case 'ack_events':
      {
        const managed = state.managedSessions.get(command.sessionId);
        if (!managed || !Number.isSafeInteger(command.seq) || command.seq < 0 || command.seq > managed.nextSeq) {
          throw new Error('invalid managed btw notification acknowledgement');
        }
        managed.journal = managed.journal.filter(notification => notification.throughSeq > command.seq);
      }
      return { done: true };
    case 'answer_user_input': {
      const managed = state.managedSessions.get(command.sessionId);
      const pending = managed?.pendingUserInputs.get(command.requestId);
      if (!managed || !pending) throw new Error('managed Trae user input request not found');
      managed.pendingUserInputs.delete(command.requestId);
      // A null settlement is the worker's expiry/explicit-stop path.
      // Rejecting enters CodexRpcEngineCore's turn/interrupt branch; replying
      // `{answers:{}}` (or any JSON-RPC error) would silently skip the ask.
      if (command.result === null) pending.reject(new Error('managed Trae user input expired or stopped'));
      else pending.resolve(command.result);
      return { done: true };
    }
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
      scheduleExecutorWake(state, command.btwOpId);
      return operation;
    }
    case 'submit_btw': {
      const operation = state.store.getBtwOperation(command.scope, command.btwOpId);
      if (!operation) throw new Error(`btw operation not found: ${command.btwOpId}`);
      publishProjectionWake(state, command.scope.larkAppId);
      scheduleExecutorWake(state, command.btwOpId);
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
        const attachCommand = envelope.command.type === 'attach_session'
          ? envelope.command
          : undefined;
        writeFrame(socket, {
          kind: 'reply',
          ok: true,
          requestId: envelope.requestId,
          commandType: envelope.command.type,
          result: result as never,
        }, envelope.command.type === 'shutdown_runtime' ? () => {
          setImmediate(() => {
            void shutdownRuntime({ dataDir: state.dataDir }).finally(() => process.exit(0));
          });
        } : attachCommand ? () => {
          const managed = state.managedSessions.get(attachCommand.sessionId)!;
          managed.subscribers.add(socket);
          socket.once('close', () => managed.subscribers.delete(socket));
          for (const notification of managed.journal) {
            if (notification.throughSeq > attachCommand.cursor) {
              writeFrame(socket, { kind: 'session_notification', notification });
            }
          }
        } : undefined);
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
      try { envelope = parseRuntimeEnvelope(JSON.parse(line)); } catch { socket.destroy(); return; }
      dispatch(envelope);
    }
  });
  socket.once('error', () => socket.destroy());
}

function parseRuntimeEnvelope(value: unknown): BtwRuntimeEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid runtime envelope');
  const envelope = value as Record<string, unknown>;
  if (typeof envelope.requestId !== 'string' || !envelope.requestId
    || envelope.protocolVersion !== BTW_RUNTIME_PROTOCOL_VERSION
    || typeof envelope.runtimeEpoch !== 'string' || !envelope.runtimeEpoch
    || !isSupportedRuntimeCommand(envelope.command)) throw new Error('invalid runtime envelope');
  return envelope as unknown as BtwRuntimeEnvelope;
}

function isSupportedRuntimeCommand(value: unknown): value is BtwRuntimeCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const command = value as Record<string, unknown>;
  const type = command.type;
  if (typeof type !== 'string') return false;
  switch (type) {
    case 'ensure_session': return !!command.profile && typeof command.profile === 'object';
    case 'attach_session': return typeof command.sessionId === 'string' && Number.isSafeInteger(command.cursor);
    case 'detach_session':
    case 'quiesce_session':
    case 'close_session': return typeof command.sessionId === 'string';
    case 'submit_first_turn':
    case 'submit_main_turn': return typeof command.sessionId === 'string' && typeof command.content === 'string' && !!command.identity && typeof command.identity === 'object';
    case 'read_thread_metadata': return typeof command.sessionId === 'string';
    case 'set_thread_name': return typeof command.sessionId === 'string' && typeof command.name === 'string';
    case 'ack_events': return typeof command.sessionId === 'string' && Number.isSafeInteger(command.seq);
    case 'answer_user_input': return typeof command.sessionId === 'string' && typeof command.requestId === 'string' && 'result' in command;
    case 'prepare_btw': return !!command.input && typeof command.input === 'object';
    case 'record_initial_card_attempt': return !!command.scope && typeof command.scope === 'object' && typeof command.btwOpId === 'string' && !!command.outcome && typeof command.outcome === 'object';
    case 'record_card': return !!command.scope && typeof command.scope === 'object' && typeof command.btwOpId === 'string' && typeof command.messageId === 'string';
    case 'submit_btw': return !!command.scope && typeof command.scope === 'object' && typeof command.btwOpId === 'string';
    case 'list_pending_initial_cards':
    case 'list_pending_projections':
    case 'watch_projection_wakes': return typeof command.larkAppId === 'string';
    case 'record_projection_failure':
    case 'ack_projection': return !!command.scope && typeof command.scope === 'object' && typeof command.btwOpId === 'string' && !!command.expected && typeof command.expected === 'object';
    case 'quiesce_all':
    case 'shutdown_runtime': return Object.keys(command).length === 1;
    default: return false;
  }
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
  const deadline = Date.now() + STARTUP_PUBLICATION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let waitingForDeadParentClaim = false;
    let waitingForLiveUnauthenticatedRuntime = false;
    await withFileLock(paths.lockPath, async () => {
      let live: RuntimeDescriptorOnDisk | undefined;
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
          waitingForLiveUnauthenticatedRuntime = true;
          return;
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
        // A rejected descriptor must not survive a later reservation wait. This
        // loop revisits the lock while a new child publishes; leaving the old
        // descriptor in place would make that later pass remove the new claim
        // and repeatedly spawn instead of observing the child publication.
        removePublishedDescriptor(paths);
      }
      const starting = readStartupMarker(paths);
      if (starting && starting.buildId === buildId) {
        if (isStartupClaim(starting)) {
          const ownerIsLive = readProcessStartIdentity(starting.ownerPid) === starting.ownerStartIdentity;
          if (ownerIsLive || Date.now() < starting.leaseExpiresAt) {
            // A dead owner may already have spawned a child carrying this opaque
            // capability. Wait outside the lock through its bounded lease, then
            // reacquire and inspect again before anyone can reclaim it.
            waitingForDeadParentClaim = !ownerIsLive;
            return;
          }
        }
        if (!isStartupClaim(starting)
          && readProcessStartIdentity(starting.pid) === starting.startIdentity) return;
      }
      removeStartupMarker(paths);

      cleanupSocketFile(paths.socketPath);
      const ownerStartIdentity = readProcessStartIdentity(process.pid);
      if (!ownerStartIdentity) throw new Error('cannot determine btw runtime startup claimant identity');
      const claim = randomToken();
      // Reserve before spawn. If this process dies at any later point, a future
      // ensure can prove the owner dead and reclaim it; it never mistakes a
      // reservation for a live child.
      writeStartupMarker(paths, {
        claim, ownerPid: process.pid, ownerStartIdentity, buildId,
        // A child has only the opaque claim capability, not the parent's PID. If
        // P dies just after spawning C, this lease prevents a reclaimer from
        // deleting the reservation before C can atomically bind itself.
        leaseExpiresAt: Date.now() + STARTUP_CLAIM_LEASE_MS,
      });
      const { spawn } = await import('node:child_process');
      const childRuntime = childSpawn();
      const child = spawn(childRuntime.command, childRuntime.args, {
        cwd: process.cwd(),
        env: {
          ...process.env,
          SESSION_DATA_DIR: dataDir,
          BOTMUX_BTW_RUNTIME_CHILD: '1',
          BOTMUX_BTW_RUNTIME_STARTUP_CLAIM: claim,
        },
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      const startIdentity = child.pid === undefined ? undefined : readProcessStartIdentity(child.pid);
      if (!child.pid || !startIdentity) {
        removeStartupMarker(paths);
        throw new Error('cannot determine spawned btw runtime identity');
      }
    });

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
    if (waitingForDeadParentClaim) await runtimeTestHooks?.onStartupClaimLeaseWait?.();
    if (waitingForLiveUnauthenticatedRuntime && Date.now() + STARTUP_POLL_MS >= deadline) {
      throw new Error('btw runtime is live but unavailable or unauthenticated');
    }
    await new Promise(resolvePromise => {
      const timer = setTimeout(resolvePromise, STARTUP_POLL_MS);
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
  const paths = runtimePaths(input.dataDir);
  state.shuttingDown = true;
  for (const managed of state.managedSessions.values()) {
    for (const pending of managed.pendingUserInputs.values()) {
      pending.reject(new Error('managed Trae runtime shutting down'));
    }
    managed.pendingUserInputs.clear();
    managed.btwAdapter?.close();
    managed.btwAdapter = undefined;
    managed.engine.closeOwnedProcess();
    await managed.mcpGatewayHost?.close().catch(() => undefined);
  }
  state.managedSessions.clear();
  // `server.close()` waits for open connections.  In particular the
  // shutdown_runtime command arrives on one of them, so close the sockets
  // first instead of waiting on the request that asked us to shut down.
  for (const socket of [...state.authenticatedSockets]) socket.destroy();
  await new Promise<void>((resolvePromise) => {
    state.server.close(() => resolvePromise());
  });
  runtimeStates.delete(canonicalDataDir(input.dataDir));
  cleanupSocketFile(paths.socketPath);
  removePublishedDescriptor(paths);
  removePublishedToken(paths);
  removeStartupMarker(paths);
}

export async function runBtwRuntime(input: { dataDir: string }): Promise<void> {
  const dataDir = canonicalDataDir(input.dataDir);
  const paths = runtimePaths(dataDir);
  mkdirSync(paths.runtimeDir, { recursive: true, mode: 0o700 });

  const buildId = assertRuntimeBuildIdKnown();
  const pid = process.pid;
  const startIdentity = readProcessStartIdentity(pid);
  if (!startIdentity) throw new Error('cannot determine btw runtime process identity');
  const startupClaim = process.env.BOTMUX_BTW_RUNTIME_STARTUP_CLAIM;
  // The child performs claim validation and marker conversion under exactly the
  // parent's singleton lock. A reclaimer can therefore either replace a dead
  // parent reservation or observe this child marker, never both.
  await withFileLock(paths.lockPath, async () => {
    const startup = readStartupMarker(paths);
    if (!startupClaim || !startup || !isStartupClaim(startup) || startup.claim !== startupClaim || startup.buildId !== buildId) {
      throw new Error('btw runtime startup claim is missing or invalid');
    }
    await runtimeTestHooks?.afterChildClaimLockAcquired?.();
    writeStartupMarker(paths, { pid, startIdentity, buildId });
  });
  // Only after the atomic handoff may this child touch socket/store state.
  cleanupSocketFile(paths.socketPath);
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
  const state = {
    dataDir,
    server,
    store,
    descriptor,
    token,
    projectionSubscribers: new Set(),
    authenticatedSockets: new Set(),
    projectionWakeQueue: new Set(),
    projectionWakeScheduled: false,
    executorWakeQueue: new RetainedBtwExecutorWakeQueue(),
    executorWakeScheduled: false,
    executorInFlight: new Set(),
    shuttingDown: false,
    managedSessions: new Map(),
  } satisfies RuntimeState;
  runtimeStates.set(dataDir, state);
  reconcileBtwForLiveSessions(state);
  for (const operation of store.listExecutableBtwOperations(descriptor.epoch)) {
    scheduleExecutorWake(state, operation.btwOpId);
  }
}
