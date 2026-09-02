import type { BtwAdapter, BtwNativeTerminalOutcome, BtwOutcome } from '../../adapters/cli/btw.js';
import type { CodexRpcNativeToolEvent, CodexRpcTurnTerminal } from '../../codex-rpc-engine.js';
import type { CodexRpcSession } from '../../codex-rpc-session.js';

type FrameState = 'definitely_unsent' | 'may_have_been_sent' | 'acknowledged';

interface PendingBtwTurn {
  requestId: string;
  nativeTurnId: string;
  owner: { turnId: string; dispatchAttempt: number };
  resolve(outcome: BtwOutcome): void;
  resultDelivered: boolean;
  terminalDelivered: boolean;
  terminalChain: Promise<void>;
  frameState: FrameState | 'not_started';
}

export interface CreateTraeBtwAdapterInput {
  session: CodexRpcSession;
  threadId: string;
  runtimeEpoch: string;
  nativeTurnIdForRequest(requestId: string): string;
  onFrameState(event: {
    requestId: string;
    nativeTurnId: string;
    runtimeEpoch: string;
    state: FrameState;
  }): Promise<void>;
  onTerminal(event: {
    requestId: string;
    nativeTurnId: string;
    terminal: BtwNativeTerminalOutcome;
  }): Promise<void>;
}

export interface TraeBtwAdapter extends BtwAdapter {
  close(): void;
}

function terminalToOutcome(terminal: CodexRpcTurnTerminal): BtwNativeTerminalOutcome {
  if (terminal.status === 'completed') {
    return { status: 'completed', answer: terminal.answer ?? '' };
  }
  if (terminal.status === 'aborted') {
    return { status: 'cancelled', ...(terminal.message ? { message: terminal.message } : {}) };
  }
  return {
    status: 'failed',
    ...(terminal.errorCode ? { errorCode: terminal.errorCode } : {}),
    ...(terminal.message ? { message: terminal.message } : {}),
  };
}

function toolEventFailure(): Extract<BtwNativeTerminalOutcome, { status: 'failed' }> {
  return {
    status: 'failed',
    errorCode: 'btw_tool_event_forbidden',
    message: 'Trae BTW attempted a native tool event',
  };
}

function isTransportLossTerminal(terminal: CodexRpcTurnTerminal): boolean {
  return terminal.status === 'engine-dead' || terminal.status === 'stopped';
}

export function createTraeBtwAdapter(input: CreateTraeBtwAdapterInput): TraeBtwAdapter {
  const pendingByNativeTurnId = new Map<string, PendingBtwTurn>();
  const settledByNativeTurnId = new Map<string, PendingBtwTurn>();
  let closed = false;

  const releasePending = (pending: PendingBtwTurn): void => {
    pendingByNativeTurnId.delete(pending.nativeTurnId);
  };

  const settleNativeOutcome = async (pending: PendingBtwTurn, terminal: BtwNativeTerminalOutcome): Promise<void> => {
    const run = async (): Promise<void> => {
      const firstTerminal = !pending.terminalDelivered;
      if (firstTerminal) {
        pending.terminalDelivered = true;
      }
      await input.onTerminal({
        requestId: pending.requestId,
        nativeTurnId: pending.nativeTurnId,
        terminal,
      });
      if (firstTerminal) {
        releasePending(pending);
        settledByNativeTurnId.set(pending.nativeTurnId, pending);
        if (settledByNativeTurnId.size > 1024) {
          const oldest = settledByNativeTurnId.keys().next().value as string | undefined;
          if (oldest) settledByNativeTurnId.delete(oldest);
        }
        if (!pending.resultDelivered) {
          pending.resultDelivered = true;
          pending.resolve(terminal);
        }
      }
    };
    pending.terminalChain = pending.terminalChain.then(run, run);
    await pending.terminalChain;
  };

  const releaseConnectionLost = (pending: PendingBtwTurn): void => {
    releasePending(pending);
  };

  const cleanupObserver = input.session.observe({
    onTurnTerminal: terminal => {
      const pending = pendingByNativeTurnId.get(terminal.nativeTurnId);
      if (!pending) return;
      if (isTransportLossTerminal(terminal)) {
        releaseConnectionLost(pending);
        return;
      }
    },
    onBtwTurnTerminal: async terminal => {
      const pending = pendingByNativeTurnId.get(terminal.nativeTurnId);
      if (!pending) return;
      if (isTransportLossTerminal(terminal)) {
        releaseConnectionLost(pending);
        return;
      }
      await settleNativeOutcome(pending, terminalToOutcome(terminal));
    },
    onDuplicateTurnTerminal: terminal => {
      const pending = pendingByNativeTurnId.get(terminal.nativeTurnId) ?? settledByNativeTurnId.get(terminal.nativeTurnId);
      if (!pending) return;
      void settleNativeOutcome(pending, terminalToOutcome(terminal));
    },
    onNativeToolEvent: (event: CodexRpcNativeToolEvent) => {
      const pending = pendingByNativeTurnId.get(event.nativeTurnId);
      if (!pending) return;
      void settleNativeOutcome(pending, toolEventFailure());
    },
  });

  const close = (): void => {
    if (closed) return;
    closed = true;
    cleanupObserver();
    for (const pending of pendingByNativeTurnId.values()) {
      input.session.releaseNativeBtwTurnOwner(pending.nativeTurnId, pending.owner);
      if (!pending.resultDelivered) {
        pending.resultDelivered = true;
        pending.resolve({
          status: 'submission_unknown',
          message: 'Trae BTW adapter is closed',
        });
      }
    }
    pendingByNativeTurnId.clear();
    settledByNativeTurnId.clear();
  };

  return {
    close,
    async run({ requestId, question }): Promise<BtwOutcome> {
      if (closed) {
        return {
          status: 'submission_unknown',
          message: 'Trae BTW adapter is closed',
        };
      }
      const nativeTurnId = input.nativeTurnIdForRequest(requestId);
      const owner = { turnId: requestId, dispatchAttempt: 1 };
      input.session.registerNativeBtwTurnOwner(nativeTurnId, owner);
      return await new Promise<BtwOutcome>((resolve) => {
        const pending: PendingBtwTurn = {
          requestId,
          nativeTurnId,
          owner,
          resolve,
          resultDelivered: false,
          terminalDelivered: false,
          terminalChain: Promise.resolve(),
          frameState: 'not_started',
        };
        pendingByNativeTurnId.set(nativeTurnId, pending);
        void input.session.requestWithDispatchBoundary(
          'turn/btw',
          { threadId: input.threadId, turnId: nativeTurnId, question },
          {
            onDispatched: async () => {
              await input.onFrameState({
                requestId,
                nativeTurnId,
                runtimeEpoch: input.runtimeEpoch,
                state: 'may_have_been_sent',
              });
              pending.frameState = 'may_have_been_sent';
            },
          },
        ).then(async result => {
          if (pending.resultDelivered) return;
          if (result.kind === 'acknowledged') {
            await input.onFrameState({
              requestId,
              nativeTurnId,
              runtimeEpoch: input.runtimeEpoch,
              state: 'acknowledged',
            });
            return;
          }
          const state: FrameState = result.kind === 'definitely_unsent'
            ? 'definitely_unsent'
            : 'may_have_been_sent';
          if (pending.frameState !== state) {
            await input.onFrameState({
              requestId,
              nativeTurnId,
              runtimeEpoch: input.runtimeEpoch,
              state,
            });
            pending.frameState = state;
          }
          if (result.kind === 'definitely_unsent') {
            releasePending(pending);
            input.session.releaseNativeBtwTurnOwner(nativeTurnId, owner);
            pending.resultDelivered = true;
            resolve({
              status: 'submission_unknown',
              message: result.error.message,
            });
            return;
          }
          pending.resultDelivered = true;
          resolve({
            status: 'submission_unknown',
            message: result.error.message,
          });
        }).catch(error => {
          if (pending.resultDelivered) return;
          pending.resultDelivered = true;
          resolve({
            status: 'submission_unknown',
            message: error instanceof Error ? error.message : String(error),
          });
        });
      });
    },
  };
}
