import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { createServer as createNetServer } from 'node:net';
import { join, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ChildProcess } from 'node:child_process';

import { spawnTsScript } from './helpers/ts-runner.js';
import { loadOrCreatePersistedToken } from '../src/dashboard/auth.js';

const DASHBOARD_ENTRY = resolve('src/index-dashboard.ts');

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as import('node:net').AddressInfo).port;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
}

async function reservePort(): Promise<number> {
  const server = createNetServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as import('node:net').AddressInfo).port;
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  return port;
}

async function waitForDashboard(
  base: string,
  child: ChildProcess,
  logs: () => string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`dashboard exited early\n${logs()}`);
    }
    try {
      const response = await fetch(`${base}/__health`);
      if (response.ok) return;
    } catch {
      // still booting
    }
    await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
  }
  throw new Error(`timeout waiting for dashboard health\n${logs()}`);
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'close'),
    new Promise(resolveTimeout => setTimeout(resolveTimeout, 10_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'close');
  }
}

describe('dashboard pin-streaming-card route auth', () => {
  let rootDir = '';
  let fakeDaemon: Server | undefined;
  let dashboardChild: ChildProcess | undefined;

  afterEach(async () => {
    await stopChild(dashboardChild);
    dashboardChild = undefined;
    await closeServer(fakeDaemon);
    fakeDaemon = undefined;
    if (rootDir) rmSync(rootDir, { recursive: true, force: true });
    rootDir = '';
  });

  it('returns 401 before reaching the daemon for anonymous PUTs, including publicReadOnly mode', async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'botmux-dashboard-pin-auth-'));
    const homeDir = join(rootDir, 'home');
    const botmuxDir = join(homeDir, '.botmux');
    const dataDir = join(botmuxDir, 'data');
    const registryDir = join(dataDir, 'dashboard-daemons');
    const botsConfigPath = join(botmuxDir, 'bots.json');
    const dashboardPort = await reservePort();
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(botmuxDir, '.dashboard-secret'), 'dashboard-secret-for-pin-auth-test', { mode: 0o600 });
    writeFileSync(join(botmuxDir, '.data-dir'), `${dataDir}\n`, { mode: 0o600 });
    writeFileSync(botsConfigPath, JSON.stringify([{
      larkAppId: 'cli auth-test-app',
      larkAppSecret: 'secret',
      botName: 'auth test bot',
      cliId: 'codex',
    }], null, 2));
    const dashboardToken = loadOrCreatePersistedToken(join(botmuxDir, '.dashboard-token'));

    const pinWrites: Array<{ method: string; url: string }> = [];
    fakeDaemon = createServer((req, res) => {
      const url = req.url ?? '/';
      if (req.method === 'PUT' && url === '/api/chat-pin-streaming-card/oc%20auth%2Ftopic') {
        pinWrites.push({ method: req.method, url });
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, enabled: false }));
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unexpected_route' }));
    });
    const fakeDaemonPort = await listen(fakeDaemon);

    writeFileSync(join(registryDir, 'cli auth-test-app.json'), JSON.stringify({
      larkAppId: 'cli auth-test-app',
      botName: 'auth test bot',
      botIndex: 0,
      ipcPort: fakeDaemonPort,
      pid: process.pid,
      startedAt: Date.now(),
      lastHeartbeat: Date.now(),
    }));

    dashboardChild = spawnTsScript(DASHBOARD_ENTRY, [], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        SESSION_DATA_DIR: dataDir,
        BOTS_CONFIG: botsConfigPath,
        BOTMUX_DASHBOARD_PORT: String(dashboardPort),
        BOTMUX_DASHBOARD_HOST: '127.0.0.1',
        BOTMUX_DASHBOARD_PUBLIC_READONLY: 'false',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    dashboardChild.stdout?.on('data', chunk => { stdout += String(chunk); });
    let stderr = '';
    dashboardChild.stderr?.on('data', chunk => { stderr += String(chunk); });

    const base = `http://127.0.0.1:${dashboardPort}`;
    await waitForDashboard(base, dashboardChild, () => `${stdout}\n${stderr}`);
    const pinRoute = `${base}/api/groups/${encodeURIComponent('oc auth/topic')}`
      + `/pin-streaming-card/${encodeURIComponent('cli auth-test-app')}`;
    const anonymousPin = () => fetch(pinRoute, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    const authenticatedPin = await fetch(pinRoute, {
      method: 'PUT',
      headers: {
        cookie: `botmux_dashboard_token=${dashboardToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ enabled: false }),
    });
    expect({ status: authenticatedPin.status, pinWrites }, stderr).toEqual({
      status: 202,
      pinWrites: [{
        method: 'PUT',
        url: '/api/chat-pin-streaming-card/oc%20auth%2Ftopic',
      }],
    });
    pinWrites.length = 0;

    const privateModeDenied = await anonymousPin();
    expect({ status: privateModeDenied.status, pinWrites }, stderr).toEqual({
      status: 401,
      pinWrites: [],
    });

    const enablePublicReadOnly = await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: {
        cookie: `botmux_dashboard_token=${dashboardToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ publicReadOnly: true }),
    });
    expect(enablePublicReadOnly.status, stderr).toBe(200);

    const anonymousSettings = await fetch(`${base}/api/settings`);
    expect(anonymousSettings.status, stderr).toBe(200);
    expect(await anonymousSettings.json()).toMatchObject({
      authed: false,
      settings: { publicReadOnly: true },
    });

    const publicModeDenied = await anonymousPin();
    expect({ status: publicModeDenied.status, pinWrites }, stderr).toEqual({
      status: 401,
      pinWrites: [],
    });
  }, 20_000);
});
