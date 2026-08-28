# Tasks 6-7: 实时卡片 Pin 热重算与文档

## Status

Implemented as one hot-reconciliation and documentation unit. The focused Task 6/7 matrix passed after fixing the active-session key collision in the multi-session reconciliation coverage.

## Files

- `src/services/pin-streaming-card-change.ts`
- `src/services/bot-config-store.ts`
- `src/services/card-prefs-store.ts`
- `src/daemon.ts`
- `test/pin-streaming-card-change.test.ts`
- `test/bot-config-store.test.ts`
- `test/card-prefs-auto-start.test.ts`
- `test/command-handler.test.ts`
- `test/dashboard-ipc.test.ts`
- `test/streaming-card-pinning.test.ts`
- `docs-site/docs/zh/bots-json.md`
- `docs-site/docs/en/bots-json.md`
- `docs-site/docs/zh/cards.md`
- `docs-site/docs/en/cards.md`

## TDD evidence

### Task 6 hot reconciliation seam

- RED: `mise exec bun@1.4.0 -- bun run test -- test/pin-streaming-card-change.test.ts` failed because `src/services/pin-streaming-card-change.ts` did not exist.
- GREEN: the new process-local callback seam passed coverage for registration, disposal, replacement, and swallowed/logged handler failures.
- Store-path RED diagnostics: the first expanded config-path matrix showed missing notifications and incorrect blocking assumptions in the `/botconfig` and dashboard flows.
- GREEN after wiring: `bot-config-store` now notifies only after successful `pinStreamingCard` write plus live-memory sync; `card-prefs-store` now notifies only when `patch.pinStreamingCard !== undefined` after successful write plus live-memory sync; unrelated patches and failed writes emit nothing.
- Non-blocking confirmation: `/botconfig` and dashboard mutation tests prove the visible response completes even when the registered reconciliation handler throws or does deferred work.

### Task 6 active-session reconciliation coverage

- Daemon startup now registers `registerPinStreamingCardChangeHandler(reconcileBotStreamingCardPins)` immediately after `setActiveSessionsRegistry(activeSessions);`, preserving the required `reconcileBotStreamingCardPins(larkAppId, enabled): void` interface and keeping the seam in the services layer to avoid a worker-pool import cycle.
- The multi-session reconciliation test initially failed twice for real harness reasons: first because sessions reused the same `sessionId`, then because `activeSessionKey(ds)` is derived from `rootMessageId` under thread scope and the test still reused the same root anchor.
- GREEN after fix: the helper now supports distinct `sessionId`, `rootMessageId`, and explicit `scope: 'thread'`, and the coverage proves reconciliation snapshots only the target bot's active sessions, ignores other bots, and isolates one session failure from the rest.

### Task 7 documentation

- Added bilingual documentation for `pinStreamingCard` in bot config and cards docs.
- The docs now state the exact approved scope: per-bot opt-in, default off, only the current public live-status `streamCardId` participates, hot on/off reconciliation applies to existing active sessions, repo picker/private `/card`/final reply/CoT/closed/other cards remain unpinned, failures are fail-open, temporary zero or multiple Pins are possible, and there is no durable retry journal or full-chat Pin audit after exceptional crashes.

## Verification

- Focused matrix: `mise exec bun@1.4.0 -- bun run test -- test/pin-streaming-card-change.test.ts test/bot-config-store.test.ts test/card-prefs-auto-start.test.ts test/command-handler.test.ts test/dashboard-ipc.test.ts test/streaming-card-pinning.test.ts` passed.
- Full suite: `mise exec bun@1.4.0 -- bun run test` still reports unrelated baseline failures, not introduced by this unit. Observed failing files remain `test/codex-browser-broker.test.ts`, `test/grok-transcript.test.ts`, `test/npm-binary-distribution.test.ts`, `test/cli-runtime-update.test.ts`, `test/session-discovery.smoke.test.ts`, `test/plugin-mcp-sandbox.test.ts`, and `test/oh-my-pi-legacy-migration.test.ts`.
- Build: `mise exec bun@1.4.0 -- bun run build` passed.
- `git diff --check` passed.

## Self-review and concerns

- Notification is intentionally fail-open. Reconciliation handler failures are swallowed and logged so config writes and API responses are never blocked by Feishu Pin/Unpin work.
- The callback seam is process-local and has no durable backlog. This matches the approved scope and means an exceptional crash between remote state mutation and the next lifecycle boundary can leave a stale Pin until a later reconciliation opportunity.
- The implementation preserves the narrow contract: only `streamCardId` participates, `pinStreamingCard` stays default-off, and no broader card classes were added to the policy.
