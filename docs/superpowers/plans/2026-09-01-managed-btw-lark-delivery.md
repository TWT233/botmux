# Managed `/btw` Lark Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver eligible Trae `/btw` answers to one independent, durable Lark card without changing the parent task lifecycle, and keep accepted native work alive across daemon/worker restart.

**Architecture:** A data-directory-scoped runtime becomes the sole owner of eligible Trae App Servers, their MCP/ask support, and BTW operation records; workers attach through a narrow authenticated proxy while daemons project durable revisions to Lark. A contributor-facing `BtwAdapter` hides native protocol details, and every session that does not satisfy the four-factor managed gate keeps a one-shot lifecycle-neutral legacy passthrough.

**Tech Stack:** TypeScript, Bun 1.4.0, Node.js, Vitest, Unix-domain sockets, JSON-RPC/WebSocket, durable JSON with atomic rename/fsync and file locks, Lark IM cards.

## Global Constraints

- The approved design in `docs/superpowers/specs/2026-09-01-managed-btw-lark-delivery-design.md` is authoritative; this first release is a BTW-specific reliability path, not a generic workflow engine, event bus, task scheduler, or arbitrary CLI RPC DSL.
- Managed execution is Trae-only and requires all four live facts to be true: `nativeBtw`, `persistentRuntime`, `structuredTerminal`, and `stableParentThread`; `cliId === 'traex'` alone is never sufficient.
- Existing sessions whose App Server was not created by the persistent runtime are never migrated in place; they remain legacy until a cold session generation owns the parent App Server through this runtime.
- Managed and legacy BTW must not call `beginNewTurn`, mutate `currentBotmuxTurnId` or dispatch attempt, replace the main reply target/turn marker/card, pin a card, change busy/idle/reaction/fallback state, change main timeout/cancellation, emit `final_output`, or reorder pending main input.
- Legacy behavior is fixed: write the original `/btw ...` exactly once to an available raw surface, immediately finish an independent warning saying `已转发到终端；答案只会出现在终端，不会回传飞书。`, and never leave that acknowledgement working. Empty `/btw` is usage-only; no raw surface is unsupported and executes nothing.
- Managed behavior is fixed: one operation creates one independent unpinned card with `旁问已接收`, terminal state PATCHes that same card with the complete answer/status, and one stable-UUID `旁问已完成` reminder follows a successful PATCH. No BTW delta is projected in this release.
- Acceptance order is strict: durable operation plus frozen target, then stable-UUID card creation plus durable `messageId`, then native submission. A repeated Lark request ID returns the original operation/card and never creates a second native turn.
- Native submission prioritizes at-most-once execution: only a failure proven before `WebSocket.send` accepts the frame may retry in the same runtime epoch; every possibly-written frame without ACK becomes `submission_unknown` and is never automatically resent.
- Card PATCH always retries the same `messageId`; only an explicit `MessageWithdrawnError` permits one stable-ID replacement. Ambiguous card creation may retry the same UUID only through 55 minutes after the first possibly-delivered attempt. An ambiguous reminder is recorded `unknown` and never resent.
- The runtime is the only operation-record writer. Daemons send authenticated `AckProjection` CAS commands; daemon/projector code never writes operation files directly and the runtime never stores Lark app secrets or calls Lark.
- The runtime is data-directory-scoped, is not a fleet member, survives `botmux restart` and daemon/worker SIGTERM/SIGKILL, and owns each eligible Trae App Server plus its frozen MCP generation and pending `request_user_input`.
- Explicit permanent session close interrupts only that runtime session. `botmux stop-bot <appId>` quiesces/closes only sessions with that frozen app ID, including the already-stopped-daemon case. `botmux stop` quiesces/closes all runtime sessions before `stopFleet()`. `restartFleet()` and `stopFleet()` remain runtime-neutral primitives.
- Runtime descriptors contain only `{pid,startIdentity,socket,protocolVersion,buildId,epoch}`. The token is a separate `0600` file; the socket directory is a real UID-owned `0700` directory and socket/token are `0600`. Descriptors never contain env, credentials, questions, or answers.
- Runtime request/response frames and notification journals are bounded. Main deltas may coalesce, but unacknowledged main terminals and `request_user_input` entries replay by sequence until cumulatively acknowledged; overflow fails new main submissions closed.
- The worker's applied notification cursor is durable in the existing bot-scoped session row; a replacement worker never relies on the prior process's memory to choose its replay cursor.
- Session config and MCP manifest payload/digest are frozen per runtime generation. `applySessionOwnerEnv` is the final environment mutation. Reattach reports drift and reuses the frozen generation; it never silently hot-mutates a live App Server.
- Codex keeps its current worker-owned `CodexRpcEngine`; non-Trae adapters, existing-App-Server adoption, PTY/sandbox/read-isolated sessions, static `CliAdapter`, normal passthrough commands, dashboard terminal controls, and low-level Lark client APIs do not gain managed BTW behavior.
- The hard continuity guarantee covers controlled `botmux restart`, daemon/worker reconstruction, daemon SIGKILL, and transient Lark failures while the runtime, App Server, data directory, host, and credentials survive. Host reboot/power loss, runtime/App Server failure, disk damage, credential revocation, incompatible protocol upgrades, and permanent Lark failure terminate visibly and never trigger native replay.
- Use the canonical checkout's existing `node_modules`; never run `bun install` in a worktree. Every implementation task follows RED→GREEN, ends in a reviewable commit, and pushes immediately.
- Every spawned TypeScript test process uses `test/helpers/ts-runner.ts`; production self-spawn uses `resolveEntrySpawn`, never a `dist/*.js` path constructed for an external process.
- Before the live check, run the complete verification matrix. Deploy this checkout only with `bun run switch:here && bun run daemon:restart`; after review/merge restore the canonical checkout because `switch:here` changes the global Botmux target for every bot.

---

## File Responsibility and Ownership Map

| Unit | File | Responsibility | Write owner |
| --- | --- | --- | --- |
| U0 | `src/adapters/cli/btw.ts` | Agent-neutral adapter/capability/outcome contract | Task 1 |
| U0 | `src/features/btw/types.ts` | Frozen operation/reply-target/runtime-session shapes | Task 1 |
| U0/U2/U4 | `src/types.ts` | Durable worker cursor/commit IPC, proxy wiring, then dedicated legacy event integration | Tasks 1, 7, then 11, serial |
| U0 | `src/features/btw/runtime-protocol.ts` | Narrow authenticated local IPC envelope, commands, replies, notifications | Task 1 |
| U0 | `test/fixtures/btw-fixtures.ts` | Shared deterministic IDs, operation input, fake clock, fake capabilities | Task 1 |
| U1 | `src/features/btw/operation-store.ts` | Per-operation durable CAS, state transitions, recovery, projection revisions | Tasks 2-4 only, serial |
| U1 | `test/btw-operation-store.test.ts` | Store schema, transition, corruption, recovery, projection tests | Tasks 2-4 only, serial |
| U2 | `src/codex-rpc-engine.ts` | Existing public facade; delegate transport/process/broker mechanics | Task 5 only |
| U2 | `src/codex-rpc-session.ts` | Reusable stateful App Server owner/broker, main event normalization and native BTW routing seam | Tasks 5, 7, then 9, serial |
| U2 | `src/features/btw/runtime-server.ts` | Singleton runtime, session registry, authenticated command/store dispatch | Tasks 6-9 and 11-12, serial |
| U2 | `src/features/btw/runtime-client.ts` | Ensure/connect/attach/control client and detached self-spawn | Tasks 6-8 and 11-12, serial |
| U2 | `src/index-btw-runtime.ts` | Hidden runtime process entry | Task 6 |
| U2 | `src/core/self-spawn.ts` | Node/Bun/standalone runtime entry wiring | Task 6 |
| U2/U5 | `src/cli.ts` | Runtime entry wiring, then explicit lifecycle calls | Task 6 then Task 12, serial |
| U2 | `src/codex-rpc-lifecycle.ts` | Trae proxy and viewer detach semantics | Task 7 |
| U2/U4 | `src/worker.ts` | Trae proxy, journal/ask handoff, then lifecycle-neutral legacy raw input | Tasks 7, 8, then 11, serial |
| U2 | `src/core/plugins/mcp/host.ts`, `src/core/plugins/mcp/session-runtime.ts` | Frozen manifest supplied to runtime-owned MCP host | Task 8 |
| U3 | `src/features/btw/trae-adapter.ts` | Native `turn/btw` submission/correlation/no-tool enforcement | Task 9 |
| U2/U3/U5 | `test/fixtures/fake-codex-rpc-server.mjs` | Characterization, native BTW, then fault-injection protocol fixtures | Tasks 5, 9, then 13, serial |
| U3 | `test/btw-trae-adapter.test.ts` | Deterministic native BTW protocol/fault coverage | Task 9 |
| U4/U5 | `src/features/btw/card.ts`, `src/features/btw/projector.ts` | BTW card render and Lark create/PATCH/replacement/reminder projection; bounded stop drain later | Tasks 10-12, serial |
| U4 | `src/features/btw/coordinator.ts` | Capability decision and durable acceptance orchestration | Task 11 |
| U4/U5 | `src/daemon.ts` | Both `/btw` ingress sites/projector service, then authenticated bounded stop-drain route | Tasks 11-12, serial |
| U4 | `src/core/passthrough-commands.ts`, `src/core/command-handler.ts` | Both `/btw` ingress sites and removal from generic passthrough lifecycle | Task 11 |
| U2/U4/U5 | `src/core/worker-pool.ts` | Durable cursor CAS, runtime attachment plumbing, then permanent-close ordering | Tasks 7, 11, then 12, serial |
| U0 | `src/adapters/cli/CLAUDE.md` | Contributor checklist for adding another managed adapter | Task 1 |
| U4 | `src/i18n/zh.ts`, `src/i18n/en.ts` | Managed card and legacy warning copy | Tasks 10-11, serial |
| U5 | `test/btw-runtime.e2e.ts`, `test/btw-restart.e2e.ts` | Integrated restart/fault acceptance | Task 13 |
| U5 | `test/btw-trae.e2e.ts` | Real-Trae acceptance | Task 14 |
| U5 | `docs/superpowers/specs/2026-09-01-managed-btw-lark-delivery-design.md`, PR artifacts | Final status, matrix, screenshot, and delivery handoff | Task 14 |

`src/worker.ts`, `src/core/worker-pool.ts`, and `src/cli.ts` are intentionally serialized integration seams even though their surrounding feature modules are independent. No parallel task may touch those files without first merging the prior owner into the integration branch.

## Frozen Interfaces

Task 1 creates these exact public contracts before any parallel implementation begins:

```ts
// src/adapters/cli/btw.ts
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

export function supportsManagedBtw(capabilities: BtwCapabilities): boolean;
```

```ts
// src/features/btw/types.ts
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
```

```ts
// Added to the existing src/types.ts IPC unions. The daemon binds both
// directions to its current child generation; workerGeneration is persisted in
// Session before init and is never chosen by the worker.
export interface BtwCursorCommitRequest {
  type: 'btw_notification_cursor_commit';
  requestId: string;
  sessionId: string;
  workerGeneration: number;
  runtimeEpoch: string;
  fromSeq: number;
  throughSeq: number;
}

export interface BtwCursorCommitAck {
  type: 'btw_notification_cursor_persisted';
  requestId: string;
  sessionId: string;
  workerGeneration: number;
  runtimeEpoch: string;
  fromSeq: number;
  throughSeq: number;
  ok: boolean;
  persistedSeq?: number;
  error?: 'stale_worker_generation' | 'session_mismatch' | 'runtime_epoch_mismatch' | 'cursor_invalid_range' | 'cursor_regression' | 'cursor_overlap' | 'cursor_gap' | 'session_store_write_failed';
}
```

There is deliberately no permanent initial-card failure variant. A provider
failure proven to be pre-dispatch/definitely-unsent retries the same UUID at
most `MAX_INITIAL_CARD_CREATE_ATTEMPTS` times; the eighth failed attempt clears
`nextCreateAttemptAt`, records `initial_card_retry_exhausted`, and enters the
existing terminal `card_unknown` state because no result location was accepted.
An ambiguous response stays on that same UUID only until its stored 55-minute
deadline, then enters the same state. Consequently, `listPendingInitialCards`
returns only due `card_pending` records and excludes records with a durable
`messageId`, a future `nextCreateAttemptAt`, or terminal `card_unknown`; no
native work starts for any pre-acceptance record.

The operation file is exactly:

```text
<dataDir>/btw/operations/<sha256(larkAppId NUL botmuxSessionId)>/<btwOpId>.json
```

All writes use:

```ts
atomicWriteFileSync(path, content, {
  mode: 0o600,
  durable: true,
  followTargetSymlink: false,
});
```

The operation store exports the constructor and path helper below. Every stateful operation is a method on the returned store; there are no same-named free functions:

```ts
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

export function btwOperationPath(dataDir: string, scope: BtwOperationScope, btwOpId: string): string;
export function createBtwOperationStore(options: { dataDir: string; now?: () => Date }): BtwOperationStore;
```

Runtime IPC is a closed discriminated union, not a generic method string:

```ts
// src/features/btw/runtime-protocol.ts
export const BTW_RUNTIME_PROTOCOL_VERSION = 1 as const;

export interface BtwRuntimeDescriptor {
  pid: number;
  startIdentity: string;
  socket: string;
  protocolVersion: typeof BTW_RUNTIME_PROTOCOL_VERSION;
  buildId: string;
  epoch: string;
}

export interface BtwRuntimeAttachment {
  runtime: BtwRuntimeDescriptor;
  appServerUrl: string;
  nativeThreadId: string;
  configHash: string;
  notificationCursor: number;
}

export type BtwMainEvent =
  | { type: 'delta'; text: string }
  | { type: 'cot'; entries: import('../../types.js').CotEntry[] };

export interface FrozenBtwSessionProfile {
  sessionId: string;
  larkAppId: string;
  cliId: 'traex';
  cliBin: string;
  cwd: string;
  env: Record<string, string>;
  ownerOpenId?: string;
  model?: string;
  reasoningEffort?: string;
  appServerFeatures: string[];
  nativeThreadId?: string;
  configHash: string;
  mcpManifest: import('../../core/plugins/mcp/session-runtime.js').SessionMcpRuntimeManifest | null;
  mcpManifestDigest: string;
}

export type BtwFirstTurnResult =
  | { outcome: 'accepted'; nativeTurnId?: string }
  | { outcome: 'not-sent' }
  | { outcome: 'ambiguous' };

export type BtwRuntimeCommand =
  | { type: 'ensure_session'; profile: FrozenBtwSessionProfile }
  | { type: 'attach_session'; sessionId: string; cursor: number }
  | { type: 'watch_projection_wakes'; larkAppId: string }
  | { type: 'detach_session'; sessionId: string }
  | { type: 'quiesce_session'; sessionId: string }
  | { type: 'close_session'; sessionId: string }
  | { type: 'submit_first_turn'; sessionId: string; content: string; identity: import('../../codex-rpc-engine.js').CodexRpcTurnIdentity }
  | { type: 'submit_main_turn'; sessionId: string; content: string; identity: import('../../codex-rpc-engine.js').CodexRpcTurnIdentity }
  | { type: 'prepare_btw'; input: PrepareBtwInput }
  | { type: 'record_initial_card_attempt'; scope: BtwOperationScope; btwOpId: string; outcome: BtwInitialCardAttemptOutcome }
  | { type: 'record_card'; scope: BtwOperationScope; btwOpId: string; messageId: string }
  | { type: 'submit_btw'; scope: BtwOperationScope; btwOpId: string }
  | { type: 'list_pending_projections'; larkAppId: string }
  | { type: 'list_pending_initial_cards'; larkAppId: string }
  | { type: 'record_projection_failure'; scope: BtwOperationScope; btwOpId: string; expected: { operationRevision: number; projectionRevision: number }; failure: BtwProjectionFailure }
  | { type: 'ack_projection'; scope: BtwOperationScope; btwOpId: string; expected: { operationRevision: number; projectionRevision: number }; outcome: BtwProjectionProviderOutcome }
  | { type: 'read_thread_metadata'; sessionId: string; timeoutMs?: number }
  | { type: 'set_thread_name'; sessionId: string; name: string }
  | { type: 'ack_events'; sessionId: string; seq: number }
  | { type: 'answer_user_input'; sessionId: string; requestId: string; result: unknown }
  | { type: 'quiesce_all' }
  | { type: 'quiesce_app'; larkAppId: string }
  | { type: 'close_app'; larkAppId: string }
  | { type: 'shutdown_runtime' };

export interface BtwRuntimeEnvelope {
  requestId: string;
  protocolVersion: typeof BTW_RUNTIME_PROTOCOL_VERSION;
  runtimeEpoch: string;
  command: BtwRuntimeCommand;
}

export interface BtwRuntimeResultMap {
  ensure_session: { attachment: BtwRuntimeAttachment; capabilities: BtwCapabilities; configDrift: boolean };
  attach_session: { attachment: BtwRuntimeAttachment };
  watch_projection_wakes: { subscribed: true };
  detach_session: { done: true };
  quiesce_session: BtwQuiesceResult;
  close_session: { done: true };
  submit_first_turn: BtwFirstTurnResult;
  submit_main_turn: { nativeTurnId: string };
  prepare_btw: PrepareBtwResult;
  record_initial_card_attempt: BtwOperation;
  record_card: BtwOperation;
  submit_btw: BtwOperation;
  list_pending_initial_cards: BtwOperation[];
  list_pending_projections: BtwProjectionItem[];
  record_projection_failure: { kind: 'applied' | 'stale'; operation: BtwOperation };
  ack_projection: { kind: 'applied' | 'stale'; operation: BtwOperation };
  read_thread_metadata: { name?: string; preview?: string; updatedAt?: number };
  set_thread_name: { done: true };
  ack_events: { done: true };
  answer_user_input: { done: true };
  quiesce_all: BtwQuiesceResult;
  quiesce_app: BtwQuiesceResult;
  close_app: { done: true };
  shutdown_runtime: { done: true };
}

export type BtwRuntimeSuccessReply = {
  [K in keyof BtwRuntimeResultMap]: {
    kind: 'reply';
    ok: true;
    requestId: string;
    commandType: K;
    result: BtwRuntimeResultMap[K];
  }
}[keyof BtwRuntimeResultMap];

export type BtwRuntimeFrame =
  | BtwRuntimeSuccessReply
  | { kind: 'reply'; ok: false; requestId: string; commandType: BtwRuntimeCommand['type']; error: { code: string; message: string } }
  | { kind: 'session_notification'; notification: BtwRuntimeNotification }
  | { kind: 'projection_wake'; larkAppId: string; wake: BtwProjectionWake };

type SequencedBtwRuntimeNotification<TKind extends string, TPayload> = {
  sessionId: string;
  fromSeq: number;
  throughSeq: number;
  kind: TKind;
  payload: TPayload;
};

export type BtwRuntimeNotification =
  | SequencedBtwRuntimeNotification<'main_event', BtwMainEvent>
  | SequencedBtwRuntimeNotification<'main_terminal', import('../../codex-rpc-engine.js').CodexRpcTurnTerminal>
  | SequencedBtwRuntimeNotification<'request_user_input', { requestId: string; params: unknown }>
  | SequencedBtwRuntimeNotification<'app_server_dead', { errorCode: string; message: string }>;

export interface BtwProjectionWake {
  kind: 'btw_projection_wake';
}

export interface AttachedBtwRuntimeSession {
  attachment: BtwRuntimeAttachment;
  notifications: AsyncIterable<BtwRuntimeNotification>;
  detach(): Promise<void>;
}
```

`EnsureSession` returns `{ attachment, capabilities, configDrift }`, where `attachment` contains only the runtime locator, epoch, App Server URL, native thread ID, config hash, and notification cursor; it never returns credentials. `stop()` on the worker proxy means `detach_session`. Permanent session/app closure is always two phase: `quiesce_*` rejects new work, persists interruption, and returns projection watermarks; only after the bounded daemon drain does `close_session`, `close_app`, or whole-runtime `shutdown_runtime` terminate the identity-fenced App Server owner.

The daemon persists the cumulative worker cursor in the existing bot-scoped `Session` row as `btwRuntime.notificationCursor`; the worker never opens `SessionStore`. Every runtime notification covers one contiguous journal interval `[fromSeq, throughSeq]`; an ordinary notification has `fromSeq === throughSeq`, while a coalesced delta may cover several consecutive sequence numbers and must include the full interval it replaces. Task 1 adds `BtwCursorCommitRequest` to `WorkerToDaemon` and `BtwCursorCommitAck` to `DaemonToWorker`, and extends `DaemonToWorker.init` with `btwRuntime?: BtwSessionAttachmentState` plus the already-daemon-owned `workerGeneration`. For each runtime notification the worker performs `apply idempotently -> send btw_notification_cursor_commit(sessionId, workerGeneration, runtimeEpoch, fromSeq, throughSeq) -> await a positive btw_notification_cursor_persisted matching requestId/sessionId/workerGeneration/runtimeEpoch/fromSeq/throughSeq -> ack_events(throughSeq)`. The daemon first requires its exact live child/session/generation/runtime epoch and a non-empty interval. It advances only when `fromSeq === persistedCursor + 1`, durably writes `throughSeq`, then ACKs. Because the Session row intentionally persists only the high-water cursor, any otherwise-valid duplicate interval with `throughSeq === persistedCursor` receives an idempotent positive ACK without another write; this rule does not claim that the daemon can reconstruct the prior interval. `throughSeq < persistedCursor`, any overlap that would advance beyond the persisted cursor, an invalid interval, and `fromSeq > persistedCursor + 1` fail closed. The runtime emits ranges in order and never coalesces across a terminal or `request_user_input` entry, so those entries retain their own replayable interval. A crash before the durable cursor ACK replays a deduplicated interval, and a crash after it resumes from the stored cursor even if runtime `ack_events` was not sent. `runtime.inspectSession()` used below is a test-fixture probe only, not a production command.

The runtime client exposes one typed method per command; no caller constructs or parses generic envelopes:

```ts
export interface BtwRuntimeClient {
  ensureSession(profile: FrozenBtwSessionProfile): Promise<{
    attachment: BtwRuntimeAttachment;
    capabilities: BtwCapabilities;
    configDrift: boolean;
  }>;
  attachSession(input: { sessionId: string; cursor: number }): Promise<AttachedBtwRuntimeSession>;
  detachSession(sessionId: string): Promise<void>;
  quiesceSession(sessionId: string): Promise<BtwQuiesceResult>;
  closeSession(sessionId: string): Promise<void>;
  submitFirstTurn(sessionId: string, content: string, identity: import('../../codex-rpc-engine.js').CodexRpcTurnIdentity): Promise<BtwFirstTurnResult>;
  submitMainTurn(sessionId: string, content: string, identity: import('../../codex-rpc-engine.js').CodexRpcTurnIdentity): Promise<{ nativeTurnId: string }>;
  prepareBtw(input: PrepareBtwInput): Promise<PrepareBtwResult>;
  recordInitialCardAttempt(scope: BtwOperationScope, btwOpId: string, outcome: BtwInitialCardAttemptOutcome): Promise<BtwOperation>;
  recordCard(scope: BtwOperationScope, btwOpId: string, messageId: string): Promise<BtwOperation>;
  submitBtw(scope: BtwOperationScope, btwOpId: string): Promise<BtwOperation>;
  listPendingInitialCards(larkAppId: string): Promise<BtwOperation[]>;
  listPendingProjections(larkAppId: string): Promise<BtwProjectionItem[]>;
  recordProjectionFailure(scope: BtwOperationScope, btwOpId: string, expected: { operationRevision: number; projectionRevision: number }, failure: BtwProjectionFailure): Promise<{ kind: 'applied' | 'stale'; operation: BtwOperation }>;
  ackProjection(scope: BtwOperationScope, btwOpId: string, expected: { operationRevision: number; projectionRevision: number }, outcome: BtwProjectionProviderOutcome): Promise<{ kind: 'applied' | 'stale'; operation: BtwOperation }>;
  readThreadMetadata(sessionId: string, timeoutMs?: number): Promise<{ name?: string; preview?: string; updatedAt?: number }>;
  setThreadName(sessionId: string, name: string): Promise<void>;
  ackEvents(sessionId: string, seq: number): Promise<void>;
  answerUserInput(sessionId: string, requestId: string, result: unknown): Promise<void>;
  quiesceAll(): Promise<BtwQuiesceResult>;
  quiesceApp(larkAppId: string): Promise<BtwQuiesceResult>;
  closeApp(larkAppId: string): Promise<void>;
  shutdownRuntime(): Promise<void>;
  watchProjectionWakes(larkAppId: string): AsyncIterable<BtwProjectionWake>;
}
```

`attachSession` and `watchProjectionWakes` each open a dedicated authenticated socket and complete one request/reply subscription handshake; later frames on that socket are respectively `session_notification` or `projection_wake` members of `BtwRuntimeFrame`. Closing the socket cancels that subscription. Each typed client method validates its command-specific reply before returning rather than casting `result: unknown`. `watchProjectionWakes` is a non-durable, BTW-specific hint stream: it carries no answer, state, revision, or credentials. The daemon always re-lists durable initial-card/projection work after every wake and on startup/reconnect, so disconnecting or losing a wake cannot lose work. It is not part of the worker session journal and does not expand into a generic event bus.

## Dependency Graph and Branch Discipline

```text
Task 1 (U0 shared contracts)
  |
  +-- shared-interface only --> Tasks 2-4 (U1 store; serial with each other)
  +-- shared-interface only --> Task 5 (U2 broker extraction)

Tasks 4-5 -- true store/broker dependency --> Task 6 (U2 runtime transport + store dispatcher)
Task 6 -- true runtime transport dependency --> Task 7 (U2 proxy/journal)
Task 7 -- true proxy/cursor dependency --> Task 8 (U2 MCP/ask custody)
Task 6 -- true runtime-client dependency --> Task 10 (U4 card/projector)
Task 8 -- true reusable-broker/proxy dependency --> Task 9 (U3 Trae adapter)
Tasks 4 + 7-10 -- true runtime/card/seam dependency --> Task 11 (U4 ingress)

Task 11 -- true integrated runtime behavior dependency --> Task 12 (U5 lifecycle)
Task 12 -- true complete lifecycle dependency --> Task 13 (U5 fault harness)
Task 13 -- true acceptance-evidence dependency --> Task 14 (U5 live/artifact verification)
```

Task 1 runs first on the one integration branch `feat/btw-lark-reliable-delivery` and is pushed. If execution is parallelized afterward, create task worktrees under `/data00/home/wangqiyilang/playground/.worktree/btw-lark-reliable-delivery/`, branch them from the current pushed integration tip, and preserve the ownership table above. Only tasks whose incoming edges are satisfied and whose write scopes do not overlap may run together. Task 9 is deliberately after Task 8 because both touch `codex-rpc-session.ts`; Task 10 is after Task 6 because it consumes the runtime client. Tasks inside one unit are serial. Each task below names its exact branch and push ref. After review, cherry-pick the task commit into the integration worktree and immediately `git push fork HEAD:feat/btw-lark-reliable-delivery` before dependent work starts. If an interface must change or write scopes overlap, stop those tasks, amend the shared contract in one integration commit, push it, then rebase or recreate only the affected clean task worktrees. Never use stash or destructive reset.

For each non-integration task, create its local branch/worktree from the latest integration tip before running its task steps. Substitute the branch printed in that task's `git push -u fork HEAD:...` command and use its suffix as the final directory component (for example branch `task/btw-u1a-operation-prepare`, directory `btw-u1a-operation-prepare`). Independent tasks may run concurrently only when their ownership rows do not overlap; otherwise create the next worktree only after the prior integration push:

```bash
git fetch fork feat/btw-lark-reliable-delivery
TASK_BRANCH=task/btw-u1a-operation-prepare
TASK_DIR=/data00/home/wangqiyilang/playground/.worktree/btw-lark-reliable-delivery/btw-u1a-operation-prepare
git worktree add "$TASK_DIR" -b "$TASK_BRANCH" fork/feat/btw-lark-reliable-delivery
cd "$TASK_DIR"
test ! -e node_modules
ln -s /data00/home/wangqiyilang/playground/botmux/node_modules node_modules
```

After review, capture every task commit SHA from `git rev-parse HEAD` (Task 5 has two SHAs) and integrate them in production order. Each task's final command block contains the exact `TASK_COMMIT`/`git cherry-pick` form; Task 5 records and cherry-picks both commits in order. Only after the integration push may a dependent task worktree be created.

This plan and the approved spec are already committed on `docs/btw-lark-reliable-delivery`. Before Task 1, from this documentation worktree, rename that branch in place and publish the one integration target (retain the old remote documentation ref until normal branch cleanup). Then link the canonical dependencies only after asserting this worktree has no `node_modules`; never install through that link:

```bash
git branch -m feat/btw-lark-reliable-delivery
test ! -e node_modules
ln -s /data00/home/wangqiyilang/playground/botmux/node_modules node_modules
git push -u fork HEAD:feat/btw-lark-reliable-delivery
git ls-files --error-unmatch docs/superpowers/plans/2026-09-01-managed-btw-lark-delivery.md
git status --short --branch
```

The initial documentation commit above is the execution base. For every production-code task, the repository-required local gate is: focused RED/GREEN checks and `bun run build` in the task worktree, then commit/push/cherry-pick. From the integration worktree run `bun run build && bun run daemon:restart`, execute the listed focused GREEN selector against the integrated tree when needed, and only then push the integration ref. Daemon startup claims the global wrapper, so an ordinary restart must never run from a disposable parallel task worktree. The one deliberate exception is a test-only RED checkpoint that is committed before production code exists: it runs the focused characterization suite, then pushes; its paired GREEN commit runs the build gate before integration, followed by the integration-worktree restart.

---

### Task 1: Freeze the BTW contracts and deterministic fixture vocabulary (U0)

**Files:**
- Create: `src/adapters/cli/btw.ts`
- Create: `src/features/btw/types.ts`
- Create: `src/features/btw/runtime-protocol.ts`
- Modify: `src/types.ts`
- Create: `test/fixtures/btw-fixtures.ts`
- Create: `test/btw-contract.test.ts`
- Modify: `src/adapters/cli/CLAUDE.md`

**Interfaces:**
- Produces every type, constant, and signature in **Frozen Interfaces** above, including `MAX_INITIAL_CARD_CREATE_ATTEMPTS = 8`, plus `Session.btwRuntime?: BtwSessionAttachmentState`, `DaemonToWorker.init.btwRuntime?: BtwSessionAttachmentState`, the `WorkerToDaemon` `BtwCursorCommitRequest`, and the `DaemonToWorker` `BtwCursorCommitAck` in `src/types.ts`.
- Produces `deriveBtwIdentifiers(scope, requestId)` returning `{ btwOpId, nativeTurnId, createUuid, replacementUuid, reminderUuid }` from domain-separated SHA-256 inputs.
- Produces `supportsManagedBtw(capabilities)`, true only when all four flags are exactly true.
- Produces fixtures `makeBtwScope()`, `makeBtwPrepareInput()`, `makeBtwOperation()`, and `ALL_BTW_CAPABILITY_COMBINATIONS`.
- Consumes no later unit and does not modify the static `CliAdapter` interface or registry.

- [ ] **Step 1: Write the failing contract tests**

Create parameterized tests that assert all sixteen capability combinations, exact stable ID reproduction, domain separation among all five IDs, app/session scoping, the explicit eight-attempt initial-card ceiling, the complete frozen operation defaults (including create/projection retry, replacement, reminder, and delivery-failure fields), runtime command/notification exhaustiveness, durable `Session.btwRuntime` shape, exact cursor-commit request/ACK discriminants, and that a fake adapter can complete two calls out of order without exposing Lark or thread fields. Use this representative contract test verbatim:

```ts
it.each(ALL_BTW_CAPABILITY_COMBINATIONS)(
  'manages only the all-true capability row %#',
  ({ capabilities, managed }) => {
    expect(supportsManagedBtw(capabilities)).toBe(managed);
  },
);

it('derives stable, domain-separated identifiers from app + session + request', () => {
  const scope = makeBtwScope();
  const first = deriveBtwIdentifiers(scope, 'om_request_1');
  expect(deriveBtwIdentifiers(scope, 'om_request_1')).toEqual(first);
  expect(new Set(Object.values(first))).toHaveSize(5);
  expect(deriveBtwIdentifiers({ ...scope, larkAppId: 'cli_other' }, 'om_request_1'))
    .not.toEqual(first);
});
```

- [ ] **Step 2: Verify RED**

Run:

```bash
./node_modules/.bin/vitest run --project unit test/btw-contract.test.ts
```

Expected: FAIL because `src/adapters/cli/btw.ts`, `src/features/btw/types.ts`, `src/features/btw/runtime-protocol.ts`, and fixture exports do not exist.

- [ ] **Step 3: Implement the frozen types and pure helpers**

Copy the exact interfaces from **Frozen Interfaces**. Implement `supportsManagedBtw` as the four-way conjunction. Implement IDs with distinct domain strings (`btw-op`, `btw-native-turn`, `btw-card`, `btw-replacement`, `btw-reminder`) over `larkAppId + NUL + botmuxSessionId + NUL + requestId`; emit every Lark provider key as an ASCII prefixed-hex token no longer than 50 characters (matching existing `dispatchUuidForKey` practice), and operation/native IDs as bounded prefixed hex. Add a contributor checklist to `src/adapters/cli/CLAUDE.md`: an implementation is runtime-bound, must expose all four capabilities, must provide structured full-answer terminals, must reject tool execution, and must pass `test/btw-contract.test.ts`.

- [ ] **Step 4: Verify GREEN, commit, push, and integrate**

```bash
./node_modules/.bin/vitest run --project unit test/btw-contract.test.ts
bun run build
git diff --check
git add src/adapters/cli/btw.ts src/features/btw/types.ts src/features/btw/runtime-protocol.ts src/types.ts test/fixtures/btw-fixtures.ts test/btw-contract.test.ts src/adapters/cli/CLAUDE.md
git commit -m "feat(btw): 冻结旁问运行时契约"
git push -u fork HEAD:feat/btw-lark-reliable-delivery
```

### Task 2: Persist preparation, deterministic identity, and poison-safe deduplication (U1a)

**Files:**
- Create: `src/features/btw/operation-store.ts`
- Create: `test/btw-operation-store.test.ts`

**Interfaces:**
- Consumes `BtwOperationScope`, `PrepareBtwInput`, `PrepareBtwResult`, `BtwOperation`, and `deriveBtwIdentifiers` from Task 1.
- Produces `btwOperationPath(dataDir, scope, btwOpId)` and `createBtwOperationStore({ dataDir, now? })`; the returned `BtwOperationStore` initially implements `pathFor`, `prepareBtw`, and `getBtwOperation`, and Tasks 3-4 fill in the remaining already-frozen methods.

- [ ] **Step 1: Write failing preparation and corruption tests**

Cover: exact partition path hash; mode `0600`; durable atomic write options; immutable frozen fields; duplicate request returns byte-equivalent identity; same request string in a different app/session is distinct; concurrent prepares converge to one record under `withFileLockSync`; malformed sibling is quarantined without blocking valid siblings; malformed exact duplicate is renamed to a poison/tombstone and future prepares for that key fail closed instead of executing; symlink targets are rejected.

```ts
const first = store.prepareBtw(makeBtwPrepareInput({ requestId: 'om_dup' }));
const duplicate = store.prepareBtw(makeBtwPrepareInput({
  requestId: 'om_dup',
  question: 'mutated replay must not win',
}));
expect(first.kind).toBe('created');
expect(duplicate).toEqual({ kind: 'duplicate', operation: first.operation });
expect(readFileSync(store.pathFor(scope, first.operation.btwOpId), 'utf8'))
  .toContain('\"card_pending\"');
```

- [ ] **Step 2: Verify RED**

```bash
./node_modules/.bin/vitest run --project unit test/btw-operation-store.test.ts
```

Expected: FAIL with missing `createBtwOperationStore` and operation path exports.

- [ ] **Step 3: Implement strict parsing and durable prepare/get**

Validate every key and enum, reject extra/malformed data, and write one record per path under `<dataDir>/btw/operations/<scopeHash>/`. Put all read-check-write sequences under `withFileLockSync(recordPath, ...)`. On a corrupt sibling, move it to a digest-named quarantine file and continue listing; on the exact requested key, write/retain a deterministic poison marker under the same scope and throw `BtwOperationPoisonedError` on every later prepare/get. Never let quarantine make an exact duplicate appear absent.

- [ ] **Step 4: Verify GREEN, commit, push, and integrate**

```bash
./node_modules/.bin/vitest run --project unit test/btw-contract.test.ts test/btw-operation-store.test.ts
bun run build
git diff --check
git add src/features/btw/operation-store.ts test/btw-operation-store.test.ts
git commit -m "feat(btw): 持久化旁问接纳记录"
git push -u fork HEAD:task/btw-u1a-operation-prepare
TASK_COMMIT=$(git rev-parse HEAD)
cd /data00/home/wangqiyilang/playground/.worktree/btw-lark-reliable-delivery/botmux
git cherry-pick "$TASK_COMMIT"
bun run build && bun run daemon:restart
git push fork HEAD:feat/btw-lark-reliable-delivery
```

### Task 3: Enforce conservative execution transitions and recovery (U1b)

**Files:**
- Modify: `src/features/btw/operation-store.ts`
- Modify: `test/btw-operation-store.test.ts`

**Interfaces:**
- Consumes Task 2's locked strict record loader.
- Produces `recordBtwCard`, `prepareBtwSubmission`, `recordBtwDefinitelyUnsent`, `recordBtwSubmissionUnknown`, `recordBtwRunning`, `recordBtwTerminal`, and `reconcileBtwOperations` with the signatures frozen above.

- [ ] **Step 1: Write failing state-machine tests**

Test every allowed edge and reject every illegal edge. Specifically assert: card recording is the only route to `accepted`; submission preparation durably increments the attempt before any transport call; definitely-unsent retry is legal only in the same epoch; possibly-written timeout becomes immutable `submission_unknown` except for an authoritative terminal from the same live connection; ACK maps only the exact native ID to `running`; terminal-before-ACK works; duplicate equal terminal is a no-op; conflicting terminal creates a quarantine diagnostic and does not overwrite; an authoritative same-connection terminal may settle `submission_unknown`; reload maps old-epoch `accepted` and `running` to `interrupted`, and old-epoch `submit_prepared` to `submission_unknown`; completed/failed/cancelled remain unchanged.

```ts
expect(store.prepareBtwSubmission(scope, opId, 'epoch-a').execution.state)
  .toBe('submit_prepared');
expect(() => store.recordBtwDefinitelyUnsent(scope, opId, 'epoch-b'))
  .toThrow(/runtime epoch/i);
expect(store.reconcileBtwOperations({
  runtimeEpoch: 'epoch-b',
  liveSessionIds: new Set(),
}).find(op => op.btwOpId === opId)?.execution.state)
  .toBe('submission_unknown');
```

- [ ] **Step 2: Verify RED**

```bash
./node_modules/.bin/vitest run --project unit test/btw-operation-store.test.ts
```

Expected: FAIL because transition and reconciliation methods are absent.

- [ ] **Step 3: Implement one transition table under record-level CAS**

Use an exhaustive `(currentState, event)` reducer. Increment `revision` and `updatedAt` only for actual changes. Persist `frameState='may_have_been_sent'` before awaiting ACK; retain the pre-registered stable native ID so terminal-before-ACK resolves exactly. `reconcileBtwOperations` may only use the supplied runtime epoch/live-session set and stored states; it never infers execution from a terminal screen or resubmits. An `accepted` record belongs to its immutable parent epoch; if that epoch is no longer live it becomes `interrupted` and is projected rather than dispatched by a replacement generation. Persist conflict diagnostics beside the quarantined record without changing the last accepted terminal.

- [ ] **Step 4: Verify GREEN, commit, push, and integrate**

```bash
./node_modules/.bin/vitest run --project unit test/btw-operation-store.test.ts
bun run build
git diff --check
git add src/features/btw/operation-store.ts test/btw-operation-store.test.ts
git commit -m "feat(btw): 收紧旁问执行状态机"
git push -u fork HEAD:task/btw-u1b-execution-state
TASK_COMMIT=$(git rev-parse HEAD)
cd /data00/home/wangqiyilang/playground/.worktree/btw-lark-reliable-delivery/botmux
git cherry-pick "$TASK_COMMIT"
bun run build && bun run daemon:restart
git push fork HEAD:feat/btw-lark-reliable-delivery
```

### Task 4: Add durable projection revisions, replacement, reminder, and card-create deadline (U1c)

**Files:**
- Modify: `src/features/btw/operation-store.ts`
- Modify: `test/btw-operation-store.test.ts`

**Interfaces:**
- Consumes Task 3's terminal transitions.
- Produces `listPendingInitialCards`, `recordInitialCardAttempt`, `listPendingBtwProjections`, and `ackBtwProjection`; successful initial creation still advances only through Task 3's `recordBtwCard`.
- A projection item is keyed by `(scope, btwOpId, expectedOperationRevision, projectionRevision)`. `expectedOperationRevision === operation.revision` fences concurrent record mutations; `projectionRevision === projection.desiredRevision` identifies the content view, while `patchedRevision` records the last visible view. `replacementForRevision` always means the projection content revision. ACK must match both numbers. PATCH/replacement/reminder acknowledgements are distinct phases: a `patched` or `replacement_created` ACK advances only the matching content revision and queues the reminder; a later reminder ACK advances only reminder state against the new operation revision, never re-PATCHes the content.

- [ ] **Step 1: Write failing projection tests**

Cover: definitely-unsent and ambiguous initial-card attempts are recorded through `recordInitialCardAttempt`, while successful creation uses `recordBtwCard` and never projection ACK; explicit pre-dispatch create failure retries the stable UUID for attempts 1-7, then attempt 8 records `initial_card_retry_exhausted`, clears retry scheduling, enters `card_unknown`, and never starts native work; terminal persistence increments `desiredRevision` before any projector can list it; stale ACK cannot advance a newer revision; repeated patch success is idempotent; 429/5xx/timeout leave the same revision pending; only explicit withdrawn records one replacement intent before creation; replacement reuses its stable UUID and cannot create a second logical replacement; successful result PATCH moves reminder `none→pending`; definitely-unsent reminder can retry; ambiguous reminder moves to `unknown` and never retries; local oversize retains the full answer and creates a bounded visible-fallback revision; a deterministic provider rejection blocks only its exact projection revision and does not falsely mark it visible; card-create ambiguity records `firstPossiblySentAt` plus exactly `+55m`, retries the same UUID before the deadline, and becomes `card_unknown` afterward without submission.

```ts
const pending = store.listPendingBtwProjections(scope.larkAppId);
const expected = {
  operationRevision: pending[0].expectedOperationRevision,
  projectionRevision: pending[0].projectionRevision,
};
store.recordBtwTerminal(scope, opId, { status: 'completed', answer: 'newer' });
expect(store.ackBtwProjection(scope, opId, expected, { kind: 'patched' }).kind)
  .toBe('stale');
```

- [ ] **Step 2: Verify RED**

```bash
./node_modules/.bin/vitest run --project unit test/btw-operation-store.test.ts
```

Expected: FAIL on missing pending-list/CAS acknowledgement and deadline/replacement state.

- [ ] **Step 3: Implement projection state inside the operation record**

Do not add a second general outbox and do not change the Task 1 schema. Implement initial-card failure/deadline transitions only through `recordInitialCardAttempt`; keep initial-card success on `recordBtwCard` and reject any attempt to encode it as `ackBtwProjection`. Increment `createAttempt` once per provider call; schedule definitely-unsent attempts 1-7 with bounded exponential backoff, and on attempt 8 persist `errorCode='initial_card_retry_exhausted'`, clear `nextCreateAttemptAt`, and move to `card_unknown`. Ambiguous attempts use the earlier of bounded backoff and `createRetryDeadline`, then also settle `card_unknown` at the deadline. Use the already-frozen retry, delivery-error, replacement-intent, and reminder fields; keep `projection.desiredRevision`, `patchedRevision`, `blockedRevision`, and `reminderState` authoritative. `recordBtwProjectionFailure` is not a delivery ACK: for a locally detected oversize it records `visible_fallback`, retains the full answer, and creates a new bounded failure-view `desiredRevision` that still needs a later `patched` ACK. A deterministic provider rejection records `provider_permanent` and `blockedRevision` so the same revision does not spin; it cannot promise a visible failure card because the provider refused delivery. `replacement_created` means the exact projection revision is now visible: persist the replacement ID, advance `patchedRevision`, and queue the same stable reminder. Every mutation and acknowledgement runs through the same record lock and durable atomic write as execution transitions. List operations by app partition without letting one corrupt sibling stop the rest.

- [ ] **Step 4: Verify GREEN, commit, push, and integrate**

```bash
./node_modules/.bin/vitest run --project unit test/btw-operation-store.test.ts
bun run build
git diff --check
git add src/features/btw/operation-store.ts test/btw-operation-store.test.ts
git commit -m "feat(btw): 持久化飞书投影进度"
git push -u fork HEAD:task/btw-u1c-projection-state
TASK_COMMIT=$(git rev-parse HEAD)
cd /data00/home/wangqiyilang/playground/.worktree/btw-lark-reliable-delivery/botmux
git cherry-pick "$TASK_COMMIT"
bun run build && bun run daemon:restart
git push fork HEAD:feat/btw-lark-reliable-delivery
```

### Task 5: Extract the stateful App Server session without changing Codex behavior (U2a)

**Files:**
- Create: `src/codex-rpc-session.ts`
- Modify: `src/codex-rpc-engine.ts`
- Modify: `test/codex-rpc-engine.test.ts`
- Modify: `test/fixtures/fake-codex-rpc-server.mjs`

**Interfaces:**
- Produces `CodexRpcSession`, the reusable owner of process group, WebSocket, JSON-RPC pending map, native ownership maps, thread metadata, and request/user-input dispatch.
- Keeps `CodexRpcEngine`'s existing constructor and public methods byte-compatible for current Codex worker callers.
- Produces `CodexRpcSession.requestWithDispatchBoundary(method, params, opts)` with result `{ kind: 'acknowledged'; result } | { kind: 'definitely_unsent'; error } | { kind: 'submission_unknown'; error }`, plus `registerNativeTurnOwner(nativeTurnId, owner)` and a normalized notification callback. These are the complete native routing seams Task 9 consumes after Task 8; the adapter does not add a second WebSocket parser.

- [ ] **Step 1: Strengthen the characterization tests before extraction**

Add tests for existing spawn args/env/detached group, initialize order, fresh/resumed thread config, title/read polling, first-turn not-sent versus ambiguous behavior, terminal-before-ACK, duplicate/unowned/conflicting terminals, request timeout, App Server death, and `request_user_input` interruption. Clear the client WebSocket, as the existing test does, to characterize pre-send failure; use a fake-server switch only for accepted-frame/drop-ACK ambiguity because a server cannot cause a pre-`WebSocket.send` failure.

- [ ] **Step 2: Run characterization tests GREEN on the old implementation**

```bash
./node_modules/.bin/vitest run --project unit test/codex-rpc-engine.test.ts
```

Expected: PASS; these tests freeze existing behavior before moving code. Commit the test-only checkpoint:

```bash
git add test/codex-rpc-engine.test.ts test/fixtures/fake-codex-rpc-server.mjs
git commit -m "test(rpc): 固化应用服务器会话行为"
git push -u fork HEAD:task/btw-u2a-rpc-session
```

- [ ] **Step 3: Extract `CodexRpcSession` and verify no behavior drift**

Move process/WebSocket/request/notification mechanics into `CodexRpcSession`. Keep main-turn ownership and public conversion logic in the facade where that prevents unrelated churn. `CodexRpcEngine.stop()` must retain its current destructive semantics for Codex; the new reusable session exposes separate `detachObserver()` and `closeOwnedProcess()` operations for later persistent clients. No BTW method is added in this refactor.

- [ ] **Step 4: Write and run the new dispatch-boundary seam RED test**

Inject a client-side send function that throws before accepting bytes, and use the fake server to accept bytes then drop the ACK. Assert the three discriminants above and that the terminal owner is registered before the send callback runs.

```bash
./node_modules/.bin/vitest run --project unit test/codex-rpc-engine.test.ts -t "dispatch boundary"
```

Expected: FAIL because `requestWithDispatchBoundary` and `registerNativeTurnOwner` are not yet exposed by `CodexRpcSession`. Implement only those seams, then rerun the selector and expect PASS.

- [ ] **Step 5: Verify GREEN, commit, push, and integrate both commits in order**

```bash
./node_modules/.bin/vitest run --project unit test/codex-rpc-engine.test.ts test/codex-rpc-lifecycle.test.ts test/codex-worker-bridge-wiring.test.ts test/traex-worker-bridge-wiring.test.ts
bun run build
git diff --check
git add src/codex-rpc-session.ts src/codex-rpc-engine.ts test/codex-rpc-engine.test.ts test/fixtures/fake-codex-rpc-server.mjs
git commit -m "refactor(rpc): 抽取有状态应用服务器会话"
git push -u fork HEAD:task/btw-u2a-rpc-session
IMPLEMENTATION_COMMIT=$(git rev-parse HEAD)
CHARACTERIZATION_COMMIT=$(git rev-parse HEAD^)
cd /data00/home/wangqiyilang/playground/.worktree/btw-lark-reliable-delivery/botmux
git cherry-pick "$CHARACTERIZATION_COMMIT" "$IMPLEMENTATION_COMMIT"
bun run build && bun run daemon:restart
git push fork HEAD:feat/btw-lark-reliable-delivery
```

### Task 6: Start and authenticate the persistent runtime across Node, Bun, and standalone (U2b)

**Files:**
- Create: `src/features/btw/runtime-server.ts`
- Create: `src/features/btw/runtime-client.ts`
- Create: `src/index-btw-runtime.ts`
- Modify: `src/core/self-spawn.ts`
- Modify: `src/cli.ts`
- Create: `test/btw-runtime-auth.test.ts`
- Create: `test/btw-runtime-process.e2e.ts`
- Modify: `test/cli-subcommand-spawn-form.test.ts`
- Modify: `test/cli-runner-compiled-entries.test.ts`

**Interfaces:**
- Consumes Task 1's runtime protocol, Task 4's complete `BtwOperationStore`, Task 5's broker, and `runtimeBuildIdentity()` / `readProcessStartIdentity()`.
- Produces `ensureBtwRuntime({ dataDir })`, `connectBtwRuntime({ dataDir, expectedEpoch? })`, `runBtwRuntime({ dataDir })`, and the non-durable `watchProjectionWakes(larkAppId)` hint stream frozen above.
- Produces descriptor path `<dataDir>/btw/runtime.json`, token path `<dataDir>/btw/runtime.token`, and a short local socket path derived from the canonical data directory.
- Implements the typed operation/store commands (`prepare_btw`, initial-card attempt/record, submit wake, list, ACK) against one runtime-owned store and exposes a single-flight executor wake queue, but Task 6 deliberately has no adapter resolver and does not dispatch native BTW. `record_card` atomically changes an operation to `accepted`; `submit_btw` is an idempotent wake hint retained until Task 9 installs the Trae adapter resolver and executor consumer.

- [ ] **Step 1: Write failing process/authentication tests**

Using `spawnTsScript`/`spawnTsEvalWithRepoImports`, assert: twenty concurrent ensures yield one PID/epoch; runtime stdio is closed and its process group differs from the fleet caller; descriptor contains exactly six allowed fields and no secret/question/env; descriptor/token/socket permissions are `0600` and directory is real UID-owned `0700`; wrong token, stale epoch, stale socket, malformed frame, oversized frame, queue overflow, and peer-UID mismatch where the platform exposes credentials fail closed; PID reuse never kills the unrelated process; compatible build change reuses the process; incompatible protocol preserves live sessions and replaces only an empty runtime. Persist an `accepted` operation, kill its daemon caller before `submit_btw`, send concurrent wake commands, and assert it remains durably accepted with one coalesced wake and zero native calls because Task 9 has not installed an adapter resolver yet. Verify projection wakes contain only `{ kind: 'btw_projection_wake' }`, are scoped by app ID, and may be dropped/reconnected without changing the durable pending list.

```ts
const descriptors = await Promise.all(
  Array.from({ length: 20 }, () => ensureBtwRuntime({ dataDir })),
);
expect(new Set(descriptors.map(value => `${value.pid}:${value.epoch}`))).toHaveSize(1);
expect(Object.keys(descriptors[0]).sort()).toEqual(
  ['buildId', 'epoch', 'pid', 'protocolVersion', 'socket', 'startIdentity'],
);
```

- [ ] **Step 2: Verify RED**

```bash
./node_modules/.bin/vitest run --project unit test/btw-runtime-auth.test.ts test/cli-subcommand-spawn-form.test.ts test/cli-runner-compiled-entries.test.ts
./node_modules/.bin/vitest run --project e2e test/btw-runtime-process.e2e.ts
```

Expected: FAIL because the runtime entry/client/server and `btw-runtime` self-spawn entry do not exist.

- [ ] **Step 3: Implement the detached authenticated singleton**

Add `btw-runtime` to `BotmuxEntry`, `ENTRY_SUBCOMMAND`, `ENTRY_SCRIPT`, and the static CLI import switch as `__btw-runtime`. Launch through `resolveEntrySpawn('btw-runtime', distDir)` with `detached: true`, closed inherited stdio, no IPC slot, and `unref()`. Serialize ensure with a private file lock, then always perform a second authenticated handshake. Encode newline-delimited bounded JSON frames and enforce the closed command union. Check UID where available, exact token, major protocol, and epoch on every connection/request. Convert `runtimeBuildIdentity()` only after narrowing `status === 'known'`; an unknown identity fails runtime creation closed rather than assigning the union to `buildId`. Use process-start identity before any signal. Runtime startup creates/reconciles the operation store and coalesces executor wake requests, but leaves `accepted` records untouched until Task 9 installs the only Trae adapter resolver/consumer; it never contacts Lark. Publish the payload-free app-scoped wake after a durable terminal/projection-relevant transition; never wait for a subscriber and never treat successful wake delivery as durable progress.

- [ ] **Step 4: Verify GREEN, commit, push, and integrate**

```bash
./node_modules/.bin/vitest run --project unit test/btw-runtime-auth.test.ts test/cli-subcommand-spawn-form.test.ts test/cli-runner-compiled-entries.test.ts
./node_modules/.bin/vitest run --project e2e test/btw-runtime-process.e2e.ts
bun run build
git diff --check
git add src/features/btw/runtime-server.ts src/features/btw/runtime-client.ts src/index-btw-runtime.ts src/core/self-spawn.ts src/cli.ts test/btw-runtime-auth.test.ts test/btw-runtime-process.e2e.ts test/cli-subcommand-spawn-form.test.ts test/cli-runner-compiled-entries.test.ts
git commit -m "feat(btw): 增加持久旁问运行时"
git push -u fork HEAD:task/btw-u2b-runtime-process
TASK_COMMIT=$(git rev-parse HEAD)
cd /data00/home/wangqiyilang/playground/.worktree/btw-lark-reliable-delivery/botmux
git cherry-pick "$TASK_COMMIT"
bun run build && bun run daemon:restart
git push fork HEAD:feat/btw-lark-reliable-delivery
```

### Task 7: Move eligible Trae ownership behind a worker proxy and replay-safe journal (U2c)

**Files:**
- Modify: `src/features/btw/runtime-server.ts`
- Modify: `src/features/btw/runtime-client.ts`
- Modify: `src/codex-rpc-session.ts`
- Modify: `src/codex-rpc-lifecycle.ts`
- Modify: `src/core/worker-pool.ts`
- Modify: `src/worker.ts`
- Modify: `src/types.ts`
- Create: `test/btw-runtime-main-proxy.test.ts`
- Create: `test/btw-worker-proxy-wiring.test.ts`
- Modify: `test/codex-rpc-lifecycle.test.ts`
- Modify: `test/traex-worker-bridge-wiring.test.ts`

**Interfaces:**
- Consumes `ensure_session`, `attach_session`, `detach_session`, `submit_first_turn`, `submit_main_turn`, metadata/title, and cursor commands from Task 1/6.
- Produces `PersistentTraeRpcProxy` with the high-level methods currently consumed by `worker.ts`: `start`, `startThread`, `resumeThread`, `sendFirstTurn`, `sendTurn`, `readThreadMetadata`, `waitForThreadPreview`, `waitForThreadUpdatedAfter`, `setThreadName`, and detach-only `stop`.
- Sends only the frozen `BtwSessionAttachmentState` locator/cursor plus daemon-owned `workerGeneration` in `DaemonToWorker.init`; operation state stays out of shared worker/session unions. Uses Task 1's dedicated cursor commit request/ACK for daemon-owned SessionStore persistence.

- [ ] **Step 1: Write failing proxy and journal tests**

Assert: only eligible cold Trae RPC chooses persistent ownership; Codex still constructs local `CodexRpcEngine`; pre-feature live/restored Trae remains local/legacy; worker proxy methods preserve current first-turn exactly-once discriminated result; worker exit/restart calls detach and leaves runtime/App Server alive; permanent close is not reachable through proxy `stop`; runtime notifications expose contiguous `[fromSeq, throughSeq]` intervals and are cumulatively ACKed only after idempotent application, worker→daemon interval commit, durable SessionStore update to `throughSeq`, and matching daemon ACK; runtime `ack_events(throughSeq)` is always last. Prove stale generation/session/epoch, interval gaps, invalid ranges, advancing overlaps, and regressions are rejected; any otherwise-valid duplicate interval ending exactly at the persisted high-water mark is positively ACKed without a second SessionStore write; SIGKILL before/after the durable daemon ACK replays or resumes correctly from a newly constructed worker. Under pressure, prove multiple adjacent deltas coalesce into one interval that starts at the prior cursor plus one and commits directly through its final sequence, while terminal and `request_user_input` entries remain separate and are never dropped; journal overflow rejects a new main turn; a stale runtime cursor is rejected; remote TUI reconnects to the same App Server URL and thread.

```ts
const before = await runtime.inspectSession(sessionId);
await proxy.stop();
const after = await runtime.inspectSession(sessionId);
expect(after.appServerPid).toBe(before.appServerPid);
expect(after.nativeThreadId).toBe(before.nativeThreadId);
expect(after.attachments).toBe(0);
```

- [ ] **Step 2: Verify RED**

```bash
./node_modules/.bin/vitest run --project unit test/btw-runtime-main-proxy.test.ts test/btw-worker-proxy-wiring.test.ts test/codex-rpc-lifecycle.test.ts test/traex-worker-bridge-wiring.test.ts test/codex-rpc-engine.test.ts
```

Expected: FAIL because persistent session ownership/proxy/journal selection is absent.

- [ ] **Step 3: Implement Trae-only ownership and attach semantics**

Have the runtime instantiate `CodexRpcSession` for an eligible frozen Trae profile and retain the original process/thread across client disconnect. Keep `codexRpcEligible` as the existing base gate, then add a cold-generation ownership decision; a restored generation without runtime metadata cannot become managed in place. Register main-turn ownership before submission, publish normalized events into a bounded per-session journal, and bind trusted caller/turn/attempt identity before each main turn. In `core/worker-pool.ts`, implement the frozen generation/session/epoch/contiguous-range CAS and acknowledge only after `sessionStore.updateSession` persists `throughSeq`. In `worker.ts`, apply each notification interval idempotently, await that daemon persistence ACK, then cumulatively call runtime `ack_events(throughSeq)`; use the proxy only for managed Trae, retain the official `--remote ... resume <threadId>` viewer and all existing terminal rendering, and change teardown/restart paths for that proxy to detach only.

- [ ] **Step 4: Verify GREEN, commit, push, and integrate**

```bash
./node_modules/.bin/vitest run --project unit test/btw-runtime-main-proxy.test.ts test/btw-worker-proxy-wiring.test.ts test/codex-rpc-lifecycle.test.ts test/traex-worker-bridge-wiring.test.ts test/codex-rpc-engine.test.ts
bun run build
git diff --check
git add src/features/btw/runtime-server.ts src/features/btw/runtime-client.ts src/codex-rpc-session.ts src/codex-rpc-lifecycle.ts src/core/worker-pool.ts src/worker.ts src/types.ts test/btw-runtime-main-proxy.test.ts test/btw-worker-proxy-wiring.test.ts test/codex-rpc-lifecycle.test.ts test/traex-worker-bridge-wiring.test.ts
git commit -m "feat(btw): 代理持久 Trae 主会话"
git push -u fork HEAD:task/btw-u2c-trae-proxy
TASK_COMMIT=$(git rev-parse HEAD)
cd /data00/home/wangqiyilang/playground/.worktree/btw-lark-reliable-delivery/botmux
git cherry-pick "$TASK_COMMIT"
bun run build && bun run daemon:restart
git push fork HEAD:feat/btw-lark-reliable-delivery
```

### Task 8: Transfer the frozen MCP generation and pending ask custody (U2d)

**Files:**
- Modify: `src/features/btw/runtime-server.ts`
- Modify: `src/features/btw/runtime-client.ts`
- Modify: `src/core/plugins/mcp/host.ts`
- Modify: `src/core/plugins/mcp/session-runtime.ts`
- Modify: `src/worker.ts`
- Create: `test/btw-runtime-support-continuity.test.ts`
- Modify: `test/plugin-mcp-gateway.test.ts`
- Modify: `test/ask-resume-restart.test.ts`

**Interfaces:**
- Consumes `FrozenBtwSessionProfile.mcpManifest`, `mcpManifestDigest`, `request_user_input`, `answer_user_input`, and main-event cursor commands.
- Extends `startSessionMcpGatewayHost` with `manifest?: SessionMcpRuntimeManifest | null` so the runtime starts `PluginMcpGateway` from the frozen payload instead of rereading current registry state.
- Produces one runtime-owned pending-ask record per native request ID; worker remains the Lark UI bridge and answers through `answer_user_input`.

- [ ] **Step 1: Write failing support-continuity tests**

Hold a fake main turn across worker replacement. Assert unchanged MCP socket/inode and manifest digest, no registry reread, trusted turn identity preserved, pending `request_user_input` replayed to the replacement worker, exact answer accepted once, expiration or explicit stop sends `turn/interrupt` rather than empty answers, and metadata/title operations continue. Assert config/manifest drift is returned to the worker but cannot mutate the live generation.

```ts
await first.detach();
fakeServer.requestUserInput('ask-native-1');
const second = await client.attachSession({ sessionId, cursor: first.attachment.notificationCursor });
for await (const event of second.notifications) {
  expect(event).toMatchObject({
    kind: 'request_user_input',
    payload: { requestId: 'ask-native-1' },
  });
  break;
}
```

- [ ] **Step 2: Verify RED**

```bash
./node_modules/.bin/vitest run --project unit test/btw-runtime-support-continuity.test.ts test/plugin-mcp-gateway.test.ts test/ask-resume-restart.test.ts test/traex-worker-bridge-wiring.test.ts
```

Expected: FAIL because MCP/ask ownership still dies with the worker.

- [ ] **Step 3: Implement frozen-generation support custody**

Allow `PluginMcpGateway`/host construction from the supplied manifest payload. Start the gateway before the App Server; write its socket into the frozen App Server environment, merge sanitized bot env first, and call `applySessionOwnerEnv` last. Keep `request_user_input` pending in runtime memory/journal until answered, interrupted, or expired. The worker converts it through the existing Lark ask broker and sends only the protocol result back. A worker disconnect never answers `{ answers: {} }`, never interrupts the main turn, and never rotates the runtime-owned generation.

- [ ] **Step 4: Verify GREEN, commit, push, and integrate**

```bash
./node_modules/.bin/vitest run --project unit test/btw-runtime-support-continuity.test.ts test/plugin-mcp-gateway.test.ts test/ask-resume-restart.test.ts test/traex-worker-bridge-wiring.test.ts
bun run build
git diff --check
git add src/features/btw/runtime-server.ts src/features/btw/runtime-client.ts src/core/plugins/mcp/host.ts src/core/plugins/mcp/session-runtime.ts src/worker.ts test/btw-runtime-support-continuity.test.ts test/plugin-mcp-gateway.test.ts test/ask-resume-restart.test.ts
git commit -m "feat(btw): 保持工具与问询运行时连续"
git push -u fork HEAD:task/btw-u2d-support-custody
TASK_COMMIT=$(git rev-parse HEAD)
cd /data00/home/wangqiyilang/playground/.worktree/btw-lark-reliable-delivery/botmux
git cherry-pick "$TASK_COMMIT"
bun run build && bun run daemon:restart
git push fork HEAD:feat/btw-lark-reliable-delivery
```

### Task 9: Implement the Trae native BTW adapter and uncertainty boundary (U3; after Task 8)

**Files:**
- Create: `src/features/btw/trae-adapter.ts`
- Create: `test/btw-trae-adapter.test.ts`
- Modify: `src/features/btw/runtime-server.ts`
- Modify: `src/codex-rpc-session.ts`
- Modify: `test/fixtures/fake-codex-rpc-server.mjs`

**Interfaces:**
- Implements Task 1's `BtwAdapter` for one frozen `CodexRpcSession`.
- Produces the runtime-owned resolver `resolveBtwAdapter(parent: FrozenBtwParent): BtwAdapter | undefined`, which returns an adapter only for a live, matching Trae session generation with all four capabilities. Task 9 installs this resolver into the Task 6 wake queue and starts the single-flight CAS executor. Missing/mismatched adapters leave `accepted` durable and undispatched while the same generation may still attach; reconciliation converts it to `interrupted` if that immutable parent epoch/session is no longer live.
- Constructor: `createTraeBtwAdapter({ session, threadId, nativeTurnIdForRequest, onFrameState, onTerminal }): BtwAdapter`, where the runtime binds `nativeTurnIdForRequest(requestId)` to the already-durable operation record. The public contributor contract remains `{ requestId, question }`; adapters never reinterpret that ID as a native ID or know Lark scope.
- `onFrameState(event: { requestId: string; nativeTurnId: string; runtimeEpoch: string; state: 'definitely_unsent' | 'may_have_been_sent' | 'acknowledged' }): Promise<void>` is awaited at every transport boundary before processing continues.
- `onTerminal(event: { requestId: string; nativeTurnId: string; terminal: BtwNativeTerminalOutcome }): Promise<void>` is awaited before releasing native ownership. A failed terminal's optional `errorCode` is copied unchanged to `operation.execution.errorCode`; human-readable detail goes to `operation.execution.message`. If `run()` already returned `submission_unknown`, the same-connection owner remains registered and a later authoritative terminal still calls this hook; runtime/App Server loss releases it through runtime reconciliation as `interrupted`, never through the adapter.

- [ ] **Step 1: Write failing native-protocol tests**

Extend the fake App Server with `turn/btw`, caller-selected IDs, delta/completed/failed notifications, terminal-before-ACK, concurrent out-of-order completion, pre-send throw, post-send timeout/disconnect, duplicate/conflicting terminal, and an injected BTW tool event. Assert the adapter sends only `{threadId, question, turnId}`, returns the complete `completed.answer`, maps failed/cancelled/submission-unknown exactly, resolves by native ID rather than arrival order, and interrupts/fails a BTW on any tool request/execution event without granting a side effect. The tool-event case must produce `{ status: 'failed', errorCode: 'btw_tool_event_forbidden', ... }`, and the runtime store must persist that exact code.

```ts
const [slow, fast] = await Promise.all([
  adapter.run({ requestId: 'btw-a', question: 'slow' }),
  adapter.run({ requestId: 'btw-b', question: 'fast' }),
]);
expect({ slow, fast }).toEqual({
  slow: { status: 'completed', answer: 'answer-a' },
  fast: { status: 'completed', answer: 'answer-b' },
});
expect(fakeServer.submissionsByTurnId).toEqual({ nativeA: 1, nativeB: 1 });
```

- [ ] **Step 2: Verify RED**

```bash
./node_modules/.bin/vitest run --project unit test/btw-trae-adapter.test.ts test/codex-rpc-engine.test.ts
```

Expected: FAIL because no `turn/btw` adapter or native notification routing exists.

- [ ] **Step 3: Implement exact native ownership and no-tool enforcement**

Resolve the native turn ID from the runtime's already-durable operation record, register its owner/promise before `requestWithDispatchBoundary` writes, and never infer ownership from “one pending request.” Await the operation-specific frame callback so A/B interleaving can never mutate the wrong record and durability precedes the next transport step. Persist `may_have_been_sent` immediately after successful `WebSocket.send`; timeout/error afterward returns `submission_unknown` without a retry, but retains the same-connection terminal owner until a terminal or connection death. Await `onTerminal` before releasing that owner so a late authoritative terminal can settle the runtime store, including its stable `errorCode`. Ignore deltas for projection. Treat server tool requests and tool-execution notifications carrying the BTW native ID as protocol violations: deny them, issue `turn/interrupt`, and resolve failed with `errorCode='btw_tool_event_forbidden'`. Install the adapter resolver and executor consumer into the Task 6 wake queue: `record_card` makes `accepted` work executable, the executor claims it under store CAS, and runtime restart scans the same state without double-dispatch. Test the previously stranded-daemon case here: an `accepted` record is automatically submitted exactly once even if the daemon dies before `submit_btw`, and concurrent wake commands still invoke one adapter.

- [ ] **Step 4: Verify GREEN, commit, push, and integrate**

```bash
./node_modules/.bin/vitest run --project unit test/btw-trae-adapter.test.ts test/codex-rpc-engine.test.ts
bun run build
git diff --check
git add src/features/btw/trae-adapter.ts src/features/btw/runtime-server.ts src/codex-rpc-session.ts test/btw-trae-adapter.test.ts test/fixtures/fake-codex-rpc-server.mjs
git commit -m "feat(btw): 接入 Trae 原生旁问"
git push -u fork HEAD:task/btw-u3-trae-adapter
TASK_COMMIT=$(git rev-parse HEAD)
cd /data00/home/wangqiyilang/playground/.worktree/btw-lark-reliable-delivery/botmux
git cherry-pick "$TASK_COMMIT"
bun run build && bun run daemon:restart
git push fork HEAD:feat/btw-lark-reliable-delivery
```

### Task 10: Render and project one durable BTW card (U4a)

**Files:**
- Create: `src/features/btw/card.ts`
- Create: `src/features/btw/projector.ts`
- Create: `test/btw-card.test.ts`
- Create: `test/btw-projector.test.ts`
- Modify: `test/lark-transport-boundary.test.ts`
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`

**Interfaces:**
- Consumes Task 1's operation/projection types and runtime client's initial-card attempt/record plus `list_pending_projections`, `record_projection_failure`, and `ack_projection`.
- Produces `buildBtwCard(operation, locale): string`, `createBtwProjector(...)`, `projector.ensureInitialCard(operation): Promise<{ kind: 'recorded'; operation: BtwOperation } | { kind: 'pending' | 'unknown'; operation: BtwOperation }>`, and `projector.drainApp(larkAppId): Promise<void>`. There is no `{ kind: 'failed' }` initial-card result: definitely-unsent creation failures remain bounded and pending; ambiguous creation returns `unknown` while retryable and becomes the durable `card_unknown` operation state only after its deadline.
- This module is the sole Lark-call owner. The coordinator and startup recovery call `ensureInitialCard`; a positive provider response is committed only through runtime `recordCard`, while definitely-unsent/ambiguous attempts use `recordInitialCardAttempt`. Generic projection ACK never reports initial-card success. All methods are per-operation single-flight, so duplicate ingress and recovery cannot issue parallel creates.

- [ ] **Step 1: Write failing renderer/projector tests**

Verify exact Chinese and English cards for received/running/completed/failed/cancelled/interrupted/submission-unknown/card-unknown/delivery-failed; card is independent and contains no session-control actions or pin request. For transport, assert frozen target routing for group topic, regular group, `p2pMode=thread`, and `p2pMode=chat`; concurrent duplicate ingress/recovery invokes one initial create with `createUuid`; terminal PATCH targets the original `messageId` until explicit withdrawal, then every current/later revision targets the single persisted `replacementMessageId`. Timeout/429/5xx/ambiguous failures retain a durable `retryAt`; locally detected payload overflow creates and then PATCHes a bounded failure-view revision; deterministic non-retryable provider rejection blocks the exact revision without falsely advancing `patchedRevision`; only `MessageWithdrawnError` records intent before creating the stable replacement once. Successful PATCH or `replacement_created` advances the exact `patchedRevision` and queues one stable reminder; ambiguous reminder is not repeated; stale ACK cannot suppress a newer revision; oversized answers remain durable and produce a visible delivery-failed card when the bounded fallback PATCH succeeds, rather than truncation or message fan-out.

```ts
await projector.drainApp('cli_a');
expect(updateMessage).toHaveBeenCalledWith('cli_a', 'om_card_1', expect.stringContaining('完整答案'));
expect(runtime.ackProjection).toHaveBeenCalledWith(
  scope, opId,
  { operationRevision: terminalOperationRevision, projectionRevision: terminalProjectionRevision },
  { kind: 'patched' },
);
expect(replyMessage).toHaveBeenCalledTimes(1);
```

- [ ] **Step 2: Verify RED**

```bash
./node_modules/.bin/vitest run --project unit test/btw-card.test.ts test/btw-projector.test.ts
```

Expected: FAIL because the BTW card and projector do not exist.

- [ ] **Step 3: Implement bounded cards and CAS projection**

Build a small display-only interactive card. Before attempting a result PATCH, serialize and enforce the existing Feishu card budget (~109 KB including structure/escaping); on local overflow call `recordProjectionFailure(scope, btwOpId, expected, { kind: 'visible_fallback', errorCode: 'payload_too_large', message })`, retain the full durable answer, re-list the newly desired bounded failure view, and PATCH that view before ACKing it. Classify timeout/429/5xx and ambiguous transport results as retryable with persisted bounded exponential backoff; classify only `MessageWithdrawnError` as replacement permission. Deterministic provider rejection calls the same method with `kind: 'provider_permanent'`, records a bounded diagnostic, and blocks that exact revision without claiming it became visible. Never spin on a permanent error. Do not import or call `scheduleCardPatch`, pin APIs, main-card builders, or session lifecycle helpers.

- [ ] **Step 4: Verify GREEN, commit, push, and integrate**

```bash
./node_modules/.bin/vitest run --project unit test/btw-card.test.ts test/btw-projector.test.ts test/lark-transport-boundary.test.ts
bun run build
git diff --check
git add src/features/btw/card.ts src/features/btw/projector.ts src/i18n/zh.ts src/i18n/en.ts test/btw-card.test.ts test/btw-projector.test.ts test/lark-transport-boundary.test.ts
git commit -m "feat(btw): 投影独立飞书结果卡"
git push -u fork HEAD:task/btw-u4a-lark-projector
TASK_COMMIT=$(git rev-parse HEAD)
cd /data00/home/wangqiyilang/playground/.worktree/btw-lark-reliable-delivery/botmux
git cherry-pick "$TASK_COMMIT"
bun run build && bun run daemon:restart
git push fork HEAD:feat/btw-lark-reliable-delivery
```

### Task 11: Intercept `/btw`, enforce the managed gate, and isolate legacy B (U4b)

**Files:**
- Create: `src/features/btw/coordinator.ts`
- Modify: `src/features/btw/runtime-server.ts`
- Modify: `src/features/btw/runtime-client.ts`
- Modify: `src/features/btw/projector.ts`
- Modify: `src/core/passthrough-commands.ts`
- Modify: `src/core/command-handler.ts`
- Modify: `src/daemon.ts`
- Modify: `src/types.ts`
- Modify: `src/core/worker-pool.ts`
- Modify: `src/worker.ts`
- Modify: `src/i18n/zh.ts`
- Modify: `src/i18n/en.ts`
- Create: `test/btw-coordinator.test.ts`
- Create: `test/btw-ingress-isolation.test.ts`
- Modify: `test/command-handler.test.ts`
- Modify: `test/initial-passthrough-ownership.test.ts`
- Modify: `test/transfer-passthrough-gate.test.ts`

**Interfaces:**
- Consumes runtime `prepare_btw`, initial-card attempt/record, idempotent `submit_btw`, Task 10 projector, live attachment capabilities, and `parseSlashCommandInvocation`.
- Produces `handleBtwInvocation(input): Promise<'managed' | 'legacy' | 'unsupported' | 'usage'>`.
- Produces one daemon-owned `BtwProjectorService` per app with `start()`, `wake()`, and `stop({ drainMs })`: startup connects to any compatible runtime and immediately scans both pending initial cards and result projections; the runtime's payload-free app-scoped `watchProjectionWakes` stream and persisted retry timers wake a single-flight drain; reconnect always re-lists durable work, and shutdown cancels only the daemon loop, never the runtime.
- Adds `DaemonToWorker` event `{ type: 'legacy_btw_raw_input'; content: string }`; it carries no turn ID, reply ID, follow-up, or operation state.

- [ ] **Step 1: Write failing coordinator and ingress tests**

Test all sixteen capability rows and both new-topic/existing-topic ingress sites. Managed ordering must be observable as `prepare_btw → ensure_initial_card/record_card → submit_btw`; duplicate inbound request plus simultaneous recovery scan returns the same operation/card and adapter count stays one; kill the daemon after `record_card` returns and before its `submit_btw` wake, then prove the runtime submits exactly once and the replacement daemon patches the original card without another inbound message. Session movement after prepare does not change the frozen target; empty input is usage-only. Legacy raw-capable rows write once and send an immediately settled warning; no-raw rows report unsupported and write zero times. Snapshot before/after every main-turn invariant across acceptance, completed/failed/cancelled/submission-unknown/interrupted, PATCH retry/replacement, daemon restart, and main-turn completion/cancellation while BTW runs; spy on `beginNewTurn`, `beginReplyTargetTurn`, `markSessionActivity`, main card/reaction/fallback/timeout functions, and `final_output`; expect no call/change.

```ts
const before = snapshotMainTurnState(ds);
await handleBtwInvocation(makeInvocation({ capabilities: allTrue }));
expect(callOrder).toEqual(['prepare_btw', 'ensure_initial_card', 'record_card', 'submit_btw']);
expect(snapshotMainTurnState(ds)).toEqual(before);
expect(beginNewTurnSpy).not.toHaveBeenCalled();
expect(worker.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'raw_input' }));
```

- [ ] **Step 2: Verify RED**

```bash
./node_modules/.bin/vitest run --project unit test/btw-coordinator.test.ts test/btw-ingress-isolation.test.ts test/command-handler.test.ts test/initial-passthrough-ownership.test.ts test/transfer-passthrough-gate.test.ts
```

Expected: FAIL because `/btw` is still routed through generic passthrough/main-turn setup.

- [ ] **Step 3: Implement the dedicated route and legacy event**

Remove `/btw` from `PASSTHROUGH_COMMANDS` and recognize it as a dedicated command before generic passthrough at both daemon ingress paths. Resolve capabilities from the live persistent attachment plus frozen parent metadata. Managed coordinator performs only the strict acceptance sequence through the projector-owned initial-card seam, then sends an idempotent executor wake. At daemon bootstrap, create/start the per-app projector service, immediately recover due `card_pending` work and pending terminal projections, consume the payload-free `watchProjectionWakes` stream, and schedule retries from durable `retryAt`; on stream disconnect, reconnect and re-list before waiting again. Stopping/restarting the daemon stops only that service. Legacy sends `legacy_btw_raw_input`; worker routes that message only through the existing literal raw writer and safety gates, then daemon sends a non-working acknowledgement. Do not attach a turn ID or call the generic passthrough wrapper. Keep every other passthrough command unchanged.

- [ ] **Step 4: Verify GREEN, commit, push, and integrate**

```bash
./node_modules/.bin/vitest run --project unit test/btw-coordinator.test.ts test/btw-ingress-isolation.test.ts test/command-handler.test.ts test/initial-passthrough-ownership.test.ts test/transfer-passthrough-gate.test.ts test/traex-worker-bridge-wiring.test.ts
bun run build
git diff --check
git add src/features/btw/coordinator.ts src/features/btw/runtime-server.ts src/features/btw/runtime-client.ts src/features/btw/projector.ts src/core/passthrough-commands.ts src/core/command-handler.ts src/daemon.ts src/types.ts src/core/worker-pool.ts src/worker.ts src/i18n/zh.ts src/i18n/en.ts test/btw-coordinator.test.ts test/btw-ingress-isolation.test.ts test/command-handler.test.ts test/initial-passthrough-ownership.test.ts test/transfer-passthrough-gate.test.ts
git commit -m "feat(btw): 隔离旁问接入与主任务状态"
git push -u fork HEAD:task/btw-u4b-command-ingress
TASK_COMMIT=$(git rev-parse HEAD)
cd /data00/home/wangqiyilang/playground/.worktree/btw-lark-reliable-delivery/botmux
git cherry-pick "$TASK_COMMIT"
bun run build && bun run daemon:restart
git push fork HEAD:feat/btw-lark-reliable-delivery
```

### Task 12: Add permanent close, global stop, and app-scoped stop semantics (U5a)

**Files:**
- Modify: `src/features/btw/runtime-server.ts`
- Modify: `src/features/btw/runtime-client.ts`
- Modify: `src/features/btw/projector.ts`
- Modify: `src/daemon.ts`
- Modify: `src/core/worker-pool.ts`
- Modify: `src/cli.ts`
- Create: `test/btw-runtime-lifecycle.test.ts`
- Modify: `test/btw-projector.test.ts`
- Modify: `test/daemon-ipc-session-auth.test.ts`
- Modify: `test/close-consumer-matrix.test.ts`
- Modify: `test/shutdown-supervisor-contract.test.ts`
- Modify: `test/fleet-runtime.test.ts`
- Modify: `test/close-stream-card-untouched.test.ts`

**Interfaces:**
- Consumes the frozen two-phase lifecycle commands `quiesce_session`/`close_session`, `quiesce_app`/`close_app`, and `quiesce_all`/`shutdown_runtime`.
- Produces `closeManagedBtwSession(sessionId)`, `stopAllManagedBtwRuntime({ drainMs })`, and `stopManagedBtwApp(larkAppId, { drainMs })`; quiesce returns the frozen projection watermarks.
- Extends each app projector with `drainUntil(input: { watermarks: readonly BtwProjectionWatermark[]; drainMs: number }): Promise<{ reached: BtwProjectionWatermark[]; pending: BtwProjectionWatermark[] }>` and adds one authenticated host-only daemon IPC action `drain_btw_projections` that calls it. A watermark is `reached` only when its revision is PATCH-ACKed or durably blocked by `recordProjectionFailure({ kind: 'provider_permanent', ... })`; all unreached entries are returned as `pending` when the shared deadline expires. The daemon route never owns runtime lifecycle.
- Keeps `stopFleet()` and `restartFleet()` signatures and semantics unchanged.

- [ ] **Step 1: Write failing lifecycle-order tests**

Assert permanent close orders `quiesce_session → bounded projector wake/drain → close_session → worker/store teardown`, marks in-flight operations interrupted, preserves terminal operations, closes the App Server with PID/start-identity verification, and never affects another session. Assert `cmdStop` order is `quiesce_all → bounded projector wake/drain → shutdown_runtime → stopFleet`; `cmdRestart` calls only `restartFleet` and retains runtime PID/epoch; `stop-bot appA` orders `quiesce_app → bounded projector wake/drain → close_app → supervisor stop` even if that daemon is already stopped, while appB remains attached. On timeout/unreachable daemon, the appropriate close/shutdown and fleet stop still proceed; an unverified PID is never signalled.

```ts
expect(stopOrder).toEqual([
  'quiesce_all',
  'drain_projection',
  'shutdown_runtime',
  'stop_fleet',
]);
expect(restartOrder).toEqual(['restart_fleet']);
```

- [ ] **Step 2: Verify RED**

```bash
./node_modules/.bin/vitest run --project unit test/btw-runtime-lifecycle.test.ts test/btw-projector.test.ts test/daemon-ipc-session-auth.test.ts test/close-consumer-matrix.test.ts test/shutdown-supervisor-contract.test.ts test/fleet-runtime.test.ts
```

Expected: FAIL because runtime close/quiesce orchestration is not wired.

- [ ] **Step 3: Implement explicit lifecycle orchestration**

From authoritative `core/worker-pool.ts::closeSession`, quiesce the runtime session, ask the owning daemon projector to drain its returned watermarks, then call runtime `close_session` before removing the session/worker. Add global/scoped runtime controls to CLI orchestration, not to fleet primitives. Every runtime quiesce first rejects new managed submissions, durably interrupts in-flight work, publishes payload-free wakes, and returns affected app IDs plus exact durable projection watermarks without terminating an App Server. The CLI calls each still-running daemon's authenticated `drain_btw_projections` action with those watermarks and the remaining shared deadline; an unreachable daemon or expired drain is recorded but does not prevent the matching second-phase `close_session`, `close_app`, or `shutdown_runtime`, followed by fleet stop where applicable. Each close command terminates only identity-verified App Server groups in its scope; whole-runtime shutdown closes every remaining group and then the runtime. `stop-bot` filters by the frozen operation/session `larkAppId`, never by mutable bot config.

- [ ] **Step 4: Verify GREEN, commit, push, and integrate**

```bash
./node_modules/.bin/vitest run --project unit test/btw-runtime-lifecycle.test.ts test/btw-projector.test.ts test/daemon-ipc-session-auth.test.ts test/close-consumer-matrix.test.ts test/shutdown-supervisor-contract.test.ts test/fleet-runtime.test.ts test/close-stream-card-untouched.test.ts
bun run build
git diff --check
git add src/features/btw/runtime-server.ts src/features/btw/runtime-client.ts src/features/btw/projector.ts src/daemon.ts src/core/worker-pool.ts src/cli.ts test/btw-runtime-lifecycle.test.ts test/btw-projector.test.ts test/daemon-ipc-session-auth.test.ts test/close-consumer-matrix.test.ts test/shutdown-supervisor-contract.test.ts test/fleet-runtime.test.ts test/close-stream-card-untouched.test.ts
git commit -m "feat(btw): 接入旁问显式关闭语义"
git push -u fork HEAD:task/btw-u5a-lifecycle-stop
TASK_COMMIT=$(git rev-parse HEAD)
cd /data00/home/wangqiyilang/playground/.worktree/btw-lark-reliable-delivery/botmux
git cherry-pick "$TASK_COMMIT"
bun run build && bun run daemon:restart
git push fork HEAD:feat/btw-lark-reliable-delivery
```

### Task 13: Prove restart, crash, security, and no-replay guarantees with fault injection (U5b)

**Files:**
- Create: `test/fixtures/fake-btw-lark.ts`
- Create: `test/btw-runtime.e2e.ts`
- Create: `test/btw-restart.e2e.ts`
- Modify: `test/fixtures/fake-codex-rpc-server.mjs`
- Modify: `test/restart-live-worker-env.test.ts`

**Interfaces:**
- Consumes the complete U1-U4 surface; produces no production API.
- Fake Lark exposes barriers/faults for definitely-unsent create, accepted-with-lost-response create, PATCH timeout/429/5xx, withdrawn, accepted-with-lost-response reminder, and payload-too-large.
- Fake App Server exposes per-native-ID submission counts, barriers, event-before-ACK, disconnect, crash, and tool-event injection.

- [ ] **Step 1: Build the end-to-end fault harness**

Use real child processes via `test/helpers/ts-runner.ts`, temporary data directories, one runtime, fake App Server, fake Lark, daemon/worker harnesses, and process-start identity probes. Test two same-parent operations where B finishes before A. Hold them across (a) a real CLI `restart` seam, (b) daemon SIGKILL/reconstruction, and (c) worker-only SIGKILL/reconstruction. Assert unchanged runtime/App Server PIDs, epoch, thread/native IDs, exactly one native submission per op, terminal/replayed ask delivered once from the durable cursor, original-card-only terminal PATCH, and unchanged main-state snapshot. Add crash barriers after operation publish, provider card acceptance, `record_card`, submission prepare, frame acceptance, terminal persistence, cursor application, cursor persistence, projection ACK, and reminder acceptance. Kill the runtime/App Server separately and assert old `submit_prepared→submission_unknown`, old `running→interrupted`, no replay, verified orphan cleanup only, and future work starts a new generation.

- [ ] **Step 2: Run the integrated fault suite and require GREEN**

```bash
./node_modules/.bin/vitest run --project e2e test/btw-runtime.e2e.ts test/btw-restart.e2e.ts
```

Expected: PASS against Tasks 1-12. This is an integration acceptance task, not a production implementation task; do not weaken assertions to accommodate a replay or identity change.

- [ ] **Step 3: Keep this task harness-only and route defects to exact owners**

Exercise stale socket, wrong token/UID, PID reuse, old epoch, concurrent ensure, corrupt exact key/sibling, config drift, incompatible protocol, all Lark failure classes, session close/global stop/scoped stop-bot, new topic/group/DM shapes, and legacy fallback. Do not change production code in this task. Keep `FleetSupervisor`, low-level Lark client methods, and non-Trae adapter code unchanged unless a dedicated repair test proves a read-only seam is required.

If any assertion fails, stop and preserve the dirty harness before rebasing. First commit the failing harness **locally without pushing** as a temporary checkpoint containing only Task 13's test/fixture files. In the integration worktree, add a new numbered RED→GREEN repair task immediately before Task 13 in this plan, naming only the owning production/test files and exact selector; stage the ignored plan explicitly with `git add -f docs/superpowers/plans/2026-09-01-managed-btw-lark-delivery.md`, then commit and push that documentation-only plan update. Create the repair worktree from that updated integration tip, implement/verify/commit/push the repair, cherry-pick it into the integration branch, run the integration build/restart gate, and push that branch. Only then return to the now-clean harness worktree, run `git fetch fork feat/btw-lark-reliable-delivery && git rebase fork/feat/btw-lark-reliable-delivery`, rerun the full Task 13 suites, and amend the checkpoint into the final GREEN harness commit before its first push. Repeat with a new numbered repair if another production defect appears. This is the sole local-before-push checkpoint exception and never uses stash or destructive reset.

- [ ] **Step 4: Verify GREEN, commit, push, and integrate**

```bash
./node_modules/.bin/vitest run --project unit test/btw-*.test.ts test/codex-rpc-engine.test.ts test/codex-rpc-lifecycle.test.ts test/command-handler.test.ts test/traex-worker-bridge-wiring.test.ts test/plugin-mcp-gateway.test.ts test/ask-resume-restart.test.ts test/restart-live-worker-env.test.ts test/shutdown-supervisor-contract.test.ts
./node_modules/.bin/vitest run --project e2e test/btw-runtime.e2e.ts test/btw-restart.e2e.ts
bun run build
git diff --check
git add test/fixtures/fake-btw-lark.ts test/btw-runtime.e2e.ts test/btw-restart.e2e.ts test/fixtures/fake-codex-rpc-server.mjs test/restart-live-worker-env.test.ts
git commit -m "test(btw): 验证重启与故障恢复边界"
git push -u fork HEAD:task/btw-u5b-fault-harness
TASK_COMMIT=$(git rev-parse HEAD)
cd /data00/home/wangqiyilang/playground/.worktree/btw-lark-reliable-delivery/botmux
git cherry-pick "$TASK_COMMIT"
bun run build && bun run daemon:restart
git push fork HEAD:feat/btw-lark-reliable-delivery
```

If Step 3 used the repair path, replace the `git add` / `git commit` / first-push
portion above with the following after the rebased suites and build pass; this
keeps one harness commit and makes its first remote publication GREEN:

```bash
git add test/fixtures/fake-btw-lark.ts test/btw-runtime.e2e.ts test/btw-restart.e2e.ts test/fixtures/fake-codex-rpc-server.mjs test/restart-live-worker-env.test.ts
git commit --amend --no-edit
git push -u fork HEAD:task/btw-u5b-fault-harness
```

### Task 14: Run artifact/real-Trae/live-Lark acceptance and publish the evidence (U5c)

**Files:**
- Create: `test/btw-trae.e2e.ts`
- Modify: `scripts/smoke-bun-binary.mjs`
- Modify: `docs/superpowers/specs/2026-09-01-managed-btw-lark-delivery-design.md`
- Create: `docs/verification/2026-09-01-managed-btw-lark-delivery.md`
- Create: `docs/verification/2026-09-01-managed-btw-lark-delivery.png`

**Interfaces:**
- Adds no production interface.
- The environment-gated real test uses `BOTMUX_E2E_TRAE_HOME` as the path to an already authenticated private Trae home and `BOTMUX_E2E_TRAE_BIN` as an absolute executable path. It skips with a named reason when either is absent unless `BOTMUX_E2E_REQUIRE_TRAE=1`, in which case absence or any assertion failure is fatal. The implementation task resolves the current machine's authenticated home/executable by inspecting the existing Trae launch configuration; operators pass the resulting absolute paths to the command below. No credential value is copied into fixtures or verification docs; fake protocol tests remain mandatory.
- The standalone smoke supplies a valid bot fixture so the daemon reaches the runtime path rather than failing at `Invalid BOTMUX_BOT_INDEX=0`.

- [ ] **Step 1: Write the real-Trae and standalone acceptance assertions**

The real Trae test must assert caller-selected BTW ID echo, parent-context marker visibility, no tool execution, two concurrent out-of-order terminals, active-writer rejection by a second App Server, successful main+BTW use by a second client of the same App Server, unchanged runtime/App Server/thread/native identity through a real Botmux restart, and explicit-stop termination. Extend standalone smoke to start with one valid inert bot fixture, launch/handshake the hidden runtime entry, and prove `__dirname`/`/$bunfs` paths never escape into descriptors or child argv.

- [ ] **Step 2: Run targeted acceptance**

```bash
./node_modules/.bin/vitest run --project e2e test/btw-trae.e2e.ts
BOTMUX_E2E_REQUIRE_TRAE=1 \
BOTMUX_E2E_TRAE_BIN=/home/wangqiyilang/.local/bin/traex \
BOTMUX_E2E_TRAE_HOME=/data00/home/wangqiyilang/.trae \
./node_modules/.bin/vitest run --project e2e test/btw-trae.e2e.ts
bun run build
bun run verify:binary
```

Expected: ordinary CI may SKIP the real Trae scenarios with the exact missing gate, while standalone smoke PASSes with a valid bot and reaches runtime launch/attach. However Task 14 is not complete and the design status must not change to `Implemented and verified` until one explicitly configured real-Trae run PASSes every assertion above.

- [ ] **Step 3: Run the complete regression matrix**

```bash
bun run test
bun run test:all
bun run build

./node_modules/.bin/tsx -e "import { readFileSync } from 'node:fs'; import { isDeferredFromBunLeg } from './test/helpers/bun-leg-selectors.ts'; for (const file of process.argv.slice(1)) { if (isDeferredFromBunLeg(readFileSync(file, 'utf8'))) throw new Error(file + ' is deferred from the Bun leg'); }" test/btw-runtime-main-proxy.test.ts test/btw-ingress-isolation.test.ts
bun run test:bun
bun run verify:binary
git diff --check
```

Expected: every command exits 0. Record command, runtime, platform, result, and any environment-gated skip in `docs/verification/2026-09-01-managed-btw-lark-delivery.md`; a skip is evidence of a pending gate, never a pass. `bun run test:bun` plus the fail-closed selector probe is the Bun execution proof because Vitest itself uses Node workers and the Bun runner refuses incomplete runs. Execute and record each row using the named test/harness fixture: Node source + Trae RPC/tmux + new-topic fixture (`btw-restart.e2e.ts`); Bun source + Trae RPC/tmux + resumed regular-group fixture (`test/btw-runtime-main-proxy.test.ts`, proven runnable by the selector probe and covered by the complete Bun leg); Bun standalone + valid-bot DM-thread fixture (`bun run verify:binary` plus real-Trae gate); Node source + Trae/PTY + DM-chat legacy fixture (`btw-ingress-isolation.test.ts`); Bun source + another CLI/tmux + topic legacy/no-raw fixture (the dedicated Task 11 fixture, proven runnable by the same probe and covered by the complete Bun leg); Bun standalone + Trae adopt/unsupported-restore fixture (extended binary smoke). If a named file is deferred, rewrite that test for dependency injection and rerun the probe; a deferred required row is a failed gate. Do not modify `scripts/run-bun-tests.mjs`: its current CLI arguments are forwarded to every selected file and are not a file-filter API.

- [ ] **Step 4: Deploy this checkout for live Lark verification**

```bash
bun run switch:here && bun run daemon:restart
```

From Lark, start an eligible cold Trae session, keep a main task running, issue two `/btw` requests, restart Botmux while both are in flight, and verify: each request has one independent unpinned card; B may finish before A without crossing answers; both patch their original cards after restart; each posts at most one completion reminder; the main task's working card/status/reactions/timeouts remain unchanged. Also verify one ineligible Trae/other-CLI session writes raw input once and immediately closes the terminal-only warning. Save a screenshot with no secrets or personal names to `docs/verification/2026-09-01-managed-btw-lark-delivery.png`.

- [ ] **Step 5: Update status, commit, and push the final evidence**

Before editing evidence, run `git rev-parse HEAD` and label that value as the **tested implementation base SHA**. Change the design status from `Conversational design approved; written-spec review pending.` to `Implemented and verified; see docs/verification/2026-09-01-managed-btw-lark-delivery.md.` Record that tested base SHA, matrix, runtime/App Server identity evidence, card IDs with sensitive values redacted, and the guarantee/non-guarantee boundary; the evidence commit does not self-reference its own not-yet-created hash.
Do not perform this step if the real-Trae run or any matrix row is skipped or red; leave the status unchanged and record the missing gate instead.

```bash
git status --short
git diff --check
git add test/btw-trae.e2e.ts scripts/smoke-bun-binary.mjs docs/superpowers/specs/2026-09-01-managed-btw-lark-delivery-design.md docs/verification/2026-09-01-managed-btw-lark-delivery.md docs/verification/2026-09-01-managed-btw-lark-delivery.png
git commit -m "docs(btw): 记录旁问可靠回传验收"
git push -u fork HEAD:feat/btw-lark-reliable-delivery
git status --short --branch
```

Expected: clean worktree; local branch is `feat/btw-lark-reliable-delivery`; its upstream is `fork/feat/btw-lark-reliable-delivery`; both tips are equal; and the verification document contains actual results rather than predictions. Restore the canonical checkout as the global Botmux target after the user finishes live review:

```bash
cd /data00/home/wangqiyilang/playground/botmux
bun run switch:here && bun run daemon:restart
readlink -f /home/wangqiyilang/.botmux/bin/botmux
```
