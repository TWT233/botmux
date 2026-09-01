import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const io = vi.hoisted(() => ({
  spawn: vi.fn(() => ({ pid: 4321, unref: vi.fn() })),
  openSync: vi.fn(() => 1),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: io.spawn };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, openSync: io.openSync };
});

describe('startFleetViaSupervisor restart environment', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fleet-spawn-env-'));
    mkdirSync(join(home, '.botmux'), { recursive: true });
    writeFileSync(join(home, '.botmux', '.env'), [
      'WEB_HOST=10.9.9.9',
      'WEB_EXTERNAL_PORT=9100',
      'BOTMUX_WEB_PROXY_BASE_PORT=8900',
      '',
    ].join('\n'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('BOTMUX_SESSION_ID', 'session-1');
    vi.stubEnv('WEB_HOST', '127.0.0.1');
    vi.stubEnv('WEB_EXTERNAL_PORT', '9000');
    vi.stubEnv('BOTMUX_WEB_PROXY_BASE_PORT', '8800');
    io.spawn.mockClear();
    io.openSync.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('passes persisted terminal endpoint settings to the supervisor instead of stale session snapshots', async () => {
    const { startFleetViaSupervisor } = await import('../src/core/fleet-runtime.js');

    expect(startFleetViaSupervisor()).toMatchObject({ action: 'started', supervisorPid: 4321 });
    expect(io.spawn).toHaveBeenCalledOnce();
    const options = io.spawn.mock.calls[0]?.[2] as { env: NodeJS.ProcessEnv };
    expect(options.env.WEB_HOST).toBe('10.9.9.9');
    expect(options.env.WEB_EXTERNAL_PORT).toBe('9100');
    expect(options.env.BOTMUX_WEB_PROXY_BASE_PORT).toBe('8900');
  });
});
