/** A broker-confirmed ask terminal. Transport, parsing, and daemon-discovery
 * failures deliberately use ordinary Error so the runtime-owned ask remains
 * unacknowledged and is replayed to a replacement worker. */
export class ManagedUserInputTerminalError extends Error {}

export interface ManagedUserInputSettlementInput<T> {
  start(): Promise<T>;
  isCurrent(): boolean;
  settle(result: T | null): Promise<void>;
  releaseStaleWaiter(): void;
  retryFromReplacement(error: Error): void;
}

/**
 * Bridge one runtime-owned native ask through a worker-local UI observer.
 *
 * A detached observer must never settle the native request: it only releases
 * its local waiter. A confirmed ask deadline/stop settles null (the runtime
 * maps it to turn/interrupt); every other failure rejects this observer before
 * its journal cursor advances so a replacement worker can replay the ask.
 */
export function settleManagedUserInputBridge<T>(input: ManagedUserInputSettlementInput<T>): void {
  void input.start().then(
    async result => {
      if (!input.isCurrent()) {
        input.releaseStaleWaiter();
        return;
      }
      await input.settle(result);
    },
    async error => {
      if (!input.isCurrent()) {
        input.releaseStaleWaiter();
        return;
      }
      if (error instanceof ManagedUserInputTerminalError) {
        await input.settle(null);
        return;
      }
      input.retryFromReplacement(error instanceof Error ? error : new Error(String(error)));
    },
  ).catch(error => {
    if (input.isCurrent()) input.retryFromReplacement(error instanceof Error ? error : new Error(String(error)));
  });
}
