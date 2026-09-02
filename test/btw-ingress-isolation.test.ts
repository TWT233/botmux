import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const zhSource = readFileSync(new URL('../src/i18n/zh.ts', import.meta.url), 'utf8');

describe('Task 11 BTW ingress isolation', () => {
  it('intercepts /btw before generic passthrough in both daemon ingress paths', () => {
    const firstIngressStart = daemonSource.indexOf('if (cmd === \'/card\')');
    const firstIngressEnd = daemonSource.indexOf('if (DAEMON_COMMANDS.has(cmd))', firstIngressStart);
    const firstIngress = daemonSource.slice(firstIngressStart, firstIngressEnd);
    expect(firstIngress).toContain('if (cmd === \'/btw\')');
    expect(firstIngress.indexOf('if (cmd === \'/btw\')')).toBeLessThan(firstIngress.indexOf('if (resolvePassthroughCommands(larkAppId).has(cmd))'));

    const secondIngressStart = daemonSource.indexOf('const passthroughCliId = existingDs?.session.cliLaunchSnapshot?.cliId');
    const secondIngressEnd = daemonSource.indexOf('if (DAEMON_COMMANDS.has(cmd))', secondIngressStart);
    const secondIngress = daemonSource.slice(secondIngressStart, secondIngressEnd);
    expect(secondIngress).toContain('if (cmd === \'/btw\')');
    expect(secondIngress.indexOf('if (cmd === \'/btw\')')).toBeLessThan(secondIngress.indexOf('if (resolvePassthroughCommands(larkAppId, passthroughCliId).has(cmd))'));
  });

  it('does not call the generic passthrough helpers for /btw', () => {
    const secondIngressStart = daemonSource.indexOf('const passthroughCliId = existingDs?.session.cliLaunchSnapshot?.cliId');
    const secondIngressEnd = daemonSource.indexOf('if (DAEMON_COMMANDS.has(cmd))', secondIngressStart);
    const secondIngress = daemonSource.slice(secondIngressStart, secondIngressEnd);
    expect(secondIngress).not.toContain('if (cmd === \'/btw\') {\n        deliverPassthroughToExistingSession');

    const firstIngressStart = daemonSource.indexOf('if (cmd === \'/card\')');
    const firstIngressEnd = daemonSource.indexOf('if (DAEMON_COMMANDS.has(cmd))', firstIngressStart);
    const firstIngress = daemonSource.slice(firstIngressStart, firstIngressEnd);
    expect(firstIngress).not.toContain('if (cmd === \'/btw\') {\n        await startInitialPassthroughSession');
  });

  it('keeps the exact legacy warning text available for immediate settlement', () => {
    expect(zhSource).toContain("'btw.legacy_warning': '已转发到终端；答案只会出现在终端，不会回传飞书。'");
  });

  it('constructs the dedicated daemon-owned BTW projector service', () => {
    expect(daemonSource).toContain('BtwProjectorService');
    expect(daemonSource).toContain('ensureBtwProjectorService(cfg.larkAppId).start()');
  });
});
