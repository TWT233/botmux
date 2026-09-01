# Streaming-card Pin provenance recovery design

## Goal

Resolve #1125 by recovering safe Pin ownership from Feishu after daemon restart
and during explicit disable reconciliation, without a durable local journal or
risking removal of manual/other-bot Pins.

## Authorization invariant

A remote Pin is Botmux-owned only when its message id is in a request-time
snapshot of a local session's real streamCardId or frozen streaming-card ids,
and Feishu reports operator_id_type === 'app_id' plus operator_id equal to the
current bot app id. Message author, card content, id shape, or later session
state can never broaden that candidate set. Remote discovery only narrows it.
An enabled setting and a local streaming-card id are candidates, never proof.

## Lark transport

listChatPins(larkAppId, chatId) calls im.v1.pin.list directly with page_size 50
and explicit page tokens. It returns normalized records and throws on non-zero
or missing response codes, missing/repeated continuation tokens, and SDK errors.
Worker code catches failures per chat, logs debug, and continues; failed lookup
is never represented as a trustworthy empty list.

pinMessage(larkAppId, messageId) returns the normalized `data.pin` record, not a
success boolean. A caller may claim ownership only when that record repeats the
exact requested message id and reports `operator_id_type === 'app_id'` with
`operator_id === larkAppId`. A successful code with missing, malformed, foreign,
or mismatched Pin provenance remains unowned.

## Reconciliation

A recovery request freezes active session identity, chat/session, and candidate
ids, groups candidates by chat, and lists each chat once. Exact same-app remote
matches map back to their frozen owner.

- Effective on classifies the current id from the list before mutating it. An
  exact same-app Pin restores process-local ownership without create; any human,
  other-app, malformed, or mixed matching record is a collision and is neither
  claimed nor re-pinned. Only a current id absent from the list is created, and
  the create response must independently prove exact same-app ownership.
- Normal enabled reconciliation keeps the current card and retires predecessors.
- Effective off cleans matching ids through the existing per-message queue.
- Explicit bot-wide and per-chat off freeze local candidates for FIFO ordering,
  but clean only process-owned ids plus candidates proven same-app by a fresh
  list. A list failure preserves process-owned cleanup and skips ambiguous ids.
- Bot-wide off may retry an already opted-out chat only when remote provenance
  proves ownership, addressing a previous failed opt-out Unpin safely.
- Ordinary disable, close, and transfer clean process-owned ids only. They never
  infer ownership from the enabled setting or the local current/frozen snapshot.

Startup recovery is queued after restoreActiveSessions and is fire-and-forget.
Startup and explicit disable share the per-bot FIFO. Candidate ids are frozen at
enqueue; no long-lived Pin-list cache is introduced. A restored worker's silent
`ready` event never re-pins its persisted card independently; the queued list
reconciliation is the single startup ownership authority.

## Safety and verification

No-transport sessions make zero list/mutation calls. One chat failure does not
stop other chats. Same-app non-candidates, humans, and other apps are untouched.
Tests cover pagination/error boundaries, create-response provenance, current-id
collisions, list-to-create races, subsequent ordinary disable/close/transfer,
explicit bot/chat off, one query per chat, partial failures, no-transport, and
FIFO ordering.
