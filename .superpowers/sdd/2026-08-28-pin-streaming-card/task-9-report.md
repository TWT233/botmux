## Task 9 report: per-chat streaming-card Pin opt-out

### Scope completed

- Implemented the accepted negative-set interface: `BotConfig.noPinStreamingCardChats?: string[]`
- Added `setChatStreamingCardPin(larkAppId, chatId, enabled)`
- Added `/card pin off|on|status`
- Kept one per-bot serialized config/write/reconcile order via the existing `serializePinStreamingCardConfigChange(...)`
- Kept Pin/Unpin fire-and-forget relative to command/config responses
- Updated user docs in `cards.md` and `bots-json.md` (en + zh)
- Did **not** implement the Dashboard follow-up

### TDD log

#### Step 1 RED

Ran:

```bash
mise exec bun@1.4.0 -- bun run test -- test/bot-registry-grant.test.ts test/pin-streaming-card-mode-store.test.ts
```

Observed RED for the intended reasons:

- `parseBotConfigsFromText` did not parse `noPinStreamingCardChats`
- `src/services/pin-streaming-card-mode-store.ts` did not exist

Representative failure evidence:

```text
FAIL test/bot-registry-grant.test.ts > parses noPinStreamingCardChats as a trimmed, deduplicated string list
AssertionError: expected undefined to deeply equal [ 'oc_chat_a', 'oc_chat_b' ]

FAIL test/pin-streaming-card-mode-store.test.ts
Error: Cannot find module '/src/services/pin-streaming-card-mode-store.js'
```

#### Step 2 GREEN

Implemented:

- `BotConfig.noPinStreamingCardChats?: string[]` parse/normalize
- `src/services/pin-streaming-card-mode-store.ts`
- chat-aware extension of the existing pin change notification seam, while preserving bot-level caller compatibility

Re-ran the same command and reached GREEN.

Focused GREEN result:

```text
Test Files  2 passed (2)
Tests  36 passed (36)
```

#### Step 3/5 RED

Ran:

```bash
mise exec bun@1.4.0 -- bun run test -- test/pin-streaming-card-change.test.ts test/streaming-card-pinning.test.ts test/command-handler.test.ts
```

Observed RED for the intended reasons:

- worker-pool Pin policy still read bot-level `pinStreamingCard` only
- bot reconcile queue had no chat-scoped request shape
- `/card` had no `pin off|on|status` routing

Representative failure evidence:

```text
FAIL test/streaming-card-pinning.test.ts > does not pin when the chat is opted out even if the bot-level master switch is on
AssertionError: expected true to be false

FAIL test/command-handler.test.ts > /card pin off updates the per-chat Pin opt-out without touching streamingCardForced or setCardMode
expected "vi.fn()" to be called with arguments: [ 'app-1', 'oc_chat_1', false ]
```

#### Step 4/6 GREEN

Implemented:

- effective Pin policy resolution from `(larkAppId, chatId)`
- chat-aware reconcile queue input while still serializing per bot
- chat-filtered batch reconcile using live config at execution time
- `/card pin off|on|status` with distinct bot-off/chat-off/effective-on responses

Re-ran the focused tests and reached GREEN.

Focused GREEN result:

```text
Test Files  3 passed (3)
Tests  321 passed (321)
```

### Key implementation notes

- Bot-level master switch remains `pinStreamingCard`; chat-level opt-out is the required negative set `noPinStreamingCardChats`
- `/card pin off` suppresses Pin only; it does not disable live cards and does not touch `streamingCardForced`
- `/card pin on` and `/card pin status` work without a live session
- Existing bot-level change handler callers remain compatible because the notifier still calls the 2-arg form when no chat payload is supplied
- Bot-wide and chat-scoped reconcile requests still share one per-bot queue
- Explicit per-chat on->off cleanup remains authoritative only when the process already owns Pin provenance for those message ids; a chat that has always been opted out does not gain authority to unpin possible manual Pins on close

### Verification

Focused GREEN:

```bash
mise exec bun@1.4.0 -- bun run test -- test/bot-registry-grant.test.ts test/pin-streaming-card-mode-store.test.ts
mise exec bun@1.4.0 -- bun run test -- test/pin-streaming-card-change.test.ts test/streaming-card-pinning.test.ts test/command-handler.test.ts
```

Observed:

```text
Test Files  2 passed (2); Tests  36 passed (36)
Test Files  3 passed (3); Tests  321 passed (321)
```

Additional cleanup-authority verification:

```bash
mise exec bun@1.4.0 -- bun run test -- test/close-stream-card-untouched.test.ts
```

Observed:

```text
Test Files  1 passed (1)
Tests  8 passed (8)
```

Final brief-required verification:

```bash
mise exec bun@1.4.0 -- bun run test -- \
  test/bot-registry-grant.test.ts test/pin-streaming-card-mode-store.test.ts \
  test/pin-streaming-card-change.test.ts test/streaming-card-pinning.test.ts \
  test/command-handler.test.ts
mise exec bun@1.4.0 -- bun run build
git diff --check
```

Observed:

```text
Test Files  5 passed (5)
Tests  357 passed (357)

build: exit 0
git diff --check: exit 0
```

Fresh pre-release re-run on the final tree:

```bash
mise exec bun@1.4.0 -- bun run test -- \
  test/bot-registry-grant.test.ts test/pin-streaming-card-mode-store.test.ts \
  test/pin-streaming-card-change.test.ts test/streaming-card-pinning.test.ts \
  test/command-handler.test.ts
mise exec bun@1.4.0 -- bun run test -- test/close-stream-card-untouched.test.ts
mise exec bun@1.4.0 -- bun run build
git diff --check
```

Observed:

```text
Test Files  5 passed (5)
Tests  357 passed (357)

Test Files  1 passed (1)
Tests  8 passed (8)

build: exit 0
git diff --check: exit 0
```

### Release status

- Commit: `001cb246` (`feat(card): 增加按群流式卡片置顶开关`)
- Push: completed to `fork/feat/pin-streaming-card`

### Follow-ups intentionally not done

- Dashboard Group Manage control
- restart-safe Pin provenance via `GET /im/v1/pins`

---

## Review fix round 4/5 — vanished queued-session authoritative cleanup

Finding addressed:

- Authoritative on-to-off cleanup previously stored exact transition-time IDs by session, but the queued drain only iterated sessions that were still active when that request began. A later-batch target that closed or disappeared while an earlier request was running was therefore skipped.

TDD log:

1. Added a deterministic >20-session regression in `test/streaming-card-pinning.test.ts`. It starts an earlier bot-wide reconcile, queues a chat off transition for 21 captured sessions, removes the later-batch target from the active registry, then releases the earlier reconcile.
2. Ran RED:

```bash
mise exec bun@1.4.0 -- bun run test -- test/streaming-card-pinning.test.ts
```

Observed the expected failure: `om_vanished_target_old` was never passed to `unpinMessage`.

3. Changed the per-bot drain so each request first executes its captured IDs as an independent, session-batched (at most 20) cleanup action with a captured `{ larkAppId, sessionId }` owner. It never re-resolves that owner session or derives additional IDs. The existing active-registry pass remains separate and reconciles only current effective state. Per-message serialization, fail-open behavior, and non-blocking config responses remain unchanged.
4. Re-ran the focused test and reached GREEN.

Verification:

```bash
mise exec bun@1.4.0 -- bun run test -- \
  test/bot-registry-grant.test.ts test/pin-streaming-card-mode-store.test.ts \
  test/pin-streaming-card-change.test.ts test/streaming-card-pinning.test.ts \
  test/close-stream-card-untouched.test.ts test/command-handler.test.ts
mise exec bun@1.4.0 -- bun run build
git diff --check
```

Observed:

```text
Test Files  6 passed (6)
Tests  374 passed (374)
build: exit 0
git diff --check: exit 0
```

Merge impact check: the current `origin/master` merge (`21fd13aa`) only touched install, binary, Grok, OpenCode, and related tests; it did not overlap the streaming-card Pin queue path.

---

## Post-review hardening — unpin logging parity (Task 2 transport)

Finding: `pinMessage` failures were downgraded to `logger.debug`, but `unpinMessage` still logged `warn` on non-zero and thrown errors, which could spam warnings during bulk cleanup. Hardened unpin to match the debug-only behavior while preserving the strict boolean contract and typed apiOnly rejection.

Focused tests + build + diff check:

```bash
mise exec bun@1.4.0 -- bun run test -- test/lark-pin-message.test.ts
mise exec bun@1.4.0 -- bun run build
git diff --check
```

Observed:

```text
test/lark-pin-message.test.ts: PASS
build: exit 0
git diff --check: exit 0
```

---

## Review fix round 1/5 — suppress master-off notify and preserve chat-scope cleanup authority

Finding addressed:

- `setChatStreamingCardPin(...)` notified reconciliation on negative-set membership changes even when `pinStreamingCard` was globally off, so the effective policy stayed off but the queue still ran a cleanup-capable reconcile.
- The per-bot reconcile queue stored only one latest `chatId`, so overlapping chat-scoped opt-outs could drop an earlier chat's authoritative cleanup intent while a prior reconcile was still awaiting.
- A later bot-wide off/on recomputation with existing opt-outs could incorrectly broad-clean chats that were already effectively off before the master transition.

TDD log:

1. Added `test/pin-streaming-card-mode-store.test.ts` regression proving `/card pin off|on` under `pinStreamingCard: false` still persists/syncs disk+memory but emits **no** notify.
2. Ran RED:

```bash
mise exec bun@1.4.0 -- bun run test -- test/pin-streaming-card-mode-store.test.ts
```

Observed:

```text
Test Files  1 failed (1)
Tests  1 failed | 6 passed (7)

AssertionError: expected [ [ 'app-one', false, 'oc_chat_a', false ] ] to deeply equal []
```

3. Fixed store notify gating to compare previous vs next **effective** chat-enabled state instead of raw negative-set membership.
4. Added `test/streaming-card-pinning.test.ts` regressions for:
   - deferred `A off` then `B off` preserving authoritative cleanup for both chats
   - global off/on with pre-existing opt-out never broad-cleaning a chat that was already effectively off
5. Ran RED:

```bash
mise exec bun@1.4.0 -- bun run test -- test/streaming-card-pinning.test.ts
```

Observed:

```text
Test Files  1 failed (1)
Tests  1 failed | 19 passed (20)

AssertionError: expected [ [ 'app-pin', 'om_chat_one' ], [ 'app-pin', 'om_chat_two' ], [ 'app-pin', 'om_chat_two' ] ] to deeply equal [ [ 'app-pin', 'om_chat_one' ] ]
```

6. Reworked the per-bot reconcile queue to keep:
   - latest desired bot-level enable state
   - `fullSweep` marker for bot-wide recomputes
   - accumulated requested chat scopes
   - accumulated authoritative cleanup chat scopes

This keeps responses fire-and-forget, preserves the `<=20` batch cap, recomputes final live effective state from config, and grants `cleanupKnownIds` only to:

- chats from real chat-scoped effective on->off transitions
- bot-wide master on->off for chats that were effectively on before the master drop

Focused verification:

```bash
mise exec bun@1.4.0 -- bun run test -- \
  test/pin-streaming-card-mode-store.test.ts \
  test/streaming-card-pinning.test.ts \
  test/close-stream-card-untouched.test.ts \
  test/command-handler.test.ts
mise exec bun@1.4.0 -- bun run build
```

Observed:

```text
Test Files  4 passed (4)
Tests  332 passed (332)

build: exit 0
```

---

## Review fix round 2/5 — snapshot transition-time cleanup authority by session

Finding addressed:

- A bot-wide `pinStreamingCard: true -> false` full sweep still derived cleanup authority for later batches from **live** `noPinStreamingCardChats`, so a master-off `/card pin off` arriving after enqueue but before a later batch could incorrectly remove authority from a session that was effectively on at the global transition.
- The symmetric race also existed: a chat already effectively off at the global transition could lose its `noPin` entry under master-off before its later batch, causing the live-config check to incorrectly **grant** cleanup authority and potentially unpin a manual Pin.
- Chat-level effective on->off authority must apply only to sessions active at that exact transition, not to newer sessions that appear in the same chat while an older reconcile is still draining.

TDD log:

1. Added `test/streaming-card-pinning.test.ts` regressions for:
   - global-off later-batch cleanup preserving transition-time authority even if a later master-off `/card pin off` mutates `noPinStreamingCardChats`
   - global-off later-batch cleanup never gaining authority if a previously opted-out chat is re-enabled under master-off before its batch
   - chat-off authority applying only to sessions active at the chat-level transition, not newer same-chat sessions that appear before the next drain snapshot

2. Ran RED:

```bash
mise exec bun@1.4.0 -- bun run test -- test/streaming-card-pinning.test.ts
```

Observed:

```text
Test Files  1 failed (1)
Tests  2 failed | 21 passed (23)

- duplicated cleanup / stale authority persistence across deferred chat-scope requests
- target later-batch session `om_target_manual` incorrectly gained cleanup under global-off after live noPin removal
```

3. Replaced the per-bot reconcile coalescer with an ordered per-bot request queue. Each request now snapshots authoritative cleanup **session IDs** synchronously when enqueued:
   - chat-level effective on->off: sessions active in that chat at that transition
   - bot-wide on->off: sessions active and effectively on at the global transition

4. Synced user-facing discoverability for the accepted `/card pin off|on|status` interface:
   - updated `docs-site/docs/en/slash-commands.md`
   - updated `docs-site/docs/zh/slash-commands.md`
   - updated `help.card` in `src/i18n/en.ts` and `src/i18n/zh.ts`

The queue still keeps:

- one queue per bot
- `<=20` concurrent session operations per batch
- fire-and-forget responses
- live recomputation of final `effectiveEnabled` at execution time

Only cleanup authority is transition-time snapshotted; final on/off state still comes from live config.

Focused verification:

```bash
mise exec bun@1.4.0 -- bun run test -- test/slash-commands-doc-sync.test.ts
mise exec bun@1.4.0 -- bun run test -- \
  test/pin-streaming-card-mode-store.test.ts \
  test/streaming-card-pinning.test.ts \
  test/close-stream-card-untouched.test.ts \
  test/command-handler.test.ts
mise exec bun@1.4.0 -- bun run build
```

Observed:

```text
Test Files  1 passed (1)
Tests  4 passed (4)

Test Files  4 passed (4)
Tests  335 passed (335)

build: exit 0
```

---

## Review fix round 3/5 — `/card pin on` master-off wording and exact cleanup-id authority

Finding addressed:

- `/card pin on` always replied with the effective-on copy even when the bot-level `pinStreamingCard` master switch was still off. That contradicted the accepted “master-off / chat-off / effective-on” distinction in the brief.
- Round 2 authority snapshotting by `sessionId` was still too broad: if a queued cleanup executed after the same persisted session changed its `streamCardId` (or was effectively resumed in place), broad cleanup could target later message ids rather than only the transition-time known current/frozen ids.

TDD log:

1. Added `test/command-handler.test.ts` regression for `/card pin on` under `pinStreamingCard: false`, requiring a master-off hint instead of the generic restored copy.
2. Ran RED:

```bash
mise exec bun@1.4.0 -- bun run test -- test/command-handler.test.ts
```

Observed:

```text
Test Files  1 failed (1)
Tests  1 failed | 297 passed (298)

AssertionError: expected "📌 已恢复当前群的流式卡片置顶。" to contain "bot 级"
```

3. Added `test/streaming-card-pinning.test.ts` regression proving chat-off/global-off queued cleanup must snapshot the exact transition-time known ids, not a later replacement current card on the same persisted session id.
4. Fixed:
   - `handleCardCommand('/card pin on')` now replies with `cmd.card.pin.on_master_off` when persistence succeeds but the bot-level master switch remains off
   - reconcile requests now snapshot authoritative cleanup as exact `messageId`s per session at enqueue time, while execution still recomputes final `effectiveEnabled` live

Focused verification:

```bash
mise exec bun@1.4.0 -- bun run test -- \
  test/streaming-card-pinning.test.ts \
  test/command-handler.test.ts \
  test/slash-commands-doc-sync.test.ts
mise exec bun@1.4.0 -- bun run build
```

Observed:

```text
Test Files  3 passed (3)
Tests  326 passed (326)

build: exit 0
```

---

## Review fix round 5/5 — no-transport authoritative cleanup guard

Finding addressed:

- The independent captured cleanup introduced in round 4 directly called `unpinStreamingCardIds`, bypassing `reconcileStreamingCardPins` transport eligibility. An `apiOnly` or HTTP virtual session could therefore issue a forbidden Lark Unpin; a queued request could also become ineligible after enqueue.

TDD log:

1. Added deterministic regressions for an `apiOnly` authoritative cleanup at enqueue and for a queued chat cleanup whose transport changes to `apiOnly` before the queue drains.
2. Ran RED:

```bash
mise exec bun@1.4.0 -- bun run test -- test/streaming-card-pinning.test.ts
```

Observed the intended failures: direct captured cleanup called `unpinMessage` in both cases.

3. Captured `chatId` together with each exact transition-time ID set and owner metadata. Immediately before each direct Unpin, the drain now calls `retainsLarkStreamingCardTransportFor(larkAppId, chatId)` and skips the captured action when transport is no longer eligible. The runtime check is intentionally retained even though snapshots carry chat metadata, because `apiOnly` and transport eligibility can drift while queued.

Verification:

```bash
mise exec bun@1.4.0 -- bun run test -- \
  test/streaming-card-pinning.test.ts test/close-stream-card-untouched.test.ts \
  test/command-handler.test.ts test/pin-streaming-card-change.test.ts \
  test/pin-streaming-card-mode-store.test.ts
mise exec bun@1.4.0 -- bun run build
git diff --check
```

Observed:

```text
Test Files  5 passed (5)
Tests  346 passed (346)
build: exit 0
git diff --check: exit 0
```

The real-Lark vanished-session cleanup regression remains green. Captured actions remain exact-ID-only, per-message serialized, session-batched at at most 20, fail-open, and non-blocking.
