import { readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { readProcessStartIdentity } from '../../src/core/session-marker.js';

/** Wait for a shutdown ACK's exact runtime identity to disappear. A changed
 * start identity is treated as exited so PID reuse can never be mistaken for
 * the runtime we asked to stop. */
export async function waitForExactRuntimeExit(pid: number, startIdentity: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (readProcessStartIdentity(pid) === startIdentity) {
    if (Date.now() >= deadline) {
      throw new Error(`runtime ${pid} with start identity ${startIdentity} did not exit after shutdown acknowledgement`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export interface FakeAppServerPidRecord {
  pid: number;
  listen: string;
  fixturePath?: string;
  argv?: string[];
}

function readPidRecord(pidFile: string): FakeAppServerPidRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(pidFile, 'utf8')) as Partial<FakeAppServerPidRecord>;
    if (!Number.isSafeInteger(parsed.pid) || (parsed.pid ?? 0) <= 0 || typeof parsed.listen !== 'string') return undefined;
    return {
      pid: parsed.pid,
      listen: parsed.listen,
      ...(typeof parsed.fixturePath === 'string' ? { fixturePath: parsed.fixturePath } : {}),
      ...(Array.isArray(parsed.argv) && parsed.argv.every(arg => typeof arg === 'string') ? { argv: parsed.argv } : {}),
    };
  } catch {
    return undefined;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function commandLine(pid: number): string[] | undefined {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return undefined;
  }
}

function isExpectedFixtureProcess(pid: number, fixturePath: string, listen: string): boolean {
  const argv = commandLine(pid);
  if (!argv || argv.length < 4) return false;
  const fixtureIndex = argv.indexOf(fixturePath);
  if (fixtureIndex < 0) return false;
  if (argv[fixtureIndex + 1] !== 'app-server') return false;
  const listenIndex = argv.indexOf('--listen', fixtureIndex + 2);
  return listenIndex >= 0 && argv[listenIndex + 1] === listen;
}

async function waitForExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && processAlive(pid); attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * Terminates precisely one fixture process group identified by test-owned PID
 * metadata. The cmdline verification is deliberately exact enough to reject a
 * PID reuse or any fixture from another worktree.
 */
export async function cleanupRegisteredFakeAppServer(input: {
  pidFile: string;
  fixturePath: string;
}): Promise<void> {
  const record = readPidRecord(input.pidFile);
  try {
    if (!record || !processAlive(record.pid) || !isExpectedFixtureProcess(record.pid, input.fixturePath, record.listen)) return;
    try { process.kill(-record.pid, 'SIGTERM'); } catch { /* process already exited */ }
    await waitForExit(record.pid);
    if (processAlive(record.pid) && isExpectedFixtureProcess(record.pid, input.fixturePath, record.listen)) {
      try { process.kill(-record.pid, 'SIGKILL'); } catch { /* process already exited */ }
    }
  } finally {
    try { unlinkSync(input.pidFile); } catch { /* absent is already clean */ }
  }
}

export async function cleanupRegisteredFakeAppServers(input: {
  pidDir: string;
  fixturePath: string;
}): Promise<void> {
  let names: string[];
  try {
    names = readdirSync(input.pidDir);
  } catch {
    return;
  }
  await Promise.all(names
    .filter(name => /^\d+\.json$/.test(name))
    .map(name => cleanupRegisteredFakeAppServer({
      pidFile: join(input.pidDir, name),
      fixturePath: input.fixturePath,
    })));
  try { rmSync(input.pidDir, { recursive: true, force: true }); } catch { /* absent is clean */ }
}

export function liveRegisteredFakeAppServerPids(input: {
  pidFiles: Iterable<string>;
  fixturePath: string;
}): number[] {
  const pids: number[] = [];
  for (const pidFile of input.pidFiles) {
    const record = readPidRecord(pidFile);
    if (record && processAlive(record.pid) && isExpectedFixtureProcess(record.pid, input.fixturePath, record.listen)) {
      pids.push(record.pid);
    }
  }
  return pids;
}

export function liveRegisteredFakeAppServerPidsInDir(input: {
  pidDir: string;
  fixturePath: string;
}): number[] {
  let names: string[];
  try {
    names = readdirSync(input.pidDir);
  } catch {
    return [];
  }
  return liveRegisteredFakeAppServerPids({
    pidFiles: names
      .filter(name => /^\d+\.json$/.test(name))
      .map(name => join(input.pidDir, name)),
    fixturePath: input.fixturePath,
  });
}

export function registeredFakeAppServerRecordCount(pidDir: string): number {
  try {
    return readdirSync(pidDir).filter(name => /^\d+\.json$/.test(name)).length;
  } catch {
    return 0;
  }
}
