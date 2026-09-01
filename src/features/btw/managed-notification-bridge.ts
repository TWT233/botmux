import type { BtwCursorCommitAck, BtwCursorCommitRequest } from '../../types.js';
import type { BtwRuntimeNotification } from './runtime-protocol.js';

type PendingCommit = {
  request: BtwCursorCommitRequest;
  resolve(): void;
  reject(error: Error): void;
};

export interface ManagedTraeNotificationBridgeInput {
  sessionId: string;
  workerGeneration: number;
  runtimeEpoch: string;
  cursor: number;
  notifications: AsyncIterable<BtwRuntimeNotification>;
  apply(notification: BtwRuntimeNotification): Promise<void>;
  requestCommit(request: BtwCursorCommitRequest): void;
  ackEvents(throughSeq: number): Promise<void>;
  detach(): Promise<void>;
  requestId(): string;
}

/**
 * Worker-side half of the managed Trae journal protocol.  It deliberately does
 * not know about PTYs or the local CodexRpcEngine: projection happens first,
 * daemon cursor persistence second, and runtime acknowledgement last.
 */
export class ManagedTraeNotificationBridge {
  private pending?: PendingCommit;
  private detached = false;
  private stopped = false;
  private _cursor: number;

  constructor(private readonly input: ManagedTraeNotificationBridgeInput) {
    this._cursor = input.cursor;
  }

  get cursor(): number { return this._cursor; }

  async run(): Promise<void> {
    try {
      for await (const notification of this.input.notifications) {
        if (this.stopped) return;
        await this.process(notification);
      }
    } catch (error) {
      await this.fail(error);
    }
  }

  onCursorPersisted(ack: BtwCursorCommitAck): void {
    const pending = this.pending;
    if (!pending || !this.matches(pending.request, ack)) {
      void this.fail(new Error('managed Trae cursor acknowledgement mismatch'));
      return;
    }
    this.pending = undefined;
    if (!ack.ok || ack.persistedSeq !== pending.request.throughSeq) {
      pending.reject(new Error(`managed Trae cursor persistence rejected: ${ack.error ?? 'unknown'}`));
      return;
    }
    pending.resolve();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      pending.reject(new Error('managed Trae notification bridge stopped'));
    }
  }

  private async process(notification: BtwRuntimeNotification): Promise<void> {
    if (notification.sessionId !== this.input.sessionId
      || !Number.isSafeInteger(notification.fromSeq)
      || !Number.isSafeInteger(notification.throughSeq)
      || notification.fromSeq < 1
      || notification.throughSeq < notification.fromSeq) {
      throw new Error('invalid managed Trae notification interval');
    }

    const duplicate = notification.throughSeq === this._cursor && notification.fromSeq <= this._cursor;
    if (!duplicate) {
      if (notification.throughSeq < this._cursor
        || notification.fromSeq <= this._cursor
        || notification.fromSeq !== this._cursor + 1) {
        throw new Error('non-contiguous managed Trae notification interval');
      }
      await this.input.apply(notification);
      // A worker can be torn down while an ask is intentionally held in
      // custody. Its release only unblocks this loop; stop still means no
      // durable cursor commit and no runtime ACK, so the journal entry replays
      // to the replacement observer.
      if (this.stopped) return;
    }

    const request: BtwCursorCommitRequest = {
      type: 'btw_notification_cursor_commit',
      requestId: this.input.requestId(),
      sessionId: this.input.sessionId,
      workerGeneration: this.input.workerGeneration,
      runtimeEpoch: this.input.runtimeEpoch,
      fromSeq: notification.fromSeq,
      throughSeq: notification.throughSeq,
    };
    await this.persist(request);
    await this.input.ackEvents(notification.throughSeq);
    this._cursor = notification.throughSeq;
  }

  private async persist(request: BtwCursorCommitRequest): Promise<void> {
    if (this.pending) throw new Error('managed Trae cursor persistence already pending');
    await new Promise<void>((resolve, reject) => {
      this.pending = { request, resolve, reject };
      try { this.input.requestCommit(request); } catch (error) {
        this.pending = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private matches(request: BtwCursorCommitRequest, ack: BtwCursorCommitAck): boolean {
    return ack.requestId === request.requestId
      && ack.sessionId === request.sessionId
      && ack.workerGeneration === request.workerGeneration
      && ack.runtimeEpoch === request.runtimeEpoch
      && ack.fromSeq === request.fromSeq
      && ack.throughSeq === request.throughSeq;
  }

  private async fail(error: unknown): Promise<void> {
    if (this.detached) return;
    this.detached = true;
    this.stopped = true;
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error instanceof Error ? error : new Error(String(error)));
    await this.input.detach();
  }
}
