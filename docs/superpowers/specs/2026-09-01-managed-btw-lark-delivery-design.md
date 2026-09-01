# Managed `/btw` Lark Delivery Design

## Status

Conversational design approved; written-spec review pending. This document
freezes the design before an implementation plan is written. No production
implementation is part of this commit.

## Context

Botmux currently treats `/btw` as a generic passthrough command. The daemon
forwards the literal command to the interactive CLI and incorrectly starts a
normal Botmux turn around that write. Trae handles `/btw` as a native side
conversation, so its answer is rendered in the terminal but does not produce a
separate parent-turn final event and does not call `botmux send`. Botmux
therefore has no structured answer to deliver to Lark.

This is also why the current behavior distorts the session UI: a side question
can create or extend the main task's working state even though it has no effect
on the main task lifecycle.

The desired behavior is a reliable, independently presented `/btw` answer in
Lark. A request already accepted by Botmux must survive a controlled
`botmux restart` or daemon/worker replacement, continue computing, and update
the same Lark card when it completes. The implementation must remain narrow,
support Trae first, and expose a clear contributor seam for another agent that
later gains equivalent native capabilities.

In this document, "accepted" means that the operation and frozen target are
durable **and** Lark has positively returned the result card's `messageId`. The
earlier `card_pending` phase is prepared but not yet accepted and therefore must
not start native computation.

## Measured Trae protocol facts

The design is based on isolated probes against Trae 0.201.6 rather than TUI
screen inference:

- `turn/btw` accepts `threadId`, `question`, and an optional caller-selected
  `turnId`. It returns that native turn ID.
- `turn/btw/delta`, `turn/btw/completed`, and `turn/btw/failed` are structured
  notifications. The completed event carries the full answer.
- A BTW turn inherits its parent thread context. A probe stored
  `PARENT_CONTEXT_8F42` in the parent turn and the later BTW request returned
  that exact marker.
- Multiple BTW turns can run concurrently on one parent thread. A later request
  can finish before an earlier one, and `threadId + turnId` keeps their events
  distinct.
- A BTW probe that explicitly requested file access emitted no tool event and
  refused the tool request. Managed BTW therefore retains native no-tool
  semantics; it is not a second unrestricted agent turn.
- Supplying a `turnId` does not make submission idempotent. Reusing the same ID
  for two questions was accepted twice and produced conflicting ownership.
  Botmux must prevent duplicate submission before calling Trae.
- A second App Server cannot take ownership of a thread held by another App
  Server. Direct `turn/btw` returned `thread not found`, and
  `thread/resume` returned `thread-store conflict ... active writer`.
- Multiple clients can use one App Server. With a keeper connection holding the
  thread, another connection successfully submitted both `turn/start` and
  `turn/btw`. The remote TUI can remain another viewer connection.

These facts rule out a sidecar App Server dedicated only to BTW. The process
that survives a Botmux restart must own the same App Server that owns the
parent thread.

## Goals

1. Deliver each eligible Trae `/btw` answer to its original Lark context.
2. Preserve accepted, in-flight BTW computation and terminal observation across
   controlled Botmux daemon/worker restarts.
3. Use one independent, patchable Lark card per BTW operation.
4. Keep BTW state entirely separate from the main Botmux turn lifecycle.
5. Prefer at-most-once native execution when delivery acknowledgement is
   ambiguous.
6. Provide a small runtime `BtwAdapter` contract that another contributor can
   implement without learning Lark delivery or main-turn internals.
7. Limit the first release to Trae sessions that already satisfy the existing
   managed RPC constraints.

## Non-goals

- A generic workflow engine, event bus, task scheduler, or arbitrary CLI RPC
  protocol.
- Managed BTW for all Botmux CLI adapters.
- Screen scraping, idle detection, or transcript heuristics for BTW completion.
- Expanding managed RPC to PTY, adopt, existing-App-Server, sandbox, or
  read-isolated sessions in this release.
- Streaming every BTW delta into Lark.
- A `/btw cancel` user command in the first release. The adapter still models a
  native cancellation terminal so later UI support does not change the result
  contract.
- Recovering the same native computation after host reboot, power loss, runtime
  process failure, Trae App Server failure, or disk corruption.
- Changing normal main-task cards, reactions, fallback output, or transcript
  parsing.
- Changing Codex App, externally owned App Server adoption, or non-Trae CLI
  behavior beyond the explicit legacy warning.

## User-visible behavior

### Managed path

One `/btw` message creates one independent BTW card in the frozen reply target.
The initial card shows the question and `旁问已接收`. It is not the session's
main working card and is never pinned as the session-control card.

When the native BTW finishes, Botmux patches the complete answer and terminal
status into that same card. It then sends one short `旁问已完成` reminder using
a stable Lark UUID. The reminder is only a notification; the card is the result
source of truth. The first release does not stream deltas.

Failure, cancellation, submission uncertainty, and interruption also update the
same card. No BTW outcome changes the main task's working or terminal display.
Answers are supported up to the existing Lark card payload limit. If the full
answer cannot be represented within that limit, Botmux retains it durably and
patches the card to a visible `delivery_failed` state rather than silently
truncating or creating an unbounded sequence of result messages. Oversize-file
delivery is a separate enhancement.

### Legacy path

If the managed capability gate fails but the session has a raw interactive
surface, Botmux writes the original `/btw ...` command exactly once. It then
immediately closes an independent acknowledgement as:

> 已转发到终端；答案只会出现在终端，不会回传飞书。

This acknowledgement never remains in a working state and does not create a
managed BTW operation. If the session has no raw surface, Botmux reports that
the command is unsupported and does not execute it. An empty `/btw` reports
usage without touching either lifecycle.

## Managed capability gate

Managed execution is selected only when all four runtime facts are true:

```ts
interface BtwCapabilities {
  nativeBtw: boolean;
  persistentRuntime: boolean;
  structuredTerminal: boolean;
  stableParentThread: boolean;
}
```

Only the all-true combination is managed. Every other combination fails closed
to legacy passthrough or unsupported, depending on raw-surface availability.
The decision uses the live runtime attachment and frozen session metadata; it is
not inferred from `cliId` alone.

For the first release, this means an eligible `traex` session already running
through Botmux's managed RPC mode on the supported tmux path. Existing gates
for startup commands, wrappers, sandboxing, read isolation, adoption, executable
identity, and remote backend support remain authoritative. A failure to start or
authenticate the persistent runtime makes `persistentRuntime` false.

The runtime profile is frozen when the App Server is created. A live session
whose App Server predates this runtime ownership cannot be migrated in place:
it keeps legacy behavior until a later cold session start creates the parent
thread under the persistent runtime. This prevents rollout from killing a live
parent turn merely to make BTW managed.

## Architecture

```text
Lark /btw
    |
    v
daemon BtwCoordinator ---- create/PATCH card ----> Lark
    | prepare / record-card / submit / drain / ack
    v
persistent Codex-family RPC runtime
    |                 |
    | BtwAdapter      | main-turn proxy operations
    v                 v
one Trae App Server per managed session
    ^
    | codex --remote ... resume <threadId>
worker-owned TUI viewer
```

The new process is a single Botmux runtime per data directory. It keeps a map of
managed session runtimes; it does not add one wrapper process per session. Each
managed session still has one Trae App Server child, as it does today.

The runtime is deliberately not registered with `FleetSupervisor`. Daemon and
worker processes are control-plane clients. The runtime is the sole process
owner and the sole stateful JSON-RPC broker for each managed Trae App Server.
This is a lifecycle extraction forced by Trae's active-writer rule, not a new
generic agent runtime.

### `BtwCoordinator`

The daemon intercepts `/btw` before generic passthrough delivery and before any
main-turn setup. The coordinator:

1. resolves the live capability snapshot;
2. freezes the Lark reply target;
3. prepares or retrieves the durable operation by Lark request ID;
4. creates and records the independent card;
5. asks the runtime to submit only after the card is durable; and
6. drains delivery work and applies it to Lark.

The coordinator never calls `beginNewTurn`, `beginReplyTargetTurn`,
`markSessionActivity`, or any equivalent main-turn mutation. It does not send a
`final_output` worker event.

### Persistent RPC runtime

The runtime owns all state that must survive daemon replacement:

- the App Server process group and its identity-checked marker;
- the keeper WebSocket, JSON-RPC request IDs, pending requests, and native event
  listener;
- the parent thread ID and frozen launch/security configuration;
- native main-turn and BTW ownership maps;
- a bounded, cursor-addressed main-turn event journal;
- BTW operation records and delivery outbox;
- server-to-client requests that are waiting for a worker UI; and
- the session MCP gateway used by the App Server process.

The runtime starts lazily when the first eligible session needs it. Concurrent
launchers use a private lock and perform a second authenticated handshake after
winning the lock, so only one runtime is created.

The runtime's control surface uses a private local socket. Its descriptor
contains `{pid, startIdentity, socket, protocolVersion, buildId, epoch}`. The
socket directory is a real `0700` directory owned by the current UID; the socket
and token file are `0600`. The token is stored separately from the public
descriptor. The handshake checks protocol compatibility, runtime epoch, token,
peer locality, and session identity. Frames and queues are bounded.

No environment values, provider credentials, Lark secret, question text, or
answer text are written to the runtime descriptor.

### Worker proxy and TUI viewer

For eligible Trae sessions, the worker-side engine becomes a proxy with the same
high-level methods used today: start/attach, start or resume thread, send first
turn, send main turn, read/set title metadata, and detach. This preserves the
existing first-turn exactly-once state machine and keeps `worker.ts` changes
localized.

Runtime IPC exposes two bounded surfaces, not a general event bus: request/response
methods for thread and turn operations, plus a sequenced per-session notification
stream for normalized App Server events. Requests carry an idempotency key and
expected runtime epoch; notifications carry a sequence and require cumulative
cursor acknowledgement.

`stop()` on this proxy means detach only. A separate, explicit close operation
is available solely to permanent session close and global Botmux stop. Worker
cleanup, IPC disconnect, daemon SIGTERM, viewer exit, and in-worker viewer
restart must never kill or reap the runtime-owned App Server.

The TUI remains an official `--remote` viewer connected to the runtime's App
Server URL and parent thread. Terminal rendering, Web terminal behavior, idle
detection, and transcript fallback stay worker-owned. The worker may be replaced
and reconnect the viewer without changing the App Server or thread identity.

The stateful broker must not reduce main-turn delivery to a live callback. It
assigns a monotonically increasing per-session sequence to normalized main-turn
events and retains them until the attached worker acknowledges a cursor. During
a disconnect, stream deltas may be coalesced into a bounded snapshot, but a
terminal event and a pending `request_user_input` event are retained and replayed
until acknowledged. A replacement worker supplies its last durable cursor,
deduplicates by sequence, then resumes live delivery. Journal overflow fails
closed for new main-turn submissions; it never drops an unacknowledged terminal.

Codex RPC sessions retain the current worker-owned engine in this release. Only
managed Trae RPC sessions use the persistent proxy, avoiding an unnecessary
cross-CLI lifecycle change.

### Execution support owned with the App Server

The App Server, not the viewer TUI, executes model tools. Keeping only the App
Server alive while its MCP gateway disappears would create a restart regression
for an in-flight main turn. The session MCP host therefore shares the persistent
runtime lifecycle. The worker prepares the normal plugin/skill generation, and
the runtime starts or retains the gateway from that frozen manifest before it
starts the App Server.

The manifest payload and digest are part of the session runtime generation. A
worker reattach reuses that exact generation and must not regenerate the catalog,
rotate the gateway socket, or replace the gateway host from current `bots.json`.
Configuration drift is reported as such while the old generation remains usable.
Applying a new plugin/security generation requires an explicit cold replacement
after main and BTW work is quiescent; it never mutates an in-flight App Server.
The runtime owns the generated manifest payload, gateway host, socket, and token
for that generation; the worker contributes configuration inputs only before the
generation is created.

Each main-turn proxy request carries the trusted caller, Botmux turn ID, and
dispatch attempt already used by the current gateway. The runtime installs that
identity before submitting the main turn and retires it on the exact terminal.
The BTW adapter never installs a main-turn identity, and native BTW is no-tool.
Any tool request or tool-execution event attributed to a BTW native turn is a
protocol violation: the runtime cancels that BTW and records a visible failure
instead of approving a side effect.

Native `request_user_input` requests are also received by the runtime connection.
The runtime forwards them to the currently attached worker, which continues to
use the existing Lark ask bridge. A short worker replacement leaves the request
pending in the runtime and allows the replacement worker to answer it. If the
existing bounded ask deadline expires, or explicit stop occurs, the runtime
interrupts the native main turn. It must never reply with empty answers, because
Trae treats that as a successful skip.

### Lark projector

The runtime never stores a Lark app secret and does not call Lark. It publishes
durable projection items. The active daemon resolves current credentials by the
frozen app ID, patches the card, and acknowledges the exact operation revision.
If the daemon disappears after a PATCH, replaying the same revision against the
same message ID is harmless.

The runtime remains the sole record writer. Projectors report results through an
authenticated `AckProjection(opId, expectedRevision, providerOutcome)` command.
The runtime applies that acknowledgement with compare-and-set semantics; a late
daemon cannot advance or overwrite a newer desired revision. No daemon writes an
operation file directly.

Only an explicit Lark `withdrawn` response permits one replacement card. The
replacement intent and stable UUID are persisted before creation. Timeouts,
rate limits, 5xx responses, and unknown responses continue to target the original
message ID; they never create another result card.

The short completion reminder has its own stable UUID. A definitely-unsent
attempt may retry. An ambiguous send is recorded as `reminder_unknown` and is
not retried, because losing a non-authoritative reminder is preferable to
duplicating it after Lark's UUID idempotency window.

## Contributor-facing adapter contract

The adapter is a runtime seam, separate from the static `CliAdapter` launch and
input contract:

```ts
interface BtwAdapter {
  run(input: {
    requestId: string;
    question: string;
  }): Promise<BtwOutcome>;
}

type BtwOutcome =
  | { status: 'completed'; answer: string }
  | {
      status: 'failed' | 'cancelled' | 'submission_unknown';
      message?: string;
    };
```

An adapter instance is bound to one frozen parent/runtime context. It hides the
native thread ID, native turn ID, cwd, model, permissions, event correlation, and
protocol details. `run()` resolves only for that request and supports multiple
concurrent calls on the same parent without ordering assumptions.

The runtime, not the adapter, maps runtime/App Server loss or explicit shutdown
to the operation-level `interrupted` state. The adapter never knows about Lark
cards, reply targets, delivery retries, main-turn cards, or Botmux session UI.

The Trae implementation derives one stable native turn ID from the Botmux
operation, registers the event owner before writing the request, and invokes
`turn/btw`. That ID is correlation only. The operation store is the sole
idempotency authority and never calls `run()` twice for the same accepted
request.

Another agent can register a managed implementation only if it provides all four
capabilities and passes the shared adapter contract tests. Otherwise it retains
legacy behavior.

## Durable operation model

Each operation is stored as an independently replaceable record under the
Botmux data directory. Writes use the existing durable atomic-write helper
(`fsync`, atomic rename, and directory sync). A corrupt record is quarantined so
one operation cannot block unrelated delivery. The runtime is the only writer;
daemon clients mutate records through authenticated commands.

The minimum record is conceptually:

```ts
interface BtwOperation {
  schemaVersion: 1;
  revision: number;
  btwOpId: string;
  requestId: string;
  question: string;

  parent: {
    botmuxSessionId: string;
    cliId: string;
    nativeThreadId: string;
    runtimeEpoch: string;
    configHash: string;
    cwd: string;
  };

  replyTarget: {
    larkAppId: string;
    chatId: string;
    rootMessageId: string | null;
    replyToMessageId: string | null;
    chatType: 'group' | 'p2p';
    brand: 'feishu' | 'lark';
  };

  card: {
    createUuid: string;
    messageId?: string;
    firstPossiblySentAt?: string;
    createRetryDeadline?: string;
    replacementUuid: string;
    replacementMessageId?: string;
  };

  execution: {
    state: BtwOperationState;
    nativeTurnId: string;
    attempt: number;
    frameState:
      | 'not_started'
      | 'definitely_unsent'
      | 'may_have_been_sent'
      | 'acknowledged';
    answer?: string;
    errorCode?: string;
    message?: string;
  };

  projection: {
    desiredRevision: number;
    patchedRevision: number;
    reminderUuid: string;
    reminderState: 'none' | 'pending' | 'sent' | 'unknown';
  };

  createdAt: string;
  updatedAt: string;
}

type BtwOperationState =
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
```

`replyTarget`, parent runtime fields, question, card UUIDs, and native turn ID are
immutable after preparation. Lark credentials are looked up when projecting and
are never copied into the record.

`requestId` is the inbound Lark message ID. The unique key is scoped by the
receiving Botmux session and Lark app so identical strings in different sessions
cannot collide. `btwOpId`, native turn ID, card UUID, replacement UUID, and
reminder UUID are deterministic derivations of that key with distinct domains.
They are identifiers, not permission tokens.

## Acceptance and execution state machine

The externally visible progression is:

```text
card_pending -> accepted -> submit_prepared -> running
                                      |          |
                                      |          +-> completed
                                      |          +-> failed
                                      |          +-> cancelled
                                      |          +-> interrupted
                                      |
                                      +-> submission_unknown

card_pending -> card_unknown

submit_prepared -- definitely unsent, same epoch --> submit_prepared
submission_unknown -- authoritative same-connection terminal -->
    completed | failed | cancelled
```

The ordering rules are strict:

1. `PrepareBtw` durably creates `card_pending`, including the frozen reply target
   and stable IDs.
2. The daemon asks the Lark provider to create the card with `createUuid`. A
   positive response supplies `messageId`; the daemon calls `RecordCard`, and the
   runtime durably moves the operation to `accepted`.
3. Only `accepted` may enter `submit_prepared`. This write is the conservative
   no-replay boundary and happens before the App Server WebSocket write.
4. A synchronous transport failure proven to occur before `WebSocket.send`
   accepts the frame can be recorded as definitely unsent and retried by the
   same runtime epoch. It remains `submit_prepared`, increments `attempt`, and
   never transitions back through `accepted`.
5. Once the frame is accepted by the WebSocket API, any missing ACK, partial
   transport failure, timeout, disconnect, or crash is never auto-resubmitted.
6. A matching ACK moves the operation to `running`. A terminal may arrive before
   that ACK; the pre-registered native ID allows the runtime to persist the exact
   terminal without guessing.
7. `turn/btw/completed.answer` is the complete result source. Deltas may be
   retained for diagnostics but never drive a Lark PATCH in the first release.
8. The terminal record and desired projection revision are durably committed
   before the first card PATCH is attempted.

Recovery of `submit_prepared` from an older runtime epoch is conservatively
`submission_unknown`, even if the process may have crashed before writing the
frame. This sacrifices automatic retry to preserve at-most-once execution.
`running` recovered after loss of the runtime/App Server becomes `interrupted`,
because the upstream protocol has no BTW query or replay API.

While the same runtime and event connection remain alive, an authoritative
terminal may resolve a previously displayed `submission_unknown` operation to
`completed`, `failed`, or `cancelled`. No other terminal transition is mutable.
Duplicate identical terminals are no-ops; conflicting terminals are quarantined
and diagnosed rather than projected in arrival order.

Card creation follows the same conservative rule. An explicit pre-dispatch
failure is retryable with the same UUID. An unknown response may be retried only
inside the stored safe window: 55 minutes from the first attempt that may have
reached Lark, leaving five minutes of margin inside Lark's one-hour UUID
idempotency window. A definitely-unsent attempt does not start that clock. Once
`createRetryDeadline` passes, the operation becomes `card_unknown` and is never
submitted, avoiding a computation with no known result location. A duplicate
inbound Lark event always resolves to the existing operation; it never allocates
another native turn.

## Main-turn isolation invariants

Managed and legacy BTW paths must preserve all of the following values and side
effects across acceptance, completion, failure, restart, and delivery retry:

- `currentBotmuxTurnId` and dispatch attempt;
- the main reply target and turn marker;
- the main streaming/control card and its pin state;
- busy/idle state and idle detector;
- reactions and start/finish feedback;
- transcript fallback ownership and final-output gating;
- main-turn timeout, cancellation, and failure state; and
- pending main input ordering.

The dedicated legacy worker message invokes only the existing raw command writer
and its safety fences. It must not call the generic passthrough wrapper that
registers a main turn.

A normal main-turn completion, cancellation, or worker replacement does not
cancel BTW operations. Permanent session close is different: it explicitly
closes that session runtime and records its in-flight BTW operations as
`interrupted`. Global `botmux stop` does the same for all sessions.

## Runtime and command lifecycle

### Start and lazy ensure

Daemon startup connects to an existing compatible runtime and starts the
projector. The first eligible Trae RPC session lazily calls `EnsureSession`. If
no runtime exists, an identity-checked detached process is launched through the
existing self-spawn abstraction so Node source, Bun source, and Bun standalone
all use valid entrypoints. Runtime children close inherited stdio and do not
share the fleet process group.

`EnsureSession` freezes the CLI executable, cwd, sanitized per-bot environment,
owner environment, model/effort, App Server feature/config flags, plugin manifest
digest, and MCP socket. `applySessionOwnerEnv` remains the final env mutation. An
attach first identifies the existing runtime generation. A differing current
config hash is returned as observable drift, not applied to that generation; the
worker reattaches with the runtime's frozen profile or explicitly requests a cold
replacement once all work is quiescent. A worker can never silently mutate the
execution boundary of an already-running App Server.

### Daemon restart or crash

`botmux restart` continues to stop and start the fleet, but it does not send the
runtime shutdown command and does not include the runtime in fleet membership.
Worker shutdown detaches its proxy and viewer observers only. The runtime, App
Server connection, BTW operations, and delivery outbox remain live.

The replacement daemon authenticates to the same runtime epoch, starts draining
pending projection revisions, and forks a worker that reattaches to the existing
session runtime. No native BTW call is repeated. Daemon SIGKILL has the same
recovery path.

### Explicit stop and close

`botmux stop` is deliberately not implemented by giving `stopFleet()` implicit
runtime semantics; `restartFleet()` calls that same primitive and must preserve
the runtime. The explicit CLI stop orchestration is instead ordered as follows:

1. authenticate to the runtime and `QuiesceAll`, rejecting new managed submits;
2. durably mark in-flight BTW operations `interrupted` and publish projections;
3. wake the still-running per-app projectors and give them a bounded drain
   window, while leaving undelivered items on disk;
4. close session App Servers and the runtime through its control socket, with a
   PID/start-identity fence for timeout escalation; and
5. only then call `stopFleet()`.

If no daemon is reachable, or the bounded projection drain expires, steps 4 and
5 still complete and the next start drains the durable items. An unverified PID
is never killed.

Permanent session close performs the same sequence for that one session. A
viewer-only restart, daemon restart, or temporary worker loss only detaches.
`botmux stop-bot <appId>` is also an explicit stop: before the supervisor kills
that bot daemon, the CLI quiesces and closes only runtime sessions whose frozen
Lark app ID matches `appId`, gives that daemon's projector the same bounded drain
window, and leaves every other bot's runtime sessions untouched. The already-
stopped case still performs this scoped runtime cleanup.

### Runtime or App Server failure

An unexpected runtime failure is outside the continuity guarantee. At next
startup, an identity-checked reconciliation quarantines stale descriptors, kills
only verified orphan App Server process groups, maps old `submit_prepared` to
`submission_unknown`, and maps old `running` to `interrupted`. It never resumes
or replays those native calls.

An App Server death observed by the live runtime immediately records affected
operations as interrupted or submission-unknown according to whether native
acceptance was confirmed. A replacement App Server may resume the parent thread
for future work only after those operations are settled; it cannot claim their
old computation survived.

### Version mismatch

The control protocol has an explicit major version. Compatible runtimes are
reused across a build change. An incompatible runtime with no live sessions may
be shut down and replaced. An incompatible runtime that still owns live sessions
or in-flight BTW is preserved and reported; the new daemon must not kill it as an
upgrade side effect. This release does not promise live handoff across a breaking
runtime protocol change.

## Failure and delivery semantics

| Condition | Native execution | Card behavior | Automatic retry |
| --- | --- | --- | --- |
| Card definitely not sent | Not started | No accepted card | Same UUID, bounded |
| Card response unknown | Not started | `card_unknown` after stored 55-minute deadline | Same UUID only before deadline |
| Native frame definitely not sent | Not started | Patch start failure/retry state | Safe in same epoch |
| Native frame may have been sent, no ACK | Unknown | `submission_unknown` | Never resubmit |
| Native completed | Completed | Persist, then PATCH original card | PATCH same message ID |
| Native failed/cancelled | Terminal | PATCH original card | PATCH same message ID |
| Runtime/App Server died | Interrupted or unknown | PATCH original card when possible | Never re-execute |
| Lark PATCH timeout/429/5xx | Unchanged | Durable pending projection | Retry same message ID |
| Card explicitly withdrawn | Unchanged | One stable-ID replacement | At most one logical replacement |
| Reminder response unknown | Unchanged | Answer remains in result card | Do not resend reminder |

The guarantee is at-most-once native submission plus eventually consistent card
projection for a surviving runtime and recoverable Lark API. It is not a claim of
distributed exactly-once side effects.

## Minimal code surface

### New files/modules

- `src/adapters/cli/btw.ts` — public adapter types and contributor contract.
- `src/features/btw/operation-store.ts` — durable records, state transitions,
  dedupe, corruption quarantine, and projection revisions.
- `src/features/btw/runtime-protocol.ts` — narrow authenticated local IPC types.
- `src/features/btw/runtime-server.ts` — singleton process and per-session
  runtime registry.
- `src/features/btw/runtime-client.ts` — daemon/worker client and lifecycle
  attach helpers.
- `src/features/btw/trae-adapter.ts` — bound Trae `turn/btw` implementation.
- `src/features/btw/coordinator.ts` — ingress acceptance and legacy decision.
- `src/features/btw/projector.ts` — single-card PATCH/replacement/reminder drain.
- `src/features/btw/card.ts` — BTW-only card rendering.
- `src/index-btw-runtime.ts` — hidden Node/Bun/standalone runtime entry.

Files may be combined when implementation shows that a module would otherwise
be trivial, but the ownership boundaries above must remain visible.

### Localized modifications

- `src/codex-rpc-engine.ts` — extract the App Server process and stateful broker
  implementation for reuse inside the runtime; retain the current local owner
  for Codex and expose a same-shape persistent proxy for eligible Trae.
- `src/codex-rpc-lifecycle.ts` — preserve existing eligibility and exactly-once
  decisions while making Trae teardown mean detach.
- `src/worker.ts` — attach the proxy, forward main RPC calls and user-input
  requests, retain the remote viewer, and add a lifecycle-neutral legacy BTW
  raw-input message.
- `src/daemon.ts` — intercept `/btw`, invoke the coordinator, and run the
  projector without entering main-turn setup.
- `src/core/worker-pool.ts` and `src/types.ts` — carry only the runtime locator,
  epoch/config hash, and dedicated legacy input event. BTW operation state does
  not enter the general worker/session union.
- `src/core/self-spawn.ts` and `src/cli.ts` — add the hidden runtime entry and
  explicit stop/close lifecycle. Restart deliberately omits runtime shutdown.
- locale resources and the CLI adapter contributor guide — add user messages and
  the adapter checklist.

### Explicitly unchanged areas

- the static `CliAdapter` interface and registry for unrelated capabilities;
- non-Codex/Trae adapters and their launch/input behavior;
- `codex-app-runner.ts` and existing-App-Server adopt mode;
- generic PTY, tmux, zellij, herdr, riff, and mojo implementations;
- normal passthrough commands such as `/compact`, `/model`, and `/fast`;
- main streaming-card, reaction, idle, timeout, and fallback state machines;
- Dashboard terminal proxy and controls; and
- the low-level Lark client API, whose existing create/reply UUID and fixed
  message-ID PATCH operations are reused.

`FleetSupervisor` does not own or enumerate the runtime. Fleet code should remain
unchanged unless implementation requires a read-only health field. Runtime
lifecycle belongs to the CLI start/stop seam and the runtime client.

## Verification strategy

Fake App Server and fake Lark implementations provide deterministic faults. A
real Trae smoke is still mandatory because fake protocol success cannot prove
native context, no-tool, concurrency, or process ownership semantics.

### P0 automated scenarios

1. **Acceptance order and idempotency** — prove durable op/target, then stable-ID
   card creation/recording, then native submission. Replaying one request ID
   returns the original op/card and calls the adapter once. A later session move
   does not alter the frozen target.
2. **Card creation failure** — an explicit failure never calls the adapter. An
   ambiguous response retries only within the UUID window and never starts the
   computation without a recorded message ID.
3. **Submission uncertainty boundary** — pre-dispatch failure can retry; any
   post-dispatch timeout, partial write, disconnect, or crash never resubmits.
4. **Structured terminal** — ACK and terminal-before-ACK both map by exact native
   ID; completed, failed, and cancelled normalize to the adapter contract.
5. **Durable-before-PATCH** — kill and reload after terminal persistence but
   before PATCH. The answer survives and only the original card is patched.
6. **Outbox and replacement** — timeout/429/5xx replay against one message ID;
   only explicit withdrawn creates one stable replacement; reminder ambiguity
   does not create duplicate reminders.
7. **Restart and daemon crash** — hold two BTW operations behind barriers, run a
   real `botmux restart` and separately SIGKILL the daemon, then assert unchanged
   runtime PID, App Server PID, runtime epoch, native IDs, single submission, and
   final PATCH of both original cards.
8. **Explicit stop and close** — runtime/session shutdown terminates verified
   process groups, marks in-flight work interrupted, preserves terminal states,
   and is not auto-restarted by the fleet.
9. **Lifecycle isolation and concurrency** — snapshot all main-turn state, run
   two same-parent BTW operations with B completing before A, inject failures,
   and assert exact cards plus a byte-equivalent main-state snapshot and zero
   `beginNewTurn` calls.
10. **Capability truth table and legacy behavior** — test all sixteen four-flag
    combinations. Only all true is managed; all other raw-capable combinations
    write once and immediately close the warning, while no-raw combinations do
    not execute.
11. **Runtime support continuity** — hold a main turn across worker replacement
    and verify MCP gateway reconnection, trusted turn identity, deferred
    `request_user_input`, title operations, remote viewer reattachment, and
    cursor replay of a terminal emitted while no worker is attached.
12. **Process security and generations** — stale socket, wrong token, wrong UID
    where supported, PID reuse, old epoch, concurrent ensure, config-hash drift,
    frozen plugin-manifest reuse, corrupt op, and incompatible protocol all fail
    closed without killing an unrelated process.
13. **Scoped stop-bot** — stopping one app interrupts and closes only that app's
    runtime sessions, persists their projections before daemon exit, and does
    not affect another app sharing the same data-directory runtime.

### Required real Trae smoke

The environment-gated smoke uses a real Trae App Server and must prove:

- caller-selected BTW IDs are echoed in ACK and terminal events;
- a BTW answer reads a marker from its parent thread context;
- an attempted tool use produces no tool execution;
- two same-parent BTW operations can run concurrently and finish out of order;
- a second App Server cannot take the active parent thread;
- a second client of the same App Server can submit main and BTW turns;
- one BTW remains running across a real Botmux restart with unchanged runtime,
  App Server, thread, and native turn identities; and
- explicit stop terminates the runtime.

### Artifact and session matrix

The test suite avoids a full Cartesian product while covering every boundary:

| Artifact | Parent/backend | Session shape | Required path |
| --- | --- | --- | --- |
| Node source | Trae RPC / tmux | new topic | managed accept and restart |
| Bun source | Trae RPC / tmux | resumed regular-group session | managed crash recovery |
| Bun standalone | Trae RPC / tmux | DM `p2pMode=thread` | real Trae continuity |
| Node source | Trae / PTY | DM `p2pMode=chat` | legacy warning |
| Bun source | another CLI / tmux | topic group | legacy/no-raw behavior |
| Bun standalone | Trae / adopt or unsupported restore | restored session | capability fallback |

Cheap parameterized resolver tests additionally cover topic, regular group, and
both DM modes. Child-process tests use `test/helpers/ts-runner.ts`; the standalone
smoke supplies a valid bot fixture so it reaches the runtime path.

Suggested test homes are:

- `test/btw-operation-store.test.ts`
- `test/btw-coordinator.test.ts`
- `test/btw-projector.test.ts`
- `test/btw-runtime.integration.test.ts`
- `test/btw-trae.e2e.ts`
- focused extensions to Codex RPC lifecycle, worker shutdown, command-handler,
  self-spawn, and Bun binary smoke tests.

Implementation verification must include focused Vitest suites, `bun run test`,
`bun run test:all`, `bun run build`, `bun run test:bun`, `bun run build:bun`, the
standalone smoke, the real Trae smoke, and one live Lark card check after
`bun run switch:here && bun run daemon:restart`. The PR includes the live card
screenshot and states the tested CLI/backend/session combinations.

## Implementation units and dependency graph

```text
U0 Freeze adapter, runtime IPC, state machine, ownership, and fixtures
 |
 +-- only shared interfaces --> U1 durable operation store and outbox
 +-- only shared interfaces --> U2 persistent process, lifecycle, and proxy
 +-- only shared interfaces --> U3 Trae BtwAdapter and native correlation
 +-- only shared interfaces --> U4 ingress, single-card projector, and legacy B

U1 + U2 + U3 + U4 -- true blocking dependency --> U5 integration and E2E
```

Each unit is independently testable, committed, and pushed before the next unit
uses it. After U0 freezes shared interfaces, U1-U4 may use disjoint worktrees and
write scopes. U5 merges them into the one integration branch, runs the full
matrix, and performs the live deployment check. Interface changes or overlapping
write scopes stop the affected parallel work until the boundary is coordinated.

## Guarantee boundary

The first release guarantees continuity for accepted managed BTW operations
across controlled `botmux restart`, daemon/worker reconstruction, daemon SIGKILL,
and transient Lark PATCH failures, provided the persistent runtime, its App
Server, durable data directory, host, and credentials remain available.

It does not guarantee native computation continuity across host reboot or power
loss, persistent runtime failure, Trae App Server failure, disk corruption,
credential revocation, a breaking runtime-protocol upgrade, or permanent Lark
API failure. Those conditions end as `interrupted`, `submission_unknown`, or a
visible delivery failure according to the last durable boundary. They never
trigger automatic native re-execution.
