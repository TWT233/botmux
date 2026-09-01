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

## Fix round 1/5: freeze runtime MCP process environment

### RED evidence

- A managed-runtime relay test started the runtime with ambient owner/env
  values, then ensured a profile with `FROZEN_SESSION_ENV=first-generation`
  and `ownerOpenId=ou_frozen_owner`.  After attachment replacement, the real
  plugin fixture returned `frozen=` and descriptor-supplied owner values.
- An ownerless managed profile likewise allowed descriptor-supplied owner values
  into the real downstream plugin process.
- A generic gateway regression showed that blindly forwarding the gateway's
  constructor env would change existing non-managed gateway behavior.

### Green behavior

- The runtime passes its already-sanitized, owner-final session env explicitly
  to the runtime-owned MCP host.  The host snapshots it into the Gateway.
- Only this explicit frozen-host path contributes that session env to stdio
  plugin subprocesses.  It applies the frozen owner after descriptor env, or
  deletes both owner channels for an ownerless session.
- Generic and omitted-manifest gateway callers retain their inherited default
  environment behavior.

### Verification

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

The focused selector passed: 4 files / 64 tests.  The fresh build and
TypeScript check passed; `git diff --check` produced no output.

## Fix round 2/5: tighten MCP SDK environment type boundary

### RED evidence

- The integration controller reported `TS2322` at the MCP SDK stdio transport:
  `ProcessEnv` permits `undefined`, while the SDK requires
  `Record<string, string>`.  The local pre-fix exact compiler command completed
  with exit 0 and no output, so the durable fix makes the stricter boundary
  explicit instead of depending on the local compiler's inference.
- A real plugin fixture regression covers a frozen environment entry whose
  value is `undefined`; the downstream process must observe an omitted value,
  never the literal string `undefined`.

### Green behavior

- Gateway stdio launch now converts its composed environment to
  `Record<string, string>` immediately before entering the MCP SDK, eliding
  only `undefined` entries.  Frozen environment, descriptor, session, and
  owner precedence are unchanged.

### Final command results

```text
./node_modules/.bin/vitest run --project unit test/plugin-mcp-gateway.test.ts -t 'omits undefined frozen environment|keeps non-managed gateways'
exit 0 — 2 tests passed

./node_modules/.bin/tsc --noEmit --pretty false
exit 0 — no output

bun run build
exit 0 — public-domain and embedded-asset audits passed

git diff --check
exit 0 — no output
```
