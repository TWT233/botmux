# Task 1 Report

## Scope

- Task: Daemon group policy contract
- Branch: `feat/dashboard-chat-pin-override`
- Worktree: `/data00/home/wangqiyilang/playground/.worktree/pin-followups/dashboard/botmux`
- Write scope honored:
  - `src/core/dashboard-ipc-server.ts`
  - `test/dashboard-ipc.test.ts`
  - this report file

## TDD

### RED

Command:

```bash
bun test test/dashboard-ipc.test.ts -t 'projects pin streaming card row booleans from bot master switch and per-chat override|PUT /api/chat-pin-streaming-card/:chatId'
```

Observed failure before implementation:

```text
(fail) GET /api/groups (Phase B) > projects pin streaming card row booleans from bot master switch and per-chat override
Expected chat rows to include:
  pinStreamingCardMasterEnabled
  pinStreamingCardChatEnabled
  pinStreamingCardEffectiveEnabled
Received rows without those fields.

(fail) PUT /api/chat-pin-streaming-card/:chatId > forwards the per-chat pin override and returns the accepted state
Expected: 200
Received: 404

(fail) PUT /api/chat-pin-streaming-card/:chatId > rejects malformed request bodies with 400
Expected: 400
Received: 404

(fail) PUT /api/chat-pin-streaming-card/:chatId > maps store failures to 500
Expected: 500
Received: 404
```

Notes:

- The environment's `bun fetch('http://127.0.0.1:...')` is intercepted and returns proxy HTML `403`, so the new targeted IPC tests use a small `node:http` helper to hit loopback directly. This keeps the RED/GREEN signal on the daemon IPC contract itself rather than the host proxy behavior.

### GREEN

Command:

```bash
bun test test/dashboard-ipc.test.ts -t 'projects pin streaming card row booleans when the bot master switch is off|projects pin streaming card row booleans from bot master switch and per-chat override|PUT /api/chat-pin-streaming-card/:chatId'
```

Observed result:

```text
5 pass
0 fail
Ran 5 tests across 1 file.
```

## Changes

### `test/dashboard-ipc.test.ts`

- Added targeted group-row projection tests for:
  - bot master switch off
  - bot master switch on with per-chat opt-out
- Added targeted `PUT /api/chat-pin-streaming-card/:chatId` tests for:
  - success
  - malformed body
  - store failure mapped to `500`
- Added a local `requestJson()` helper using `node:http` so the new IPC tests bypass the host proxy behavior affecting `bun fetch` to loopback HTTP.

### `src/core/dashboard-ipc-server.ts`

- Added `GET /api/groups` projection fields:
  - `pinStreamingCardMasterEnabled`
  - `pinStreamingCardChatEnabled`
  - `pinStreamingCardEffectiveEnabled`
- Added `PUT /api/chat-pin-streaming-card/:chatId`
  - accepts `{ enabled: boolean }`
  - returns `400` for invalid body
  - forwards to `setChatStreamingCardPin(...)`
  - returns `404` for `bot_not_registered`
  - returns `500` for other store failures
  - returns `200` with `{ ok, enabled, changed }` on success

## Verification

- Focused contract tests passed:

```bash
bun test test/dashboard-ipc.test.ts -t 'projects pin streaming card row booleans when the bot master switch is off|projects pin streaming card row booleans from bot master switch and per-chat override|PUT /api/chat-pin-streaming-card/:chatId'
```

## SHA

- Pre-commit HEAD: `a574639ce9d47fc4cd59fa90e0b73be80fe05417`
- Final commit SHA: pending commit

## Concerns

- The broader `test/dashboard-ipc.test.ts` file currently has unrelated baseline failures in this environment because plain `bun fetch` to loopback HTTP is intercepted and returns proxy `403` HTML. Task 1 work isolated its own coverage with direct `node:http` requests and did not attempt to normalize the rest of that file.
