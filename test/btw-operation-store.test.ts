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

  it('rejects symlink targets instead of following or replacing them', () => {
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
  });
});

function basenameWithoutJson(filePath: string): string {
  const name = filePath.split('/').pop() ?? filePath;
  return name.endsWith('.json') ? name.slice(0, -'.json'.length) : name;
}
