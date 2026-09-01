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

export function supportsManagedBtw(capabilities: BtwCapabilities): boolean {
  return capabilities.nativeBtw === true
    && capabilities.persistentRuntime === true
    && capabilities.structuredTerminal === true
    && capabilities.stableParentThread === true;
}
