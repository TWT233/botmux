import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { BtwOperationPoisonedError, btwOperationPath, createBtwOperationStore } from '../src/features/btw/operation-store.js';
import { deriveBtwIdentifiers } from '../src/features/btw/types.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import {
  makeBtwOperation,
  makeBtwParent,
  makeBtwPrepareInput,
  makeBtwReplyTarget,
  makeBtwScope,
} from './fixtures/btw-fixtures.js';

const FIXED_NOW = '2026-09-01T00:00:00.000Z';
const FIFTY_FIVE_MINUTES_MS = 55 * 60 * 1000;
const tempDirs: string[] = [];

function newDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-btw-operation-store-'));
  tempDirs.push(dir);
  return dir;
}

function createStore(dataDir: string) {
  return createBtwOperationStore({
    dataDir,
    now: () => new Date(FIXED_NOW),
  });
}

function createAdvancingClock(start = FIXED_NOW) {
  let currentMs = Date.parse(start);
  return {
    now: () => new Date(currentMs),
    advance: (ms = 1000) => {
      currentMs += ms;
    },
  };
}

function createStoreWithClock(dataDir: string, clock: { now: () => Date }) {
  return createBtwOperationStore({
    dataDir,
    now: clock.now,
  });
}

function expectedScopeHash(scope = makeBtwScope()): string {
  return createHash('sha256')
    .update(scope.larkAppId)
    .update('\0')
    .update(scope.botmuxSessionId)
    .digest('hex');
}

function operationPathForRequest(dataDir: string, requestId: string, scope = makeBtwScope()): string {
  return btwOperationPath(dataDir, scope, deriveBtwIdentifiers(scope, requestId).btwOpId);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('btw operation store', () => {
  it('partitions by exact scope hash, writes 0600 records, and preserves frozen defaults', () => {
    const dataDir = newDataDir();
    const store = createStore(dataDir);
    const scope = makeBtwScope();
    const input = makeBtwPrepareInput();
    const expected = makeBtwOperation();

    const result = store.prepareBtw(input);
    const path = store.pathFor(scope, result.operation.btwOpId);

    expect(result).toEqual({ kind: 'created', operation: expected });
    expect(path).toBe(join(
      dataDir,
      'btw',
      'operations',
      expectedScopeHash(scope),
      `${expected.btwOpId}.json`,
    ));
    expect(path).toBe(operationPathForRequest(dataDir, input.requestId, scope));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf8')).toContain('"card_pending"');
    expect(store.getBtwOperation(scope, expected.btwOpId)).toEqual(expected);
  });

  it('returns byte-equivalent duplicates and keeps the first immutable payload', () => {
    const dataDir = newDataDir();
    const store = createStore(dataDir);
    const first = store.prepareBtw(makeBtwPrepareInput());
    const path = operationPathForRequest(dataDir, 'om_request_1');
    const originalBytes = readFileSync(path, 'utf8');

    const duplicate = store.prepareBtw({
      requestId: 'om_request_1',
      question: 'mutated replay must not win',
      parent: {
        ...makeBtwParent(),
        cliId: 'codex',
      },
      replyTarget: {
        ...makeBtwReplyTarget(),
        chatId: 'oc_other_chat',
      },
    });

    expect(first.kind).toBe('created');
    expect(duplicate).toEqual({ kind: 'duplicate', operation: first.operation });
    expect(readFileSync(path, 'utf8')).toBe(originalBytes);
    expect(duplicate.operation.question).toBe(makeBtwPrepareInput().question);
    expect(duplicate.operation.parent.cliId).toBe(makeBtwParent().cliId);
    expect(duplicate.operation.replyTarget.chatId).toBe(makeBtwReplyTarget().chatId);
  });

  it('treats the same request id in a different app or session as a distinct operation', () => {
    const dataDir = newDataDir();
    const store = createStore(dataDir);
    const base = store.prepareBtw(makeBtwPrepareInput());
    const otherApp = store.prepareBtw({
      ...makeBtwPrepareInput(),
      replyTarget: {
        ...makeBtwReplyTarget(),
        larkAppId: 'cli_app_other',
      },
    });
    const otherSession = store.prepareBtw({
      ...makeBtwPrepareInput(),
      parent: {
        ...makeBtwParent(),
        botmuxSessionId: 'btw_session_other',
      },
    });

    expect(otherApp.kind).toBe('created');
    expect(otherSession.kind).toBe('created');
    expect(otherApp.operation.btwOpId).not.toBe(base.operation.btwOpId);
    expect(otherSession.operation.btwOpId).not.toBe(base.operation.btwOpId);
    expect(otherApp.operation.btwOpId).not.toBe(otherSession.operation.btwOpId);
    expect(store.pathFor(makeBtwScope(), base.operation.btwOpId))
      .not.toBe(store.pathFor({
        larkAppId: 'cli_app_other',
        botmuxSessionId: makeBtwScope().botmuxSessionId,
      }, otherApp.operation.btwOpId));
    expect(store.pathFor(makeBtwScope(), base.operation.btwOpId))
      .not.toBe(store.pathFor({
        larkAppId: makeBtwScope().larkAppId,
        botmuxSessionId: 'btw_session_other',
      }, otherSession.operation.btwOpId));
  });

  it('converges concurrent prepares to one durable record across real child processes', async () => {
    const dataDir = newDataDir();
    const childCount = 8;
    const source = `
      import { createBtwOperationStore } from './src/features/btw/operation-store.js';
      import { makeBtwPrepareInput } from './test/fixtures/btw-fixtures.ts';

      const store = createBtwOperationStore({
        dataDir: process.env.BTW_DATA_DIR,
        now: () => new Date('${FIXED_NOW}'),
      });
      const result = store.prepareBtw(makeBtwPrepareInput());
      process.stdout.write(JSON.stringify({
        kind: result.kind,
        btwOpId: result.operation.btwOpId,
      }));
    `;

    const settled = await Promise.all(
      Array.from({ length: childCount }, () => new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
        const child = spawnTsEvalWithRepoImports(source, {
          cwd: process.cwd(),
          env: {
            ...process.env,
            BTW_DATA_DIR: dataDir,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', chunk => { stdout += String(chunk); });
        child.stderr?.on('data', chunk => { stderr += String(chunk); });
        child.on('close', code => resolve({ stdout, stderr, code }));
      })),
    );
    const rows = settled.map(({ stdout, stderr, code }) => {
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      return JSON.parse(stdout) as { kind: 'created' | 'duplicate'; btwOpId: string };
    });
    const [opId] = [...new Set(rows.map(row => row.btwOpId))];
    const partitionDir = dirname(operationPathForRequest(dataDir, 'om_request_1'));
    const siblings = readdirSync(partitionDir).filter(name => name.endsWith('.json'));

    expect(new Set(rows.map(row => row.btwOpId))).toEqual(new Set([opId]));
    expect(rows.filter(row => row.kind === 'created')).toHaveLength(1);
    expect(rows.filter(row => row.kind === 'duplicate')).toHaveLength(childCount - 1);
    expect(siblings).toEqual([`${opId}.json`]);
  });

  it('quarantines malformed siblings during scope scans without blocking valid prepares', () => {
    const dataDir = newDataDir();
    const store = createStore(dataDir);
    const valid = store.prepareBtw(makeBtwPrepareInput());
    const siblingRequestId = 'om_sibling_bad';
    const siblingPath = operationPathForRequest(dataDir, siblingRequestId);
    mkdirSync(dirname(siblingPath), { recursive: true });
    writeFileSync(siblingPath, JSON.stringify({
      ...makeBtwOperation(),
      btwOpId: deriveBtwIdentifiers(makeBtwScope(), siblingRequestId).btwOpId,
      requestId: siblingRequestId,
      execution: {
        ...makeBtwOperation().execution,
        state: 'not-a-real-state',
      },
      unexpected: true,
    }, null, 2));

    const next = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_2',
    });
    const siblings = readdirSync(dirname(siblingPath));

    expect(next.kind).toBe('created');
    expect(store.getBtwOperation(makeBtwScope(), valid.operation.btwOpId)).toEqual(valid.operation);
    expect(existsSync(siblingPath)).toBe(false);
    expect(siblings.some(name => name.startsWith(`${basenameWithoutJson(siblingPath)}.corrupt.`))).toBe(true);
  });

  it('poisons an exact-key corruption deterministically and fails closed on later prepare/get', () => {
    const dataDir = newDataDir();
    const store = createStore(dataDir);
    const input = makeBtwPrepareInput();
    const created = store.prepareBtw(input);
    const path = store.pathFor(makeBtwScope(), created.operation.btwOpId);
    const poisonPath = `${path}.poison.json`;

    writeFileSync(path, JSON.stringify({
      ...created.operation,
      execution: {
        ...created.operation.execution,
        state: 'definitely-not-valid',
      },
      forged: true,
    }, null, 2));

    expect(() => store.prepareBtw(input)).toThrow(BtwOperationPoisonedError);
    expect(() => store.prepareBtw(input)).toThrow(/poison/i);
    expect(() => store.getBtwOperation(makeBtwScope(), created.operation.btwOpId)).toThrow(BtwOperationPoisonedError);
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(poisonPath, 'utf8')).toContain(created.operation.btwOpId);
    expect(readFileSync(poisonPath, 'utf8')).toContain('"reason": "corrupt_exact_duplicate"');
  });

  it('rejects malicious btwOpIds without escaping the partition or touching outside files', () => {
    const dataDir = newDataDir();
    const store = createStore(dataDir);
    const scope = makeBtwScope();
    const escaped = '../../escape';
    const outsideDir = join(dataDir, 'btw');
    const outsidePath = join(outsideDir, 'escape.json');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(outsidePath, '{broken}\n');

    expect(() => store.pathFor(scope, escaped)).toThrow(/invalid/i);
    expect(() => store.getBtwOperation(scope, escaped)).toThrow(/invalid/i);
    expect(readFileSync(outsidePath, 'utf8')).toBe('{broken}\n');
    expect(readdirSync(outsideDir).sort()).toEqual(['escape.json']);
    expect(store.getBtwOperation(scope, deriveBtwIdentifiers(scope, 'om_request_1').btwOpId)).toBeUndefined();
  });

  it('waits on the exact record lock before concluding an operation is absent', async () => {
    const dataDir = newDataDir();
    const store = createStore(dataDir);
    const scope = makeBtwScope();
    const missingOpId = deriveBtwIdentifiers(scope, 'om_absent_locked').btwOpId;
    const recordPath = store.pathFor(scope, missingOpId);
    const source = `
      import { mkdirSync } from 'node:fs';
      import { dirname } from 'node:path';
      import { withFileLockSync } from './src/utils/file-lock.js';

      const recordPath = process.env.BTW_LOCK_PATH;
      mkdirSync(dirname(recordPath), { recursive: true });
      withFileLockSync(recordPath, () => {
        process.stdout.write('READY\\n');
        const start = Date.now();
        while (Date.now() - start < 200) { /* hold lock synchronously */ }
      });
    `;

    const child = spawnTsEvalWithRepoImports(source, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        BTW_LOCK_PATH: recordPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
      let stdout = '';
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
        if (stdout.includes('READY\n')) resolve();
      });
      child.stderr?.on('data', (chunk) => {
        reject(new Error(String(chunk)));
      });
      child.on('exit', (code) => {
        if (!stdout.includes('READY\n')) reject(new Error(`lock child exited before ready: ${code}`));
      });
    });

    const startedAt = Date.now();
    expect(store.getBtwOperation(scope, missingOpId)).toBeUndefined();
    const elapsedMs = Date.now() - startedAt;

    await new Promise<void>((resolve) => child.on('close', () => resolve()));
    expect(elapsedMs).toBeGreaterThanOrEqual(120);
  });

  it('rejects live and dangling symlink targets instead of following or replacing them', () => {
    const dataDir = newDataDir();
    const store = createStore(dataDir);
    const path = operationPathForRequest(dataDir, 'om_symlink');
    const outside = join(dataDir, 'outside-target.json');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(outside, '{"outside":true}\n');
    symlinkSync(outside, path);

    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(() => store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_symlink',
    })).toThrow(/symlink/i);
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('{"outside":true}\n');

    const danglingPath = operationPathForRequest(dataDir, 'om_symlink_dangling');
    const missingTarget = join(dataDir, 'missing-target.json');
    symlinkSync(missingTarget, danglingPath);

    expect(lstatSync(danglingPath).isSymbolicLink()).toBe(true);
    expect(() => store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_symlink_dangling',
    })).toThrow(/symlink/i);
    expect(lstatSync(danglingPath).isSymbolicLink()).toBe(true);
    expect(existsSync(missingTarget)).toBe(false);
  });

  it('enforces accepted-only submission transitions and exact native-id ACKs', () => {
    const dataDir = newDataDir();
    const clock = createAdvancingClock();
    const store = createStoreWithClock(dataDir, clock);
    const input = makeBtwPrepareInput();
    const scope = makeBtwScope();
    const created = store.prepareBtw(input).operation;
    const opId = created.btwOpId;

    expect(() => store.prepareBtwSubmission(scope, opId, input.parent.runtimeEpoch)).toThrow(/accepted/i);

    const accepted = store.recordBtwCard(scope, opId, 'om_card_accepted_1');
    expect(accepted.execution.state).toBe('accepted');
    expect(accepted.card.messageId).toBe('om_card_accepted_1');
    expect(store.listExecutableBtwOperations(input.parent.runtimeEpoch).map(op => op.btwOpId)).toEqual([opId]);

    const prepared = store.prepareBtwSubmission(scope, opId, input.parent.runtimeEpoch);
    expect(prepared.execution).toMatchObject({
      state: 'submit_prepared',
      attempt: 1,
      submissionEpoch: input.parent.runtimeEpoch,
      frameState: 'may_have_been_sent',
    });
    expect(store.listExecutableBtwOperations(input.parent.runtimeEpoch)).toEqual([]);

    const definitelyUnsent = store.recordBtwDefinitelyUnsent(scope, opId, input.parent.runtimeEpoch);
    expect(definitelyUnsent.execution).toMatchObject({
      state: 'submit_prepared',
      attempt: 1,
      submissionEpoch: input.parent.runtimeEpoch,
      frameState: 'definitely_unsent',
    });
    expect(() => store.recordBtwDefinitelyUnsent(scope, opId, 'runtime_epoch_other')).toThrow(/runtime epoch/i);

    const retried = store.prepareBtwSubmission(scope, opId, input.parent.runtimeEpoch);
    expect(retried.execution).toMatchObject({
      state: 'submit_prepared',
      attempt: 2,
      submissionEpoch: input.parent.runtimeEpoch,
      frameState: 'may_have_been_sent',
    });
    expect(() => store.prepareBtwSubmission(scope, opId, 'runtime_epoch_other')).toThrow(/runtime epoch/i);

    expect(() => store.recordBtwRunning(scope, opId, 'btwturn_wrong_native')).toThrow(/native/i);

    const running = store.recordBtwRunning(scope, opId, retried.execution.nativeTurnId);
    expect(running.execution).toMatchObject({
      state: 'running',
      attempt: 2,
      submissionEpoch: input.parent.runtimeEpoch,
      frameState: 'acknowledged',
    });

    clock.advance();
    const runningAgain = store.recordBtwRunning(scope, opId, retried.execution.nativeTurnId);
    expect(runningAgain).toEqual(running);
    expect(runningAgain.revision).toBe(running.revision);
    expect(runningAgain.updatedAt).toBe(running.updatedAt);
  });

  it('accepts cards only from card_pending and keeps the accepted binding immutable', () => {
    const dataDir = newDataDir();
    const clock = createAdvancingClock();
    const store = createStoreWithClock(dataDir, clock);
    const scope = makeBtwScope();

    const pending = store.prepareBtw(makeBtwPrepareInput()).operation;
    const accepted = store.recordBtwCard(scope, pending.btwOpId, 'om_card_binding_1');
    expect(accepted.execution.state).toBe('accepted');
    expect(accepted.card.messageId).toBe('om_card_binding_1');
    clock.advance();
    const acceptedAgain = store.recordBtwCard(scope, pending.btwOpId, 'om_card_binding_1');
    expect(acceptedAgain).toEqual(accepted);
    expect(acceptedAgain.revision).toBe(accepted.revision);
    expect(acceptedAgain.updatedAt).toBe(accepted.updatedAt);
    expect(() => store.recordBtwCard(scope, pending.btwOpId, 'om_card_binding_2')).toThrow(/different message id/i);

    const preSubmitted = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_card_illegal_submit_prepared',
    }).operation;
    store.recordBtwCard(scope, preSubmitted.btwOpId, 'om_card_binding_3');
    store.prepareBtwSubmission(scope, preSubmitted.btwOpId, preSubmitted.parent.runtimeEpoch);
    expect(() => store.recordBtwCard(scope, preSubmitted.btwOpId, 'om_card_binding_3')).toThrow(/card_pending/i);

    const terminal = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_card_illegal_terminal',
    }).operation;
    store.recordBtwCard(scope, terminal.btwOpId, 'om_card_binding_4');
    store.prepareBtwSubmission(scope, terminal.btwOpId, terminal.parent.runtimeEpoch);
    store.recordBtwTerminal(scope, terminal.btwOpId, { status: 'completed', answer: 'done' });
    expect(() => store.recordBtwCard(scope, terminal.btwOpId, 'om_card_binding_4')).toThrow(/card_pending/i);
  });

  it('allows definitely-unsent only for same-epoch submit_prepared may-have-been-sent records', () => {
    const dataDir = newDataDir();
    const clock = createAdvancingClock();
    const store = createStoreWithClock(dataDir, clock);
    const scope = makeBtwScope();

    const acceptedOnly = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_definitely_unsent_from_accepted',
    }).operation;
    store.recordBtwCard(scope, acceptedOnly.btwOpId, 'om_card_du_accepted');
    expect(() => store.recordBtwDefinitelyUnsent(scope, acceptedOnly.btwOpId, acceptedOnly.parent.runtimeEpoch)).toThrow(/submit_prepared/i);

    const prepared = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_definitely_unsent_same_epoch',
    }).operation;
    store.recordBtwCard(scope, prepared.btwOpId, 'om_card_du_prepared');
    store.prepareBtwSubmission(scope, prepared.btwOpId, prepared.parent.runtimeEpoch);
    const definitelyUnsent = store.recordBtwDefinitelyUnsent(scope, prepared.btwOpId, prepared.parent.runtimeEpoch);
    expect(definitelyUnsent.execution.frameState).toBe('definitely_unsent');
    clock.advance();
    const definitelyUnsentAgain = store.recordBtwDefinitelyUnsent(scope, prepared.btwOpId, prepared.parent.runtimeEpoch);
    expect(definitelyUnsentAgain).toEqual(definitelyUnsent);
    expect(definitelyUnsentAgain.revision).toBe(definitelyUnsent.revision);
    expect(definitelyUnsentAgain.updatedAt).toBe(definitelyUnsent.updatedAt);
    expect(() => store.recordBtwDefinitelyUnsent(scope, prepared.btwOpId, 'runtime_epoch_other')).toThrow(/runtime epoch/i);

    const running = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_definitely_unsent_from_running',
    }).operation;
    store.recordBtwCard(scope, running.btwOpId, 'om_card_du_running');
    const runningPrepared = store.prepareBtwSubmission(scope, running.btwOpId, running.parent.runtimeEpoch);
    store.recordBtwRunning(scope, running.btwOpId, runningPrepared.execution.nativeTurnId);
    expect(() => store.recordBtwDefinitelyUnsent(scope, running.btwOpId, running.parent.runtimeEpoch)).toThrow(/submit_prepared/i);

    const unknown = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_definitely_unsent_from_unknown',
    }).operation;
    store.recordBtwCard(scope, unknown.btwOpId, 'om_card_du_unknown');
    store.prepareBtwSubmission(scope, unknown.btwOpId, unknown.parent.runtimeEpoch);
    store.recordBtwSubmissionUnknown(scope, unknown.btwOpId, 'timeout');
    expect(() => store.recordBtwDefinitelyUnsent(scope, unknown.btwOpId, unknown.parent.runtimeEpoch)).toThrow(/submit_prepared/i);
  });

  it('enforces submission-unknown and terminal legality across submit_prepared, running, and same-live unknown states', () => {
    const dataDir = newDataDir();
    const clock = createAdvancingClock();
    const store = createStoreWithClock(dataDir, clock);
    const scope = makeBtwScope();

    const preSubmit = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_unknown_reject_pre_submit',
    }).operation;
    store.recordBtwCard(scope, preSubmit.btwOpId, 'om_card_unknown_pre_submit');
    expect(() => store.recordBtwSubmissionUnknown(scope, preSubmit.btwOpId, 'too early')).toThrow(/submit_prepared/i);
    expect(() => store.recordBtwTerminal(scope, preSubmit.btwOpId, { status: 'completed', answer: 'too early' })).toThrow(/active or submission_unknown/i);

    const submitPrepared = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_terminal_from_submit_prepared',
    }).operation;
    store.recordBtwCard(scope, submitPrepared.btwOpId, 'om_card_terminal_submit_prepared');
    store.prepareBtwSubmission(scope, submitPrepared.btwOpId, submitPrepared.parent.runtimeEpoch);

    const submitPreparedCases = [
      {
        requestId: 'om_request_terminal_completed_mapping',
        terminal: { status: 'completed', answer: 'full answer' } as const,
        expected: { state: 'completed', answer: 'full answer', errorCode: undefined, message: undefined },
      },
      {
        requestId: 'om_request_terminal_failed_mapping',
        terminal: { status: 'failed', errorCode: 'BTW_FAIL_MAP', message: 'failed body' } as const,
        expected: { state: 'failed', answer: undefined, errorCode: 'BTW_FAIL_MAP', message: 'failed body' },
      },
      {
        requestId: 'om_request_terminal_cancelled_mapping',
        terminal: { status: 'cancelled', message: 'cancelled body' } as const,
        expected: { state: 'cancelled', answer: undefined, errorCode: undefined, message: 'cancelled body' },
      },
    ];

    for (const row of submitPreparedCases) {
      const op = store.prepareBtw({
        ...makeBtwPrepareInput(),
        requestId: row.requestId,
      }).operation;
      store.recordBtwCard(scope, op.btwOpId, `om_card_${row.requestId}`);
      store.prepareBtwSubmission(scope, op.btwOpId, op.parent.runtimeEpoch);
      const result = store.recordBtwTerminal(scope, op.btwOpId, row.terminal);
      expect(result.kind).toBe('advanced');
      expect(result.operation.execution.state).toBe(row.expected.state);
      expect(result.operation.execution.answer).toBe(row.expected.answer);
      expect(result.operation.execution.errorCode).toBe(row.expected.errorCode);
      expect(result.operation.execution.message).toBe(row.expected.message);
    }

    const running = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_terminal_from_running',
    }).operation;
    store.recordBtwCard(scope, running.btwOpId, 'om_card_terminal_running');
    const runningPrepared = store.prepareBtwSubmission(scope, running.btwOpId, running.parent.runtimeEpoch);
    store.recordBtwRunning(scope, running.btwOpId, runningPrepared.execution.nativeTurnId);
    const interrupted = store.recordBtwTerminal(scope, running.btwOpId, {
      status: 'interrupted',
      message: 'lost runtime',
    });
    expect(interrupted.operation.execution).toMatchObject({
      state: 'interrupted',
      message: 'lost runtime',
    });

    const unknown = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_terminal_from_unknown',
    }).operation;
    store.recordBtwCard(scope, unknown.btwOpId, 'om_card_terminal_unknown');
    store.prepareBtwSubmission(scope, unknown.btwOpId, unknown.parent.runtimeEpoch);
    const unknownState = store.recordBtwSubmissionUnknown(scope, unknown.btwOpId, 'send timeout');
    expect(unknownState.execution.state).toBe('submission_unknown');
    clock.advance();
    const duplicateUnknown = store.recordBtwSubmissionUnknown(scope, unknown.btwOpId, 'send timeout');
    expect(duplicateUnknown).toEqual(unknownState);
    expect(duplicateUnknown.revision).toBe(unknownState.revision);
    expect(duplicateUnknown.updatedAt).toBe(unknownState.updatedAt);
    const settled = store.recordBtwTerminal(scope, unknown.btwOpId, {
      status: 'failed',
      errorCode: 'BTW_AFTER_UNKNOWN',
      message: 'same live connection terminal',
    });
    expect(settled.operation.execution).toMatchObject({
      state: 'failed',
      errorCode: 'BTW_AFTER_UNKNOWN',
      message: 'same live connection terminal',
    });
  });

  it('preserves conservative ambiguous execution handling and quarantines conflicting terminals', () => {
    const dataDir = newDataDir();
    const clock = createAdvancingClock();
    const store = createStoreWithClock(dataDir, clock);
    const input = makeBtwPrepareInput();
    const scope = makeBtwScope();
    const accepted = store.recordBtwCard(
      scope,
      store.prepareBtw(input).operation.btwOpId,
      'om_card_terminal_1',
    );
    const opId = accepted.btwOpId;
    const recordPath = store.pathFor(scope, opId);

    const prepared = store.prepareBtwSubmission(scope, opId, input.parent.runtimeEpoch);
    const terminalBeforeAck = store.recordBtwTerminal(scope, opId, {
      status: 'completed',
      answer: 'done before ack',
    });
    expect(terminalBeforeAck.kind).toBe('advanced');
    expect(terminalBeforeAck.operation.execution).toMatchObject({
      state: 'completed',
      nativeTurnId: prepared.execution.nativeTurnId,
      answer: 'done before ack',
    });
    expect(() => store.recordBtwRunning(scope, opId, prepared.execution.nativeTurnId)).toThrow(/state/i);

    const duplicateTerminal = store.recordBtwTerminal(scope, opId, {
      status: 'completed',
      answer: 'done before ack',
    });
    clock.advance();
    const duplicateTerminalAfterTick = store.recordBtwTerminal(scope, opId, {
      status: 'completed',
      answer: 'done before ack',
    });
    expect(duplicateTerminal.kind).toBe('duplicate');
    expect(duplicateTerminal.operation.revision).toBe(terminalBeforeAck.operation.revision);
    expect(duplicateTerminal.operation.updatedAt).toBe(terminalBeforeAck.operation.updatedAt);
    expect(duplicateTerminalAfterTick.kind).toBe('duplicate');
    expect(duplicateTerminalAfterTick.operation.revision).toBe(terminalBeforeAck.operation.revision);
    expect(duplicateTerminalAfterTick.operation.updatedAt).toBe(terminalBeforeAck.operation.updatedAt);

    const conflictingTerminal = store.recordBtwTerminal(scope, opId, {
      status: 'failed',
      errorCode: 'BTW_CONFLICT',
      message: 'should not replace completed',
    });
    expect(conflictingTerminal.kind).toBe('duplicate');
    expect(conflictingTerminal.operation).toEqual(terminalBeforeAck.operation);
    const diagnosticName = readdirSync(dirname(recordPath)).find(name =>
      name.startsWith(`${basenameWithoutJson(recordPath)}.terminal-conflict.`));
    expect(diagnosticName).toBeDefined();
    const diagnosticPath = join(dirname(recordPath), diagnosticName!);
    const diagnosticBytes = readFileSync(diagnosticPath, 'utf8');

    const secondInput = {
      ...makeBtwPrepareInput(),
      requestId: 'om_request_submission_unknown',
    };
    const secondOpId = store.prepareBtw(secondInput).operation.btwOpId;
    store.recordBtwCard(scope, secondOpId, 'om_card_unknown_1');
    store.prepareBtwSubmission(scope, secondOpId, input.parent.runtimeEpoch);
    const unknown = store.recordBtwSubmissionUnknown(scope, secondOpId, 'rpc timeout after send');
    expect(unknown.execution).toMatchObject({
      state: 'submission_unknown',
      submissionEpoch: input.parent.runtimeEpoch,
      frameState: 'may_have_been_sent',
      message: 'rpc timeout after send',
    });

    expect(() => store.recordBtwRunning(scope, secondOpId, unknown.execution.nativeTurnId)).toThrow(/submission_unknown/i);
    expect(() => store.prepareBtwSubmission(scope, secondOpId, input.parent.runtimeEpoch)).toThrow(/submission_unknown/i);

    const settled = store.recordBtwTerminal(scope, secondOpId, {
      status: 'cancelled',
      message: 'cancelled from same live connection',
    });
    expect(settled.kind).toBe('advanced');
    expect(settled.operation.execution).toMatchObject({
      state: 'cancelled',
      message: 'cancelled from same live connection',
    });

    const laterPrepared = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_after_terminal_conflict',
    });
    expect(laterPrepared.kind).toBe('created');
    store.recordBtwCard(scope, laterPrepared.operation.btwOpId, 'om_card_after_terminal_conflict');
    expect(store.listExecutableBtwOperations(input.parent.runtimeEpoch).map(op => op.btwOpId))
      .toContain(laterPrepared.operation.btwOpId);
    const reconciled = store.reconcileBtwOperations({
      runtimeEpoch: input.parent.runtimeEpoch,
      liveSessionIds: new Set([scope.botmuxSessionId]),
    });
    expect(Array.isArray(reconciled)).toBe(true);
    expect(readFileSync(diagnosticPath, 'utf8')).toBe(diagnosticBytes);
    expect(readdirSync(dirname(recordPath)).some(name => name.startsWith(`${diagnosticName}.corrupt.`))).toBe(false);
  });

  it('quarantines malformed terminal-conflict-looking siblings while preserving valid diagnostics verbatim', () => {
    const dataDir = newDataDir();
    const store = createStore(dataDir);
    const input = makeBtwPrepareInput();
    const scope = makeBtwScope();
    const opId = store.prepareBtw(input).operation.btwOpId;
    store.recordBtwCard(scope, opId, 'om_card_conflict_marker_1');
    store.prepareBtwSubmission(scope, opId, input.parent.runtimeEpoch);
    store.recordBtwTerminal(scope, opId, {
      status: 'completed',
      answer: 'done before malformed marker scan',
    });
    store.recordBtwTerminal(scope, opId, {
      status: 'failed',
      errorCode: 'BTW_CONFLICT_MARKER',
      message: 'conflict for marker test',
    });

    const recordPath = store.pathFor(scope, opId);
    const partitionDir = dirname(recordPath);
    const validDiagnosticName = readdirSync(partitionDir).find(name =>
      name.startsWith(`${basenameWithoutJson(recordPath)}.terminal-conflict.`));
    expect(validDiagnosticName).toBeDefined();
    const validDiagnosticPath = join(partitionDir, validDiagnosticName!);
    const validDiagnosticBytes = readFileSync(validDiagnosticPath, 'utf8');

    const malformedMarkerPath = join(partitionDir, 'junk.terminal-conflict.ignore.json');
    writeFileSync(malformedMarkerPath, JSON.stringify({
      fake: true,
      why: 'malformed marker filename must still be scanned as a primary candidate',
    }, null, 2));

    const later = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_after_malformed_marker',
    });
    expect(later.kind).toBe('created');
    expect(readFileSync(validDiagnosticPath, 'utf8')).toBe(validDiagnosticBytes);
    expect(readdirSync(partitionDir).some(name =>
      name.startsWith('junk.terminal-conflict.ignore.corrupt.'))).toBe(true);
    expect(existsSync(malformedMarkerPath)).toBe(false);

    const afterList = readFileSync(validDiagnosticPath, 'utf8');
    void store.listExecutableBtwOperations(input.parent.runtimeEpoch);
    void store.reconcileBtwOperations({
      runtimeEpoch: input.parent.runtimeEpoch,
      liveSessionIds: new Set([scope.botmuxSessionId]),
    });
    expect(readFileSync(validDiagnosticPath, 'utf8')).toBe(afterList);
    expect(readdirSync(partitionDir).some(name =>
      name.startsWith(`${validDiagnosticName}.corrupt.`))).toBe(false);
  });

  it('preserves exact legacy 24-hex terminal-conflict sidecars while still quarantining malformed lookalikes', () => {
    const dataDir = newDataDir();
    const store = createStore(dataDir);
    const input = makeBtwPrepareInput();
    const scope = makeBtwScope();
    const opId = store.prepareBtw({
      ...input,
      requestId: 'om_request_legacy_terminal_conflict',
    }).operation.btwOpId;
    const recordPath = store.pathFor(scope, opId);
    const partitionDir = dirname(recordPath);

    const legacyDiagnosticPath = join(
      partitionDir,
      `${opId}.terminal-conflict.0123456789abcdef01234567.json`,
    );
    const legacyDiagnosticBytes = `${JSON.stringify({
      schemaVersion: 1,
      kind: 'btw_terminal_conflict',
      btwOpId: opId,
      scope,
      existingExecution: {
        state: 'completed',
        nativeTurnId: deriveBtwIdentifiers(scope, 'om_request_legacy_terminal_conflict').nativeTurnId,
        attempt: 1,
        submissionEpoch: input.parent.runtimeEpoch,
        frameState: 'acknowledged',
        answer: 'legacy terminal answer',
      },
      incomingTerminal: {
        status: 'failed',
        errorCode: 'BTW_LEGACY_CONFLICT',
        message: 'legacy conflict marker',
      },
      detectedAt: FIXED_NOW,
    }, null, 2)}\n`;
    writeFileSync(legacyDiagnosticPath, legacyDiagnosticBytes);

    const malformedMarkerPath = join(partitionDir, 'junk.terminal-conflict.ignore.json');
    writeFileSync(malformedMarkerPath, JSON.stringify({
      fake: true,
      why: 'legacy compatibility must not exempt malformed lookalikes',
    }, null, 2));

    const later = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_after_legacy_terminal_conflict',
    });
    expect(later.kind).toBe('created');
    expect(readFileSync(legacyDiagnosticPath, 'utf8')).toBe(legacyDiagnosticBytes);
    expect(readdirSync(partitionDir).some(name =>
      name.startsWith('junk.terminal-conflict.ignore.corrupt.'))).toBe(true);
    expect(existsSync(malformedMarkerPath)).toBe(false);

    const afterList = readFileSync(legacyDiagnosticPath, 'utf8');
    void store.listExecutableBtwOperations(input.parent.runtimeEpoch);
    void store.reconcileBtwOperations({
      runtimeEpoch: input.parent.runtimeEpoch,
      liveSessionIds: new Set([scope.botmuxSessionId]),
    });
    expect(readFileSync(legacyDiagnosticPath, 'utf8')).toBe(afterList);
    expect(readdirSync(partitionDir).some(name =>
      name.startsWith(`${basenameWithoutJson(legacyDiagnosticPath)}.corrupt.`))).toBe(false);
  });

  it('retries initial-card definitely-unsent attempts, then exhausts at attempt 8 without ever starting native work', () => {
    const dataDir = newDataDir();
    const clock = createAdvancingClock();
    const store = createStoreWithClock(dataDir, clock);
    const scope = makeBtwScope();
    const created = store.prepareBtw(makeBtwPrepareInput()).operation;
    const retryAt = '2026-09-01T00:05:00.000Z';

    expect(store.listPendingInitialCards(scope.larkAppId).map(op => op.btwOpId)).toEqual([created.btwOpId]);

    let latest = created;
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      latest = store.recordInitialCardAttempt(scope, created.btwOpId, {
        kind: 'definitely_unsent',
        errorCode: `BTW_CREATE_${attempt}`,
        message: `create failed ${attempt}`,
        retryAt,
      });
      expect(latest.card.createUuid).toBe(created.card.createUuid);
      expect(latest.card.createAttempt).toBe(attempt);
      expect(latest.card.nextCreateAttemptAt).toBe(retryAt);
      expect(latest.execution.state).toBe('card_pending');
    }

    expect(store.listPendingInitialCards(scope.larkAppId)).toEqual([]);
    clock.advance(5 * 60 * 1000);
    expect(store.listPendingInitialCards(scope.larkAppId).map(op => op.btwOpId)).toEqual([created.btwOpId]);

    const exhausted = store.recordInitialCardAttempt(scope, created.btwOpId, {
      kind: 'definitely_unsent',
      errorCode: 'BTW_CREATE_8',
      message: 'final create failure',
      retryAt: '2026-09-01T00:10:00.000Z',
    });

    expect(exhausted.card.createAttempt).toBe(8);
    expect(exhausted.card.nextCreateAttemptAt).toBeUndefined();
    expect(exhausted.execution.state).toBe('card_unknown');
    expect(exhausted.execution.errorCode).toBe('initial_card_retry_exhausted');
    expect(store.listPendingInitialCards(scope.larkAppId)).toEqual([]);
    expect(() => store.prepareBtwSubmission(scope, created.btwOpId, created.parent.runtimeEpoch)).toThrow(/accepted/i);
  });

  it('clamps ambiguous initial-card retries to exactly +55 minutes and settles unknown at the deadline', () => {
    const dataDir = newDataDir();
    const clock = createAdvancingClock();
    const store = createStoreWithClock(dataDir, clock);
    const scope = makeBtwScope();
    const created = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_initial_card_unknown_deadline',
    }).operation;
    const deadline = new Date(Date.parse(FIXED_NOW) + FIFTY_FIVE_MINUTES_MS).toISOString();

    const ambiguous = store.recordInitialCardAttempt(scope, created.btwOpId, {
      kind: 'unknown',
      errorCode: 'BTW_CREATE_TIMEOUT',
      message: 'provider timed out after maybe sending',
      retryAt: '2026-09-01T03:00:00.000Z',
    });

    expect(ambiguous.card.createAttempt).toBe(1);
    expect(ambiguous.card.firstPossiblySentAt).toBe(FIXED_NOW);
    expect(ambiguous.card.createRetryDeadline).toBe(deadline);
    expect(ambiguous.card.nextCreateAttemptAt).toBe(deadline);
    expect(ambiguous.execution.state).toBe('card_pending');
    expect(store.listPendingInitialCards(scope.larkAppId)).toEqual([]);

    clock.advance(FIFTY_FIVE_MINUTES_MS);
    expect(store.listPendingInitialCards(scope.larkAppId).map(op => op.btwOpId)).toEqual([created.btwOpId]);

    const unknown = store.recordInitialCardAttempt(scope, created.btwOpId, {
      kind: 'unknown',
      errorCode: 'BTW_CREATE_TIMEOUT',
      message: 'deadline expired with no certainty',
      retryAt: '2026-09-01T04:00:00.000Z',
    });

    expect(unknown.card.createUuid).toBe(created.card.createUuid);
    expect(unknown.card.createAttempt).toBe(2);
    expect(unknown.card.nextCreateAttemptAt).toBeUndefined();
    expect(unknown.execution.state).toBe('card_unknown');
    expect(unknown.execution.errorCode).toBe('BTW_CREATE_TIMEOUT');
    expect(unknown.execution.message).toBe('deadline expired with no certainty');
    expect(store.listPendingInitialCards(scope.larkAppId)).toEqual([]);
    expect(() => store.prepareBtwSubmission(scope, created.btwOpId, created.parent.runtimeEpoch)).toThrow(/accepted/i);
  });

  it('lists only terminal projection revisions, enforces CAS staleness, and makes repeated patch success idempotent', () => {
    const dataDir = newDataDir();
    const clock = createAdvancingClock();
    const store = createStoreWithClock(dataDir, clock);
    const scope = makeBtwScope();

    const accepted = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_projection_patch_flow',
    }).operation;
    store.recordBtwCard(scope, accepted.btwOpId, 'om_card_projection_patch');
    expect(store.listPendingBtwProjections(scope.larkAppId)).toEqual([]);

    store.prepareBtwSubmission(scope, accepted.btwOpId, accepted.parent.runtimeEpoch);
    store.recordBtwTerminal(scope, accepted.btwOpId, {
      status: 'completed',
      answer: 'done',
    });
    const afterTerminal = store.getBtwOperation(scope, accepted.btwOpId)!;
    const pending = store.listPendingBtwProjections(scope.larkAppId);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      btwOpId: accepted.btwOpId,
      expectedOperationRevision: afterTerminal.revision,
      projectionRevision: 2,
    });

    const patched = store.ackBtwProjection(scope, accepted.btwOpId, {
      operationRevision: pending[0].expectedOperationRevision,
      projectionRevision: pending[0].projectionRevision,
    }, { kind: 'patched' });
    expect(patched.kind).toBe('applied');
    expect(patched.operation.projection).toMatchObject({
      desiredRevision: 2,
      patchedRevision: 2,
      reminderState: 'pending',
    });

    const afterPatch = store.getBtwOperation(scope, accepted.btwOpId)!;
    const duplicatePatch = store.ackBtwProjection(scope, accepted.btwOpId, {
      operationRevision: afterPatch.revision,
      projectionRevision: afterPatch.projection.desiredRevision,
    }, { kind: 'patched' });
    expect(duplicatePatch.kind).toBe('applied');
    expect(duplicatePatch.operation.revision).toBe(afterPatch.revision);
    expect(duplicatePatch.operation.updatedAt).toBe(afterPatch.updatedAt);
    expect(store.listPendingBtwProjections(scope.larkAppId)).toHaveLength(1);

    const staleTarget = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_projection_stale_ack',
    }).operation;
    store.recordBtwCard(scope, staleTarget.btwOpId, 'om_card_projection_stale');
    store.prepareBtwSubmission(scope, staleTarget.btwOpId, staleTarget.parent.runtimeEpoch);
    store.recordBtwTerminal(scope, staleTarget.btwOpId, {
      status: 'completed',
      answer: 'very long answer',
    });
    const staleExpected = store.listPendingBtwProjections(scope.larkAppId)
      .find(item => item.btwOpId === staleTarget.btwOpId)!;
    const fallback = store.recordBtwProjectionFailure(scope, staleTarget.btwOpId, {
      operationRevision: staleExpected.expectedOperationRevision,
      projectionRevision: staleExpected.projectionRevision,
    }, {
      kind: 'visible_fallback',
      errorCode: 'BTW_VISIBLE_FALLBACK',
      message: 'visible fallback summary',
    });
    expect(fallback.kind).toBe('applied');
    expect(fallback.operation.projection.desiredRevision).toBe(3);
    expect(store.ackBtwProjection(scope, staleTarget.btwOpId, {
      operationRevision: staleExpected.expectedOperationRevision,
      projectionRevision: staleExpected.projectionRevision,
    }, { kind: 'patched' }).kind).toBe('stale');
  });

  it('keeps retryable projection failures pending, blocks only the exact provider-permanent revision, and preserves full answers for visible fallback', () => {
    const dataDir = newDataDir();
    const clock = createAdvancingClock();
    const store = createStoreWithClock(dataDir, clock);
    const scope = makeBtwScope();

    const retryable = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_projection_retryable',
    }).operation;
    store.recordBtwCard(scope, retryable.btwOpId, 'om_card_projection_retryable');
    store.prepareBtwSubmission(scope, retryable.btwOpId, retryable.parent.runtimeEpoch);
    store.recordBtwTerminal(scope, retryable.btwOpId, {
      status: 'failed',
      errorCode: 'BTW_FAIL',
      message: 'runtime failed',
    });
    const retryableExpected = store.listPendingBtwProjections(scope.larkAppId)
      .find(item => item.btwOpId === retryable.btwOpId)!;

    const retryQueued = store.ackBtwProjection(scope, retryable.btwOpId, {
      operationRevision: retryableExpected.expectedOperationRevision,
      projectionRevision: retryableExpected.projectionRevision,
    }, {
      kind: 'retryable_failure',
      errorCode: 'HTTP_429',
      message: 'rate limited',
      retryAt: '2026-09-01T00:02:00.000Z',
    });
    expect(retryQueued.kind).toBe('applied');
    expect(retryQueued.operation.projection).toMatchObject({
      desiredRevision: 2,
      patchedRevision: 0,
      retryAttempt: 1,
      nextAttemptAt: '2026-09-01T00:02:00.000Z',
    });
    expect(store.listPendingBtwProjections(scope.larkAppId).some(item => item.btwOpId === retryable.btwOpId)).toBe(false);

    clock.advance(2 * 60 * 1000);
    const retried = store.listPendingBtwProjections(scope.larkAppId)
      .find(item => item.btwOpId === retryable.btwOpId)!;
    expect(retried.projectionRevision).toBe(2);

    const blocked = store.recordBtwProjectionFailure(scope, retryable.btwOpId, {
      operationRevision: retried.expectedOperationRevision,
      projectionRevision: retried.projectionRevision,
    }, {
      kind: 'provider_permanent',
      errorCode: 'FEISHU_400',
      message: 'deterministic provider rejection',
    });
    expect(blocked.kind).toBe('applied');
    expect(blocked.operation.projection.blockedRevision).toBe(2);
    expect(blocked.operation.projection.deliveryFailure).toEqual({
      kind: 'provider_permanent',
      errorCode: 'FEISHU_400',
      message: 'deterministic provider rejection',
    });
    expect(store.listPendingBtwProjections(scope.larkAppId).some(item => item.btwOpId === retryable.btwOpId)).toBe(false);

    const fallbackTarget = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_projection_visible_fallback',
    }).operation;
    store.recordBtwCard(scope, fallbackTarget.btwOpId, 'om_card_projection_visible_fallback');
    store.prepareBtwSubmission(scope, fallbackTarget.btwOpId, fallbackTarget.parent.runtimeEpoch);
    const fullAnswer = 'A'.repeat(5000);
    store.recordBtwTerminal(scope, fallbackTarget.btwOpId, {
      status: 'completed',
      answer: fullAnswer,
    });
    const fallbackExpected = store.listPendingBtwProjections(scope.larkAppId)
      .find(item => item.btwOpId === fallbackTarget.btwOpId)!;
    const visibleFallback = store.recordBtwProjectionFailure(scope, fallbackTarget.btwOpId, {
      operationRevision: fallbackExpected.expectedOperationRevision,
      projectionRevision: fallbackExpected.projectionRevision,
    }, {
      kind: 'visible_fallback',
      errorCode: 'BTW_VISIBLE_FALLBACK',
      message: 'answer too large for card body',
    });
    expect(visibleFallback.kind).toBe('applied');
    expect(visibleFallback.operation.execution.answer).toBe(fullAnswer);
    expect(visibleFallback.operation.projection).toMatchObject({
      desiredRevision: 3,
      patchedRevision: 0,
      deliveryFailure: {
        kind: 'visible_fallback',
        errorCode: 'BTW_VISIBLE_FALLBACK',
        message: 'answer too large for card body',
      },
    });
    expect(store.listPendingBtwProjections(scope.larkAppId).find(item =>
      item.btwOpId === fallbackTarget.btwOpId)?.projectionRevision).toBe(3);
  });

  it('records a single replacement intent per revision and reuses the stable replacement identity before queueing reminders', () => {
    const dataDir = newDataDir();
    const store = createStore(dataDir);
    const scope = makeBtwScope();
    const created = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_projection_replacement',
    }).operation;
    store.recordBtwCard(scope, created.btwOpId, 'om_card_projection_replacement');
    store.prepareBtwSubmission(scope, created.btwOpId, created.parent.runtimeEpoch);
    store.recordBtwTerminal(scope, created.btwOpId, {
      status: 'cancelled',
      message: 'cancelled result',
    });
    const pending = store.listPendingBtwProjections(scope.larkAppId)
      .find(item => item.btwOpId === created.btwOpId)!;

    const withdrawn = store.ackBtwProjection(scope, created.btwOpId, {
      operationRevision: pending.expectedOperationRevision,
      projectionRevision: pending.projectionRevision,
    }, { kind: 'withdrawn' });
    expect(withdrawn.kind).toBe('applied');
    expect(withdrawn.operation.card).toMatchObject({
      replacementUuid: created.card.replacementUuid,
      replacementState: 'pending',
      replacementForRevision: 2,
    });

    const afterWithdrawn = store.getBtwOperation(scope, created.btwOpId)!;
    const duplicateWithdrawn = store.ackBtwProjection(scope, created.btwOpId, {
      operationRevision: afterWithdrawn.revision,
      projectionRevision: afterWithdrawn.projection.desiredRevision,
    }, { kind: 'withdrawn' });
    expect(duplicateWithdrawn.kind).toBe('applied');
    expect(duplicateWithdrawn.operation.revision).toBe(afterWithdrawn.revision);

    const replacementCreated = store.ackBtwProjection(scope, created.btwOpId, {
      operationRevision: afterWithdrawn.revision,
      projectionRevision: afterWithdrawn.projection.desiredRevision,
    }, {
      kind: 'replacement_created',
      messageId: 'om_card_projection_replacement_new',
    });
    expect(replacementCreated.kind).toBe('applied');
    expect(replacementCreated.operation.card).toMatchObject({
      replacementUuid: created.card.replacementUuid,
      replacementState: 'created',
      replacementForRevision: 2,
      replacementMessageId: 'om_card_projection_replacement_new',
    });
    expect(replacementCreated.operation.projection).toMatchObject({
      patchedRevision: 2,
      reminderState: 'pending',
    });
  });

  it('retries definitely-unsent reminders, marks ambiguous reminders unknown, and never re-patches visible content', () => {
    const dataDir = newDataDir();
    const clock = createAdvancingClock();
    const store = createStoreWithClock(dataDir, clock);
    const scope = makeBtwScope();
    const created = store.prepareBtw({
      ...makeBtwPrepareInput(),
      requestId: 'om_request_projection_reminder',
    }).operation;
    store.recordBtwCard(scope, created.btwOpId, 'om_card_projection_reminder');
    store.prepareBtwSubmission(scope, created.btwOpId, created.parent.runtimeEpoch);
    store.recordBtwTerminal(scope, created.btwOpId, {
      status: 'completed',
      answer: 'final answer',
    });
    const patch = store.listPendingBtwProjections(scope.larkAppId)
      .find(item => item.btwOpId === created.btwOpId)!;
    const patched = store.ackBtwProjection(scope, created.btwOpId, {
      operationRevision: patch.expectedOperationRevision,
      projectionRevision: patch.projectionRevision,
    }, { kind: 'patched' });
    expect(patched.operation.projection.reminderState).toBe('pending');

    const reminder = store.listPendingBtwProjections(scope.larkAppId)
      .find(item => item.btwOpId === created.btwOpId)!;
    const retryReminder = store.ackBtwProjection(scope, created.btwOpId, {
      operationRevision: reminder.expectedOperationRevision,
      projectionRevision: reminder.projectionRevision,
    }, {
      kind: 'reminder_definitely_unsent',
      retryAt: '2026-09-01T00:03:00.000Z',
    });
    expect(retryReminder.kind).toBe('applied');
    expect(retryReminder.operation.projection).toMatchObject({
      desiredRevision: 2,
      patchedRevision: 2,
      reminderState: 'pending',
      reminderAttempt: 1,
      reminderNextAttemptAt: '2026-09-01T00:03:00.000Z',
    });
    expect(store.listPendingBtwProjections(scope.larkAppId).some(item => item.btwOpId === created.btwOpId)).toBe(false);

    clock.advance(3 * 60 * 1000);
    const retryPending = store.listPendingBtwProjections(scope.larkAppId)
      .find(item => item.btwOpId === created.btwOpId)!;
    const unknownReminder = store.ackBtwProjection(scope, created.btwOpId, {
      operationRevision: retryPending.expectedOperationRevision,
      projectionRevision: retryPending.projectionRevision,
    }, { kind: 'reminder_unknown' });
    expect(unknownReminder.kind).toBe('applied');
    expect(unknownReminder.operation.projection).toMatchObject({
      desiredRevision: 2,
      patchedRevision: 2,
      reminderState: 'unknown',
      reminderAttempt: 2,
    });
    expect(unknownReminder.operation.projection.reminderNextAttemptAt).toBeUndefined();
    expect(store.listPendingBtwProjections(scope.larkAppId).some(item => item.btwOpId === created.btwOpId)).toBe(false);
  });

  it('reconciles old epochs and dead sessions without reviving terminal records', () => {
    const dataDir = newDataDir();
    const store = createStore(dataDir);

    const acceptedInput = makeBtwPrepareInput();
    const acceptedScope = makeBtwScope();
    const acceptedOpId = store.prepareBtw(acceptedInput).operation.btwOpId;
    store.recordBtwCard(acceptedScope, acceptedOpId, 'om_card_reconcile_accepted');

    const runningInput = {
      ...makeBtwPrepareInput(),
      requestId: 'om_request_running_old_epoch',
    };
    const runningOpId = store.prepareBtw(runningInput).operation.btwOpId;
    store.recordBtwCard(acceptedScope, runningOpId, 'om_card_reconcile_running');
    const runningPrepared = store.prepareBtwSubmission(acceptedScope, runningOpId, runningInput.parent.runtimeEpoch);
    store.recordBtwRunning(acceptedScope, runningOpId, runningPrepared.execution.nativeTurnId);

    const preparedInput = {
      ...makeBtwPrepareInput(),
      requestId: 'om_request_prepared_old_epoch',
    };
    const preparedOpId = store.prepareBtw(preparedInput).operation.btwOpId;
    store.recordBtwCard(acceptedScope, preparedOpId, 'om_card_reconcile_prepared');
    store.prepareBtwSubmission(acceptedScope, preparedOpId, preparedInput.parent.runtimeEpoch);

    const completedInput = {
      ...makeBtwPrepareInput(),
      requestId: 'om_request_completed_terminal',
    };
    const completedOpId = store.prepareBtw(completedInput).operation.btwOpId;
    store.recordBtwCard(acceptedScope, completedOpId, 'om_card_reconcile_completed');
    store.prepareBtwSubmission(acceptedScope, completedOpId, completedInput.parent.runtimeEpoch);
    store.recordBtwTerminal(acceptedScope, completedOpId, { status: 'completed', answer: 'still done' });

    const failedInput = {
      ...makeBtwPrepareInput(),
      requestId: 'om_request_failed_terminal',
    };
    const failedOpId = store.prepareBtw(failedInput).operation.btwOpId;
    store.recordBtwCard(acceptedScope, failedOpId, 'om_card_reconcile_failed');
    store.prepareBtwSubmission(acceptedScope, failedOpId, failedInput.parent.runtimeEpoch);
    store.recordBtwTerminal(acceptedScope, failedOpId, { status: 'failed', errorCode: 'BTW_FAIL', message: 'failed' });

    const cancelledInput = {
      ...makeBtwPrepareInput(),
      requestId: 'om_request_cancelled_terminal',
    };
    const cancelledOpId = store.prepareBtw(cancelledInput).operation.btwOpId;
    store.recordBtwCard(acceptedScope, cancelledOpId, 'om_card_reconcile_cancelled');
    store.prepareBtwSubmission(acceptedScope, cancelledOpId, cancelledInput.parent.runtimeEpoch);
    store.recordBtwTerminal(acceptedScope, cancelledOpId, { status: 'cancelled', message: 'cancelled' });

    const liveScope = {
      larkAppId: 'cli_app',
      botmuxSessionId: 'btw_session_live',
    };
    const liveInput = {
      ...makeBtwPrepareInput(),
      requestId: 'om_request_live_epoch',
      parent: {
        ...makeBtwParent(),
        botmuxSessionId: liveScope.botmuxSessionId,
        runtimeEpoch: 'runtime_epoch_live',
      },
    };
    const liveOpId = store.prepareBtw(liveInput).operation.btwOpId;
    store.recordBtwCard(liveScope, liveOpId, 'om_card_live');

    const reconciled = store.reconcileBtwOperations({
      runtimeEpoch: 'runtime_epoch_live',
      liveSessionIds: new Set([liveScope.botmuxSessionId]),
    });

    expect(reconciled.map(op => [op.btwOpId, op.execution.state])).toEqual(expect.arrayContaining([
      [acceptedOpId, 'interrupted'],
      [runningOpId, 'interrupted'],
      [preparedOpId, 'submission_unknown'],
    ]));
    expect(reconciled.some(op => op.btwOpId === completedOpId)).toBe(false);
    expect(reconciled.some(op => op.btwOpId === failedOpId)).toBe(false);
    expect(reconciled.some(op => op.btwOpId === cancelledOpId)).toBe(false);
    expect(reconciled.some(op => op.btwOpId === liveOpId)).toBe(false);

    expect(store.getBtwOperation(acceptedScope, acceptedOpId)?.execution.state).toBe('interrupted');
    expect(store.getBtwOperation(acceptedScope, runningOpId)?.execution.state).toBe('interrupted');
    expect(store.getBtwOperation(acceptedScope, preparedOpId)?.execution.state).toBe('submission_unknown');
    expect(store.getBtwOperation(acceptedScope, completedOpId)?.execution.state).toBe('completed');
    expect(store.getBtwOperation(acceptedScope, failedOpId)?.execution.state).toBe('failed');
    expect(store.getBtwOperation(acceptedScope, cancelledOpId)?.execution.state).toBe('cancelled');
    expect(store.getBtwOperation(liveScope, liveOpId)?.execution.state).toBe('accepted');
  });
});

function basenameWithoutJson(filePath: string): string {
  const name = filePath.split('/').pop() ?? filePath;
  return name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
}
