import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';

const CLI = resolve('src/cli.ts');
const CAPABILITY = 'ab'.repeat(32);
let server: Server | undefined;
let dir: string | undefined;

afterEach(async () => {
  if (server) await new Promise<void>(resolveClose => server!.close(() => resolveClose()));
  server = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function listen(policy: unknown, status = 200, response?: unknown): Promise<number> {
  if (server) await new Promise<void>(resolveClose => server!.close(() => resolveClose()));
  server = createServer((req, res) => {
    req.resume();
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response ?? (status === 200 ? { ok: true, policy } : { ok: false })));
  });
  await new Promise<void>(resolveListen => server!.listen(0, '127.0.0.1', resolveListen));
  return (server.address() as { port: number }).port;
}

async function runHook(
  payloadText: string,
  options: {
    policy?: unknown;
    status?: number;
    startServer?: boolean;
    endStdin?: boolean;
    exitTimeoutMs?: number;
    transcriptRecords?: readonly Record<string, unknown>[];
    response?: unknown;
  } = {},
): Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  dir = mkdtempSync(join(tmpdir(), 'botmux-native-subagent-hook-'));
  const relay = join(dir, 'relay');
  const transcript = join(dir, 'rollout.jsonl');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(relay, { mode: 0o700 });
  writeFileSync(join(relay, '.botmux-origin-capability.json'), JSON.stringify({
    capability: CAPABILITY, turnId: 'turn-1', dispatchAttempt: 1,
  }), { mode: 0o600 });
  const transcriptRecords = options.transcriptRecords ?? [
    { type: 'turn_context', payload: { model: 'old', reasoning_effort: 'low' } },
    { type: 'turn_context', payload: {
      model: 'parent-model', collaboration_mode: { settings: { reasoning_effort: 'xhigh' } },
    } },
  ];
  writeFileSync(transcript, [
    ...transcriptRecords.map(record => JSON.stringify(record)),
    '{"type":"turn_context","payload":{"model":"partial"',
  ].join('\n'));
  const port = options.startServer === false
    ? 9
    : await listen(options.policy, options.status ?? 200, options.response);
  const parsed = (() => { try { return JSON.parse(payloadText); } catch { return null; } })();
  if (parsed && typeof parsed === 'object' && !('transcript_path' in parsed)) {
    parsed.transcript_path = transcript;
    payloadText = JSON.stringify(parsed);
  }

  const child = spawnTsScript(CLI, ['native-subagent-runtime-hook'], {
    cwd: resolve('.'),
    env: {
      ...process.env,
      HOME: dir,
      SESSION_DATA_DIR: dir,
      BOTMUX_SESSION_ID: 'session-native',
      BOTMUX_LARK_APP_ID: 'app-native',
      BOTMUX_DAEMON_IPC_PORT: String(port),
      BOTMUX_SEND_RELAY: relay,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin!.on('error', () => { /* hook may close oversized/slow input early */ });
  if (options.endStdin === false) child.stdin!.write(payloadText);
  else child.stdin!.end(payloadText);
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  let timedOut = false;
  const status = await new Promise<number | null>(resolveExit => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.exitTimeoutMs ?? 5_000);
    child.once('exit', code => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
  return { status, stdout, stderr, timedOut };
}

const spawnPayload = {
  hook_event_name: 'PreToolUse',
  tool_name: 'spawn_agent',
  model: 'payload-model-fallback',
  tool_input: { task_name: 'child', role: 'worker', fork_turns: 'all' },
};

describe('native-subagent-runtime-hook CLI', () => {
  it('is a no-op for unrelated tools and malformed or oversized stdin', async () => {
    for (const input of [
      JSON.stringify({ ...spawnPayload, tool_name: 'Bash' }),
      '{bad json',
      JSON.stringify({ ...spawnPayload, padding: 'secret-never-echo'.repeat(100_000) }),
    ]) {
      const result = await runHook(input, { startServer: false });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeLessThanOrEqual(1024);
      expect(result.stderr).not.toContain('secret-never-echo');
    }
  });

  it('stops reading oversized stdin without waiting for EOF', async () => {
    const result = await runHook('x'.repeat(256 * 1024 + 1), {
      startServer: false,
      endStdin: false,
      exitTimeoutMs: 3_000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('stdin exceeded size limit');
  });

  it('stops reading slow partial stdin at an internal deadline', async () => {
    const result = await runHook('{"hook_event_name":', {
      startServer: false,
      endStdin: false,
      exitTimeoutMs: 3_000,
    });

    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('stdin read timed out');
  });

  it('fails open for daemon failure, invalid response policy, and pass-through policy', async () => {
    const cases = [
      { options: { startServer: false }, diagnostic: undefined },
      { options: { status: 503 }, diagnostic: undefined },
      {
        options: { policy: { model: { mode: 'custom', value: '' } } },
        diagnostic: 'daemon returned invalid policy; allowing spawn',
      },
      {
        options: { response: { ok: true, invalidPolicy: true } },
        diagnostic: 'daemon rejected invalid stored policy; allowing spawn',
      },
      { options: { policy: undefined }, diagnostic: undefined },
    ];
    for (const { options, diagnostic } of cases) {
      const result = await runHook(JSON.stringify(spawnPayload), options);
      expect(result.status).toBe(0);
      expect(result.stdout).toBe('');
      expect(result.stderr.length).toBeLessThanOrEqual(1024);
      if (diagnostic) expect(result.stderr).toContain(diagnostic);
    }
  });

  it('rewrites spawn input from the latest complete immediate-parent turn context', async () => {
    const result = await runHook(JSON.stringify(spawnPayload), {
      policy: { model: { mode: 'inherit' }, reasoningEffort: { mode: 'inherit' } },
    });
    expect(result.status).toBe(0);
    expect(result.stderr.length).toBeLessThanOrEqual(1024);
    expect(result.stdout.endsWith('\n')).toBe(false);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        updatedInput: {
          task_name: 'child', role: 'worker', fork_turns: 'all',
          model_provider: 'trae', model: 'parent-model', reasoning_effort: 'xhigh',
        },
      },
    });
  });

  it('keeps scanning backward for effort after the newest turn context establishes model', async () => {
    const result = await runHook(JSON.stringify(spawnPayload), {
      policy: { model: { mode: 'inherit' }, reasoningEffort: { mode: 'inherit' } },
      transcriptRecords: [
        { type: 'turn_context', payload: { reasoning_effort: 'high' } },
        { type: 'turn_context', payload: { model: 'newest-model' } },
      ],
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput).toMatchObject({
      model_provider: 'trae',
      model: 'newest-model',
      reasoning_effort: 'high',
    });
  });

  it('keeps scanning backward for model after the newest turn context establishes effort', async () => {
    const result = await runHook(JSON.stringify(spawnPayload), {
      policy: { model: { mode: 'inherit' }, reasoningEffort: { mode: 'inherit' } },
      transcriptRecords: [
        { type: 'turn_context', payload: { model: 'older-model' } },
        { type: 'turn_context', payload: { reasoning_effort: 'medium' } },
      ],
    });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.updatedInput).toMatchObject({
      model_provider: 'trae',
      model: 'older-model',
      reasoning_effort: 'medium',
    });
  });

  it('uses payload.model only as model fallback and explicitly denies unresolved inheritance', async () => {
    const missingTranscript = {
      ...spawnPayload,
      reasoning_effort: 'ultra',
      effort: 'max',
      transcript_path: join(tmpdir(), 'missing-rollout.jsonl'),
    };
    const model = await runHook(JSON.stringify(missingTranscript), {
      policy: { model: { mode: 'inherit' } },
    });
    expect(JSON.parse(model.stdout).hookSpecificOutput.updatedInput.model).toBe('payload-model-fallback');

    const denied = await runHook(JSON.stringify(missingTranscript), {
      policy: { reasoningEffort: { mode: 'inherit' } },
    });
    expect(denied.status).toBe(0);
    expect(JSON.parse(denied.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Cannot inherit native subagent reasoning effort: immediate parent runtime is unavailable',
      },
    });
  });
});
