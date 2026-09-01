// Stateful Codex app-server session.  The legacy CodexRpcEngine remains the
// worker-facing compatibility facade while this class is the reusable owner of
// one app-server process, its WebSocket and native-turn routing state.
import { CodexRpcEngineCore, type CodexRpcEngineOpts, type CodexRpcTurnIdentity } from './codex-rpc-engine.js';
import type { BtwFirstTurnResult, BtwRuntimeClient } from './features/btw/runtime-protocol.js';

export type CodexRpcDispatchBoundaryResult =
  | { kind: 'acknowledged'; result: unknown }
  | { kind: 'definitely_unsent'; error: Error }
  | { kind: 'submission_unknown'; error: Error };

export interface CodexRpcDispatchBoundaryOpts {
  timeoutMs?: number;
  fatalOnTimeout?: boolean;
  /** Testable client-side boundary: runs immediately before WebSocket.send. */
  beforeSend?: () => void;
}

export interface CodexRpcSessionOpts extends CodexRpcEngineOpts {
  /** Receives parsed app-server notifications without introducing another WS parser. */
  onNotification?: (notification: { method: string; params: unknown }) => void;
}

/**
 * Reusable application-server session. The contained compatibility engine owns
 * the established process/WS/pending-map implementation; callbacks are routed
 * through this object so a later persistent client can detach its observer
 * without destroying the process it does not own.
 */
export class CodexRpcSession extends CodexRpcEngineCore {
  private observerAttached = true;

  constructor(opts: CodexRpcSessionOpts) {
    super({
      ...opts,
      onDead: () => { if (this.observerAttached) opts.onDead?.(); },
      onTurnTerminal: terminal => { if (this.observerAttached) opts.onTurnTerminal?.(terminal); },
      onRequestUserInput: async params => {
        if (!this.observerAttached || !opts.onRequestUserInput) return { answers: {} };
        return opts.onRequestUserInput(params);
      },
      onNotification: notification => {
        // Terminals are delivered through onTurnTerminal and input through its
        // dedicated callback; ordinary notifications remain exactly once here.
        if (this.observerAttached && !notification.method.startsWith('turn/')) opts.onNotification?.(notification);
      },
    });
  }

  /** Bind a native turn before submitting bytes when its owner is already known. */
  registerNativeTurnOwner(nativeTurnId: string, owner: CodexRpcTurnIdentity): void {
    super.registerNativeTurnOwner(nativeTurnId, owner);
  }

  /**
   * Classify the exact client dispatch boundary. A callback that throws before
   * the original send is definitely unsent; every failure after send returns is
   * submission-unknown, including a server that accepted the frame but lost ACK.
   */
  async requestWithDispatchBoundary(
    method: string,
    params: unknown,
    opts: CodexRpcDispatchBoundaryOpts = {},
  ): Promise<CodexRpcDispatchBoundaryResult> {
    const outcome = await super.requestAtDispatchBoundary(method, params, opts);
    if (!outcome.error) return { kind: 'acknowledged', result: outcome.result };
    return outcome.dispatched ? { kind: 'submission_unknown', error: outcome.error } : { kind: 'definitely_unsent', error: outcome.error };
  }

  /** Stop delivering observer callbacks while leaving the app-server alive. */
  detachObserver(): void { this.observerAttached = false; }

  /** Explicit destructive ownership operation for clients that spawned this process. */
  closeOwnedProcess(): void { super.stop(); }
}

/**
 * Worker-facing facade for a Trae app-server owned by the daemon's BTW runtime.
 * Its stop operation is intentionally a detach: permanent runtime shutdown is
 * a later explicit lifecycle operation and cannot be reached through a worker.
 */
export class PersistentTraeRpcProxy {
  constructor(private readonly input: {
    runtime: Pick<BtwRuntimeClient,
      'detachSession' | 'submitFirstTurn' | 'submitMainTurn' | 'readThreadMetadata' | 'setThreadName'>;
    sessionId: string;
    appServerUrl: string;
    nativeThreadId: string;
    closeSubscription?: () => Promise<void>;
  }) {}

  get wsUrl(): string { return this.input.appServerUrl; }
  get activeThreadId(): string { return this.input.nativeThreadId; }

  async start(): Promise<void> {}
  async startThread(): Promise<string> { return this.input.nativeThreadId; }
  async resumeThread(threadId: string): Promise<string> {
    if (threadId !== this.input.nativeThreadId) throw new Error('persistent Trae proxy cannot change native thread');
    return threadId;
  }
  async sendFirstTurn(
    content: string,
    identity: CodexRpcTurnIdentity,
    _rolloutProbe: (threadId: string) => Promise<boolean>,
  ): Promise<BtwFirstTurnResult> {
    return await this.input.runtime.submitFirstTurn(this.input.sessionId, content, identity);
  }
  async sendTurn(content: string, identity: CodexRpcTurnIdentity): Promise<{ nativeTurnId: string }> {
    return await this.input.runtime.submitMainTurn(this.input.sessionId, content, identity);
  }
  async readThreadMetadata(timeoutMs?: number): Promise<{ name?: string; preview?: string; updatedAt?: number }> {
    return await this.input.runtime.readThreadMetadata(this.input.sessionId, timeoutMs);
  }
  async setThreadName(name: string): Promise<void> { await this.input.runtime.setThreadName(this.input.sessionId, name); }
  async waitForThreadPreview(timeoutMs = 10_000): Promise<string | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const preview = (await this.readThreadMetadata()).preview;
      if (preview) return preview;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return undefined;
  }
  async waitForThreadUpdatedAfter(baseline: number, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const metadata = await this.readThreadMetadata();
      if (metadata.updatedAt !== undefined && metadata.updatedAt > baseline) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  async stop(): Promise<void> {
    await this.input.closeSubscription?.();
    await this.input.runtime.detachSession(this.input.sessionId);
  }
}
