## Unit A - pinStreamingCard config ordering

### Scope

- Worktree: `/data00/home/wangqiyilang/playground/.worktree/pin-streaming-card/config-order-botmux`
- Branch: `task/pin-streaming-card-config-order`
- Base: `b21caba4`

### Unit breakdown

1. Add a shared per-`larkAppId` serializer for the full `write -> live-sync -> notify` critical section.
2. Route `/botconfig` `applyConfigField(... pinStreamingCard ...)` through that serializer.
3. Route dashboard `updateBotCardPrefs(... pinStreamingCard ...)` through the same serializer.
4. Add deterministic concurrency tests plus queue-release coverage.

### Dependency map

- `serializer -> bot-config-store`: true blocking
- `serializer -> card-prefs-store`: true blocking
- `tests -> serializer contract`: shared interface only

### Interface contract

- Serialization key: `larkAppId`
- Critical section: disk write, in-memory sync, notification scheduling
- Different bots proceed independently
- Notification remains fire-and-forget and fail-open
- Failures must release the queue for later writes
- No version-based ordering scheme

### RED evidence

Command:

```bash
bun run test -- test/card-prefs-auto-start.test.ts
```

Observed failure on `b21caba4`:

```text
FAIL  test/card-prefs-auto-start.test.ts > serializes pinStreamingCard writes across dashboard and /botconfig by invocation order
AssertionError: expected 2 to be 1
```

Meaning:

- The second write entered `rmwBotEntry` before the first write finished its post-write continuation.
- Current locking only serializes disk mutation, not the full `write -> live-sync -> notify` section.

Command:

```bash
bun run test -- test/pin-streaming-card-change.test.ts
```

Observed failure on `b21caba4`:

```text
FAIL  test/pin-streaming-card-change.test.ts > releases the per-bot serializer after a failed operation so later writes still run
TypeError: serializePinStreamingCardConfigChange is not a function
```

Meaning:

- The shared serializer required by the contract does not exist yet.

### Next step

Implement the smallest shared serializer in `src/services/pin-streaming-card-change.ts`, then wire both config writers through it and rerun the focused suite.

### GREEN checkpoint

Commands:

```bash
bun run test -- test/pin-streaming-card-change.test.ts
bun run test -- test/card-prefs-auto-start.test.ts
bun run test -- test/bot-config-store.test.ts
```

Result:

- All three focused unit files passed after adding the shared serializer and routing both entry points through it.
- The cross-entry test now proves the second write does not enter `rmwBotEntry` until the first write has finished disk write, live sync, and notification scheduling.

### Final verification

Commands:

```bash
bun run test -- test/bot-config-store.test.ts
bun run test -- test/card-prefs-auto-start.test.ts
bun run test -- test/pin-streaming-card-change.test.ts
bun run test -- test/command-handler.test.ts
bun run test -- test/dashboard-ipc.test.ts
bun run build
git diff --check
```

Result:

- All required focused tests passed.
- `bun run build` passed.
- `git diff --check` passed.

### Files changed

- `src/services/pin-streaming-card-change.ts`
- `src/services/bot-config-store.ts`
- `src/services/card-prefs-store.ts`
- `test/pin-streaming-card-change.test.ts`
- `test/card-prefs-auto-start.test.ts`
- `.superpowers/sdd/2026-08-28-pin-streaming-card/config-order-fix-report.md`
