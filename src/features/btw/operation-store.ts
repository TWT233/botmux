import { createHash } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { BtwTerminalOutcome } from '../../adapters/cli/btw.js';
import { atomicWriteFileSync } from '../../utils/atomic-write.js';
import { withFileLockSync } from '../../utils/file-lock.js';
import {
  deriveBtwIdentifiers,
  MAX_INITIAL_CARD_CREATE_ATTEMPTS,
  type BtwInitialCardAttemptOutcome,
  type BtwOperation,
  type BtwOperationScope,
  type BtwOperationStore,
  type BtwProjectionFailure,
  type BtwProjectionItem,
  type BtwProjectionProviderOutcome,
  type PrepareBtwInput,
  type PrepareBtwResult,
} from './types.js';

const OPERATION_SCHEMA_VERSION = 1 as const;
const POISON_SCHEMA_VERSION = 1 as const;
const CREATE_AMBIGUITY_DEADLINE_MS = 55 * 60 * 1000;

const OPERATION_STATES = new Set([
  'card_pending',
  'card_unknown',
  'accepted',
  'submit_prepared',
  'running',
  'completed',
  'failed',
  'cancelled',
  'interrupted',
  'submission_unknown',
] as const);

const CHAT_TYPES = new Set(['group', 'p2p'] as const);
const BRANDS = new Set(['feishu', 'lark'] as const);
const REPLACEMENT_STATES = new Set(['none', 'pending', 'created'] as const);
const FRAME_STATES = new Set(['not_started', 'definitely_unsent', 'may_have_been_sent', 'acknowledged'] as const);
const DELIVERY_FAILURE_KINDS = new Set(['visible_fallback', 'provider_permanent'] as const);
const REMINDER_STATES = new Set(['none', 'pending', 'sent', 'unknown'] as const);
const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'interrupted'] as const);

interface BtwOperationPoisonMarker {
  schemaVersion: typeof POISON_SCHEMA_VERSION;
  kind: 'btw_operation_poison';
  btwOpId: string;
  scope: BtwOperationScope;
  reason: 'corrupt_exact_duplicate';
  sourceDigest: string;
}

interface BtwTerminalConflictDiagnostic {
  schemaVersion: 1;
  kind: 'btw_terminal_conflict';
  btwOpId: string;
  scope: BtwOperationScope;
  existingExecution: BtwOperation['execution'];
  incomingTerminal: BtwTerminalOutcome;
  detectedAt: string;
}

class BtwRecordParseError extends Error {
  constructor(
    message: string,
    public readonly digest: string,
  ) {
    super(message);
    this.name = 'BtwRecordParseError';
  }
}

class BtwSymlinkRejectedError extends Error {
  constructor(message = 'symlink target rejected') {
    super(message);
    this.name = 'BtwSymlinkRejectedError';
  }
}

export class BtwOperationPoisonedError extends Error {
  constructor(
    public readonly scope: BtwOperationScope,
    public readonly btwOpId: string,
  ) {
    super(`btw operation poisoned: ${scope.larkAppId}/${scope.botmuxSessionId}/${btwOpId}`);
    this.name = 'BtwOperationPoisonedError';
  }
}

export function btwOperationPath(
  dataDir: string,
  scope: BtwOperationScope,
  btwOpId: string,
): string {
  assertValidBtwOpId(btwOpId);
  return join(
    dataDir,
    'btw',
    'operations',
    scopeHash(scope),
    `${btwOpId}.json`,
  );
}

export function createBtwOperationStore(options: {
  dataDir: string;
  now?: () => Date;
}): BtwOperationStore {
  const now = options.now ?? (() => new Date());

  const pathFor = (scope: BtwOperationScope, btwOpId: string): string =>
    btwOperationPath(options.dataDir, scope, btwOpId);

  const prepareBtw = (input: PrepareBtwInput): PrepareBtwResult => {
    const scope = scopeFromInput(input);
    const ids = deriveBtwIdentifiers(scope, input.requestId);
    const recordPath = pathFor(scope, ids.btwOpId);
    ensureParentDir(recordPath);
    return withFileLockSync(recordPath, () => {
      assertNotPoisoned(recordPath, scope, ids.btwOpId);
      scanAndHandleSiblingCorruption(recordPath, ids.btwOpId, scope);
      assertNotPoisoned(recordPath, scope, ids.btwOpId);
      if (!pathExistsNoFollow(recordPath)) {
        const operation = freezeDeep(createPreparedOperation(input, scope, now().toISOString()));
        writeOperation(recordPath, operation);
        return { kind: 'created', operation };
      }
      try {
        const operation = readOperationRecord(recordPath, {
          expectedScope: scope,
          expectedBtwOpId: ids.btwOpId,
          expectedRequestId: input.requestId,
        });
        return { kind: 'duplicate', operation };
      } catch (error) {
        if (error instanceof BtwOperationPoisonedError) throw error;
        if (error instanceof BtwSymlinkRejectedError) throw error;
        poisonExactRecord(recordPath, scope, ids.btwOpId, toParseError(recordPath, error));
      }
    });
  };

  const getBtwOperation = (
    scope: BtwOperationScope,
    btwOpId: string,
  ): BtwOperation | undefined => {
    assertValidBtwOpId(btwOpId);
    const recordPath = pathFor(scope, btwOpId);
    ensureParentDir(recordPath);
    return withFileLockSync(recordPath, () => {
      assertNotPoisoned(recordPath, scope, btwOpId);
      if (!pathExistsNoFollow(recordPath)) return undefined;
      try {
        return readOperationRecord(recordPath, {
          expectedScope: scope,
          expectedBtwOpId: btwOpId,
        });
      } catch (error) {
        if (error instanceof BtwOperationPoisonedError) throw error;
        if (error instanceof BtwSymlinkRejectedError) throw error;
        poisonExactRecord(recordPath, scope, btwOpId, toParseError(recordPath, error));
      }
    });
  };

  const withOperationMutation = <T>(
    scope: BtwOperationScope,
    btwOpId: string,
    mutate: (operation: BtwOperation, isoNow: string, recordPath: string) => {
      operation: BtwOperation;
      result: T;
      changed: boolean;
    },
  ): T => {
    assertValidBtwOpId(btwOpId);
    const recordPath = pathFor(scope, btwOpId);
    ensureParentDir(recordPath);
    return withFileLockSync(recordPath, () => {
      assertNotPoisoned(recordPath, scope, btwOpId);
      if (!pathExistsNoFollow(recordPath)) {
        throw new Error(`btw operation not found: ${btwOpId}`);
      }
      const current = readOperationRecord(recordPath, {
        expectedScope: scope,
        expectedBtwOpId: btwOpId,
      });
      const isoNow = now().toISOString();
      const next = mutate(current, isoNow, recordPath);
      if (next.changed) {
        writeOperation(recordPath, next.operation);
      }
      return next.result;
    });
  };

  const listExecutableBtwOperations = (runtimeEpoch: string): BtwOperation[] =>
    listAllOperations(options.dataDir).filter((operation) =>
      (operation.execution.state === 'accepted'
        && operation.parent.runtimeEpoch === runtimeEpoch)
      || (
        operation.execution.state === 'submit_prepared'
        && operation.execution.frameState === 'definitely_unsent'
        && operation.execution.submissionEpoch === runtimeEpoch
      ));

  const recordBtwCard = (
    scope: BtwOperationScope,
    btwOpId: string,
    messageId: string,
  ): BtwOperation => withOperationMutation(scope, btwOpId, (operation, isoNow) => {
    if (operation.execution.state === 'accepted') {
      if (operation.card.messageId === messageId) {
        return { operation, result: operation, changed: false };
      }
      throw new Error('accepted btw operation already bound to a different message id');
    }
    if (operation.execution.state !== 'card_pending') {
      throw new Error(`recordBtwCard requires card_pending state, got ${operation.execution.state}`);
    }
    const next = evolveOperation(operation, isoNow, {
      card: {
        ...operation.card,
        messageId,
      },
      execution: {
        ...operation.execution,
        state: 'accepted',
      },
    });
    return { operation: next, result: next, changed: true };
  });

  const prepareBtwSubmission = (
    scope: BtwOperationScope,
    btwOpId: string,
    runtimeEpoch: string,
  ): BtwOperation => withOperationMutation(scope, btwOpId, (operation, isoNow) => {
    const current = operation.execution;
    const canStartFresh = current.state === 'accepted';
    const canRetrySameEpoch = current.state === 'submit_prepared'
      && current.frameState === 'definitely_unsent'
      && current.submissionEpoch === runtimeEpoch;
    if (canStartFresh && operation.parent.runtimeEpoch !== runtimeEpoch) {
      throw new Error(`runtime epoch mismatch for accepted btw operation: expected ${operation.parent.runtimeEpoch}, got ${runtimeEpoch}`);
    }
    if (!canStartFresh && !canRetrySameEpoch) {
      if (current.state === 'submit_prepared' && current.submissionEpoch !== runtimeEpoch) {
        throw new Error(`runtime epoch mismatch for submit_prepared btw operation: expected ${current.submissionEpoch}, got ${runtimeEpoch}`);
      }
      throw new Error(`prepareBtwSubmission requires accepted state or same-epoch definitely-unsent retry, got ${current.state}`);
    }
    const next = evolveOperation(operation, isoNow, {
      execution: {
        ...current,
        state: 'submit_prepared',
        attempt: current.attempt + 1,
        submissionEpoch: runtimeEpoch,
        frameState: 'may_have_been_sent',
        message: undefined,
      },
    });
    return { operation: next, result: next, changed: true };
  });

  const recordBtwDefinitelyUnsent = (
    scope: BtwOperationScope,
    btwOpId: string,
    runtimeEpoch: string,
  ): BtwOperation => withOperationMutation(scope, btwOpId, (operation, isoNow) => {
    const current = operation.execution;
    if (current.state !== 'submit_prepared') {
      throw new Error(`recordBtwDefinitelyUnsent requires submit_prepared state, got ${current.state}`);
    }
    if (current.submissionEpoch !== runtimeEpoch) {
      throw new Error(`runtime epoch mismatch for submit_prepared btw operation: expected ${current.submissionEpoch}, got ${runtimeEpoch}`);
    }
    if (current.frameState === 'definitely_unsent') {
      return { operation, result: operation, changed: false };
    }
    if (current.frameState !== 'may_have_been_sent') {
      throw new Error(`recordBtwDefinitelyUnsent requires may_have_been_sent frame state, got ${current.frameState}`);
    }
    const next = evolveOperation(operation, isoNow, {
      execution: {
        ...current,
        frameState: 'definitely_unsent',
      },
    });
    return { operation: next, result: next, changed: true };
  });

  const recordBtwSubmissionUnknown = (
    scope: BtwOperationScope,
    btwOpId: string,
    message: string,
  ): BtwOperation => withOperationMutation(scope, btwOpId, (operation, isoNow) => {
    const current = operation.execution;
    if (current.state === 'submission_unknown') {
      if ((current.message ?? '') === message) {
        return { operation, result: operation, changed: false };
      }
      throw new Error('submission_unknown btw operation is immutable');
    }
    if (current.state !== 'submit_prepared' || current.frameState !== 'may_have_been_sent') {
      throw new Error(`recordBtwSubmissionUnknown requires submit_prepared/may_have_been_sent, got ${current.state}/${current.frameState}`);
    }
    const next = evolveVisibleOperation(operation, isoNow, {
      execution: {
        ...current,
        state: 'submission_unknown',
        message,
      },
    });
    return { operation: next, result: next, changed: true };
  });

  const recordBtwRunning = (
    scope: BtwOperationScope,
    btwOpId: string,
    nativeTurnId: string,
  ): BtwOperation => withOperationMutation(scope, btwOpId, (operation, isoNow) => {
    const current = operation.execution;
    if (current.nativeTurnId !== nativeTurnId) {
      throw new Error(`native turn id mismatch: expected ${current.nativeTurnId}, got ${nativeTurnId}`);
    }
    if (current.state === 'running') {
      return { operation, result: operation, changed: false };
    }
    if (current.state !== 'submit_prepared' || current.frameState !== 'may_have_been_sent') {
      throw new Error(`recordBtwRunning invalid state: expected submit_prepared/may_have_been_sent, got ${current.state}/${current.frameState}`);
    }
    const next = evolveOperation(operation, isoNow, {
      execution: {
        ...current,
        state: 'running',
        frameState: 'acknowledged',
      },
    });
    return { operation: next, result: next, changed: true };
  });

  const recordBtwTerminal = (
    scope: BtwOperationScope,
    btwOpId: string,
    terminal: BtwTerminalOutcome,
  ): { kind: 'advanced' | 'duplicate'; operation: BtwOperation } => withOperationMutation<{ kind: 'advanced' | 'duplicate'; operation: BtwOperation }>(scope, btwOpId, (operation, isoNow, recordPath) => {
    const current = operation.execution;
    if (isTerminalExecutionState(current.state)) {
      if (terminalMatchesExecution(current, terminal)) {
        return { operation, result: { kind: 'duplicate', operation }, changed: false };
      }
      writeTerminalConflict(recordPath, {
        schemaVersion: 1,
        kind: 'btw_terminal_conflict',
        btwOpId,
        scope,
        existingExecution: current,
        incomingTerminal: terminal,
        detectedAt: isoNow,
      });
      return { operation, result: { kind: 'duplicate', operation }, changed: false };
    }
    if (!(
      current.state === 'submit_prepared'
      || current.state === 'running'
      || current.state === 'submission_unknown'
    )) {
      throw new Error(`recordBtwTerminal requires active or submission_unknown state, got ${current.state}`);
    }
    const next = evolveVisibleOperation(operation, isoNow, {
      execution: terminalToExecution(current, terminal),
    });
    return { operation: next, result: { kind: 'advanced', operation: next }, changed: true };
  });

  const listPendingInitialCards = (larkAppId: string): BtwOperation[] =>
    listAllOperations(options.dataDir)
      .filter((operation) =>
        operation.replyTarget.larkAppId === larkAppId
        && operation.execution.state === 'card_pending'
        && isRetryDue(operation.card.nextCreateAttemptAt, now()),
      )
      .sort(compareOperationsForListing);

  const nextBtwRetryAt = (larkAppId: string): string | undefined => {
    const current = now().getTime();
    const future = listAllOperations(options.dataDir)
      .filter(operation => operation.replyTarget.larkAppId === larkAppId)
      .flatMap(operation => {
        const candidates: Array<string | undefined> = [];
        if (operation.execution.state === 'card_pending') candidates.push(operation.card.nextCreateAttemptAt);
        if (isContentProjectionPending(operation)) candidates.push(operation.projection.nextAttemptAt);
        if (isReminderPhase(operation)) candidates.push(operation.projection.reminderNextAttemptAt);
        return candidates;
      })
      .filter((value): value is string => value !== undefined && Date.parse(value) > current)
      .sort((left, right) => Date.parse(left) - Date.parse(right));
    return future[0];
  };

  const recordInitialCardAttempt = (
    scope: BtwOperationScope,
    btwOpId: string,
    outcome: BtwInitialCardAttemptOutcome,
  ): BtwOperation => withOperationMutation(scope, btwOpId, (operation, isoNow) => {
    if (operation.execution.state !== 'card_pending') {
      throw new Error(`recordInitialCardAttempt requires card_pending state, got ${operation.execution.state}`);
    }
    const nextAttempt = operation.card.createAttempt + 1;
    const firstPossiblySentAt = outcome.kind === 'unknown'
      ? (operation.card.firstPossiblySentAt ?? isoNow)
      : operation.card.firstPossiblySentAt;
    const deadline = currentCreateRetryDeadline({
      ...operation.card,
      ...(firstPossiblySentAt !== undefined ? { firstPossiblySentAt } : {}),
    });
    const retryAt = clampRetryAt(outcome.retryAt, deadline);

    if (
      outcome.kind === 'definitely_unsent'
      && nextAttempt >= MAX_INITIAL_CARD_CREATE_ATTEMPTS
    ) {
      const next = evolveOperation(operation, isoNow, {
        card: {
          ...operation.card,
          createAttempt: nextAttempt,
          nextCreateAttemptAt: undefined,
        },
        execution: {
          ...operation.execution,
          state: 'card_unknown',
          errorCode: 'initial_card_retry_exhausted',
          message: outcome.message,
        },
      });
      return { operation: next, result: next, changed: true };
    }

    if (deadline !== undefined && Date.parse(isoNow) >= Date.parse(deadline)) {
      const next = evolveOperation(operation, isoNow, {
        card: {
          ...operation.card,
          createAttempt: nextAttempt,
          nextCreateAttemptAt: undefined,
          ...(firstPossiblySentAt !== undefined
            ? { firstPossiblySentAt }
            : {}),
          createRetryDeadline: deadline,
        },
        execution: {
          ...operation.execution,
          state: 'card_unknown',
          errorCode: outcome.errorCode,
          message: outcome.message,
        },
      });
      return { operation: next, result: next, changed: true };
    }

    const next = evolveOperation(operation, isoNow, {
      card: stripUndefinedObjectKeys({
        ...operation.card,
        createAttempt: nextAttempt,
        nextCreateAttemptAt: retryAt,
        ...(firstPossiblySentAt !== undefined ? { firstPossiblySentAt } : {}),
        ...(deadline !== undefined ? { createRetryDeadline: deadline } : {}),
      }),
      execution: stripUndefinedObjectKeys({
        ...operation.execution,
        errorCode: undefined,
        message: undefined,
      }),
    });
    return { operation: next, result: next, changed: true };
  });

  const listPendingBtwProjections = (larkAppId: string): BtwProjectionItem[] =>
    listAllOperations(options.dataDir)
      .filter((operation) => operation.replyTarget.larkAppId === larkAppId)
      .map((operation) => pendingProjectionForOperation(operation, now()))
      .filter((item): item is BtwProjectionItem => item !== undefined)
      .sort(compareProjectionItemsForListing);

  const recordBtwProjectionFailure = (
    scope: BtwOperationScope,
    btwOpId: string,
    expected: { operationRevision: number; projectionRevision: number },
    failure: BtwProjectionFailure,
  ): { kind: 'applied' | 'stale'; operation: BtwOperation } => withOperationMutation<{ kind: 'applied' | 'stale'; operation: BtwOperation }>(scope, btwOpId, (operation, isoNow) => {
    if (!matchesProjectionCas(operation, expected)) {
      return { operation, result: { kind: 'stale', operation }, changed: false };
    }
    if (!isContentProjectionPending(operation)) {
      throw new Error('recordBtwProjectionFailure requires a pending content projection');
    }
    if (failure.kind === 'visible_fallback') {
      const next = evolveVisibleOperation(operation, isoNow, {
        projection: {
          ...operation.projection,
          deliveryFailure: {
            kind: 'visible_fallback',
            errorCode: failure.errorCode,
            message: failure.message,
          },
        },
      });
      return { operation: next, result: { kind: 'applied', operation: next }, changed: true };
    }
    const next = evolveOperation(operation, isoNow, {
      projection: {
        ...operation.projection,
        blockedRevision: operation.projection.desiredRevision,
        nextAttemptAt: undefined,
        deliveryFailure: {
          kind: 'provider_permanent',
          errorCode: failure.errorCode,
          message: failure.message,
        },
      },
    });
    return { operation: next, result: { kind: 'applied', operation: next }, changed: true };
  });

  const ackBtwProjection = (
    scope: BtwOperationScope,
    btwOpId: string,
    expected: { operationRevision: number; projectionRevision: number },
    outcome: BtwProjectionProviderOutcome,
  ): { kind: 'applied' | 'stale'; operation: BtwOperation } => withOperationMutation<{ kind: 'applied' | 'stale'; operation: BtwOperation }>(scope, btwOpId, (operation, isoNow) => {
    if (!matchesProjectionCas(operation, expected)) {
      return { operation, result: { kind: 'stale', operation }, changed: false };
    }

    if (outcome.kind === 'patched') {
      if (operation.projection.patchedRevision === operation.projection.desiredRevision) {
        return { operation, result: { kind: 'applied', operation }, changed: false };
      }
      if (!isContentProjectionPending(operation)) {
        throw new Error('patched acknowledgement requires a pending content projection');
      }
      if (
        operation.card.replacementState === 'pending'
        && operation.card.replacementForRevision === operation.projection.desiredRevision
      ) {
        throw new Error('patched acknowledgement cannot advance a replacement-pending projection');
      }
      const next = evolveOperation(operation, isoNow, {
        projection: {
          ...operation.projection,
          patchedRevision: operation.projection.desiredRevision,
          blockedRevision: undefined,
          nextAttemptAt: undefined,
          deliveryFailure: undefined,
          reminderState: 'pending',
          reminderAttempt: 0,
          reminderNextAttemptAt: undefined,
        },
      });
      return { operation: next, result: { kind: 'applied', operation: next }, changed: true };
    }

    if (outcome.kind === 'withdrawn') {
      if (
        operation.card.replacementState === 'pending'
        && operation.card.replacementForRevision === operation.projection.desiredRevision
      ) {
        return { operation, result: { kind: 'applied', operation }, changed: false };
      }
      if (!isContentProjectionPending(operation)) {
        throw new Error('withdrawn acknowledgement requires a pending content projection');
      }
      const next = evolveOperation(operation, isoNow, {
        card: {
          ...operation.card,
          replacementState: 'pending',
          replacementForRevision: operation.projection.desiredRevision,
          replacementMessageId: undefined,
        },
      });
      return { operation: next, result: { kind: 'applied', operation: next }, changed: true };
    }

    if (outcome.kind === 'replacement_created') {
      if (
        operation.card.replacementState === 'created'
        && operation.card.replacementForRevision === operation.projection.desiredRevision
        && operation.card.replacementMessageId === outcome.messageId
        && operation.projection.patchedRevision === operation.projection.desiredRevision
      ) {
        return { operation, result: { kind: 'applied', operation }, changed: false };
      }
      if (!(
        operation.card.replacementState === 'pending'
        && operation.card.replacementForRevision === operation.projection.desiredRevision
      )) {
        throw new Error('replacement_created acknowledgement requires a pending replacement intent');
      }
      const next = evolveOperation(operation, isoNow, {
        card: {
          ...operation.card,
          replacementState: 'created',
          replacementForRevision: operation.projection.desiredRevision,
          replacementMessageId: outcome.messageId,
        },
        projection: {
          ...operation.projection,
          patchedRevision: operation.projection.desiredRevision,
          blockedRevision: undefined,
          nextAttemptAt: undefined,
          deliveryFailure: undefined,
          reminderState: 'pending',
          reminderAttempt: 0,
          reminderNextAttemptAt: undefined,
        },
      });
      return { operation: next, result: { kind: 'applied', operation: next }, changed: true };
    }

    if (outcome.kind === 'retryable_failure') {
      if (isReminderProjectionPending(operation)) {
        const next = evolveOperation(operation, isoNow, {
          projection: {
            ...operation.projection,
            reminderState: 'pending',
            reminderAttempt: operation.projection.reminderAttempt + 1,
            reminderNextAttemptAt: outcome.retryAt,
          },
        });
        return { operation: next, result: { kind: 'applied', operation: next }, changed: true };
      }
      if (!isContentProjectionPending(operation)) {
        throw new Error('retryable_failure acknowledgement requires a pending projection');
      }
      const next = evolveOperation(operation, isoNow, {
        projection: {
          ...operation.projection,
          retryAttempt: operation.projection.retryAttempt + 1,
          nextAttemptAt: outcome.retryAt,
        },
      });
      return { operation: next, result: { kind: 'applied', operation: next }, changed: true };
    }

    if (outcome.kind === 'reminder_sent') {
      if (operation.projection.reminderState === 'sent') {
        return { operation, result: { kind: 'applied', operation }, changed: false };
      }
      if (!isReminderPhase(operation)) {
        throw new Error('reminder_sent acknowledgement requires a pending reminder');
      }
      const next = evolveOperation(operation, isoNow, {
        projection: {
          ...operation.projection,
          reminderState: 'sent',
          reminderAttempt: operation.projection.reminderAttempt + 1,
          reminderNextAttemptAt: undefined,
        },
      });
      return { operation: next, result: { kind: 'applied', operation: next }, changed: true };
    }

    if (outcome.kind === 'reminder_definitely_unsent') {
      if (!isReminderPhase(operation)) {
        throw new Error('reminder_definitely_unsent acknowledgement requires a pending reminder');
      }
      const next = evolveOperation(operation, isoNow, {
        projection: {
          ...operation.projection,
          reminderState: 'pending',
          reminderAttempt: operation.projection.reminderAttempt + 1,
          reminderNextAttemptAt: outcome.retryAt,
        },
      });
      return { operation: next, result: { kind: 'applied', operation: next }, changed: true };
    }

    if (outcome.kind === 'reminder_unknown') {
      if (operation.projection.reminderState === 'unknown') {
        return { operation, result: { kind: 'applied', operation }, changed: false };
      }
      if (!isReminderPhase(operation)) {
        throw new Error('reminder_unknown acknowledgement requires a pending reminder');
      }
      const next = evolveOperation(operation, isoNow, {
        projection: {
          ...operation.projection,
          reminderState: 'unknown',
          reminderAttempt: operation.projection.reminderAttempt + 1,
          reminderNextAttemptAt: undefined,
        },
      });
      return { operation: next, result: { kind: 'applied', operation: next }, changed: true };
    }

    return { operation, result: { kind: 'applied', operation }, changed: false };
  });

  const reconcileBtwOperations = (input: {
    runtimeEpoch: string;
    liveSessionIds: ReadonlySet<string>;
  }): BtwOperation[] => {
    const changed: BtwOperation[] = [];
    for (const operation of listAllOperations(options.dataDir)) {
      const currentEpoch = operation.execution.submissionEpoch ?? operation.parent.runtimeEpoch;
      const sessionLive = input.liveSessionIds.has(operation.parent.botmuxSessionId);
      const sameEpoch = currentEpoch === input.runtimeEpoch;
      let nextState: BtwOperation['execution']['state'] | undefined;
      if (operation.execution.state === 'accepted' && (!sessionLive || operation.parent.runtimeEpoch !== input.runtimeEpoch)) {
        nextState = 'interrupted';
      } else if (operation.execution.state === 'running' && (!sessionLive || !sameEpoch)) {
        nextState = 'interrupted';
      } else if (operation.execution.state === 'submit_prepared' && (!sessionLive || !sameEpoch)) {
        nextState = 'submission_unknown';
      }
      if (!nextState) continue;
      const updated = withOperationMutation(
        {
          larkAppId: operation.replyTarget.larkAppId,
          botmuxSessionId: operation.parent.botmuxSessionId,
        },
        operation.btwOpId,
        (fresh, isoNow) => {
          const freshEpoch = fresh.execution.submissionEpoch ?? fresh.parent.runtimeEpoch;
          const freshSessionLive = input.liveSessionIds.has(fresh.parent.botmuxSessionId);
          const freshSameEpoch = freshEpoch === input.runtimeEpoch;
          if (fresh.execution.state === 'accepted' && (!freshSessionLive || fresh.parent.runtimeEpoch !== input.runtimeEpoch)) {
            const next = evolveVisibleOperation(fresh, isoNow, {
              execution: {
                ...fresh.execution,
                state: 'interrupted',
                message: fresh.execution.message ?? 'runtime no longer owns accepted btw operation',
              },
            });
            return { operation: next, result: next, changed: true };
          }
          if (fresh.execution.state === 'running' && (!freshSessionLive || !freshSameEpoch)) {
            const next = evolveVisibleOperation(fresh, isoNow, {
              execution: {
                ...fresh.execution,
                state: 'interrupted',
                message: fresh.execution.message ?? 'runtime lost before btw terminal persisted',
              },
            });
            return { operation: next, result: next, changed: true };
          }
          if (fresh.execution.state === 'submit_prepared' && (!freshSessionLive || !freshSameEpoch)) {
            const next = evolveVisibleOperation(fresh, isoNow, {
              execution: {
                ...fresh.execution,
                state: 'submission_unknown',
                message: fresh.execution.message ?? 'runtime lost after btw submission may have been sent',
              },
            });
            return { operation: next, result: next, changed: true };
          }
          return { operation: fresh, result: fresh, changed: false };
        },
      );
      if (updated.revision !== operation.revision || updated.updatedAt !== operation.updatedAt) {
        changed.push(updated);
      }
    }
    return changed;
  };

  const notImplemented = (name: string): never => {
    throw new Error(`${name} is not implemented in Task 2`);
  };

  return {
    pathFor,
    prepareBtw,
    getBtwOperation,
    listPendingInitialCards,
    nextBtwRetryAt,
    recordInitialCardAttempt,
    recordBtwCard,
    listExecutableBtwOperations,
    prepareBtwSubmission,
    recordBtwDefinitelyUnsent,
    recordBtwSubmissionUnknown,
    recordBtwRunning,
    recordBtwTerminal,
    listPendingBtwProjections,
    recordBtwProjectionFailure,
    ackBtwProjection,
    reconcileBtwOperations,
  };
}

function scopeFromInput(input: PrepareBtwInput): BtwOperationScope {
  return {
    larkAppId: input.replyTarget.larkAppId,
    botmuxSessionId: input.parent.botmuxSessionId,
  };
}

function scopeHash(scope: BtwOperationScope): string {
  return createHash('sha256')
    .update(scope.larkAppId)
    .update('\0')
    .update(scope.botmuxSessionId)
    .digest('hex');
}

function ensureParentDir(filePath: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
}

function poisonPathFor(recordPath: string): string {
  return `${recordPath}.poison.json`;
}

function quarantinePathFor(filePath: string, digest: string): string {
  const stem = basename(filePath).endsWith('.json')
    ? basename(filePath).slice(0, -'.json'.length)
    : basename(filePath);
  return join(dirname(filePath), `${stem}.corrupt.${digest}.json`);
}

function writeOperation(recordPath: string, operation: BtwOperation): void {
  assertLeafIsNotSymlink(recordPath);
  atomicWriteFileSync(recordPath, `${JSON.stringify(operation, null, 2)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

function writePoisonMarker(recordPath: string, marker: BtwOperationPoisonMarker): void {
  const poisonPath = poisonPathFor(recordPath);
  assertLeafIsNotSymlink(poisonPath);
  atomicWriteFileSync(poisonPath, `${JSON.stringify(marker, null, 2)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

function writeTerminalConflict(recordPath: string, diagnostic: BtwTerminalConflictDiagnostic): void {
  const conflictPath = `${recordPath.slice(0, -'.json'.length)}.terminal-conflict.${fullDigestOfString(JSON.stringify(diagnostic))}.json`;
  assertLeafIsNotSymlink(conflictPath);
  atomicWriteFileSync(conflictPath, `${JSON.stringify(diagnostic, null, 2)}\n`, {
    mode: 0o600,
    durable: true,
    followTargetSymlink: false,
  });
}

function scanAndHandleSiblingCorruption(
  recordPath: string,
  expectedBtwOpId: string,
  scope: BtwOperationScope,
): void {
  const dir = dirname(recordPath);
  if (!pathExistsNoFollow(dir)) return;
  const expectedFile = basename(recordPath);
  for (const name of readdirSync(dir)) {
    if (!isPrimaryRecordFile(name)) continue;
    const siblingPath = join(dir, name);
    try {
      readOperationRecord(siblingPath, {
        expectedPartitionHash: basename(dir),
      });
    } catch (error) {
      if (error instanceof BtwSymlinkRejectedError) {
        if (name === expectedFile) throw error;
        quarantineCorruptSibling(siblingPath, toParseError(siblingPath, error));
        continue;
      }
      if (name === expectedFile) {
        poisonExactRecord(recordPath, scope, expectedBtwOpId, toParseError(siblingPath, error));
      }
      quarantineCorruptSibling(siblingPath, toParseError(siblingPath, error));
    }
  }
}

function isPrimaryRecordFile(name: string): boolean {
  return name.endsWith('.json')
    && !name.endsWith('.poison.json')
    && !name.includes('.corrupt.')
    && !isTerminalConflictDiagnosticFile(name);
}

function assertNotPoisoned(recordPath: string, scope: BtwOperationScope, btwOpId: string): void {
  if (!pathExistsNoFollow(poisonPathFor(recordPath))) return;
  throw new BtwOperationPoisonedError(scope, btwOpId);
}

function poisonExactRecord(
  recordPath: string,
  scope: BtwOperationScope,
  btwOpId: string,
  error: BtwRecordParseError,
): never {
  if (pathExistsNoFollow(recordPath)) {
    const quarantinePath = quarantinePathFor(recordPath, error.digest);
    try {
      renameSync(recordPath, quarantinePath);
    } catch (renameError) {
      const code = (renameError as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'EEXIST') throw renameError;
    }
  }
  writePoisonMarker(recordPath, {
    schemaVersion: POISON_SCHEMA_VERSION,
    kind: 'btw_operation_poison',
    btwOpId,
    scope,
    reason: 'corrupt_exact_duplicate',
    sourceDigest: error.digest,
  });
  throw new BtwOperationPoisonedError(scope, btwOpId);
}

function quarantineCorruptSibling(filePath: string, error: BtwRecordParseError): void {
  const quarantinePath = quarantinePathFor(filePath, error.digest);
  if (!pathExistsNoFollow(filePath)) return;
  try {
    renameSync(filePath, quarantinePath);
  } catch (renameError) {
    const code = (renameError as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'EEXIST') throw renameError;
  }
}

function listAllOperations(dataDir: string): BtwOperation[] {
  const root = join(dataDir, 'btw', 'operations');
  if (!pathExistsNoFollow(root)) return [];
  const operations: BtwOperation[] = [];
  for (const partitionName of readdirSync(root)) {
    const partitionPath = join(root, partitionName);
    let partitionStat: ReturnType<typeof lstatSync>;
    try {
      partitionStat = lstatSync(partitionPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    if (!partitionStat.isDirectory() || partitionStat.isSymbolicLink()) continue;
    for (const name of readdirSync(partitionPath)) {
      if (!isPrimaryRecordFile(name)) continue;
      const recordPath = join(partitionPath, name);
      const operation = withFileLockSync(recordPath, () => {
        try {
          return readOperationRecord(recordPath, {
            expectedPartitionHash: partitionName,
          });
        } catch (error) {
          if (error instanceof BtwSymlinkRejectedError) {
            quarantineCorruptSibling(recordPath, toParseError(recordPath, error));
            return undefined;
          }
          quarantineCorruptSibling(recordPath, toParseError(recordPath, error));
          return undefined;
        }
      });
      if (operation) operations.push(operation);
    }
  }
  return operations;
}

function toParseError(filePath: string, error: unknown): BtwRecordParseError {
  if (error instanceof BtwRecordParseError) return error;
  return new BtwRecordParseError(
    error instanceof Error ? error.message : String(error),
    digestOfString(`${filePath}\0${error instanceof Error ? error.message : String(error)}`),
  );
}

function readOperationRecord(
  recordPath: string,
  opts: {
    expectedScope?: BtwOperationScope;
    expectedBtwOpId?: string;
    expectedRequestId?: string;
    expectedPartitionHash?: string;
  } = {},
): BtwOperation {
  assertLeafIsNotSymlink(recordPath);
  const raw = readFileSync(recordPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BtwRecordParseError(
      `btw operation json invalid: ${error instanceof Error ? error.message : String(error)}`,
      digestOfString(raw),
    );
  }
  try {
    return parseBtwOperation(parsed, {
      sourceDigest: digestOfString(raw),
      expectedScope: opts.expectedScope,
      expectedBtwOpId: opts.expectedBtwOpId,
      expectedRequestId: opts.expectedRequestId,
      expectedPartitionHash: opts.expectedPartitionHash,
    });
  } catch (error) {
    if (error instanceof BtwRecordParseError) throw error;
    throw new BtwRecordParseError(
      error instanceof Error ? error.message : String(error),
      digestOfString(raw),
    );
  }
}

function createPreparedOperation(
  input: PrepareBtwInput,
  scope: BtwOperationScope,
  isoNow: string,
): BtwOperation {
  const ids = deriveBtwIdentifiers(scope, input.requestId);
  return {
    schemaVersion: OPERATION_SCHEMA_VERSION,
    revision: 1,
    btwOpId: ids.btwOpId,
    requestId: input.requestId,
    question: input.question,
    parent: {
      ...input.parent,
    },
    replyTarget: {
      ...input.replyTarget,
    },
    card: {
      createUuid: ids.createUuid,
      createAttempt: 0,
      replacementUuid: ids.replacementUuid,
      replacementState: 'none',
    },
    execution: {
      state: 'card_pending',
      nativeTurnId: ids.nativeTurnId,
      attempt: 0,
      frameState: 'not_started',
    },
    projection: {
      desiredRevision: 1,
      patchedRevision: 0,
      retryAttempt: 0,
      reminderUuid: ids.reminderUuid,
      reminderState: 'none',
      reminderAttempt: 0,
    },
    createdAt: isoNow,
    updatedAt: isoNow,
  };
}

function evolveOperation(
  operation: BtwOperation,
  isoNow: string,
  patch: Partial<Pick<BtwOperation, 'card' | 'execution' | 'projection'>>,
): BtwOperation {
  return freezeDeep({
    ...operation,
    ...(patch.card ? { card: patch.card } : {}),
    ...(patch.execution ? { execution: stripUndefinedObjectKeys(patch.execution) } : {}),
    ...(patch.projection ? { projection: stripUndefinedObjectKeys(patch.projection) } : {}),
    revision: operation.revision + 1,
    updatedAt: isoNow,
  });
}

function evolveVisibleOperation(
  operation: BtwOperation,
  isoNow: string,
  patch: Partial<Pick<BtwOperation, 'card' | 'execution' | 'projection'>>,
): BtwOperation {
  const projection: BtwOperation['projection'] = {
    ...operation.projection,
    retryAttempt: 0,
    nextAttemptAt: undefined,
    blockedRevision: undefined,
    deliveryFailure: undefined,
    reminderState: 'none',
    reminderAttempt: 0,
    reminderNextAttemptAt: undefined,
    ...(patch.projection ?? {}),
  };
  return evolveOperation(operation, isoNow, {
    ...patch,
    projection: {
      ...projection,
      desiredRevision: operation.projection.desiredRevision + 1,
    },
  });
}

function stripUndefinedObjectKeys<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function ambiguityDeadlineFrom(firstPossiblySentAt: string): string {
  return new Date(Date.parse(firstPossiblySentAt) + CREATE_AMBIGUITY_DEADLINE_MS).toISOString();
}

function currentCreateRetryDeadline(
  card: BtwOperation['card'],
): string | undefined {
  if (card.createRetryDeadline !== undefined) return card.createRetryDeadline;
  if (card.firstPossiblySentAt !== undefined) return ambiguityDeadlineFrom(card.firstPossiblySentAt);
  return undefined;
}

function clampRetryAt(retryAt: string, deadline?: string): string {
  if (Number.isNaN(Date.parse(retryAt))) {
    throw new Error(`retryAt must be an ISO timestamp: ${retryAt}`);
  }
  if (deadline === undefined) return retryAt;
  return Date.parse(retryAt) <= Date.parse(deadline) ? retryAt : deadline;
}

function isRetryDue(retryAt: string | undefined, current: Date): boolean {
  return retryAt === undefined || Date.parse(retryAt) <= current.getTime();
}

function compareOperationsForListing(left: BtwOperation, right: BtwOperation): number {
  return left.createdAt.localeCompare(right.createdAt)
    || left.btwOpId.localeCompare(right.btwOpId);
}

function compareProjectionItemsForListing(left: BtwProjectionItem, right: BtwProjectionItem): number {
  return compareOperationsForListing(left.operation, right.operation)
    || left.projectionRevision - right.projectionRevision;
}

function matchesProjectionCas(
  operation: BtwOperation,
  expected: { operationRevision: number; projectionRevision: number },
): boolean {
  return operation.revision === expected.operationRevision
    && operation.projection.desiredRevision === expected.projectionRevision;
}

function hasVisibleCard(operation: BtwOperation): boolean {
  return operation.card.messageId !== undefined;
}

function isContentProjectionPending(operation: BtwOperation): boolean {
  return hasVisibleCard(operation)
    && operation.projection.desiredRevision > 1
    && operation.projection.desiredRevision > operation.projection.patchedRevision
    && operation.projection.blockedRevision !== operation.projection.desiredRevision;
}

function isReminderPhase(operation: BtwOperation): boolean {
  return operation.projection.desiredRevision > 1
    && operation.projection.patchedRevision === operation.projection.desiredRevision
    && operation.projection.reminderState === 'pending';
}

function isReminderProjectionPending(operation: BtwOperation): boolean {
  return isReminderPhase(operation);
}

function pendingProjectionForOperation(
  operation: BtwOperation,
  current: Date,
): BtwProjectionItem | undefined {
  if (isContentProjectionPending(operation) && isRetryDue(operation.projection.nextAttemptAt, current)) {
    return {
      larkAppId: operation.replyTarget.larkAppId,
      botmuxSessionId: operation.parent.botmuxSessionId,
      btwOpId: operation.btwOpId,
      expectedOperationRevision: operation.revision,
      projectionRevision: operation.projection.desiredRevision,
      operation,
    };
  }
  if (isReminderPhase(operation) && isRetryDue(operation.projection.reminderNextAttemptAt, current)) {
    return {
      larkAppId: operation.replyTarget.larkAppId,
      botmuxSessionId: operation.parent.botmuxSessionId,
      btwOpId: operation.btwOpId,
      expectedOperationRevision: operation.revision,
      projectionRevision: operation.projection.desiredRevision,
      operation,
    };
  }
  return undefined;
}

function isTerminalExecutionState(state: BtwOperation['execution']['state']): boolean {
  return TERMINAL_STATES.has(state as (typeof TERMINAL_STATES extends Set<infer T> ? T : never));
}

function terminalMatchesExecution(
  execution: BtwOperation['execution'],
  terminal: BtwTerminalOutcome,
): boolean {
  if (execution.state !== terminal.status) return false;
  switch (terminal.status) {
    case 'completed':
      return execution.answer === terminal.answer;
    case 'failed':
      return execution.errorCode === terminal.errorCode
        && execution.message === terminal.message;
    case 'cancelled':
    case 'interrupted':
      return execution.message === terminal.message;
  }
}

function terminalToExecution(
  current: BtwOperation['execution'],
  terminal: BtwTerminalOutcome,
): BtwOperation['execution'] {
  switch (terminal.status) {
    case 'completed':
      return stripUndefinedObjectKeys({
        ...current,
        state: 'completed',
        answer: terminal.answer,
        errorCode: undefined,
        message: undefined,
      });
    case 'failed':
      return stripUndefinedObjectKeys({
        ...current,
        state: 'failed',
        answer: undefined,
        errorCode: terminal.errorCode,
        message: terminal.message,
      });
    case 'cancelled':
      return stripUndefinedObjectKeys({
        ...current,
        state: 'cancelled',
        answer: undefined,
        errorCode: undefined,
        message: terminal.message,
      });
    case 'interrupted':
      return stripUndefinedObjectKeys({
        ...current,
        state: 'interrupted',
        answer: undefined,
        errorCode: undefined,
        message: terminal.message,
      });
  }
}

function parseBtwOperation(
  value: unknown,
  opts: {
    sourceDigest: string;
    expectedScope?: BtwOperationScope;
    expectedBtwOpId?: string;
    expectedRequestId?: string;
    expectedPartitionHash?: string;
  },
): BtwOperation {
  const root = exactRecord(value, [
    'schemaVersion',
    'revision',
    'btwOpId',
    'requestId',
    'question',
    'parent',
    'replyTarget',
    'card',
    'execution',
    'projection',
    'createdAt',
    'updatedAt',
  ], 'btw operation');
  const parent = parseParent(root.parent);
  const replyTarget = parseReplyTarget(root.replyTarget);
  const card = parseCard(root.card);
  const execution = parseExecution(root.execution);
  const projection = parseProjection(root.projection);
  const scope: BtwOperationScope = {
    larkAppId: replyTarget.larkAppId,
    botmuxSessionId: parent.botmuxSessionId,
  };
  const derived = deriveBtwIdentifiers(scope, requiredString(root.requestId, 'requestId'));
  const operation: BtwOperation = {
    schemaVersion: exactLiteralNumber(root.schemaVersion, OPERATION_SCHEMA_VERSION, 'schemaVersion'),
    revision: positiveInteger(root.revision, 'revision'),
    btwOpId: requiredString(root.btwOpId, 'btwOpId'),
    requestId: requiredString(root.requestId, 'requestId'),
    question: requiredString(root.question, 'question'),
    parent,
    replyTarget,
    card,
    execution,
    projection,
    createdAt: isoTimestamp(root.createdAt, 'createdAt'),
    updatedAt: isoTimestamp(root.updatedAt, 'updatedAt'),
  };
  if (operation.btwOpId !== derived.btwOpId) {
    throw new Error('btwOpId does not match derived identity');
  }
  if (operation.card.createUuid !== derived.createUuid) {
    throw new Error('createUuid does not match derived identity');
  }
  if (operation.card.replacementUuid !== derived.replacementUuid) {
    throw new Error('replacementUuid does not match derived identity');
  }
  if (operation.execution.nativeTurnId !== derived.nativeTurnId) {
    throw new Error('nativeTurnId does not match derived identity');
  }
  if (operation.projection.reminderUuid !== derived.reminderUuid) {
    throw new Error('reminderUuid does not match derived identity');
  }
  if (opts.expectedScope && (
    operation.replyTarget.larkAppId !== opts.expectedScope.larkAppId
    || operation.parent.botmuxSessionId !== opts.expectedScope.botmuxSessionId
  )) {
    throw new Error('btw operation scope mismatch');
  }
  if (opts.expectedBtwOpId && operation.btwOpId !== opts.expectedBtwOpId) {
    throw new Error('btw operation id mismatch');
  }
  if (opts.expectedRequestId && operation.requestId !== opts.expectedRequestId) {
    throw new Error('btw operation request id mismatch');
  }
  if (opts.expectedPartitionHash && scopeHash(scope) !== opts.expectedPartitionHash) {
    throw new Error('btw operation partition hash mismatch');
  }
  return freezeDeep(operation);
}

function parseParent(value: unknown): BtwOperation['parent'] {
  const record = exactRecord(value, [
    'botmuxSessionId',
    'cliId',
    'nativeThreadId',
    'runtimeEpoch',
    'configHash',
    'cwd',
  ], 'btw parent');
  return {
    botmuxSessionId: requiredString(record.botmuxSessionId, 'parent.botmuxSessionId'),
    cliId: requiredString(record.cliId, 'parent.cliId'),
    nativeThreadId: requiredString(record.nativeThreadId, 'parent.nativeThreadId'),
    runtimeEpoch: requiredString(record.runtimeEpoch, 'parent.runtimeEpoch'),
    configHash: requiredString(record.configHash, 'parent.configHash'),
    cwd: requiredString(record.cwd, 'parent.cwd'),
  };
}

function parseReplyTarget(value: unknown): BtwOperation['replyTarget'] {
  const record = exactRecord(value, [
    'larkAppId',
    'chatId',
    'rootMessageId',
    'replyToMessageId',
    'chatType',
    'brand',
  ], 'btw replyTarget');
  return {
    larkAppId: requiredString(record.larkAppId, 'replyTarget.larkAppId'),
    chatId: requiredString(record.chatId, 'replyTarget.chatId'),
    rootMessageId: nullableString(record.rootMessageId, 'replyTarget.rootMessageId'),
    replyToMessageId: nullableString(record.replyToMessageId, 'replyTarget.replyToMessageId'),
    chatType: stringEnum(record.chatType, CHAT_TYPES, 'replyTarget.chatType'),
    brand: stringEnum(record.brand, BRANDS, 'replyTarget.brand'),
  };
}

function parseCard(value: unknown): BtwOperation['card'] {
  const record = exactRecord(value, [
    'createUuid',
    'messageId',
    'createAttempt',
    'nextCreateAttemptAt',
    'firstPossiblySentAt',
    'createRetryDeadline',
    'replacementUuid',
    'replacementState',
    'replacementForRevision',
    'replacementMessageId',
  ], 'btw card');
  return {
    createUuid: requiredString(record.createUuid, 'card.createUuid'),
    ...(optionalString(record.messageId, 'card.messageId') !== undefined
      ? { messageId: optionalString(record.messageId, 'card.messageId') }
      : {}),
    createAttempt: nonNegativeInteger(record.createAttempt, 'card.createAttempt'),
    ...(optionalIsoTimestamp(record.nextCreateAttemptAt, 'card.nextCreateAttemptAt') !== undefined
      ? { nextCreateAttemptAt: optionalIsoTimestamp(record.nextCreateAttemptAt, 'card.nextCreateAttemptAt') }
      : {}),
    ...(optionalIsoTimestamp(record.firstPossiblySentAt, 'card.firstPossiblySentAt') !== undefined
      ? { firstPossiblySentAt: optionalIsoTimestamp(record.firstPossiblySentAt, 'card.firstPossiblySentAt') }
      : {}),
    ...(optionalIsoTimestamp(record.createRetryDeadline, 'card.createRetryDeadline') !== undefined
      ? { createRetryDeadline: optionalIsoTimestamp(record.createRetryDeadline, 'card.createRetryDeadline') }
      : {}),
    replacementUuid: requiredString(record.replacementUuid, 'card.replacementUuid'),
    replacementState: stringEnum(record.replacementState, REPLACEMENT_STATES, 'card.replacementState'),
    ...(optionalPositiveInteger(record.replacementForRevision, 'card.replacementForRevision') !== undefined
      ? { replacementForRevision: optionalPositiveInteger(record.replacementForRevision, 'card.replacementForRevision') }
      : {}),
    ...(optionalString(record.replacementMessageId, 'card.replacementMessageId') !== undefined
      ? { replacementMessageId: optionalString(record.replacementMessageId, 'card.replacementMessageId') }
      : {}),
  };
}

function parseExecution(value: unknown): BtwOperation['execution'] {
  const record = exactRecord(value, [
    'state',
    'nativeTurnId',
    'attempt',
    'submissionEpoch',
    'frameState',
    'answer',
    'errorCode',
    'message',
  ], 'btw execution');
  return {
    state: stringEnum(record.state, OPERATION_STATES, 'execution.state'),
    nativeTurnId: requiredString(record.nativeTurnId, 'execution.nativeTurnId'),
    attempt: nonNegativeInteger(record.attempt, 'execution.attempt'),
    ...(optionalString(record.submissionEpoch, 'execution.submissionEpoch') !== undefined
      ? { submissionEpoch: optionalString(record.submissionEpoch, 'execution.submissionEpoch') }
      : {}),
    frameState: stringEnum(record.frameState, FRAME_STATES, 'execution.frameState'),
    ...(optionalString(record.answer, 'execution.answer') !== undefined
      ? { answer: optionalString(record.answer, 'execution.answer') }
      : {}),
    ...(optionalString(record.errorCode, 'execution.errorCode') !== undefined
      ? { errorCode: optionalString(record.errorCode, 'execution.errorCode') }
      : {}),
    ...(optionalString(record.message, 'execution.message') !== undefined
      ? { message: optionalString(record.message, 'execution.message') }
      : {}),
  };
}

function parseProjection(value: unknown): BtwOperation['projection'] {
  const record = exactRecord(value, [
    'desiredRevision',
    'patchedRevision',
    'blockedRevision',
    'retryAttempt',
    'nextAttemptAt',
    'deliveryFailure',
    'reminderUuid',
    'reminderState',
    'reminderAttempt',
    'reminderNextAttemptAt',
  ], 'btw projection');
  return {
    desiredRevision: positiveInteger(record.desiredRevision, 'projection.desiredRevision'),
    patchedRevision: nonNegativeInteger(record.patchedRevision, 'projection.patchedRevision'),
    ...(optionalPositiveInteger(record.blockedRevision, 'projection.blockedRevision') !== undefined
      ? { blockedRevision: optionalPositiveInteger(record.blockedRevision, 'projection.blockedRevision') }
      : {}),
    retryAttempt: nonNegativeInteger(record.retryAttempt, 'projection.retryAttempt'),
    ...(optionalIsoTimestamp(record.nextAttemptAt, 'projection.nextAttemptAt') !== undefined
      ? { nextAttemptAt: optionalIsoTimestamp(record.nextAttemptAt, 'projection.nextAttemptAt') }
      : {}),
    ...(record.deliveryFailure !== undefined
      ? { deliveryFailure: parseDeliveryFailure(record.deliveryFailure) }
      : {}),
    reminderUuid: requiredString(record.reminderUuid, 'projection.reminderUuid'),
    reminderState: stringEnum(record.reminderState, REMINDER_STATES, 'projection.reminderState'),
    reminderAttempt: nonNegativeInteger(record.reminderAttempt, 'projection.reminderAttempt'),
    ...(optionalIsoTimestamp(record.reminderNextAttemptAt, 'projection.reminderNextAttemptAt') !== undefined
      ? { reminderNextAttemptAt: optionalIsoTimestamp(record.reminderNextAttemptAt, 'projection.reminderNextAttemptAt') }
      : {}),
  };
}

function parseDeliveryFailure(value: unknown): NonNullable<BtwOperation['projection']['deliveryFailure']> {
  const record = exactRecord(value, [
    'kind',
    'errorCode',
    'message',
  ], 'btw deliveryFailure');
  return {
    kind: stringEnum(record.kind, DELIVERY_FAILURE_KINDS, 'projection.deliveryFailure.kind'),
    errorCode: requiredString(record.errorCode, 'projection.deliveryFailure.errorCode'),
    message: requiredString(record.message, 'projection.deliveryFailure.message'),
  };
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const allowed = new Set(allowedKeys);
  if (actualKeys.some((key) => !allowed.has(key))) {
    throw new Error(`${label} has unexpected keys`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return positiveInteger(value, label);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function exactLiteralNumber<const T extends number>(value: unknown, expected: T, label: string): T {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
  return expected;
}

function isoTimestamp(value: unknown, label: string): string {
  const str = requiredString(value, label);
  if (Number.isNaN(Date.parse(str))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
  return str;
}

function optionalIsoTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return isoTimestamp(value, label);
}

function stringEnum<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string,
): T {
  const str = requiredString(value, label);
  if (!allowed.has(str as T)) {
    throw new Error(`${label} must be one of: ${[...allowed].join(', ')}`);
  }
  return str as T;
}

function assertLeafIsNotSymlink(filePath: string): void {
  try {
    if (lstatSync(filePath).isSymbolicLink()) throw new BtwSymlinkRejectedError();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

function pathExistsNoFollow(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function assertValidBtwOpId(btwOpId: string): void {
  if (!isValidBtwOpId(btwOpId)) {
    throw new Error(`invalid btwOpId: ${btwOpId}`);
  }
}

function isValidBtwOpId(btwOpId: string): boolean {
  return /^[a-z][a-z0-9-]*_[0-9a-f]+$/.test(btwOpId);
}

function isTerminalConflictDiagnosticFile(name: string): boolean {
  const match = /^(?<btwOpId>.+)\.terminal-conflict\.(?<digest>[0-9a-f]{24}|[0-9a-f]{64})\.json$/.exec(name);
  if (!match?.groups) return false;
  return isValidBtwOpId(match.groups.btwOpId);
}

function digestOfString(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function fullDigestOfString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      freezeDeep(child);
    }
  }
  return value;
}

void MAX_INITIAL_CARD_CREATE_ATTEMPTS;
