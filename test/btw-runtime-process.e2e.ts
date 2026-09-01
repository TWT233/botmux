import { mkdtempSync, readFileSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

import { connectBtwRuntime, ensureBtwRuntime } from '../src/features/btw/runtime-client.js';
import { btwOperationPath, createBtwOperationStore } from '../src/features/btw/operation-store.js';
import { deriveBtwIdentifiers } from '../src/features/btw/types.js';
import { makeBtwPrepareInput, makeBtwScope } from './fixtures/btw-fixtures.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const tempDirs: string[] = [];

function newDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-btw-runtime-process-'));
  tempDirs.push(dir);
  return dir;
}

async function collectWake(iterator: AsyncIterator<{ kind: 'btw_projection_wake' }>, timeoutMs = 4_000) {
  return await Promise.race([
    iterator.next(),
    new Promise<IteratorResult<{ kind: 'btw_projection_wake' }>>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('wake timeout')), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    try {
      const connected = await connectBtwRuntime({ dataDir: dir }).catch(() => null);
      if (connected) {
        try { await connected.client.shutdownRuntime(); } catch { /* best effort */ }
        connected.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe('BTW runtime process behavior', () => {
  it('starts detached with closed stdio and a different process group than the caller', async () => {
    const dataDir = newDataDir();
    const descriptor = await ensureBtwRuntime({ dataDir });
    const callerGroup = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
    const runtimeGroup = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(descriptor.pid)], { encoding: 'utf8' }).trim());

    expect(runtimeGroup).toBe(descriptor.pid);
    expect(runtimeGroup).not.toBe(callerGroup);
    expect(readlinkSync(`/proc/${descriptor.pid}/fd/0`)).toContain('/dev/null');
  });

  it('keeps an accepted operation durable, coalesces concurrent submit wakes, and performs zero native BTW calls', async () => {
    const dataDir = newDataDir();
    const source = `
      import { createBtwOperationStore } from './src/features/btw/operation-store.js';
      import { deriveBtwIdentifiers } from './src/features/btw/types.js';
      import { makeBtwPrepareInput, makeBtwScope } from './test/fixtures/btw-fixtures.ts';

      const input = makeBtwPrepareInput();
      const scope = makeBtwScope();
      const store = createBtwOperationStore({ dataDir: process.env.BTW_DATA_DIR });
      const prepared = store.prepareBtw(input);
      const ids = deriveBtwIdentifiers(scope, input.requestId);
      store.recordBtwCard(scope, ids.btwOpId, 'om_card_1');
      process.stdout.write(JSON.stringify({ btwOpId: ids.btwOpId }));
    `;
    const created = await new Promise<{ btwOpId: string }>((resolve, reject) => {
      const child = spawnTsEvalWithRepoImports(source, {
        cwd: process.cwd(),
        env: { ...process.env, BTW_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', chunk => { stdout += String(chunk); });
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      child.once('close', code => {
        if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
        else resolve(JSON.parse(stdout) as { btwOpId: string });
      });
      child.once('error', reject);
    });

    const runtime = await connectBtwRuntime({ dataDir });
    const wakeSubscription = runtime.client.watchProjectionWakes('cli_app');
    await wakeSubscription.ready;
    const wakeStream = wakeSubscription[Symbol.asyncIterator]();
    const wakePromise = collectWake(wakeStream);
    const submitResults = await Promise.all([
      runtime.client.submitBtw(makeBtwScope(), created.btwOpId),
      runtime.client.submitBtw(makeBtwScope(), created.btwOpId),
      runtime.client.submitBtw(makeBtwScope(), created.btwOpId),
    ]);
    const wake = await wakePromise;

    const store = createBtwOperationStore({ dataDir });
    const operation = store.getBtwOperation(makeBtwScope(), created.btwOpId);
    await wakeStream.return?.();
    runtime.close();

    expect(submitResults.every(result => result.execution.state === 'accepted')).toBe(true);
    expect(wake.value).toEqual({ kind: 'btw_projection_wake' });
    expect(operation?.execution.state).toBe('accepted');
    expect(operation?.card.messageId).toBe('om_card_1');
  });

  it('scopes projection wakes by app id and reconnecting a watcher never mutates the durable pending list', async () => {
    const dataDir = newDataDir();
    const runtime = await connectBtwRuntime({ dataDir });
    const input = makeBtwPrepareInput();
    const created = await runtime.client.prepareBtw(input);
    const ids = deriveBtwIdentifiers(makeBtwScope(), input.requestId);
    await runtime.client.recordCard(makeBtwScope(), ids.btwOpId, 'om_card_projection_1');

    const firstSubscription = runtime.client.watchProjectionWakes('cli_app');
    const otherSubscription = runtime.client.watchProjectionWakes('other_app');
    await Promise.all([firstSubscription.ready, otherSubscription.ready]);
    const firstWatcher = firstSubscription[Symbol.asyncIterator]();
    const otherWatcher = otherSubscription[Symbol.asyncIterator]();
    const firstWakePromise = collectWake(firstWatcher);
    const foreignWakePromise = otherWatcher.next();
    await runtime.client.submitBtw(makeBtwScope(), ids.btwOpId);
    const firstWake = await firstWakePromise;

    expect(firstWake.value).toEqual({ kind: 'btw_projection_wake' });
    await Promise.race([
      foreignWakePromise.then(() => { throw new Error('unexpected foreign-app wake'); }),
      new Promise(resolve => {
        const timer = setTimeout(resolve, 200);
        timer.unref?.();
      }),
    ]);

    const beforeReconnect = await runtime.client.listPendingProjections('cli_app');
    const secondSubscription = runtime.client.watchProjectionWakes('cli_app');
    await secondSubscription.ready;
    const secondWatcher = secondSubscription[Symbol.asyncIterator]();
    const secondWakePromise = collectWake(secondWatcher);
    await runtime.client.submitBtw(makeBtwScope(), ids.btwOpId);
    const secondWake = await secondWakePromise;
    const afterReconnect = await runtime.client.listPendingProjections('cli_app');
    // The foreign watcher is deliberately blocked in `next()` to prove its
    // app-scoping.  Async-generator `return()` cannot interrupt that pending
    // socket read, so let runtime shutdown close it and consume its expected
    // rejection below instead of hanging the e2e process.
    void foreignWakePromise.catch(() => undefined);
    await firstWatcher.return?.();
    await secondWatcher.return?.();
    runtime.close();

    expect(created.kind).toBe('created');
    expect(secondWake.value).toEqual({ kind: 'btw_projection_wake' });
    expect(beforeReconnect).toEqual(afterReconnect);
  });

  it('persists the accepted operation on disk before submit_btw and returns the same durable state after caller exit', async () => {
    const dataDir = newDataDir();
    const helperScript = `
      import { createBtwOperationStore } from './src/features/btw/operation-store.js';
      import { deriveBtwIdentifiers } from './src/features/btw/types.js';
      import { makeBtwPrepareInput, makeBtwScope } from './test/fixtures/btw-fixtures.ts';

      const input = makeBtwPrepareInput();
      const scope = makeBtwScope();
      const store = createBtwOperationStore({ dataDir: process.env.BTW_DATA_DIR });
      store.prepareBtw(input);
      const ids = deriveBtwIdentifiers(scope, input.requestId);
      const operation = store.recordBtwCard(scope, ids.btwOpId, 'om_card_persisted_1');
      process.stdout.write(JSON.stringify({ btwOpId: ids.btwOpId, state: operation.execution.state }));
    `;
    const prepared = await new Promise<{ btwOpId: string; state: string }>((resolve, reject) => {
      const child = spawnTsEvalWithRepoImports(helperScript, {
        cwd: process.cwd(),
        env: { ...process.env, BTW_DATA_DIR: dataDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', chunk => { stdout += String(chunk); });
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      child.once('close', code => {
        if (code !== 0) reject(new Error(stderr || `child exited ${code}`));
        else resolve(JSON.parse(stdout) as { btwOpId: string; state: string });
      });
      child.once('error', reject);
    });

    const runtime = await connectBtwRuntime({ dataDir });
    const submitted = await runtime.client.submitBtw(makeBtwScope(), prepared.btwOpId);
    const raw = readFileSync(btwOperationPath(dataDir, makeBtwScope(), prepared.btwOpId), 'utf8');
    runtime.close();

    expect(prepared.state).toBe('accepted');
    expect(submitted.execution.state).toBe('accepted');
    expect(raw).toContain('"state": "accepted"');
    expect(raw).not.toContain('"submit_prepared"');
  });

  it('flushes the shutdown reply before closing the runtime socket', async () => {
    const dataDir = newDataDir();
    const runtime = await connectBtwRuntime({ dataDir });

    await expect(runtime.client.shutdownRuntime()).resolves.toBeUndefined();
    runtime.close();
  });
});
