import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const zhSource = readFileSync(new URL('../src/i18n/zh.ts', import.meta.url), 'utf8');

describe('Task 11 BTW ingress isolation', () => {
  it('routes /btw through the executable router before generic passthrough in both daemon ingress paths', () => {
    const firstIngressStart = daemonSource.indexOf('if (cmd === \'/card\')');
    const firstIngressEnd = daemonSource.indexOf('if (DAEMON_COMMANDS.has(cmd))', firstIngressStart);
    const firstIngress = daemonSource.slice(firstIngressStart, firstIngressEnd);
    expect(firstIngress).toContain('routeBtwIngress({');
    expect(firstIngress.indexOf('routeBtwIngress({')).toBeLessThan(firstIngress.indexOf('if (resolvePassthroughCommands(larkAppId).has(cmd))'));

    const secondIngressStart = daemonSource.indexOf('const passthroughCliId = existingDs?.session.cliLaunchSnapshot?.cliId');
    const secondIngressEnd = daemonSource.indexOf('if (DAEMON_COMMANDS.has(cmd))', secondIngressStart);
    const secondIngress = daemonSource.slice(secondIngressStart, secondIngressEnd);
    expect(secondIngress).toContain('routeBtwIngress({');
    expect(secondIngress.indexOf('routeBtwIngress({')).toBeLessThan(secondIngress.indexOf('if (resolvePassthroughCommands(larkAppId, passthroughCliId).has(cmd))'));
  });

  it('returns from the BTW router before the generic passthrough helpers', () => {
    const secondIngressStart = daemonSource.indexOf('const passthroughCliId = existingDs?.session.cliLaunchSnapshot?.cliId');
    const secondIngressEnd = daemonSource.indexOf('if (DAEMON_COMMANDS.has(cmd))', secondIngressStart);
    const secondIngress = daemonSource.slice(secondIngressStart, secondIngressEnd);
    expect(secondIngress).toContain('if (await routeBtwIngress({');
    expect(secondIngress.indexOf('if (await routeBtwIngress({')).toBeLessThan(secondIngress.indexOf('deliverPassthroughToExistingSession'));

    const firstIngressStart = daemonSource.indexOf('if (cmd === \'/card\')');
    const firstIngressEnd = daemonSource.indexOf('if (DAEMON_COMMANDS.has(cmd))', firstIngressStart);
    const firstIngress = daemonSource.slice(firstIngressStart, firstIngressEnd);
    expect(firstIngress).toContain('if (await routeBtwIngress({');
    expect(firstIngress.indexOf('if (await routeBtwIngress({')).toBeLessThan(firstIngress.indexOf('startInitialPassthroughSession'));
  });

  it('keeps the exact legacy warning text available for immediate settlement', () => {
    expect(zhSource).toContain("'btw.legacy_warning': '已转发到终端；答案只会出现在终端，不会回传飞书。'");
  });

  it('constructs the dedicated daemon-owned BTW projector service', () => {
    expect(daemonSource).toContain('BtwProjectorService');
    expect(daemonSource).toContain('ensureBtwProjectorService(cfg.larkAppId).start()');
  });
});
