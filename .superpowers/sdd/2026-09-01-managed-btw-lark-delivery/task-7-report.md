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
