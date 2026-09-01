export interface BtwAdapter {
  run(input: { requestId: string; question: string }): Promise<BtwOutcome>;
}

export type BtwNativeTerminalOutcome =
  | { status: 'completed'; answer: string }
  | { status: 'failed'; errorCode?: string; message?: string }
  | { status: 'cancelled'; message?: string };

export type BtwOutcome =
  | BtwNativeTerminalOutcome
  | { status: 'submission_unknown'; message?: string };

export type BtwTerminalOutcome =
  | BtwNativeTerminalOutcome
  | { status: 'interrupted'; message?: string };

export interface BtwCapabilities {
  nativeBtw: boolean;
  persistentRuntime: boolean;
  structuredTerminal: boolean;
  stableParentThread: boolean;
}

/**
 * BTW-specific launch evidence available before a live adapter exists.
 * `nativeBtw` intentionally remains false for Trae in Task 7: Task 9 owns
 * construction/proof of a live `BtwAdapter` and is the only layer allowed to
 * upgrade that fact. This keeps the generic CLI adapter contract unchanged.
 */
export type ManagedBtwLaunchContract = Omit<BtwCapabilities, 'persistentRuntime'>;

export function managedBtwLaunchContract(cliId: string): ManagedBtwLaunchContract | undefined {
  if (cliId !== 'traex') return undefined;
  return { nativeBtw: false, structuredTerminal: true, stableParentThread: true };
}

export function supportsManagedBtw(capabilities: BtwCapabilities): boolean {
  return capabilities.nativeBtw === true
    && capabilities.persistentRuntime === true
    && capabilities.structuredTerminal === true
    && capabilities.stableParentThread === true;
}
