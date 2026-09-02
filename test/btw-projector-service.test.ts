import { describe, expect, it, vi } from 'vitest';
import { BtwProjectorService } from '../src/features/btw/projector-service.js';

describe('BtwProjectorService', () => {
  it('recovers durable pending initial cards when it starts', async () => {
    const initialCard = { btwOpId: 'btwop_pending' };
    const ensureInitialCard = vi.fn(async () => ({ kind: 'recorded' }));
    const drainApp = vi.fn(async () => undefined);
    const close = vi.fn();
    const iterator = {
      async next() { return new Promise<IteratorResult<void>>(() => {}); },
      async return() { return { done: true, value: undefined }; },
      [Symbol.asyncIterator]() { return this; },
    };
    const runtime = {
      listPendingInitialCards: vi.fn(async () => [initialCard]),
      watchProjectionWakes: vi.fn(() => Object.assign(iterator, { ready: Promise.resolve() })),
    };

    const service = new BtwProjectorService({
      larkAppId: 'cli_app',
      connect: vi.fn(async () => ({ client: runtime, close })),
      createProjector: vi.fn(() => ({ ensureInitialCard, drainApp })),
    });

    await service.start();

    expect(runtime.listPendingInitialCards).toHaveBeenCalledWith('cli_app');
    expect(ensureInitialCard).toHaveBeenCalledWith(initialCard);
    expect(drainApp).toHaveBeenCalledWith('cli_app');
    await service.stop();
    expect(close).toHaveBeenCalledOnce();
  });

  it('arms one durable retry deadline and coalesces wake bursts into one scan', async () => {
    vi.useFakeTimers();
    try {
      const retryAt = new Date(Date.now() + 1_000).toISOString();
      let releaseWake!: () => void;
      const iterator = {
        async next() { return new Promise<IteratorResult<void>>(resolve => { releaseWake = () => resolve({ done: true, value: undefined }); }); },
        async return() { return { done: true, value: undefined }; },
        [Symbol.asyncIterator]() { return this; },
      };
      const runtime = {
        listPendingInitialCards: vi.fn(async () => []),
        nextBtwRetryAt: vi.fn(async () => retryAt),
        watchProjectionWakes: vi.fn(() => Object.assign(iterator, { ready: Promise.resolve() })),
      };
      const drainApp = vi.fn(async () => undefined);
      const service = new BtwProjectorService({
        larkAppId: 'cli_app',
        connect: vi.fn(async () => ({ client: runtime, close: vi.fn() })),
        createProjector: vi.fn(() => ({ ensureInitialCard: vi.fn(), drainApp })),
      });

      await service.start();
      service.wake();
      service.wake();
      await vi.runOnlyPendingTimersAsync();
      expect(runtime.listPendingInitialCards.mock.calls.length).toBeLessThanOrEqual(3);
      expect(drainApp).toHaveBeenCalled();
      releaseWake();
      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
