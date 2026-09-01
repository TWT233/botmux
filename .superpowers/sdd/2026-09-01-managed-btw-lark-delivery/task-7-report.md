# Task 7: persistent Trae main-session proxy

## Delivered

- Eligible Trae sessions receive a daemon-owned BTW runtime locator before the
  synchronous worker fork.  Legacy/restored sessions without that locator retain
  the existing local `CodexRpcEngine` lifecycle.
- Workers attach through `PersistentTraeRpcProxy`; observer teardown closes the
  subscription and sends `detach_session` only.  The runtime-owned app server
  and native thread remain alive across replacement attachments.
- Managed notifications are journaled and processed in strict order: worker
  projection, daemon cursor persistence, matching positive ACK, then runtime
  `ack_events`.  Gap, overlap, regression, identity mismatch, and invalid ACK
  paths detach without acknowledging runtime events.
- Fresh first-turn ownership, follow-up main-turn routing, terminal-before-submit
  buffering, worker restart reattachment, close/transfer/restart/suspend detach
  paths, and app-server/request-user-input failure boundaries use the managed
  attachment state machine without changing local RPC ownership.
- Runtime journal pressure rejects new main turns instead of silently evicting
  unacknowledged events.

## Verification

```sh
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run --project unit test/btw-runtime-main-proxy.test.ts test/btw-worker-proxy-wiring.test.ts test/codex-rpc-lifecycle.test.ts test/traex-worker-bridge-wiring.test.ts test/codex-rpc-engine.test.ts
bun run build
git diff --check
```

The focused selector passed: 5 files / 131 tests.  The build completed with the
public-domain and embedded-asset audits passing.

## Fix round 1/5: admission, pending asks, and observer shutdown

### RED evidence

- Added the fake-app-server behavior test for a pending `request_user_input`.
  Before the fix it failed because the old runtime callback threw, causing the
  engine's failure path to publish `main_terminal: aborted` before an answer.
- Added a capability-denial test with `stableParentThread: false`. Before the
  fix the runtime still spawned the fake app server and returned an attachment
  with all capabilities set to true.
- Added a synchronous observer-close test. Before the fix the proxy had no
  `closeObserver()` operation, so parent-exit code could reach `process.exit()`
  before attachment socket invalidation.

### Green behavior

- Managed capability admission no longer uses a static all-true constant. The
  BTW-specific launch contract lives in `adapters/cli/btw.ts`, keeping the
  generic `CliAdapter` registry/interface unchanged. `persistentRuntime` is
  derived only after the runtime has started the App Server and native thread.
  The production Trae contract deliberately reports `nativeBtw: false`: Task 7
  does not construct a proven live `BtwAdapter`; Task 9 owns that upgrade. As a
  result, eligible Trae sessions safely remain on the existing local RPC path
  rather than being blocked or falsely admitted as managed. The injected test
  contract proves a missing bit returns no attachment and spawns no App Server.
- `request_user_input` stores its exact resolver before publishing a replayable
  journal notification. The `answer_user_input` command accepts it exactly
  once; unknown and duplicate IDs fail. Detach/reattach from cursor zero replays
  the same ask ID, and the native turn receives no terminal until the explicit
  answer is accepted.
- Worker-side ask custody no longer fails active turns or throws. It holds the
  bridge at the ask event, so no cursor persistence or runtime ACK occurs until
  an exact resolver answers it. Controlled detach releases that local waiter,
  stops the bridge without commit/ACK, and allows the runtime journal to replay
  to a replacement attachment.
- `PersistentTraeRpcProxy.closeObserver()` synchronously destroys the observer
  subscription; `killCli()` calls the synchronous invalidation before its
  asynchronous, tracked bridge-stop/detach cleanup. The real runtime lifecycle
  test verifies a new attachment has the same App Server URL and native thread
  after observer teardown.

### Verification

```sh
./node_modules/.bin/vitest run --project unit test/btw-runtime-main-proxy.test.ts test/btw-worker-proxy-wiring.test.ts test/codex-rpc-lifecycle.test.ts test/traex-worker-bridge-wiring.test.ts test/codex-rpc-engine.test.ts
./node_modules/.bin/tsc --noEmit
bun run build
git diff --check
```

Focused verification passed: 5 files / 136 tests. `tsc --noEmit` and the full
build passed, including the public-domain and embedded-asset audits.
