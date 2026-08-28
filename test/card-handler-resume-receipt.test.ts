/**
 * card-handler resume action receipt: distinguish "topic route reactivated"
 * from "CLI history restored".
 *
 * When the resumed session's adapter can only resume a precise cliSessionId
 * (copilot / kimi / cursor) and none was persisted, the receipt must say the
 * next message starts a FRESH session — not "会话已恢复", which would make the
 * user believe the old context is still there.
 *
 * Run: pnpm vitest run test/card-handler-resume-receipt.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

const { continuePublishedStreamingCardPinChainMock, deleteMessageMock } = vi.hoisted(() => ({
  continuePublishedStreamingCardPinChainMock: vi.fn(),
  deleteMessageMock: vi.fn(async () => {}),
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

// Only resumeSession is faked; the rest of session-manager stays real so the
// receipt path (locale, display name, delivery) exercises production code.
vi.mock('../src/core/session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/session-manager.js')>();
  return {
    ...actual,
    resumeSession: vi.fn(),
  };
});

vi.mock('../src/core/worker-pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/worker-pool.js')>();
  return {
    ...actual,
    continuePublishedStreamingCardPinChain: continuePublishedStreamingCardPinChainMock,
  };
});

vi.mock('../src/im/lark/client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/im/lark/client.js')>();
  return { ...actual, deleteMessage: deleteMessageMock };
});

import { handleCardAction } from '../src/im/lark/card-handler.js';

const APP_ID = 'h1';
const ROOT_ID = 'om_root_resume';
const CHAT_ID = 'oc_1';
const OWNER = 'ou_owner';

function makeDs(cliId: string, cliSessionId?: string): DaemonSession {
  return {
    larkAppId: APP_ID,
    chatId: CHAT_ID,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '',
    lastMessageAt: Date.now(),
    hasHistory: true,
    worker: null,
    workerPort: null,
    workerToken: null,
    workingDir: '/repo/real',
    session: {
      sessionId: 'sess-resume-1',
      cliId,
      ...(cliSessionId ? { cliSessionId } : {}),
      chatId: CHAT_ID,
      rootMessageId: ROOT_ID,
      title: 'task',
      status: 'active',
      createdAt: new Date().toISOString(),
      workingDir: '/repo/real',
    },
  } as DaemonSession;
}

function resumeAction(): any {
  return {
    operator: { open_id: OWNER },
    action: {
      value: { action: 'resume', root_id: ROOT_ID, session_id: 'sess-resume-1' },
    },
    context: { open_message_id: 'om_card' },
  };
}

async function fresh() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const handler = await import('../src/im/lark/card-handler.js');
  const sessionManager = await import('../src/core/session-manager.js');
  registry.loadBotConfigs().forEach(c => registry.registerBot(c));
  return { handler, resumeSession: sessionManager.resumeSession as unknown as ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-resume-receipt-'));
  const cfg = join(dir, 'bots.json');
  writeFileSync(cfg, JSON.stringify([{
    larkAppId: APP_ID,
    larkAppSecret: 's',
    cliId: 'copilot',
    lang: 'zh',
    allowedUsers: [OWNER],
  }], null, 2));
  process.env.BOTS_CONFIG = cfg;
});

afterEach(() => {
  delete process.env.BOTS_CONFIG;
  vi.restoreAllMocks();
  continuePublishedStreamingCardPinChainMock.mockReset();
  deleteMessageMock.mockClear();
});

describe('card-handler resume receipt', () => {
  // The resume flow reposts the live streaming card FIRST (sessionReply with an
  // interactive card body) and then sends the "会话已恢复 / 新起干净会话" text
  // receipt from a background task. The tests use an exact receipt barrier,
  // rather than sleeping for a fire-and-forget task.
  function replyWithReceiptBarrier() {
    let receiptArrived!: () => void;
    const receipt = new Promise<void>(resolve => { receiptArrived = resolve; });
    const sessionReply = vi.fn(async (_rootId: string, content: string) => {
      if (!content.trimStart().startsWith('{')) receiptArrived();
      return 'om_reply';
    });
    return { sessionReply, receipt };
  }
  const textReceipt = (sessionReply: ReturnType<typeof vi.fn>): string => {
    const textCalls = sessionReply.mock.calls
      .map(c => String(c[1] ?? ''))
      .filter(body => !body.trimStart().startsWith('{')); // drop the card JSON repost
    return textCalls.join('\n');
  };
  const repostedCardCount = (sessionReply: ReturnType<typeof vi.fn>): number =>
    sessionReply.mock.calls.filter(c => String(c[1] ?? '').trimStart().startsWith('{')).length;

  it('copilot session without a cliSessionId: receipt says the next message starts a fresh session', async () => {
    const { handler, resumeSession: mockedResume } = await fresh();
    mockedResume.mockResolvedValue({ ok: true, ds: makeDs('copilot') });
    const { sessionReply, receipt: receiptDone } = replyWithReceiptBarrier();
    const deps = { activeSessions: new Map(), sessionReply, lastRepoScan: new Map() } as any;

    await handler.handleCardAction(resumeAction(), deps, APP_ID);
    await receiptDone;

    expect(mockedResume).toHaveBeenCalledWith('sess-resume-1', deps.activeSessions);
    // The live streaming card is reposted before the text receipt.
    expect(repostedCardCount(sessionReply)).toBe(1);
    const receiptText = textReceipt(sessionReply);
    expect(receiptText).toContain('话题路由已重新激活');
    expect(receiptText).toContain('新起干净会话');
    // Must NOT claim the history session is back.
    expect(receiptText).not.toContain('会话已恢复');
  });

  it('copilot session WITH a cliSessionId: normal "session resumed" receipt', async () => {
    const { handler, resumeSession: mockedResume } = await fresh();
    mockedResume.mockResolvedValue({ ok: true, ds: makeDs('copilot', 'cli-sess-9') });
    const { sessionReply, receipt: receiptDone } = replyWithReceiptBarrier();
    const deps = { activeSessions: new Map(), sessionReply, lastRepoScan: new Map() } as any;

    await handler.handleCardAction(resumeAction(), deps, APP_ID);
    await receiptDone;

    expect(repostedCardCount(sessionReply)).toBe(1);
    const receiptText = textReceipt(sessionReply);
    expect(receiptText).toContain('会话已恢复');
    expect(receiptText).not.toContain('新起干净会话');
  });

  it('claude-code session (always resumable via botmux sessionId): normal receipt', async () => {
    const { handler, resumeSession: mockedResume } = await fresh();
    mockedResume.mockResolvedValue({ ok: true, ds: makeDs('claude-code') });
    const { sessionReply, receipt: receiptDone } = replyWithReceiptBarrier();
    const deps = { activeSessions: new Map(), sessionReply, lastRepoScan: new Map() } as any;

    await handler.handleCardAction(resumeAction(), deps, APP_ID);
    await receiptDone;

    expect(repostedCardCount(sessionReply)).toBe(1);
    const receiptText = textReceipt(sessionReply);
    expect(receiptText).toContain('会话已恢复');
    expect(receiptText).not.toContain('新起干净会话');
  });

  it('commits, withdraws predecessor, and sends receipt without waiting for the detached Pin chain', async () => {
    const { handler, resumeSession: mockedResume } = await fresh();
    const ds = makeDs('claude-code');
    ds.streamCardId = 'om_prior_stream';
    mockedResume.mockResolvedValue({ ok: true, ds });
    // A hung Pin API must not hold the resume publication boundary. The real
    // helper owns rejection handling and stale-Pin compensation; this seam
    // verifies card-handler never awaits that detached chain.
    continuePublishedStreamingCardPinChainMock.mockImplementation(() => new Promise<void>(() => {}));
    let releasePost!: (messageId: string) => void;
    let markReceipt!: () => void;
    let markPostStarted!: () => void;
    const postStarted = new Promise<void>(resolve => { markPostStarted = resolve; });
    const receiptDelivered = new Promise<void>(resolve => { markReceipt = resolve; });
    const sessionReply = vi.fn((_rootId: string, content: string) => {
      if (content.trimStart().startsWith('{')) {
        markPostStarted();
        return new Promise<string>(postResolve => { releasePost = postResolve; });
      }
      markReceipt();
      return Promise.resolve('om_receipt');
    });
    const deps = { activeSessions: new Map(), sessionReply, lastRepoScan: new Map() } as any;

    const action = handler.handleCardAction(resumeAction(), deps, APP_ID);
    await postStarted;
    releasePost('om_fresh_stream');
    await action;
    await receiptDelivered;

    expect(continuePublishedStreamingCardPinChainMock).toHaveBeenCalledWith(ds, 'om_fresh_stream', ['om_prior_stream']);
    expect(deleteMessageMock).toHaveBeenCalledWith(APP_ID, 'om_card');
    expect(textReceipt(sessionReply)).toContain('会话已恢复');
  });
});
