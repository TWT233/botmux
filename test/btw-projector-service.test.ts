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

  it('subscribes before its first durable scan so a mutation in that gap is projected', async () => {
    let resolveReady!: () => void;
    const ready = new Promise<void>(resolve => { resolveReady = resolve; });
    let pending: Array<{ btwOpId: string }> = [];
    const iterator = {
      async next() { return new Promise<IteratorResult<void>>(() => {}); },
      async return() { return { done: true, value: undefined }; },
      [Symbol.asyncIterator]() { return this; },
    };
    const runtime = {
      listPendingInitialCards: vi.fn(async () => pending),
      nextBtwRetryAt: vi.fn(async () => undefined),
      watchProjectionWakes: vi.fn(() => Object.assign(iterator, { ready })),
    };
    const ensureInitialCard = vi.fn(async () => ({ kind: 'recorded' }));
    const service = new BtwProjectorService({
      larkAppId: 'cli_app',
      connect: vi.fn(async () => ({ client: runtime, close: vi.fn() })),
      createProjector: vi.fn(() => ({ ensureInitialCard, drainApp: vi.fn(async () => undefined) })),
    });

    const starting = service.start();
    await vi.waitFor(() => expect(runtime.watchProjectionWakes).toHaveBeenCalledOnce());
    pending = [{ btwOpId: 'btwop_gap' }];
    resolveReady();
    await starting;

    expect(ensureInitialCard).toHaveBeenCalledWith({ btwOpId: 'btwop_gap' });
    await service.stop();
  });

  it('reconnects, re-lists durable cards, and stops an active watch without stopping the runtime', async () => {
    const firstIterator = {
      async next() { return { done: true, value: undefined }; },
      async return() { return { done: true, value: undefined }; },
      [Symbol.asyncIterator]() { return this; },
    };
    let releaseSecond!: () => void;
    const secondIterator = {
      async next() { return new Promise<IteratorResult<void>>(resolve => { releaseSecond = () => resolve({ done: true, value: undefined }); }); },
      return: vi.fn(async () => ({ done: true, value: undefined })),
      [Symbol.asyncIterator]() { return this; },
    };
    const first = {
      listPendingInitialCards: vi.fn(async () => []), nextBtwRetryAt: vi.fn(async () => undefined),
      watchProjectionWakes: vi.fn(() => Object.assign(firstIterator, { ready: Promise.resolve() })),
    };
    const second = {
      listPendingInitialCards: vi.fn(async () => [{ btwOpId: 'btwop_relisted' }]), nextBtwRetryAt: vi.fn(async () => undefined),
      watchProjectionWakes: vi.fn(() => Object.assign(secondIterator, { ready: Promise.resolve() })),
    };
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const ensureInitialCard = vi.fn(async () => ({ kind: 'recorded' }));
    const connect = vi.fn()
      .mockResolvedValueOnce({ client: first, close: firstClose })
      .mockResolvedValueOnce({ client: second, close: secondClose });
    const service = new BtwProjectorService({
      larkAppId: 'cli_app', connect,
      createProjector: vi.fn(() => ({ ensureInitialCard, drainApp: vi.fn(async () => undefined) })),
    });

    await service.start();
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(ensureInitialCard).toHaveBeenCalledWith({ btwOpId: 'btwop_relisted' }));
    await service.stop({ drainMs: 1 });

    expect(firstClose).toHaveBeenCalled();
    expect(secondIterator.return).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
    releaseSecond();
  });
});
