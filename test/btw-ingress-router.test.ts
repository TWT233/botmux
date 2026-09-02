import { describe, expect, it, vi } from 'vitest';
import { routeBtwIngress } from '../src/features/btw/ingress.js';

describe('BTW executable ingress router', () => {
  it.each(['new-topic', 'existing-thread'])('routes %s /btw to the dedicated coordinator using the inbound message id', async () => {
    const ds = { session: { sessionId: 'sess' } } as any;
    const invoke = vi.fn(async () => undefined);
    const noSession = vi.fn(async () => undefined);
    await expect(routeBtwIngress({
      cmd: '/btw', ds, commandContent: '/btw explain this', requestId: 'om_inbound', invoke, noSession,
    })).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith(ds, '/btw explain this', 'om_inbound');
    expect(noSession).not.toHaveBeenCalled();
  });

  it('does not claim generic commands', async () => {
    const invoke = vi.fn();
    await expect(routeBtwIngress({
      cmd: '/model', ds: undefined, commandContent: '/model', requestId: 'om_other', invoke, noSession: vi.fn(),
    })).resolves.toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});
