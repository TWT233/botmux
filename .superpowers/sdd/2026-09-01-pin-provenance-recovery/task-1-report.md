# Task 1 Report

## Scope

- Worktree: `/data00/home/wangqiyilang/playground/.worktree/pin-followups/provenance/botmux`
- Branch: `feat/pin-provenance-recovery`
- Write scope respected:
  - `src/im/lark/client.ts`
  - `test/lark-pin-message.test.ts`
  - this report

## Unit Breakdown

1. Add focused RED tests for chat-pin pagination payloads, normalization, and failure contracts.
2. Implement the minimal `listChatPins` wrapper and `LarkPinRecord` normalization in `src/im/lark/client.ts`.
3. Re-run the focused test file to confirm GREEN, then commit and push.

## Dependency Graph

- Unit 1 -> Unit 2: true blocking
  Unit 2 must be shaped by the observed failing tests.
- Unit 2 -> Unit 3: true blocking
  Verification and commit only make sense after implementation exists.

## Interface Contract

- Export `LarkPinRecord` with normalized camelCase fields:
  - `messageId: string`
  - `chatId?: string`
  - `operatorId?: string`
  - `operatorIdType?: string`
  - `createTime?: string`
- Export `listChatPins(larkAppId, chatId): Promise<LarkPinRecord[]>`
- Request contract:
  - call `c.im.v1.pin.list`
  - first page params must be `{ chat_id, page_size: 100 }`
  - next pages must append `page_token`
- Failure contract:
  - non-zero `code` throws
  - missing `code` throws
  - SDK throw rethrows
  - `has_more === true` with missing `page_token` throws
  - repeated `page_token` throws

## RED Evidence

Command:

```bash
bun test test/lark-pin-message.test.ts
```

Observed failure before implementation:

```text
bun test v1.4.0 (34cbb9a40)

test/lark-pin-message.test.ts:

# Unhandled error between tests
-------------------------------
SyntaxError: Export named 'listChatPins' not found in module '/data00/home/wangqiyilang/playground/.worktree/pin-followups/provenance/botmux/src/im/lark/client.ts'.
-------------------------------

0 pass
1 fail
1 error
Ran 1 test across 1 file. [290.00ms]
```

## Changes

- Added `listChatPins` tests that pin:
  - exact first/next request payloads
  - normalized output records
  - non-zero and missing `code`
  - SDK throw
  - missing next-page token
  - repeated page token
- Added `LarkPinRecord` and a minimal `listChatPins` implementation that:
  - uses `im.v1.pin.list`
  - pages explicitly with `page_size: 100`
  - normalizes snake_case response fields to camelCase
  - throws on truncated or unsafe pagination states

## GREEN Verification

Command:

```bash
bun test test/lark-pin-message.test.ts
```

Observed passing result:

```text
bun test v1.4.0 (34cbb9a40)

test/lark-pin-message.test.ts:
(pass) pinMessage/unpinMessage boolean contract > pin calls SDK with exact create payload
(pass) pinMessage/unpinMessage boolean contract > unpin calls SDK with exact delete payload
(pass) pinMessage/unpinMessage boolean contract > returns true only when Lark confirms (code 0)
(pass) pinMessage/unpinMessage boolean contract > returns false on non-zero code
(pass) pinMessage/unpinMessage boolean contract > returns false when response has no code field (treated as failure)
(pass) pinMessage/unpinMessage boolean contract > returns false when the SDK throws and logs only at debug without leaking auth tokens
(pass) pinMessage/unpinMessage boolean contract > unpin failures log only at debug (not warn)
(pass) pinMessage/unpinMessage boolean contract > two successful unpin calls both return true (wrapper is stateless)
(pass) listChatPins pagination contract > drains pages with exact first and next payloads and normalizes records
(pass) listChatPins pagination contract > throws on non-zero code or missing code
(pass) listChatPins pagination contract > rethrows SDK errors
(pass) listChatPins pagination contract > throws when has_more is true but next page token is missing
(pass) listChatPins pagination contract > throws when the server repeats a page token

13 pass
0 fail
34 expect() calls
Ran 13 tests across 1 file. [292.00ms]
```

## Commit

- Commit message: `feat(card): 封装群内 Pin 来源分页查询`
- Commit SHA: `PENDING`

## Concerns

- Verification is intentionally scoped to `test/lark-pin-message.test.ts` per task brief and write-scope limits; no broader suite was run in this task.
