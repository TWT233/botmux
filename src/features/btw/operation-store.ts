import { createHash } from 'node:crypto';
import {
  existsSync,
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

interface BtwOperationPoisonMarker {
  schemaVersion: typeof POISON_SCHEMA_VERSION;
  kind: 'btw_operation_poison';
  btwOpId: string;
  scope: BtwOperationScope;
  reason: 'corrupt_exact_duplicate';
  sourceDigest: string;
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
      if (!existsSync(recordPath)) {
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
    const recordPath = pathFor(scope, btwOpId);
    if (!existsSync(recordPath) && !existsSync(poisonPathFor(recordPath))) return undefined;
    ensureParentDir(recordPath);
    return withFileLockSync(recordPath, () => {
      assertNotPoisoned(recordPath, scope, btwOpId);
      if (!existsSync(recordPath)) return undefined;
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

  const notImplemented = (name: string): never => {
    throw new Error(`${name} is not implemented in Task 2`);
  };

  return {
    pathFor,
    prepareBtw,
    getBtwOperation,
    listPendingInitialCards: () => notImplemented('listPendingInitialCards'),
    recordInitialCardAttempt: (_scope: BtwOperationScope, _btwOpId: string, _outcome: BtwInitialCardAttemptOutcome) =>
      notImplemented('recordInitialCardAttempt'),
    recordBtwCard: (_scope: BtwOperationScope, _btwOpId: string, _messageId: string) =>
      notImplemented('recordBtwCard'),
    listExecutableBtwOperations: (_runtimeEpoch: string) =>
      notImplemented('listExecutableBtwOperations'),
    prepareBtwSubmission: (_scope: BtwOperationScope, _btwOpId: string, _runtimeEpoch: string) =>
      notImplemented('prepareBtwSubmission'),
    recordBtwDefinitelyUnsent: (_scope: BtwOperationScope, _btwOpId: string, _runtimeEpoch: string) =>
      notImplemented('recordBtwDefinitelyUnsent'),
    recordBtwSubmissionUnknown: (_scope: BtwOperationScope, _btwOpId: string, _message: string) =>
      notImplemented('recordBtwSubmissionUnknown'),
    recordBtwRunning: (_scope: BtwOperationScope, _btwOpId: string, _nativeTurnId: string) =>
      notImplemented('recordBtwRunning'),
    recordBtwTerminal: (_scope: BtwOperationScope, _btwOpId: string, _terminal: BtwTerminalOutcome) =>
      notImplemented('recordBtwTerminal'),
    listPendingBtwProjections: (_larkAppId: string): BtwProjectionItem[] =>
      notImplemented('listPendingBtwProjections'),
    recordBtwProjectionFailure: (
      _scope: BtwOperationScope,
      _btwOpId: string,
      _expected: { operationRevision: number; projectionRevision: number },
      _failure: BtwProjectionFailure,
    ) => notImplemented('recordBtwProjectionFailure'),
    ackBtwProjection: (
      _scope: BtwOperationScope,
      _btwOpId: string,
      _expected: { operationRevision: number; projectionRevision: number },
      _outcome: BtwProjectionProviderOutcome,
    ) => notImplemented('ackBtwProjection'),
    reconcileBtwOperations: (_input: { runtimeEpoch: string; liveSessionIds: ReadonlySet<string> }) =>
      notImplemented('reconcileBtwOperations'),
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
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
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

function scanAndHandleSiblingCorruption(
  recordPath: string,
  expectedBtwOpId: string,
  scope: BtwOperationScope,
): void {
  const dir = dirname(recordPath);
  if (!existsSync(dir)) return;
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
  return name.endsWith('.json') && !name.endsWith('.poison.json') && !name.includes('.corrupt.');
}

function assertNotPoisoned(recordPath: string, scope: BtwOperationScope, btwOpId: string): void {
  if (!existsSync(poisonPathFor(recordPath))) return;
  throw new BtwOperationPoisonedError(scope, btwOpId);
}

function poisonExactRecord(
  recordPath: string,
  scope: BtwOperationScope,
  btwOpId: string,
  error: BtwRecordParseError,
): never {
  if (existsSync(recordPath)) {
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
  if (!existsSync(filePath)) return;
  try {
    renameSync(filePath, quarantinePath);
  } catch (renameError) {
    const code = (renameError as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'EEXIST') throw renameError;
  }
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
  if (!existsSync(filePath)) return;
  if (lstatSync(filePath).isSymbolicLink()) {
    throw new BtwSymlinkRejectedError();
  }
}

function digestOfString(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
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
