// Stateful Codex app-server session.  The legacy CodexRpcEngine remains the
// worker-facing compatibility facade while this class is the reusable owner of
// one app-server process, its WebSocket and native-turn routing state.
import { CodexRpcEngineCore, type CodexRpcEngineOpts, type CodexRpcTurnIdentity } from './codex-rpc-engine.js';

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
export class CodexRpcSession {
  private readonly engine: CodexRpcEngineCore;
  private observerAttached = true;
  // This mirror is intentionally owned by the session boundary. It makes
  // registration observable to the next dispatch without exposing the engine's
  // private transport maps as a second routing API.
  private readonly registeredNativeTurnOwners = new Map<string, CodexRpcTurnIdentity>();

  constructor(opts: CodexRpcSessionOpts) {
    this.engine = new CodexRpcEngineCore({
      ...opts,
      onDead: () => { if (this.observerAttached) opts.onDead?.(); },
      onTurnTerminal: terminal => { if (this.observerAttached) opts.onTurnTerminal?.(terminal); },
      onRequestUserInput: async params => {
        if (!this.observerAttached || !opts.onRequestUserInput) return { answers: {} };
        return opts.onRequestUserInput(params);
      },
    });

    // The engine is the only WebSocket parser. Observe its already-parsed input
    // at the method boundary so consumers never attach a competing ws listener.
    const internals = this.engine as any;
    const onMessage = internals.onMessage.bind(this.engine);
    internals.onMessage = (line: string) => {
      try {
        const message = JSON.parse(line);
        if (this.observerAttached && typeof message?.method === 'string' && typeof message.id !== 'number') {
          opts.onNotification?.({ method: message.method, params: message.params });
        }
      } catch { /* engine owns malformed-frame handling */ }
      onMessage(line);
    };
  }

  get wsUrl(): string { return this.engine.wsUrl; }
  get activeThreadId(): string | undefined { return this.engine.activeThreadId; }
  get appServerPid(): number | undefined { return this.engine.appServerPid; }

  start(): Promise<void> { return this.engine.start(); }
  startThread(): Promise<string> { return this.engine.startThread(); }
  resumeThread(threadId: string): Promise<string> { return this.engine.resumeThread(threadId); }
  sendTurn(content: string, identity: CodexRpcTurnIdentity, opts?: { timeoutMs?: number; fatalOnTimeout?: boolean }): Promise<{ nativeTurnId: string }> {
    return this.engine.sendTurn(content, identity, opts);
  }
  sendFirstTurn(content: string, identity: CodexRpcTurnIdentity, rolloutProbe: (threadId: string) => Promise<boolean>) {
    return this.engine.sendFirstTurn(content, identity, rolloutProbe);
  }
  setThreadName(name: string): Promise<void> { return this.engine.setThreadName(name); }
  waitForThreadPreview(timeoutMs?: number): Promise<string | undefined> { return this.engine.waitForThreadPreview(timeoutMs); }
  waitForThreadUpdatedAfter(baseline: number, timeoutMs?: number): Promise<void> { return this.engine.waitForThreadUpdatedAfter(baseline, timeoutMs); }
  readThreadMetadata(timeoutMs?: number) { return this.engine.readThreadMetadata(timeoutMs); }

  /** Bind a native turn before submitting bytes when its owner is already known. */
  registerNativeTurnOwner(nativeTurnId: string, owner: CodexRpcTurnIdentity): void {
    this.registeredNativeTurnOwners.set(nativeTurnId, { ...owner });
    (this.engine as any).bindNativeTurn(nativeTurnId, owner);
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
    const internals = this.engine as any;
    const originalSend = internals.send;
    let dispatched = false;
    internals.send = (message: unknown) => {
      opts.beforeSend?.();
      originalSend.call(this.engine, message);
      dispatched = true;
    };
    try {
      const result = await internals.request(
        method,
        params,
        { timeoutMs: opts.timeoutMs, fatalOnTimeout: opts.fatalOnTimeout ?? false },
        undefined,
      );
      return { kind: 'acknowledged', result };
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      return dispatched
        ? { kind: 'submission_unknown', error: normalized }
        : { kind: 'definitely_unsent', error: normalized };
    } finally {
      internals.send = originalSend;
    }
  }

  /** Stop delivering observer callbacks while leaving the app-server alive. */
  detachObserver(): void { this.observerAttached = false; }

  /** Explicit destructive ownership operation for clients that spawned this process. */
  closeOwnedProcess(): void { this.engine.stop(); }
}
