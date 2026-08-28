import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from '../src/utils/logger.js';
import {
  notifyPinStreamingCardChanged,
  registerPinStreamingCardChangeHandler,
} from '../src/services/pin-streaming-card-change.js';

describe('pin-streaming-card change handler seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerPinStreamingCardChangeHandler(null as any);
  });

  it('notifies the currently registered handler and allows disposal', () => {
    const calls: Array<[string, boolean]> = [];
    const dispose = registerPinStreamingCardChangeHandler((appId, enabled) => {
      calls.push([appId, enabled]);
    });

    notifyPinStreamingCardChanged('app-one', true);
    expect(calls).toEqual([['app-one', true]]);

    dispose();
    notifyPinStreamingCardChanged('app-one', false);
    expect(calls).toEqual([['app-one', true]]);
  });

  it('replaces the previous handler and only clears the current one when disposed', () => {
    const first = vi.fn();
    const second = vi.fn();

    const disposeFirst = registerPinStreamingCardChangeHandler(first);
    const disposeSecond = registerPinStreamingCardChangeHandler(second);

    notifyPinStreamingCardChanged('app-two', true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith('app-two', true);

    disposeFirst();
    notifyPinStreamingCardChanged('app-two', false);
    expect(second).toHaveBeenNthCalledWith(2, 'app-two', false);

    disposeSecond();
    notifyPinStreamingCardChanged('app-two', true);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('swallows handler throws and logs them', () => {
    registerPinStreamingCardChangeHandler(() => {
      throw new Error('boom');
    });

    expect(() => notifyPinStreamingCardChanged('app-three', true)).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('pinStreamingCard change handler failed'));
  });
});
