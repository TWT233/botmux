# Tasks 3-5: 实时卡片 Pin 生命周期

## Status

Implemented as one lifecycle unit. The focused lifecycle matrix and build pass.

## Files

- `src/core/worker-pool.ts`
- `src/im/lark/card-handler.ts`
- `test/streaming-card-pinning.test.ts`

## TDD evidence

### Task 3 policy

- RED: `mise exec bun@1.4.0 -- bun run test -- test/streaming-card-pinning.test.ts` failed with `pinStreamingCardIfEnabled is not a function` and `reconcileStreamingCardPins is not a function`.
- GREEN: `mise exec bun@1.4.0 -- bun run test -- test/streaming-card-pinning.test.ts test/recall-frozen-cards.test.ts` passed: 63 tests.
- Coverage added: default-off and invalid/sentinel/inactive/displaced refusals, ownership/current-ID checking, stale post-Pin compensating Unpin, enable Pin-before-frozen-Unpin, disable deduplicated cleanup, and cross-topic frozen IDs.

### Tasks 4-5 integration

- RED diagnostic: the first expanded publication matrix exposed a real fence-scope regression (`ReferenceError: ownsFreshReadyPost is not defined`) and one dependent worker-ready assertion failed.
- GREEN after fix: publication/resume matrix passed: 142 tests.
- Close/transfer matrix passed: 140 tests.

## Verification

- Focused final matrix: 9 files, 279 tests passed.
- Build: `mise exec bun@1.4.0 -- bun run build` passed.
- `git diff --check` passed.
- Full unit suite: completed with 18,803 passed and 14 failed, plus 17 skipped. Failures are unrelated baseline/environment issues: `/home` versus `/data00/home` path-alias expectations in runtime/plugin/npm/OMP/Grok tests, Bubblewrap sandbox cleanup permissions and MCP connection closure, process-name expectation under Bun (`MainThread` vs `node`), and DSH sandbox timeout. None are in the Pin lifecycle matrix.

## Race invariants reviewed

- Only real `streamCardId` values are eligible; the posting sentinel is rejected.
- Pin checks active status, route ownership, object/current-ID identity, transfer state, and preference before and after the request. A stale successful Pin gets a best-effort compensating Unpin of the captured ID.
- Fresh `/card`, worker-ready, and screen-update POST paths recheck captured session/app/anchor/registry/nonce state before commit; stale posts are deleted without Pin.
- New cards persist before Pin; frozen IDs are unpinned only after successor Pin succeeds; destination-sensitive `recallFrozenCards` remains unchanged and always executes afterward.
- Persisted reuse reconciles the live ID after its PATCH. Resume repost captures identity before POST and deletes stale results without Pin.
- Transfer and close snapshot/deduplicate IDs before source fields or frozen sidecars disappear, then launch best-effort Unpin only after their durable commit. Neither path awaits Unpin; refused or failed durable close does no cleanup.

## Self-review and concerns

- Pin/Unpin failures are fail-open and do not change publication, resume, transfer, or close results.
- No repo picker, private card, final card, CoT, or closed-card path calls the policy; calls are restricted to `streamCardId` lifecycle points.
- The intentional scope has no durable Pin-operation journal or chat-wide Pin scan. A crash between remote mutation and later lifecycle reconciliation can leave a stale Pin until a later known lifecycle boundary; this matches the approved QoL/fail-open design.

## Fix round 1/5

### Findings resolved

- Publication continuations now capture/deduplicate frozen predecessor IDs before awaiting the successor Pin. `reconcilePublishedStreamingCard` returns whether the captured real card is still the authoritative current identity after Pin; turn-start, `/card`, worker-ready fresh POST, and screen-update POST use that result to skip `recallFrozenCards` and all later post-publication mutation if a successor won the race.
- Screen-update POST rejection now requires both the broad lifecycle fence and its captured POST nonce/sentinel fence before rollback, clear, or persistence. A rejected stale request therefore cannot erase a successor `streamCardId`.
- Resume repost rechecks its captured session/app/registry/current-card identity after its awaited Pin before deleting the stale predecessor or sending a receipt.
- Removed the obsolete post-Pin frozen-ID snapshot helper: predecessor IDs are now always captured before the await.
- Added actual-path coverage for deferred ready Pin ownership loss, deferred screen-update POST rejection, transfer source cleanup after routing commit, and close’s non-deleting asynchronous Unpin. Existing focused harnesses continue to cover turn-start, `/card`, worker-ready reuse/fresh, screen-update, resume, transfer, and close.

### TDD evidence

- RED: the deferred worker-ready Pin test failed because the older continuation called `recallFrozenCards`, deleting `om_frozen_predecessor` after a successor became current.
- GREEN: after fencing post-Pin continuation effects, that test passes and confirms the stale card gets only a compensating Unpin.
- Screen-update deferred rejection test confirms a stale POST error leaves `om_successor` unchanged.

### Verification

- `mise exec bun@1.4.0 -- bun run test -- test/streaming-card-pinning.test.ts test/recall-frozen-cards.test.ts test/worker-ready-display-mode.test.ts test/card-integration.test.ts test/card-handler-resume-receipt.test.ts test/transfer-session.test.ts test/session-delete-close-barrier.test.ts test/mojo-explicit-close.test.ts test/close-stream-card-untouched.test.ts` — 9 files passed, 282 tests passed.
- `mise exec bun@1.4.0 -- bun run build` — passed.
- `git diff --check` — passed (no output).

## Persisted worker-ready reuse race fix

### Finding resolved

- The persisted worker-ready reuse branch now captures session, app, anchor, registry key, and `restoredCardId` before its restore PATCH/Pin reconciliation. After the awaited reconciliation it rechecks that the captured card is still the authoritative current identity before recalling frozen cards, publishing reuse completion, or arming the usage refresh.
- A lost-ownership old restore stays fail-open: Pin policy compensates the old Pin with Unpin, while the reuse continuation leaves successor-owned card and frozen state untouched.

### TDD evidence

- RED: a deferred Pin during the real persisted worker-ready reuse path removed `om_frozen_predecessor` after `streamCardId` changed to `om_successor`.
- GREEN: the same test preserves `om_successor` and its frozen entry, emits no predecessor deletion, and verifies compensating Unpin of `om_restored_card`.

### Verification

- `mise exec bun@1.4.0 -- bun run test -- test/streaming-card-pinning.test.ts test/recall-frozen-cards.test.ts test/worker-ready-display-mode.test.ts test/card-integration.test.ts test/card-handler-resume-receipt.test.ts test/transfer-session.test.ts test/session-delete-close-barrier.test.ts test/mojo-explicit-close.test.ts test/close-stream-card-untouched.test.ts` — 9 files passed, 287 tests passed.
- `mise exec bun@1.4.0 -- bun run build` — passed.
- `git diff --check` — passed (no output).

## Fix round 2/5

### Finding resolved

- A stale publication after an awaited Pin must suppress captured-card mutation, but it must not strand a later turn already marked pending. Turn-start, worker-ready fresh POST, and screen-update POST now retain their successor-card scheduling path after `reconcilePublishedStreamingCard()` reports lost ownership.
- The scheduling predicate rechecks the live `streamCardTurnGeneration` after the await instead of relying on the pre-await `superseded` snapshot. This preserves the successor's liveness while the captured-ID fence still excludes recall, refresh patches, timer arming, and other old-card side effects.

### TDD evidence

- RED: three deferred-Pin liveness tests failed with only one POST: turn-start, worker-ready, and screen-update each left the successor pending card unscheduled after the older card lost ownership.
- GREEN: each orchestration shape now posts its successor (two POSTs total) and clears the successor pending turn, while the earlier concurrency test continues to prove stale continuations do not recall the successor state.

### Verification

- `mise exec bun@1.4.0 -- bun run test -- test/streaming-card-pinning.test.ts test/recall-frozen-cards.test.ts test/worker-ready-display-mode.test.ts test/card-integration.test.ts test/card-handler-resume-receipt.test.ts test/transfer-session.test.ts test/session-delete-close-barrier.test.ts test/mojo-explicit-close.test.ts test/close-stream-card-untouched.test.ts` — 9 files passed, 285 tests passed.
- `mise exec bun@1.4.0 -- bun run build` — passed.
- `git diff --check` — passed (no output).
