#!/usr/bin/env node
// Minimal stand-in for `codex app-server --listen ws://127.0.0.1:<port>` used by
// codex-rpc-engine.test.ts. Serves HTTP /readyz AND a JSON-RPC WebSocket on the
// SAME port (as the real app-server does), answering the handshake + thread/turn
// requests. Env knobs drive the failure-path tests:
//   FAKE_HANG_TURN=1     → never answer turn/start (wedged app-server)
//   FAKE_HANG_TURN_NOTIFY=1 → emit started/completed but lose the ack
//   FAKE_TERMINAL_BEFORE_RESPONSE=1 → broadcast terminal before turn/start ack
//   FAKE_ERROR_AFTER_STARTED=1 → emit turn/started, reject the response, then complete
//   FAKE_DUPLICATE_TERMINAL=1 → broadcast turn/completed twice
//   FAKE_DIE_AFTER_MS=N  → exit(1) after N ms (crash → engine onDead)
//   FAKE_THREAD_CONFIG_FILE=path → write the received thread/start params to path
//                                  (lets a test assert model/effort forwarding)
//   FAKE_RESUME_CONFIG_FILE=path → write the received thread/resume params to path
//                                  (lets a test assert model/effort are SUPPRESSED
//                                   on resume)
//   FAKE_TRACE_FILE=path → append process + RPC observations for characterization
//   FAKE_DELAY_THREAD_READ_MS=N → delay thread/read responses for concurrency tests
//   FAKE_NOTIFY_ON_TURN=1 → emit one ordinary notification while processing turn/start
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const listenArg = process.argv[process.argv.indexOf('--listen') + 1] || '';
const m = listenArg.match(/ws:\/\/127\.0\.0\.1:(\d+)/);
const port = m ? Number(m[1]) : 0;
const HANG_TURN = process.env.FAKE_HANG_TURN === '1';
const HANG_TURN_NOTIFY = process.env.FAKE_HANG_TURN_NOTIFY === '1';
const TERMINAL_BEFORE_RESPONSE = process.env.FAKE_TERMINAL_BEFORE_RESPONSE === '1';
const ERROR_AFTER_STARTED = process.env.FAKE_ERROR_AFTER_STARTED === '1';
const DUPLICATE_TERMINAL = process.env.FAKE_DUPLICATE_TERMINAL === '1';
const CONFLICTING_TERMINAL = process.env.FAKE_CONFLICTING_TERMINAL === '1';
const NO_TURN_TERMINAL = process.env.FAKE_NO_TURN_TERMINAL === '1';
const DELAY_TURN_TERMINAL_MS = Number(process.env.FAKE_DELAY_TURN_TERMINAL_MS ?? '0');
const TURN_STATUS = process.env.FAKE_TURN_STATUS ?? '';
const DIE_AFTER = process.env.FAKE_DIE_AFTER_MS ? Number(process.env.FAKE_DIE_AFTER_MS) : 0;
const PREVIEW_DELAY_READS = Number(process.env.FAKE_PREVIEW_DELAY_READS ?? '0');
const UPDATED_DELAY_READS = Number(process.env.FAKE_UPDATED_DELAY_READS ?? '0');
const UPDATED_BEFORE = Number(process.env.FAKE_UPDATED_BEFORE ?? '100');
const UPDATED_AFTER = Number(process.env.FAKE_UPDATED_AFTER ?? '101');
let threadReadAttempt = 0;
let currentThreadName;
const REQUEST_USER_INPUT = process.env.FAKE_REQUEST_USER_INPUT === '1';
const DELAY_THREAD_READ_MS = Number(process.env.FAKE_DELAY_THREAD_READ_MS ?? '0');
const NOTIFY_ON_TURN = process.env.FAKE_NOTIFY_ON_TURN === '1';
const TRACE_FILE = process.env.FAKE_TRACE_FILE;
const PID_FILE = process.env.FAKE_PID_FILE;
const PID_DIR = process.env.FAKE_PID_DIR;
const BTW_MODE = process.env.FAKE_BTW_MODE ?? '';
const BTW_MAP = (() => {
  try { return JSON.parse(process.env.FAKE_BTW_MAP ?? '{}'); } catch { return {}; }
})();
let turnCount = 0;

function trace(event, detail = {}) {
  if (!TRACE_FILE) return;
  try {
    writeFileSync(TRACE_FILE, `${JSON.stringify({ event, ...detail })}\n`, { flag: 'a' });
  } catch { /* test-only observation */ }
}

function traceRpc(method, params) {
  trace('rpc', { method, params });
}

trace('spawn', { argv: process.argv.slice(2), env: { FAKE_TRACE_ENV: process.env.FAKE_TRACE_ENV } });
if (PID_FILE) {
  try {
    writeFileSync(PID_FILE, JSON.stringify({ pid: process.pid, listen: listenArg }) + '\n', { mode: 0o600 });
  } catch { /* test-owned cleanup hint only */ }
}
if (PID_DIR) {
  try {
    mkdirSync(PID_DIR, { recursive: true });
    writeFileSync(join(PID_DIR, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      listen: listenArg,
      fixturePath: fileURLToPath(import.meta.url),
      argv: process.argv.slice(1),
    }) + '\n', { flag: 'wx', mode: 0o600 });
  } catch { /* test-owned cleanup hint only */ }
}

const httpServer = createServer((req, res) => {
  if (req.url === '/readyz') { res.writeHead(200); res.end('ok'); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer });
wss.on('connection', (ws) => {
  let pendingTurnReply;
  let pendingNativeTurnId;
  let pendingThreadId;
  const emitTurnStarted = (threadId, nativeTurnId) => {
    ws.send(JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/started',
      params: { threadId, turn: { id: nativeTurnId } },
    }));
  };
  const emitTurnCompleted = (threadId, nativeTurnId, status = TURN_STATUS) => {
    if (NO_TURN_TERMINAL) return;
    const turn = {
      id: nativeTurnId,
      ...(status ? { status } : {}),
      ...(status === 'failed'
        ? { error: { code: 'fake_failed', message: 'fake failure' } }
        : {}),
    };
    const completed = JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { threadId, turn },
    });
    ws.send(completed);
    if (DUPLICATE_TERMINAL) ws.send(completed);
  };
  const emitTurnLifecycle = (threadId, nativeTurnId, status = TURN_STATUS) => {
    emitTurnStarted(threadId, nativeTurnId);
    emitTurnCompleted(threadId, nativeTurnId, status);
  };
  const emitBtwCompleted = (threadId, nativeTurnId, answer, status = 'completed', extra = {}) => {
    const completed = JSON.stringify({
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: {
        threadId,
        turn: {
          id: nativeTurnId,
          status,
          ...(status === 'completed' ? { answer } : {}),
          ...extra,
        },
      },
    });
    ws.send(completed);
    if (CONFLICTING_TERMINAL) {
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: {
          threadId,
          turn: {
            id: nativeTurnId,
            status: 'failed',
            error: { code: 'fake_conflicting_terminal', message: 'conflicting terminal' },
          },
        },
      }));
    }
  };
  const scheduleBtwTerminal = (threadId, nativeTurnId) => {
    const config = BTW_MAP?.[nativeTurnId] ?? {};
    const delayMs = Number(config.delayMs ?? 0);
    const answer = config.answer ?? `answer-for-${nativeTurnId}`;
    const status = config.status ?? 'completed';
    const send = () => {
      if (status === 'failed') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: {
            threadId,
            turn: {
              id: nativeTurnId,
              status: 'failed',
              error: {
                code: config.errorCode ?? 'fake_btw_failed',
                message: config.message ?? 'fake btw failure',
              },
            },
          },
        }));
        return;
      }
      if (status === 'cancelled') {
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: {
            threadId,
            turn: {
              id: nativeTurnId,
              status: 'cancelled',
              message: config.message ?? 'fake btw cancelled',
            },
          },
        }));
        return;
      }
      if (config.replayTerminalTurnId) {
        emitBtwCompleted(
          threadId,
          config.replayTerminalTurnId,
          config.replayAnswer ?? `answer-for-${config.replayTerminalTurnId}`,
          'completed',
        );
      }
      emitBtwCompleted(threadId, nativeTurnId, answer, 'completed');
    };
    if (delayMs > 0) setTimeout(send, delayMs);
    else send();
  };
  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    if (typeof msg.method === 'string') traceRpc(msg.method, msg.params);
    if (REQUEST_USER_INPUT && msg.id === 900 && (msg.result !== undefined || msg.error !== undefined)) {
      if (!pendingTurnReply) return;
      // Real traex 0.200.19 normalizes ANY reply to requestUserInput (empty
      // answers OR a JSON-RPC error) into {answers:{}} and COMPLETES the turn.
      // Model that: a direct reply always completes the turn. Only an explicit
      // `turn/interrupt` (below) ends it as interrupted. This keeps the fixture
      // faithful to the verified product behavior instead of inventing an
      // "error bubbles up" semantics that traex does not implement.
      const accepted = msg.result?.answers?.choice?.answers?.[0] === 'Yes';
      ws.send(JSON.stringify({
        jsonrpc: '2.0',
        id: pendingTurnReply,
        result: { accepted, turn: { id: pendingNativeTurnId, status: 'completed' } },
      }));
      emitTurnLifecycle(pendingThreadId, pendingNativeTurnId, 'completed');
      pendingTurnReply = undefined;
      pendingNativeTurnId = undefined;
      pendingThreadId = undefined;
      return;
    }
    if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
    const reply = (result) => ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    switch (msg.method) {
      case 'initialize': return reply({ ok: true });
      case 'thread/start': {
        if (process.env.FAKE_THREAD_CONFIG_FILE) {
          try { writeFileSync(process.env.FAKE_THREAD_CONFIG_FILE, JSON.stringify(msg.params ?? {})); } catch { /* test-only */ }
        }
        return reply({ thread: { id: 'thread-fake-1' } });
      }
      case 'thread/resume': {
        if (process.env.FAKE_RESUME_CONFIG_FILE) {
          try { writeFileSync(process.env.FAKE_RESUME_CONFIG_FILE, JSON.stringify(msg.params ?? {})); } catch { /* test-only */ }
        }
        return reply({ thread: { id: msg.params?.threadId ?? 'thread-fake-1' } });
      }
      case 'thread/read':
        threadReadAttempt += 1;
        const threadRead = { thread: {
          id: msg.params?.threadId ?? 'thread-fake-1',
          name: currentThreadName ?? null,
          preview: threadReadAttempt > PREVIEW_DELAY_READS ? '<botmux_routing> first message preview' : '',
          updatedAt: threadReadAttempt > UPDATED_DELAY_READS ? UPDATED_AFTER : UPDATED_BEFORE,
        } };
        if (DELAY_THREAD_READ_MS > 0) return setTimeout(() => reply(threadRead), DELAY_THREAD_READ_MS);
        return reply(threadRead);
      case 'thread/name/set': currentThreadName = msg.params?.name; return reply({});
      case 'turn/interrupt': {
        // FAKE_INTERRUPT_ERROR=1 models an interrupt that itself fails: the
        // app-server rejects turn/interrupt with a JSON-RPC error. The engine
        // then has no lever left and must declare itself dead (onDead) rather
        // than leaking a wedged turn.
        if (process.env.FAKE_INTERRUPT_ERROR === '1') {
          return ws.send(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            error: { code: -32000, message: 'interrupt failed' },
          }));
        }
        // Verified real behavior: interrupt ends the in-flight turn as
        // 'interrupted' and acks with {}. Resolve the pending turn/start as an
        // interrupted turn so the engine test can assert the turn stopped
        // instead of silently completing.
        if (pendingTurnReply) {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: pendingTurnReply,
            result: { turn: { id: pendingNativeTurnId, status: 'interrupted' } },
          }));
          emitTurnLifecycle(pendingThreadId, pendingNativeTurnId, 'interrupted');
          pendingTurnReply = undefined;
          pendingNativeTurnId = undefined;
          pendingThreadId = undefined;
        }
        return reply({});
      }
      case 'turn/start': {
        turnCount++;
        const nativeTurnId = `turn-fake-${turnCount}`;
        const threadId = msg.params?.threadId;
        if (NOTIFY_ON_TURN) {
          ws.send(JSON.stringify({
            jsonrpc: '2.0', method: 'item/agentMessage/delta',
            params: { threadId, turnId: nativeTurnId, delta: 'fake notification' },
          }));
        }
        if (HANG_TURN) {
          if (HANG_TURN_NOTIFY) emitTurnLifecycle(threadId, nativeTurnId);
          return;
        }
        if (REQUEST_USER_INPUT) {
          pendingTurnReply = msg.id;
          pendingNativeTurnId = nativeTurnId;
          pendingThreadId = threadId;
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 900,
            method: 'item/tool/requestUserInput',
            params: {
              threadId: msg.params?.threadId ?? 'thread-fake-1',
              turnId: nativeTurnId,
              itemId: 'item-fake-1',
              questions: [{
                id: 'choice', header: 'Test', question: 'Continue?', multiSelect: false,
                options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }],
              }],
            },
          }));
          return;
        }
        if (ERROR_AFTER_STARTED) {
          emitTurnStarted(threadId, nativeTurnId);
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32000, message: 'fake response failure after turn/started' },
          }));
          setTimeout(() => emitTurnCompleted(threadId, nativeTurnId), 100);
          return;
        }
        if (TERMINAL_BEFORE_RESPONSE) {
          if (DELAY_TURN_TERMINAL_MS > 0) {
            setTimeout(() => emitTurnLifecycle(threadId, nativeTurnId), DELAY_TURN_TERMINAL_MS);
          } else {
            emitTurnLifecycle(threadId, nativeTurnId);
          }
          reply({ turn: { id: nativeTurnId } });
        } else {
          reply({ turn: { id: nativeTurnId } });
          if (DELAY_TURN_TERMINAL_MS > 0) {
            setTimeout(() => emitTurnLifecycle(threadId, nativeTurnId), DELAY_TURN_TERMINAL_MS);
          } else {
            emitTurnLifecycle(threadId, nativeTurnId);
          }
        }
        return;
      }
      case 'turn/btw': {
        const threadId = msg.params?.threadId ?? 'thread-fake-1';
        const nativeTurnId = msg.params?.turnId ?? `btw-turn-${turnCount + 1}`;
        const config = BTW_MAP?.[nativeTurnId] ?? {};
        if (config.delta) {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'item/agentMessage/delta',
            params: { threadId, turnId: nativeTurnId, delta: config.delta },
          }));
        }
        if (config.tracePayload !== false) {
          trace('btw_submission', {
            nativeTurnId,
            params: msg.params ?? null,
          });
        }
        if (BTW_MODE === 'pre-send-throw') {
          return reply({ rejected: true });
        }
        if (BTW_MODE === 'terminal-before-ack') {
          scheduleBtwTerminal(threadId, nativeTurnId);
          return setTimeout(() => reply({ turn: { id: nativeTurnId } }), Number(config.ackDelayMs ?? 10));
        }
        if (BTW_MODE === 'tool-request') {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            id: 1900,
            method: 'item/tool/call',
            params: { threadId, turnId: nativeTurnId, tool: 'forbidden-btw-tool' },
          }));
          return reply({ turn: { id: nativeTurnId } });
        }
        if (BTW_MODE === 'tool-execution') {
          ws.send(JSON.stringify({
            jsonrpc: '2.0',
            method: 'item/tool/result',
            params: {
              threadId,
              turnId: nativeTurnId,
              item: { type: 'toolResult' },
              result: { success: true },
            },
          }));
          return reply({ turn: { id: nativeTurnId } });
        }
        if (BTW_MODE === 'post-send-timeout-then-terminal') {
          scheduleBtwTerminal(threadId, nativeTurnId);
          return;
        }
        if (BTW_MODE === 'post-send-error-then-terminal') {
          ws.send(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            error: { code: -32000, message: 'fake BTW acknowledgement lost after send' },
          }));
          scheduleBtwTerminal(threadId, nativeTurnId);
          return;
        }
        if (BTW_MODE === 'post-send-disconnect') {
          scheduleBtwTerminal(threadId, nativeTurnId);
          setTimeout(() => {
            try { ws.close(); } catch { /* already gone */ }
          }, Number(config.disconnectDelayMs ?? 20));
          return;
        }
        reply({ turn: { id: nativeTurnId } });
        scheduleBtwTerminal(threadId, nativeTurnId);
        return;
      }
      default: return reply({});
    }
  });
});
httpServer.listen(port, '127.0.0.1');
if (DIE_AFTER > 0) setTimeout(() => process.exit(1), DIE_AFTER);
