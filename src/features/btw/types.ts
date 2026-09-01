import { createHash } from 'node:crypto';
import type { BtwTerminalOutcome } from '../../adapters/cli/btw.js';

export type BtwOperationState =
  | 'card_pending'
  | 'card_unknown'
  | 'accepted'
  | 'submit_prepared'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'submission_unknown';

export interface BtwOperationScope {
  larkAppId: string;
  botmuxSessionId: string;
}

export interface FrozenBtwReplyTarget {
  larkAppId: string;
  chatId: string;
  rootMessageId: string | null;
  replyToMessageId: string | null;
  chatType: 'group' | 'p2p';
  brand: 'feishu' | 'lark';
}

export interface FrozenBtwParent {
  botmuxSessionId: string;
  cliId: string;
  nativeThreadId: string;
  runtimeEpoch: string;
  configHash: string;
  cwd: string;
}

export interface BtwRuntimeLocator {
  socket: string;
  epoch: string;
  protocolVersion: number;
  buildId: string;
}

export interface BtwSessionAttachmentState extends BtwRuntimeLocator {
  configHash: string;
  notificationCursor: number;
}

export interface BtwOperation {
  schemaVersion: 1;
  revision: number;
  btwOpId: string;
  requestId: string;
  question: string;
  parent: FrozenBtwParent;
  replyTarget: FrozenBtwReplyTarget;
  card: {
    createUuid: string;
    messageId?: string;
    createAttempt: number;
    nextCreateAttemptAt?: string;
    firstPossiblySentAt?: string;
    createRetryDeadline?: string;
    replacementUuid: string;
    replacementState: 'none' | 'pending' | 'created';
    replacementForRevision?: number;
    replacementMessageId?: string;
  };
  execution: {
    state: BtwOperationState;
    nativeTurnId: string;
    attempt: number;
    submissionEpoch?: string;
    frameState: 'not_started' | 'definitely_unsent' | 'may_have_been_sent' | 'acknowledged';
    answer?: string;
    errorCode?: string;
    message?: string;
  };
  projection: {
    desiredRevision: number;
    patchedRevision: number;
    blockedRevision?: number;
    retryAttempt: number;
    nextAttemptAt?: string;
    deliveryFailure?: {
      kind: 'visible_fallback' | 'provider_permanent';
      errorCode: string;
      message: string;
    };
    reminderUuid: string;
    reminderState: 'none' | 'pending' | 'sent' | 'unknown';
    reminderAttempt: number;
    reminderNextAttemptAt?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface PrepareBtwInput {
  requestId: string;
  question: string;
  parent: FrozenBtwParent;
  replyTarget: FrozenBtwReplyTarget;
}

export type PrepareBtwResult =
  | { kind: 'created'; operation: BtwOperation }
  | { kind: 'duplicate'; operation: BtwOperation };

export interface BtwProjectionItem {
  larkAppId: string;
  botmuxSessionId: string;
  btwOpId: string;
  expectedOperationRevision: number;
  projectionRevision: number;
  operation: BtwOperation;
}

export type BtwInitialCardAttemptOutcome =
  | { kind: 'definitely_unsent'; errorCode: string; message: string; retryAt: string }
  | { kind: 'unknown'; errorCode: string; message: string; retryAt: string };

export const MAX_INITIAL_CARD_CREATE_ATTEMPTS = 8 as const;

export type BtwProjectionFailure =
  | { kind: 'visible_fallback'; errorCode: string; message: string }
  | { kind: 'provider_permanent'; errorCode: string; message: string };

export type BtwProjectionProviderOutcome =
  | { kind: 'patched' }
  | { kind: 'withdrawn' }
  | { kind: 'replacement_created'; messageId: string }
  | { kind: 'reminder_sent' }
  | { kind: 'reminder_definitely_unsent'; retryAt: string }
  | { kind: 'reminder_unknown' }
  | { kind: 'retryable_failure'; errorCode: string; message: string; retryAt: string };

export interface BtwProjectionWatermark {
  scope: BtwOperationScope;
  btwOpId: string;
  projectionRevision: number;
}

export interface BtwQuiesceResult {
  affectedAppIds: string[];
  projectionWatermarks: BtwProjectionWatermark[];
}

/** Frozen store surface implemented by `operation-store.ts` in Task 2. */
export interface BtwOperationStore {
  pathFor(scope: BtwOperationScope, btwOpId: string): string;
  prepareBtw(input: PrepareBtwInput): PrepareBtwResult;
  getBtwOperation(scope: BtwOperationScope, btwOpId: string): BtwOperation | undefined;
  listPendingInitialCards(larkAppId: string): BtwOperation[];
  recordInitialCardAttempt(scope: BtwOperationScope, btwOpId: string, outcome: BtwInitialCardAttemptOutcome): BtwOperation;
  recordBtwCard(scope: BtwOperationScope, btwOpId: string, messageId: string): BtwOperation;
  listExecutableBtwOperations(runtimeEpoch: string): BtwOperation[];
  prepareBtwSubmission(scope: BtwOperationScope, btwOpId: string, runtimeEpoch: string): BtwOperation;
  recordBtwDefinitelyUnsent(scope: BtwOperationScope, btwOpId: string, runtimeEpoch: string): BtwOperation;
  recordBtwSubmissionUnknown(scope: BtwOperationScope, btwOpId: string, message: string): BtwOperation;
  recordBtwRunning(scope: BtwOperationScope, btwOpId: string, nativeTurnId: string): BtwOperation;
  recordBtwTerminal(
    scope: BtwOperationScope,
    btwOpId: string,
    terminal: BtwTerminalOutcome,
  ): { kind: 'advanced' | 'duplicate'; operation: BtwOperation };
  listPendingBtwProjections(larkAppId: string): BtwProjectionItem[];
  recordBtwProjectionFailure(
    scope: BtwOperationScope,
    btwOpId: string,
    expected: { operationRevision: number; projectionRevision: number },
    failure: BtwProjectionFailure,
  ): { kind: 'applied' | 'stale'; operation: BtwOperation };
  ackBtwProjection(
    scope: BtwOperationScope,
    btwOpId: string,
    expected: { operationRevision: number; projectionRevision: number },
    outcome: BtwProjectionProviderOutcome,
  ): { kind: 'applied' | 'stale'; operation: BtwOperation };
  reconcileBtwOperations(input: { runtimeEpoch: string; liveSessionIds: ReadonlySet<string> }): BtwOperation[];
}

/** Callable declaration implemented by `operation-store.ts` in Task 2. */
export declare function btwOperationPath(
  dataDir: string,
  scope: BtwOperationScope,
  btwOpId: string,
): string;

/** Callable declaration implemented by `operation-store.ts` in Task 2. */
export declare function createBtwOperationStore(options: {
  dataDir: string;
  now?: () => Date;
}): BtwOperationStore;

export interface BtwIdentifiers {
  btwOpId: string;
  nativeTurnId: string;
  createUuid: string;
  replacementUuid: string;
  reminderUuid: string;
}

function deriveId(domain: string, prefix: string, scope: BtwOperationScope, requestId: string): string {
  const digest = createHash('sha256')
    .update(domain)
    .update('\0')
    .update(scope.larkAppId)
    .update('\0')
    .update(scope.botmuxSessionId)
    .update('\0')
    .update(requestId)
    .digest('hex')
    .slice(0, 50 - prefix.length - 1);
  return `${prefix}_${digest}`;
}

export function deriveBtwIdentifiers(scope: BtwOperationScope, requestId: string): BtwIdentifiers {
  return {
    btwOpId: deriveId('btw-op', 'btwop', scope, requestId),
    nativeTurnId: deriveId('btw-native-turn', 'btwturn', scope, requestId),
    createUuid: deriveId('btw-card', 'btwcard', scope, requestId),
    replacementUuid: deriveId('btw-replacement', 'btwreplace', scope, requestId),
    reminderUuid: deriveId('btw-reminder', 'btwremind', scope, requestId),
  };
}
