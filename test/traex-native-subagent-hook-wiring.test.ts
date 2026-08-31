import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

describe('TRAE native subagent hook launch wiring', () => {
  it('always supplies the process hook to managed Trae TUI launches only', () => {
    const start = workerSource.indexOf('const args = cliAdapter.buildArgs({');
    const end = workerSource.indexOf('});', start);
    const buildArgs = workerSource.slice(start, end);

    expect(buildArgs).toContain('nativeSubagentRuntimeHookCommand:');
    expect(buildArgs).toContain("cfg.cliId === 'traex'");
    expect(buildArgs).toContain('nativeSubagentRuntimeHookCommand()');
  });

  it('imports the Botmux hook command without installing or mutating global hooks', () => {
    expect(workerSource).toContain("nativeSubagentRuntimeHookCommand } from './adapters/hook-command.js'");
    expect(workerSource).not.toContain("installHook('traex'");
  });

  it('keeps authenticated session identity on the ordinary Trae child process', () => {
    const start = workerSource.indexOf('childEnv.BOTMUX_SESSION_ID = cfg.sessionId;');
    const end = workerSource.indexOf('applySessionOwnerEnv(childEnv, cfg.ownerOpenId);', start);
    const authEnv = workerSource.slice(start, end + 64);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(authEnv).toContain('childEnv.BOTMUX_LARK_APP_ID = cfg.larkAppId;');
    expect(authEnv).toContain('applySessionOwnerEnv(childEnv, cfg.ownerOpenId);');
  });
});
