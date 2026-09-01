import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const reconcileRestoredStreamingCardPinsMock = vi.fn();
const loggerWarnMock = vi.fn();

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  class FakeWSClient { start() {} }
  class FakeEventDispatcher { register() {} }
  return {
    Client: FakeClient,
    WSClient: FakeWSClient,
    EventDispatcher: FakeEventDispatcher,
    LoggerLevel: { info: 2 },
  };
});

vi.mock('../src/core/worker-pool.js', async (importOriginal) => ({
  ...(await importOriginal() as object),
  reconcileRestoredStreamingCardPins: (...args: any[]) => reconcileRestoredStreamingCardPinsMock(...args),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: (...args: any[]) => loggerWarnMock(...args),
  },
}));

const daemonSource = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');

function region(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  expect(start, `${startMarker} not found`).toBeGreaterThan(-1);
  expect(end, `${endMarker} not found after ${startMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('startup streaming-card Pin recovery helper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('schedules restored Pin recovery in a fire-and-forget microtask', async () => {
    const daemon = await import('../src/daemon.js');

    daemon.__testOnly_scheduleRestoredStreamingCardPinRecovery('app-pin');

    expect(reconcileRestoredStreamingCardPinsMock).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(reconcileRestoredStreamingCardPinsMock).toHaveBeenCalledTimes(1);
    expect(reconcileRestoredStreamingCardPinsMock).toHaveBeenCalledWith('app-pin');
  });

  it('does not propagate synchronous Pin recovery failures', async () => {
    reconcileRestoredStreamingCardPinsMock.mockImplementation(() => {
      throw new Error('pin restore boom');
    });
    const daemon = await import('../src/daemon.js');

    expect(() => daemon.__testOnly_scheduleRestoredStreamingCardPinRecovery('app-pin')).not.toThrow();

    await Promise.resolve();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      expect.stringContaining('[card-pin] startup restore reconcile failed for app-pin: pin restore boom'),
    );
  });
});

describe('startDaemon wiring for restored streaming-card Pin recovery', () => {
  it('wires one non-blocking recovery after restoreActiveSessions for the current bot', () => {
    const block = region(
      daemonSource,
      'await restoreActiveSessions(activeSessions, idempotencyQuarantinedSessionIds);',
      'sessionsRestored = true;',
    );

    expect(block).toContain('scheduleRestoredStreamingCardPinRecovery(cfg.larkAppId);');
    expect(block).not.toContain('await scheduleRestoredStreamingCardPinRecovery');
  });
});
