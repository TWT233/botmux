# Task 8: frozen MCP generation and pending-ask custody

## Delivered

- The persistent managed runtime owns a frozen MCP generation.  A supplied
  manifest, including explicit `null`, bypasses live session and plugin-registry
  discovery; the runtime starts the trusted Gateway before its App Server and
  supplies only the authenticated socket capability to that server.
- Runtime attachment replacement does not rotate the gateway generation.  The
  deterministic socket pathname and inode remain stable while a replacement
  worker reconnects, and config drift now includes an independently changed
  MCP-manifest digest even when the broader config hash is unchanged.
- Runtime-owned turns retain the trusted caller, turn ID, and dispatch attempt
  only while active.  The downstream plugin fixture observes those values after
  a worker replacement; terminal handling clears the metadata before later tool
  calls.
- Pending native asks stay in the runtime journal.  A worker bridges the Lark
  UI only: an exact answer is settled once, an explicit stop/expiry settles
  `null` and reaches `turn/interrupt`, and detach or non-terminal bridge failure
  leaves the journal entry replayable for a replacement worker.

## Verification

Runtime tests use generated `dist/index-btw-runtime.js`, so build and runtime
verification were deliberately serialized: build first, then the selector.

```sh
bun run build
./node_modules/.bin/vitest run --project unit \
  test/btw-runtime-support-continuity.test.ts \
  test/plugin-mcp-gateway.test.ts \
  test/ask-resume-restart.test.ts \
  test/traex-worker-bridge-wiring.test.ts
./node_modules/.bin/tsc --noEmit
git diff --check
```

The focused selector passed: 4 files / 61 tests.  TypeScript checking, the
final Bun build (including public-domain and embedded-asset audits), and the
whitespace check all passed.  Test-created fake App Server processes under this
task worktree were terminated after verification.
