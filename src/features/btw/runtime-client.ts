import { createConnection, type Socket } from 'node:net';

import {
  BTW_RUNTIME_PROTOCOL_VERSION,
  type BtwOperation,
  type BtwOperationScope,
  type BtwProjectionFailure,
  type BtwProjectionProviderOutcome,
  type BtwQuiesceResult,
  type BtwRuntimeClient,
  type BtwRuntimeCommand,
  type BtwRuntimeDescriptor,
  type BtwRuntimeEnvelope,
  type BtwRuntimeFrame,
  type PrepareBtwInput,
  type PrepareBtwResult,
} from './runtime-protocol.js';
import { connectBtwRuntime as connectServerRuntime, ensureBtwRuntime as ensureServerRuntime } from './runtime-server.js';

interface ClientInit {
  descriptor: BtwRuntimeDescriptor;
  token: string;
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

export class BtwRuntimeClientImpl implements BtwRuntimeClient {
  private socket?: Socket;

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
    if (this.socket && !this.socket.destroyed) return;
    this.socket = await this.createAuthenticatedSocket();
  }

  close(): void {
    this.socket?.destroy();
    this.socket = undefined;
  }

  private async request<T>(command: BtwRuntimeCommand): Promise<T> {
    await this.connect();
    const socket = this.socket!;
    const requestId = randomRequestId();
    const frame = {
      requestId,
      protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION,
      runtimeEpoch: this.input.descriptor.epoch,
      command,
    } satisfies BtwRuntimeEnvelope;
    socket.write(`${JSON.stringify(frame)}\n`);
    while (true) {
      const reply = JSON.parse(await readLine(socket)) as BtwRuntimeFrame;
      if (reply.kind === 'projection_wake') continue;
      if (reply.kind !== 'reply' || reply.requestId !== requestId) continue;
      if (!reply.ok) throw new Error(reply.error.message);
      return reply.result as T;
    }
  }

  async *watchProjectionWakes(larkAppId: string): AsyncIterable<{ kind: 'btw_projection_wake' }> {
    // Subscriptions own their transport.  Sharing the RPC socket would give two
    // independent readers the same newline stream and corrupt replies/wakes.
    const socket = await this.createAuthenticatedSocket();
    try {
      const requestId = randomRequestId();
      socket.write(`${JSON.stringify({
        requestId,
        protocolVersion: BTW_RUNTIME_PROTOCOL_VERSION,
        runtimeEpoch: this.input.descriptor.epoch,
        command: { type: 'watch_projection_wakes', larkAppId },
      } satisfies BtwRuntimeEnvelope)}\n`);
      while (!socket.destroyed) {
        const reply = JSON.parse(await readLine(socket)) as BtwRuntimeFrame;
        if (reply.kind === 'projection_wake' && reply.larkAppId === larkAppId) {
          yield reply.wake;
        } else if (reply.kind === 'reply' && reply.requestId === requestId && !reply.ok) {
          throw new Error(reply.error.message);
        }
      }
    } finally {
      socket.destroy();
    }
  }

  ensureSession(): Promise<never> { throw new Error('Task 6 does not implement ensureSession'); }
  attachSession(): Promise<never> { throw new Error('Task 6 does not implement attachSession'); }
  detachSession(): Promise<never> { throw new Error('Task 6 does not implement detachSession'); }
  quiesceSession(): Promise<never> { throw new Error('Task 6 does not implement quiesceSession'); }
  closeSession(): Promise<never> { throw new Error('Task 6 does not implement closeSession'); }
  submitFirstTurn(): Promise<never> { throw new Error('Task 6 does not implement submitFirstTurn'); }
  submitMainTurn(): Promise<never> { throw new Error('Task 6 does not implement submitMainTurn'); }
  readThreadMetadata(): Promise<never> { throw new Error('Task 6 does not implement readThreadMetadata'); }
  setThreadName(): Promise<never> { throw new Error('Task 6 does not implement setThreadName'); }
  ackEvents(): Promise<never> { throw new Error('Task 6 does not implement ackEvents'); }
  answerUserInput(): Promise<never> { throw new Error('Task 6 does not implement answerUserInput'); }
  quiesceApp(): Promise<never> { throw new Error('Task 6 does not implement quiesceApp'); }
  closeApp(): Promise<never> { throw new Error('Task 6 does not implement closeApp'); }

  async prepareBtw(input: PrepareBtwInput): Promise<PrepareBtwResult> {
    return await this.request<PrepareBtwResult>({ type: 'prepare_btw', input });
  }

  async recordInitialCardAttempt(scope: BtwOperationScope, btwOpId: string, outcome: never): Promise<BtwOperation> {
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

  async listPendingProjections(larkAppId: string) {
    return await this.request({ type: 'list_pending_projections', larkAppId });
  }

  async recordProjectionFailure(
    scope: BtwOperationScope,
    btwOpId: string,
    expected: { operationRevision: number; projectionRevision: number },
    failure: BtwProjectionFailure,
  ) {
    return await this.request({ type: 'record_projection_failure', scope, btwOpId, expected, failure });
  }

  async ackProjection(
    scope: BtwOperationScope,
    btwOpId: string,
    expected: { operationRevision: number; projectionRevision: number },
    outcome: BtwProjectionProviderOutcome,
  ) {
    return await this.request({ type: 'ack_projection', scope, btwOpId, expected, outcome });
  }

  async quiesceAll(): Promise<BtwQuiesceResult> {
    return await this.request<BtwQuiesceResult>({ type: 'quiesce_all' });
  }

  async shutdownRuntime(): Promise<void> {
    await this.request({ type: 'shutdown_runtime' });
  }
}

export async function ensureBtwRuntime(input: { dataDir: string }) {
  return await ensureServerRuntime(input);
}

export async function connectBtwRuntime(input: { dataDir: string; expectedEpoch?: string }) {
  return await connectServerRuntime(input);
}
