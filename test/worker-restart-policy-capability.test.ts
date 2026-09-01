import { execFileSync, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { probeTmuxFunctional } from '../src/setup/ensure-tmux.js';
import type { DaemonToWorker, WorkerToDaemon } from '../src/types.js';
import { spawnTsScript } from './helpers/ts-runner.js';

type Origin = Extract<WorkerToDaemon, { type: 'managed_turn_origin' }>;
type OriginRevoke = Extract<WorkerToDaemon, { type: 'managed_turn_origin_revoked' }>;

interface Harness {
  child: ChildProcess;
  logs: string[];
  messages: WorkerToDaemon[];
  root: string;
  sessionId: string;
  launchCount?: string;
  tmuxSession?: string;
}

const children = new Set<ChildProcess>();
const tempDirs = new Set<string>();
const tmuxSessions = new Set<string>();
let sequence = 0;
const tmuxAvailable = probeTmuxFunctional().ok;

async function waitFor(
  harness: Harness,
  predicate: () => boolean,
  description: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    if (harness.child.exitCode !== null || harness.child.signalCode !== null) {
      throw new Error(`worker exited before ${description}\n${harness.logs.join('')}`);
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(`timed out waiting for ${description}\n${harness.logs.join('')}`);
}

function origins(harness: Harness): Origin[] {
  return harness.messages.filter((message): message is Origin => message.type === 'managed_turn_origin');
}

function revokesSince(harness: Harness, index: number): OriginRevoke[] {
  return harness.messages.slice(index)
    .filter((message): message is OriginRevoke => message.type === 'managed_turn_origin_revoked');
}

function startWorker(backendType: 'tmux' | 'mojo'): Harness {
  const root = mkdtempSync(join(tmpdir(), 'botmux-restart-policy-'));
  tempDirs.add(root);
  const launchCount = join(root, 'launch-count');
  const fakeCli = join(root, backendType === 'mojo' ? 'mojo' : 'trae');
  writeFileSync(fakeCli, backendType === 'mojo' ? `#!/usr/bin/env bash
echo '{"type":"system","subtype":"init","session_id":"mojo-restart-session"}'
echo '{"type":"result","status":"ok","result":"ok","session_id":"mojo-restart-session","warnings":[]}'
` : `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then
  echo "fake trae 1.0.0"
  exit 0
fi
count=0
if [ -f '${launchCount}' ]; then count=$(cat '${launchCount}'); fi
count=$((count + 1))
printf '%s' "$count" > '${launchCount}'
for _ in $(seq 1 20); do
  printf '\n› \n'
  sleep 0.05
done
while :; do sleep 60; done
`);
  chmodSync(fakeCli, 0o755);

  const prefix = `${process.pid.toString(36)}${(++sequence).toString(36)}${Date.now().toString(36)}`;
  const sessionId = `rpc${prefix}`;
  const tmuxSession = backendType === 'tmux' ? `bmx-${sessionId.slice(0, 8)}` : undefined;
  if (tmuxSession) tmuxSessions.add(tmuxSession);
  const logs: string[] = [];
  const messages: WorkerToDaemon[] = [];
  const child = spawnTsScript(resolve('src/worker.ts'), [], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      SESSION_DATA_DIR: root,
      BOTMUX_SESSION_ID: sessionId,
      LARK_APP_ID: 'app_restart_policy',
      LARK_APP_SECRET: 'secret',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  child.stdout?.on('data', chunk => logs.push(chunk.toString()));
  child.stderr?.on('data', chunk => logs.push(chunk.toString()));
  child.on('message', raw => messages.push(raw as WorkerToDaemon));
  child.send({
    type: 'init',
    sessionId,
    chatId: 'oc_restart_policy',
    rootMessageId: 'om_restart_policy',
    workingDir: root,
    cliId: backendType === 'mojo' ? 'mojo' : 'traex',
    cliPathOverride: fakeCli,
    backendType,
    ...(backendType === 'mojo' ? { backendConfig: { cloud: true } } : {}),
    prompt: 'opening turn',
    turnId: 'turn-before-restart',
    larkAppId: 'app_restart_policy',
    larkAppSecret: 'secret',
    launchShell: '/bin/sh',
  } satisfies DaemonToWorker);
  return { child, logs, messages, root, sessionId, launchCount, tmuxSession };
}

async function waitForInitialOrigin(harness: Harness): Promise<Origin> {
  await waitFor(
    harness,
    () => harness.messages.some(message => message.type === 'ready')
      && origins(harness).some(message => message.turnId === 'turn-before-restart'),
    'initial worker readiness and managed origin',
  );
  return origins(harness).filter(message => message.turnId === 'turn-before-restart').at(-1)!;
}

async function restartAndPublishNextTurn(harness: Harness, attemptId: string): Promise<Origin> {
  harness.child.send({ type: 'restart', attemptId } satisfies DaemonToWorker);
  await waitFor(
    harness,
    () => harness.messages.some(message => message.type === 'restart_result'
      && message.attemptId === attemptId && message.status === 'succeeded'),
    `restart ${attemptId} to succeed`,
    30_000,
  );
  harness.child.send({
    type: 'message',
    content: 'turn after restart',
    turnId: `turn-${attemptId}`,
  } satisfies DaemonToWorker);
  await waitFor(
    harness,
    () => origins(harness).some(message => message.turnId === `turn-${attemptId}`),
    `managed origin after ${attemptId}`,
  );
  return origins(harness).filter(message => message.turnId === `turn-${attemptId}`).at(-1)!;
}

afterEach(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  children.clear();
  for (const session of tmuxSessions) {
    try { execFileSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' }); } catch { /* gone */ }
  }
  tmuxSessions.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

describe.skipIf(!tmuxAvailable)('worker restart policy capability lifecycle', () => {
  it('keeps policy authority stable through backend onExit and killCli', async () => {
    const harness = startWorker('tmux');
    const before = await waitForInitialOrigin(harness);
    const restartMessageIndex = harness.messages.length;

    harness.child.send({ type: 'restart', attemptId: 'kill-cli' } satisfies DaemonToWorker);
    await waitFor(
      harness,
      () => harness.messages.some(message => message.type === 'restart_result'
        && message.attemptId === 'kill-cli' && message.status === 'succeeded'),
      'replacement CLI readiness after killCli',
      30_000,
    );
    expect(readFileSync(harness.launchCount!, 'utf8')).toBe('2');
    const restartRevokes = revokesSince(harness, restartMessageIndex);
    // The entry revoke and the backend teardown/killCli edge must both complete
    // before the replacement reaches ready.
    expect(restartRevokes.length).toBeGreaterThanOrEqual(2);
    expect(restartRevokes.some(message => message.capability === before.capability)).toBe(true);
    expect(restartRevokes.every(message => message.policyCapability === undefined)).toBe(true);
  }, 45_000);

  it('reuses policy authority when the replacement publishes its next turn', async () => {
    const harness = startWorker('mojo');
    const before = await waitForInitialOrigin(harness);
    const restartMessageIndex = harness.messages.length;

    const after = await restartAndPublishNextTurn(harness, 'after-on-exit');
    expect(after.policyCapability).toBe(before.policyCapability);
    expect(after.capability).not.toBe(before.capability);
    const restartRevokes = revokesSince(harness, restartMessageIndex);
    // Mojo gives the replacement a deterministic next-turn publication,
    // proving the worker-generation policy token survived the restart.
    expect(restartRevokes.length).toBeGreaterThanOrEqual(2);
    expect(restartRevokes.some(message => message.capability === before.capability)).toBe(true);
    expect(restartRevokes.every(message => message.policyCapability === undefined)).toBe(true);
  }, 45_000);
});
