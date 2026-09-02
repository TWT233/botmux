import { createConnection, type Socket } from 'node:net';

import {
  BTW_RUNTIME_PROTOCOL_VERSION,
  type BtwRuntimeClient,
  type BtwRuntimeCommand,
  type BtwRuntimeDescriptor,
  type BtwRuntimeEnvelope,
  type BtwRuntimeFrame,
} from './runtime-protocol.js';
import { connectBtwRuntime as connectServerRuntime, ensureBtwRuntime as ensureServerRuntime } from './runtime-server.js';
import type {
  BtwInitialCardAttemptOutcome,
  BtwOperation,
  BtwOperationScope,
  BtwProjectionFailure,
  BtwProjectionItem,
  BtwProjectionProviderOutcome,
  BtwQuiesceResult,
  PrepareBtwInput,
  PrepareBtwResult,
} from './types.js';
import type { AttachedBtwRuntimeSession, BtwFirstTurnResult, BtwRuntimeNotification, FrozenBtwSessionProfile } from './runtime-protocol.js';

interface ClientInit {
  descriptor: BtwRuntimeDescriptor;
  token: string;
}

interface PendingRequest {
  commandType: BtwRuntimeCommand['type'];
  resolve(value: unknown): void;
  reject(error: Error): void;
}

function randomRequestId(): string {
  return `req_${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
}

async function readLine(socket: Socket, maxBytes = 64 * 1024): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
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
      const rest = buffer.subarray(newline + 1);
      if (rest.length > 0) socket.unshift(rest);
      resolvePromise(buffer.subarray(0, newline).toString('utf8').replace(/\r$/, ''));
    };

    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

/** One decoder owns the RPC socket; request callers only own a pending-map row. */
class RuntimeRpcConnection {
  private readonly pending = new Map<string, PendingRequest>();
  private buffer = Buffer.alloc(0);

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData);
    socket.once('error', error => this.failAll(error));
    socket.once('close', () => this.failAll(new Error('btw runtime socket closed')));
  }

  get destroyed(): boolean { return this.socket.destroyed; }

  close(): void { this.socket.destroy(); }

  request<T>(frame: BtwRuntimeEnvelope): Promise<T> {
    if (this.socket.destroyed) return Promise.reject(new Error('btw runtime socket closed'));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(frame.requestId, {
        commandType: frame.command.type,
        resolve: value => resolve(value as T),
        reject,
      });
      this.socket.write(`${JSON.stringify(frame)}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(frame.requestId);
        this.pending.delete(frame.requestId);
        pending?.reject(error);
      });
    });
  }

  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer = Buffer.concat([this.buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    if (this.buffer.length > 64 * 1024) {
      this.failAll(new Error('btw runtime frame too large'));
      this.socket.destroy();
      return;
    }
    while (!this.socket.destroyed) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
      this.buffer = this.buffer.subarray(newline + 1);
      let frame: BtwRuntimeFrame;
      try { frame = JSON.parse(line) as BtwRuntimeFrame; } catch {
        this.failAll(new Error('invalid btw runtime reply'));
        this.socket.destroy();
        return;
      }
      if (frame.kind !== 'reply') continue;
      const pending = this.pending.get(frame.requestId);
      if (!pending) continue;
      this.pending.delete(frame.requestId);
      if (frame.commandType !== pending.commandType) {
        pending.reject(new Error('btw runtime reply command mismatch'));
      } else if (!frame.ok) {
        pending.reject(new Error(frame.error.message));
      } else if (!isValidRuntimeResult(frame.commandType, frame.result)) {
        pending.reject(new Error('invalid btw runtime reply result'));
      } else {
        pending.resolve(frame.result);
      }
    }
  };

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function isString(value: unknown): value is string { return typeof value === 'string'; }
function isOptionalString(value: unknown): boolean { return value === undefined || isString(value); }
function isFiniteNonNegativeInteger(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
const OPERATION_STATES = new Set(['card_pending', 'card_unknown', 'accepted', 'submit_prepared', 'running', 'completed', 'failed', 'cancelled', 'interrupted', 'submission_unknown']);
const FRAME_STATES = new Set(['not_started', 'definitely_unsent', 'may_have_been_sent', 'acknowledged']);
const REPLACEMENT_STATES = new Set(['none', 'pending', 'created']);
const REMINDER_STATES = new Set(['none', 'pending', 'sent', 'unknown']);

function isOperation(value: unknown): boolean {
  return isRecord(value)
    && value.schemaVersion === 1 && isFiniteNonNegativeInteger(value.revision)
    && typeof value.btwOpId === 'string' && typeof value.requestId === 'string' && typeof value.question === 'string'
    && isRecord(value.parent) && isString(value.parent.botmuxSessionId) && isString(value.parent.cliId) && isString(value.parent.nativeThreadId) && isString(value.parent.runtimeEpoch) && isString(value.parent.configHash) && isString(value.parent.cwd)
    && isRecord(value.replyTarget) && isString(value.replyTarget.larkAppId) && isString(value.replyTarget.chatId) && (value.replyTarget.rootMessageId === null || isString(value.replyTarget.rootMessageId)) && (value.replyTarget.replyToMessageId === null || isString(value.replyTarget.replyToMessageId)) && (value.replyTarget.chatType === 'group' || value.replyTarget.chatType === 'p2p') && (value.replyTarget.brand === 'feishu' || value.replyTarget.brand === 'lark')
    && isRecord(value.card) && isString(value.card.createUuid) && isFiniteNonNegativeInteger(value.card.createAttempt) && isOptionalString(value.card.messageId) && isOptionalString(value.card.nextCreateAttemptAt) && isOptionalString(value.card.firstPossiblySentAt) && isOptionalString(value.card.createRetryDeadline) && isString(value.card.replacementUuid) && REPLACEMENT_STATES.has(value.card.replacementState as string) && (value.card.replacementForRevision === undefined || isFiniteNonNegativeInteger(value.card.replacementForRevision)) && isOptionalString(value.card.replacementMessageId)
    && isRecord(value.execution) && OPERATION_STATES.has(value.execution.state as string) && isString(value.execution.nativeTurnId) && isFiniteNonNegativeInteger(value.execution.attempt) && isOptionalString(value.execution.submissionEpoch) && FRAME_STATES.has(value.execution.frameState as string) && isOptionalString(value.execution.answer) && isOptionalString(value.execution.errorCode) && isOptionalString(value.execution.message)
    && isRecord(value.projection) && isFiniteNonNegativeInteger(value.projection.desiredRevision) && isFiniteNonNegativeInteger(value.projection.patchedRevision) && (value.projection.blockedRevision === undefined || isFiniteNonNegativeInteger(value.projection.blockedRevision)) && isFiniteNonNegativeInteger(value.projection.retryAttempt) && isOptionalString(value.projection.nextAttemptAt) && isString(value.projection.reminderUuid) && REMINDER_STATES.has(value.projection.reminderState as string) && isFiniteNonNegativeInteger(value.projection.reminderAttempt) && isOptionalString(value.projection.reminderNextAttemptAt)
    && (value.projection.deliveryFailure === undefined || (isRecord(value.projection.deliveryFailure) && (value.projection.deliveryFailure.kind === 'visible_fallback' || value.projection.deliveryFailure.kind === 'provider_permanent') && isString(value.projection.deliveryFailure.errorCode) && isString(value.projection.deliveryFailure.message)))
    && typeof value.createdAt === 'string' && typeof value.updatedAt === 'string';
}

function isProjectionItem(value: unknown): boolean {
  return isRecord(value) && typeof value.larkAppId === 'string' && typeof value.botmuxSessionId === 'string'
    && typeof value.btwOpId === 'string' && isFiniteNonNegativeInteger(value.expectedOperationRevision)
    && isFiniteNonNegativeInteger(value.projectionRevision) && isOperation(value.operation);
}

function isQuiesceResult(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.affectedAppIds) && value.affectedAppIds.every(item => typeof item === 'string')
    && Array.isArray(value.projectionWatermarks) && value.projectionWatermarks.every(item => isRecord(item)
      && isRecord(item.scope) && typeof item.scope.larkAppId === 'string' && typeof item.scope.botmuxSessionId === 'string'
      && typeof item.btwOpId === 'string' && isFiniteNonNegativeInteger(item.projectionRevision));
}

function isValidRuntimeResult(commandType: BtwRuntimeCommand['type'], value: unknown): boolean {
  switch (commandType) {
    case 'ensure_session': return isRecord(value) && (value.attachment === null || isRecord(value.attachment)) && isRecord(value.capabilities);
    case 'attach_session': return isRecord(value) && isRecord(value.attachment);
    case 'detach_session':
    case 'ack_events':
    case 'set_thread_name': return isRecord(value) && value.done === true;
    case 'answer_user_input': return isRecord(value) && value.done === true;
    case 'submit_first_turn': return isRecord(value) && (value.outcome === 'accepted' || value.outcome === 'not-sent' || value.outcome === 'ambiguous');
    case 'submit_main_turn': return isRecord(value) && typeof value.nativeTurnId === 'string';
    case 'read_thread_metadata': return isRecord(value);
    case 'prepare_btw': return isRecord(value) && (value.kind === 'created' || value.kind === 'duplicate') && isOperation(value.operation);
    case 'record_initial_card_attempt':
    case 'record_card':
    case 'submit_btw': return isOperation(value);
    case 'list_pending_initial_cards': return Array.isArray(value) && value.every(isOperation);
    case 'next_btw_retry_at': return value === undefined || (typeof value === 'string' && !Number.isNaN(Date.parse(value)));
    case 'list_pending_projections': return Array.isArray(value) && value.every(isProjectionItem);
    case 'record_projection_failure':
    case 'ack_projection': return isRecord(value) && (value.kind === 'applied' || value.kind === 'stale') && isOperation(value.operation);
    case 'watch_projection_wakes': return isRecord(value) && value.subscribed === true;
    case 'quiesce_all': return isQuiesceResult(value);
    case 'shutdown_runtime': return isRecord(value) && value.done === true;
    default: return false;
  }
}

export class BtwRuntimeClientImpl implements BtwRuntimeClient {
  private rpc?: RuntimeRpcConnection;
  private connecting?: Promise<void>;

  constructor(private readonly input: ClientInit) {}

  private async createAuthenticatedSocket(): Promise<Socket> {
    const socket = await new Promise<Socket>((resolvePromise, rejectPromise) => {
      const client = createConnection(this.input.descriptor.socket);
      client.once('connect', () => resolvePromise(client));
      client.once('error', rejectPromise);
    });
    socket.write(`${JSON.stringify({
      kind: 'auth',
      token: this.input.token,
      protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION,
      runtimeEpoch: this.input.descriptor.epoch,
    })}\n`);
    const reply = JSON.parse(await readLine(socket)) as { kind: string; error?: { message: string } };
    if (reply.kind !== 'auth_ok') {
      socket.destroy();
      throw new Error(reply.error?.message ?? 'btw runtime auth failed');
    }
    return socket;
  }

  async connect(): Promise<void> {
    if (this.rpc && !this.rpc.destroyed) return;
    if (!this.connecting) {
      this.connecting = this.createAuthenticatedSocket()
        .then(socket => { this.rpc = new RuntimeRpcConnection(socket); })
        .finally(() => { this.connecting = undefined; });
    }
    await this.connecting;
  }

  close(): void {
    this.rpc?.close();
    this.rpc = undefined;
  }

  private async request<T>(command: BtwRuntimeCommand): Promise<T> {
    await this.connect();
    const requestId = randomRequestId();
    const frame = {
      requestId,
      protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION,
      runtimeEpoch: this.input.descriptor.epoch,
      command,
    } satisfies BtwRuntimeEnvelope;
    return await this.rpc!.request<T>(frame);
  }

  watchProjectionWakes(larkAppId: string): BtwProjectionWakeSubscription {
    return BtwProjectionWakeSubscription(() => this.createAuthenticatedSocket(), this.input.descriptor, larkAppId);
  }

  async ensureSession(profile: FrozenBtwSessionProfile): Promise<import('./runtime-protocol.js').BtwRuntimeResultMap['ensure_session']> {
    return await this.request({ type: 'ensure_session', profile });
  }
  async attachSession(input: { sessionId: string; cursor: number }): Promise<AttachedBtwRuntimeSession> {
    const subscription = new BtwSessionNotificationSubscription(() => this.createAuthenticatedSocket(), this.input.descriptor, input);
    const attachment = await subscription.ready;
    return { attachment, notifications: subscription, detach: async () => { await subscription.return(); await this.detachSession(input.sessionId); } };
  }
  async detachSession(sessionId: string): Promise<void> { await this.request({ type: 'detach_session', sessionId }); }
  quiesceSession(): Promise<never> { throw new Error('Task 6 does not implement quiesceSession'); }
  closeSession(): Promise<never> { throw new Error('Task 6 does not implement closeSession'); }
  async submitFirstTurn(sessionId: string, content: string, identity: any): Promise<BtwFirstTurnResult> { return await this.request({ type: 'submit_first_turn', sessionId, content, identity }); }
  async submitMainTurn(sessionId: string, content: string, identity: any): Promise<{ nativeTurnId: string }> { return await this.request({ type: 'submit_main_turn', sessionId, content, identity }); }
  async readThreadMetadata(sessionId: string, timeoutMs?: number) { return await this.request<{ name?: string; preview?: string; updatedAt?: number }>({ type: 'read_thread_metadata', sessionId, timeoutMs }); }
  async setThreadName(sessionId: string, name: string): Promise<void> { await this.request({ type: 'set_thread_name', sessionId, name }); }
  async ackEvents(sessionId: string, seq: number): Promise<void> { await this.request({ type: 'ack_events', sessionId, seq }); }
  async answerUserInput(sessionId: string, requestId: string, result: unknown): Promise<void> {
    await this.request({ type: 'answer_user_input', sessionId, requestId, result });
  }
  quiesceApp(): Promise<never> { throw new Error('Task 6 does not implement quiesceApp'); }
  closeApp(): Promise<never> { throw new Error('Task 6 does not implement closeApp'); }

  async prepareBtw(input: PrepareBtwInput): Promise<PrepareBtwResult> {
    return await this.request<PrepareBtwResult>({ type: 'prepare_btw', input });
  }

  async recordInitialCardAttempt(scope: BtwOperationScope, btwOpId: string, outcome: BtwInitialCardAttemptOutcome): Promise<BtwOperation> {
    return await this.request<BtwOperation>({ type: 'record_initial_card_attempt', scope, btwOpId, outcome });
  }

  async recordCard(scope: BtwOperationScope, btwOpId: string, messageId: string): Promise<BtwOperation> {
    return await this.request<BtwOperation>({ type: 'record_card', scope, btwOpId, messageId });
  }

  async submitBtw(scope: BtwOperationScope, btwOpId: string): Promise<BtwOperation> {
    return await this.request<BtwOperation>({ type: 'submit_btw', scope, btwOpId });
  }

  async listPendingInitialCards(larkAppId: string): Promise<BtwOperation[]> {
    return await this.request<BtwOperation[]>({ type: 'list_pending_initial_cards', larkAppId });
  }

  async nextBtwRetryAt(larkAppId: string): Promise<string | undefined> {
    return await this.request<string | undefined>({ type: 'next_btw_retry_at', larkAppId });
  }

  async listPendingProjections(larkAppId: string): Promise<BtwProjectionItem[]> {
    return await this.request<BtwProjectionItem[]>({ type: 'list_pending_projections', larkAppId });
  }

  async recordProjectionFailure(
    scope: BtwOperationScope,
    btwOpId: string,
    expected: { operationRevision: number; projectionRevision: number },
    failure: BtwProjectionFailure,
  ): Promise<{ kind: 'applied' | 'stale'; operation: BtwOperation }> {
    return await this.request<{ kind: 'applied' | 'stale'; operation: BtwOperation }>({ type: 'record_projection_failure', scope, btwOpId, expected, failure });
  }

  async ackProjection(
    scope: BtwOperationScope,
    btwOpId: string,
    expected: { operationRevision: number; projectionRevision: number },
    outcome: BtwProjectionProviderOutcome,
  ): Promise<{ kind: 'applied' | 'stale'; operation: BtwOperation }> {
    return await this.request<{ kind: 'applied' | 'stale'; operation: BtwOperation }>({ type: 'ack_projection', scope, btwOpId, expected, outcome });
  }

  async quiesceAll(): Promise<BtwQuiesceResult> {
    return await this.request<BtwQuiesceResult>({ type: 'quiesce_all' });
  }

  async shutdownRuntime(): Promise<void> {
    await this.request({ type: 'shutdown_runtime' });
  }
}

export interface BtwProjectionWakeSubscription extends AsyncIterable<{ kind: 'btw_projection_wake' }> {
  /** Resolves only after the server accepted the authenticated subscription. */
  readonly ready: Promise<void>;
}

class BtwSessionNotificationSubscription implements AsyncIterable<BtwRuntimeNotification>, AsyncIterator<BtwRuntimeNotification> {
  private readonly values: BtwRuntimeNotification[] = [];
  private waiting?: { resolve(value: IteratorResult<BtwRuntimeNotification>): void; reject(error: Error): void };
  private socket?: Socket;
  private closed = false;
  private buffer = Buffer.alloc(0);
  readonly ready: Promise<import('./runtime-protocol.js').BtwRuntimeAttachment>;

  constructor(
    createSocket: () => Promise<Socket>, descriptor: BtwRuntimeDescriptor,
    private readonly input: { sessionId: string; cursor: number },
  ) {
    this.ready = (async () => {
      const socket = this.socket = await createSocket();
      const requestId = randomRequestId();
      socket.write(`${JSON.stringify({ requestId, protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION, runtimeEpoch: descriptor.epoch, command: { type: 'attach_session', ...input } } satisfies BtwRuntimeEnvelope)}\n`);
      const reply = JSON.parse(await readLine(socket)) as BtwRuntimeFrame;
      if (reply.kind !== 'reply' || !reply.ok || reply.requestId !== requestId || reply.commandType !== 'attach_session') {
        throw new Error('btw session attachment was not acknowledged');
      }
      socket.on('data', this.onData);
      socket.once('error', error => this.fail(error));
      socket.once('close', () => this.fail(new Error('btw session attachment closed')));
      return reply.result.attachment;
    })().catch(error => { this.fail(error instanceof Error ? error : new Error(String(error))); throw error; });
  }

  [Symbol.asyncIterator](): AsyncIterator<BtwRuntimeNotification> { return this; }
  next(): Promise<IteratorResult<BtwRuntimeNotification>> {
    if (this.values.length) return Promise.resolve({ done: false, value: this.values.shift()! });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }
  async return(): Promise<IteratorResult<BtwRuntimeNotification>> {
    this.closed = true;
    this.socket?.destroy();
    this.waiting?.resolve({ done: true, value: undefined });
    return { done: true, value: undefined };
  }
  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer = Buffer.concat([this.buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString('utf8');
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        const frame = JSON.parse(line) as BtwRuntimeFrame;
        if (frame.kind === 'session_notification' && frame.notification.sessionId === this.input.sessionId) this.push(frame.notification);
      } catch { this.fail(new Error('invalid btw session notification')); }
    }
  };
  private push(value: BtwRuntimeNotification): void {
    if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting.resolve({ done: false, value }); }
    else this.values.push(value);
  }
  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const waiting = this.waiting; this.waiting = undefined;
    waiting?.reject(error);
  }
}

class BtwProjectionWakeSubscriptionImpl implements BtwProjectionWakeSubscription {
  private readonly values: Array<{ kind: 'btw_projection_wake' }> = [];
  private waiting?: { resolve(value: IteratorResult<{ kind: 'btw_projection_wake' }>): void; reject(error: Error): void };
  private socket?: Socket;
  private closed = false;
  readonly ready: Promise<void>;

  constructor(
    createSocket: () => Promise<Socket>,
    descriptor: BtwRuntimeDescriptor,
    private readonly larkAppId: string,
  ) {
    this.ready = (async () => {
      const socket = this.socket = await createSocket();
      const requestId = randomRequestId();
      socket.write(`${JSON.stringify({ requestId, protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION, runtimeEpoch: descriptor.epoch, command: { type: 'watch_projection_wakes', larkAppId } } satisfies BtwRuntimeEnvelope)}\n`);
      const subscribed = JSON.parse(await readLine(socket)) as BtwRuntimeFrame;
      if (subscribed.kind !== 'reply' || subscribed.requestId !== requestId || !subscribed.ok
        || subscribed.commandType !== 'watch_projection_wakes' || subscribed.result.subscribed !== true) {
        throw new Error('btw projection watcher subscription was not acknowledged');
      }
      socket.on('data', this.onData);
      socket.once('error', error => this.fail(error));
      socket.once('close', () => this.fail(new Error('btw projection watcher closed')));
    })().catch(error => { this.fail(error instanceof Error ? error : new Error(String(error))); throw error; });
  }

  [Symbol.asyncIterator](): AsyncIterator<{ kind: 'btw_projection_wake' }> { return this; }

  next(): Promise<IteratorResult<{ kind: 'btw_projection_wake' }>> {
    if (this.values.length > 0) return Promise.resolve({ done: false, value: this.values.shift()! });
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => { this.waiting = { resolve, reject }; });
  }

  async return(): Promise<IteratorResult<{ kind: 'btw_projection_wake' }>> {
    this.closed = true;
    this.socket?.destroy();
    this.waiting?.resolve({ done: true, value: undefined });
    return { done: true, value: undefined };
  }

  private buffer = Buffer.alloc(0);
  private readonly onData = (chunk: Buffer | string): void => {
    this.buffer = Buffer.concat([this.buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    while (true) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline < 0) return;
      const line = this.buffer.subarray(0, newline).toString('utf8');
      this.buffer = this.buffer.subarray(newline + 1);
      try {
        const frame = JSON.parse(line) as BtwRuntimeFrame;
        if (frame.kind === 'projection_wake' && frame.larkAppId === this.larkAppId) this.push(frame.wake);
      } catch { this.fail(new Error('invalid btw projection wake frame')); }
    }
  };

  private push(value: { kind: 'btw_projection_wake' }): void {
    if (this.waiting) { const waiting = this.waiting; this.waiting = undefined; waiting.resolve({ done: false, value }); }
    else this.values.push(value);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    const waiting = this.waiting; this.waiting = undefined;
    waiting?.reject(error);
  }
}

function BtwProjectionWakeSubscription(createSocket: () => Promise<Socket>, descriptor: BtwRuntimeDescriptor, larkAppId: string): BtwProjectionWakeSubscription {
  return new BtwProjectionWakeSubscriptionImpl(createSocket, descriptor, larkAppId);
}

export async function ensureBtwRuntime(input: { dataDir: string }) {
  return await ensureServerRuntime(input);
}

export async function connectBtwRuntime(input: { dataDir: string; expectedEpoch?: string }) {
  return await connectServerRuntime(input);
}
