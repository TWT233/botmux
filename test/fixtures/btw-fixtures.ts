import type { BtwCapabilities } from '../../src/adapters/cli/btw.js';
import { deriveBtwIdentifiers, type BtwOperation, type BtwOperationScope, type FrozenBtwParent, type FrozenBtwReplyTarget, type PrepareBtwInput } from '../../src/features/btw/types.js';

const FIXED_REQUEST_ID = 'om_request_1';
const FIXED_QUESTION = 'What changed in the upstream delivery path?';
const FIXED_CREATED_AT = '2026-09-01T00:00:00.000Z';

export function makeBtwScope(): BtwOperationScope {
  return {
    larkAppId: 'cli_app',
    botmuxSessionId: 'btw_session_1',
  };
}

export function makeBtwParent(): FrozenBtwParent {
  return {
    botmuxSessionId: 'btw_session_1',
    cliId: 'traex',
    nativeThreadId: 'thread_parent_1',
    runtimeEpoch: 'runtime_epoch_1',
    configHash: `sha256:${'a'.repeat(64)}`,
    cwd: '/repo/botmux',
  };
}

export function makeBtwReplyTarget(): FrozenBtwReplyTarget {
  return {
    larkAppId: 'cli_app',
    chatId: 'oc_chat_1',
    rootMessageId: 'om_root_1',
    replyToMessageId: 'om_reply_1',
    chatType: 'group',
    brand: 'feishu',
  };
}

export function makeBtwPrepareInput(): PrepareBtwInput {
  return {
    requestId: FIXED_REQUEST_ID,
    question: FIXED_QUESTION,
    parent: makeBtwParent(),
    replyTarget: makeBtwReplyTarget(),
  };
}

export function makeBtwOperation(): BtwOperation {
  const scope = makeBtwScope();
  const input = makeBtwPrepareInput();
  const ids = deriveBtwIdentifiers(scope, input.requestId);

  return {
    schemaVersion: 1,
    revision: 1,
    btwOpId: ids.btwOpId,
    requestId: input.requestId,
    question: input.question,
    parent: input.parent,
    replyTarget: input.replyTarget,
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
    createdAt: FIXED_CREATED_AT,
    updatedAt: FIXED_CREATED_AT,
  };
}

const BOOLEAN_ROWS = [false, true] as const;

export const ALL_BTW_CAPABILITY_COMBINATIONS: Array<{
  capabilities: BtwCapabilities;
  managed: boolean;
}> = BOOLEAN_ROWS.flatMap(nativeBtw =>
  BOOLEAN_ROWS.flatMap(persistentRuntime =>
    BOOLEAN_ROWS.flatMap(structuredTerminal =>
      BOOLEAN_ROWS.map(stableParentThread => ({
        capabilities: {
          nativeBtw,
          persistentRuntime,
          structuredTerminal,
          stableParentThread,
        },
        managed:
          nativeBtw
          && persistentRuntime
          && structuredTerminal
          && stableParentThread,
      })),
    ),
  ),
);
