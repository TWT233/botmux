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
