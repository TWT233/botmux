import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession, FrozenCard } from '../src/core/types.js';
import { activeSessionKey } from '../src/core/types.js';

const pinMessageMock = vi.fn(async () => true);
const unpinMessageMock = vi.fn(async () => true);

vi.mock('../src/im/lark/client.js', () => ({
  pinMessage: (...args: any[]) => pinMessageMock(...args),
  unpinMessage: (...args: any[]) => unpinMessageMock(...args),
  deleteMessage: vi.fn(async () => {}),
  updateMessage: vi.fn(async () => {}),
  MessageWithdrawnError: class MessageWithdrawnError extends Error {},
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: true } })),
  getAllBots: vi.fn(() => []),
  resolveUsageDisplay: vi.fn(() => 'streaming'),
}));
vi.mock('../src/services/frozen-card-store.js', () => ({ loadFrozenCards: vi.fn(() => new Map()), saveFrozenCards: vi.fn() }));
vi.mock('../src/core/session-manager.js', () => ({ persistStreamCardState: vi.fn() }));
vi.mock('../src/utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
vi.mock('../src/config.js', () => ({ config: { web: { externalHost: 'localhost' }, session: { dataDir: '/tmp' } } }));
vi.mock('../src/global-config.js', () => ({ isRemoteAccessEnabled: vi.fn(() => false) }));
vi.mock('../src/platform/binding.js', () => ({ platformMachineBaseUrl: vi.fn(() => null), publicReverseProxyBaseUrl: vi.fn(() => null) }));
vi.mock('../src/services/session-store.js', () => ({ registerSessionBridgeSendMarkerCleanupFence: vi.fn(), cleanupSessionBridgeSendMarkers: vi.fn(), cleanupSessionBridgeSendMarkersNow: vi.fn(), closeSession: vi.fn(), updateSession: vi.fn() }));
vi.mock('../src/core/dashboard-events.js', () => ({ dashboardEventBus: { publish: vi.fn() } }));
vi.mock('../src/core/dashboard-rows.js', () => ({ composeRowFromActive: vi.fn() }));
vi.mock('../src/skills/installer.js', () => ({ ensureSkills: vi.fn() }));
vi.mock('../src/adapters/cli/registry.js', () => ({ createCliAdapterSync: vi.fn() }));
vi.mock('../src/adapters/cli/claude-code.js', () => ({ claudeJsonlPathForSession: vi.fn() }));
vi.mock('../src/adapters/backend/tmux-backend.js', () => ({ TmuxBackend: class {} }));
vi.mock('../src/im/lark/card-builder.js', () => ({ buildStreamingCard: vi.fn(() => '{}'), buildSessionCard: vi.fn(() => '{}'), buildTuiPromptCard: vi.fn(() => '{}'), buildTuiPromptResolvedCard: vi.fn(() => '{}'), getCliDisplayName: vi.fn(() => 'Claude') }));

import {
  __testOnly_resetPinStreamingCardReconcileQueue,
  __testOnly_waitForPinStreamingCardIdle,
  CARD_POSTING_SENTINEL,
  pinStreamingCardIfEnabled,
  reconcileBotStreamingCardPins,
  reconcileStreamingCardPins,
  setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import { getBot } from '../src/bot-registry.js';

const getBotMock = getBot as ReturnType<typeof vi.fn>;

async function drainMicrotasks(times = 2): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

function makeDs(
  card = 'om_current',
  frozenCards?: Map<string, FrozenCard>,
  sessionId = 'pin-session',
  rootMessageId = 'om_root',
): DaemonSession {
  return { session: { sessionId, rootMessageId, chatId: 'oc_chat', title: 'pin', status: 'active', createdAt: Date.now(), updatedAt: Date.now(), pid: null, chatType: 'group' }, worker: null, workerPort: null, workerToken: null, larkAppId: 'app-pin', chatId: 'oc_chat', chatType: 'group', spawnedAt: Date.now(), cliVersion: 'test', lastMessageAt: Date.now(), hasHistory: true, scope: 'thread', streamCardId: card, frozenCards } as any;
}
function activate(ds: DaemonSession) { setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]])); }

describe('streaming-card pin policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testOnly_resetPinStreamingCardReconcileQueue();
    setActiveSessionsRegistry(new Map());
    pinMessageMock.mockResolvedValue(true);
    unpinMessageMock.mockResolvedValue(true);
    getBotMock.mockReturnValue({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: true } } as any);
  });
  it('does nothing when disabled, sentinel, inactive, displaced, or changed', async () => {
    const ds = makeDs(); activate(ds);
    getBotMock.mockReturnValue({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: false } } as any);
    expect(await pinStreamingCardIfEnabled(ds, 'om_current')).toBe(false);
    getBotMock.mockReturnValue({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: true } } as any);
    ds.streamCardId = CARD_POSTING_SENTINEL; expect(await pinStreamingCardIfEnabled(ds, CARD_POSTING_SENTINEL)).toBe(false);
    ds.streamCardId = 'om_current'; ds.session.status = 'closed'; expect(await pinStreamingCardIfEnabled(ds, 'om_current')).toBe(false);
    ds.session.status = 'active'; setActiveSessionsRegistry(new Map()); expect(await pinStreamingCardIfEnabled(ds, 'om_current')).toBe(false);
    expect(pinMessageMock).not.toHaveBeenCalled();
  });

  it('fails closed when the active session registry is unavailable', async () => {
    const ds = makeDs();
    setActiveSessionsRegistry(undefined as any);

    await expect(pinStreamingCardIfEnabled(ds, 'om_current')).resolves.toBe(false);

    expect(pinMessageMock).not.toHaveBeenCalled();
    expect(unpinMessageMock).not.toHaveBeenCalled();
  });
  it('pins only the active owned current card and compensates a stale success', async () => {
    const ds = makeDs(); activate(ds);
    let resolvePin!: (value: boolean) => void; pinMessageMock.mockImplementation(() => new Promise(resolve => { resolvePin = resolve; }));
    const pending = pinStreamingCardIfEnabled(ds, 'om_current');
    await drainMicrotasks(1);
    ds.streamCardId = 'om_new'; resolvePin(true);
    expect(await pending).toBe(false);
    expect(pinMessageMock).toHaveBeenCalledWith('app-pin', 'om_current');
    expect(unpinMessageMock).toHaveBeenCalledWith('app-pin', 'om_current');
  });
  it('reconciles enabled in pin-then-session-wide-frozen-unpin order and disable unpins every unique real id', async () => {
    const frozen = new Map<string, FrozenCard>([['a', { messageId: 'om_same_topic', content: '', title: '', displayMode: 'hidden', replyTargetKey: 'one' }], ['b', { messageId: 'om_other_topic', content: '', title: '', displayMode: 'hidden', replyTargetKey: 'two' }], ['c', { messageId: 'om_current', content: '', title: '', displayMode: 'hidden' }]]);
    const ds = makeDs('om_current', frozen); activate(ds);
    await reconcileStreamingCardPins(ds, true);
    expect(pinMessageMock).toHaveBeenCalledWith('app-pin', 'om_current');
    expect(unpinMessageMock.mock.calls.map(c => c[1])).toEqual(['om_same_topic', 'om_other_topic']);
    pinMessageMock.mockClear(); unpinMessageMock.mockClear();
    await reconcileStreamingCardPins(ds, false);
    expect(pinMessageMock).not.toHaveBeenCalled();
    expect(new Set(unpinMessageMock.mock.calls.map(c => c[1]))).toEqual(new Set(['om_current']));
  });

  it('default-off with no feature-owned ids is zero-call and leaves manual pins untouched', async () => {
    const ds = makeDs(
      'om_current',
      new Map<string, FrozenCard>([['frozen', { messageId: 'om_frozen', content: '', title: '', displayMode: 'hidden' }]]),
    );
    activate(ds);

    await reconcileStreamingCardPins(ds, false);

    expect(pinMessageMock).not.toHaveBeenCalled();
    expect(unpinMessageMock).not.toHaveBeenCalled();
  });

  it('reconciles all active sessions for the matching bot, ignores other bots, and isolates one session failure', async () => {
    const first = makeDs('om_first', undefined, 'pin-session-1', 'om_root_1');
    const second = makeDs('om_second', undefined, 'pin-session-2', 'om_root_2');
    const otherBot = { ...makeDs('om_other', undefined, 'pin-session-3', 'om_root_3'), larkAppId: 'app-other' } as DaemonSession;
    const inactive = { ...makeDs('om_inactive', undefined, 'pin-session-4', 'om_root_4'), session: { ...makeDs('om_inactive', undefined, 'pin-session-4', 'om_root_4').session, status: 'closed' } } as DaemonSession;
    const displaced = makeDs('om_displaced', undefined, 'pin-session-5', 'om_root_shared');
    const winner = makeDs('om_winner', undefined, 'pin-session-6', 'om_root_shared');
    setActiveSessionsRegistry(new Map([
      [activeSessionKey(first), first],
      [activeSessionKey(second), second],
      [activeSessionKey(otherBot), otherBot],
      [activeSessionKey(inactive), inactive],
      [activeSessionKey(displaced), displaced],
      [activeSessionKey(winner), winner],
    ]));

    pinMessageMock.mockImplementation(async (_appId: string, messageId: string) => {
      if (messageId === 'om_first') throw new Error('pin failed');
      return true;
    });

    reconcileBotStreamingCardPins('app-pin', true);
    await Promise.resolve();
    await Promise.resolve();

    expect(pinMessageMock.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['app-pin', 'om_first'],
      ['app-pin', 'om_second'],
      ['app-pin', 'om_winner'],
    ]);
    expect(pinMessageMock).not.toHaveBeenCalledWith('app-pin', 'om_inactive');
    expect(pinMessageMock).not.toHaveBeenCalledWith('app-pin', 'om_displaced');
    expect(unpinMessageMock).not.toHaveBeenCalledWith('app-other', 'om_other');
  });

  it('serializes bot-wide disable then enable and reruns the latest desired state after deferred unpin completes', async () => {
    const first = makeDs(
      'om_current',
      new Map<string, FrozenCard>([['frozen', { messageId: 'om_frozen', content: '', title: '', displayMode: 'hidden' }]]),
      'pin-session-1',
      'om_root_1',
    );
    const second = makeDs('om_second', undefined, 'pin-session-2', 'om_root_2');
    activate(first);
    await reconcileStreamingCardPins(first, true);
    pinMessageMock.mockClear();
    unpinMessageMock.mockClear();
    let resolveCurrentUnpin!: (value: boolean) => void;
    unpinMessageMock.mockImplementation((appId: string, messageId: string) => {
      if (appId === 'app-pin' && messageId === 'om_current') {
        return new Promise<boolean>(resolve => { resolveCurrentUnpin = resolve; });
      }
      return Promise.resolve(true);
    });

    setActiveSessionsRegistry(new Map([[activeSessionKey(first), first]]));
    reconcileBotStreamingCardPins('app-pin', false);
    await drainMicrotasks();

    expect(unpinMessageMock).toHaveBeenCalledWith('app-pin', 'om_current');
    expect(pinMessageMock).not.toHaveBeenCalled();

    setActiveSessionsRegistry(new Map([
      [activeSessionKey(first), first],
      [activeSessionKey(second), second],
    ]));
    reconcileBotStreamingCardPins('app-pin', true);
    await drainMicrotasks(1);

    expect(pinMessageMock).not.toHaveBeenCalled();

    resolveCurrentUnpin(true);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(pinMessageMock.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['app-pin', 'om_current'],
      ['app-pin', 'om_second'],
    ]);
  });

  it('serializes bot-wide enable then disable and ends at the latest off state after deferred pin completes', async () => {
    const ds = makeDs(
      'om_current',
      new Map<string, FrozenCard>([['frozen', { messageId: 'om_frozen', content: '', title: '', displayMode: 'hidden' }]]),
    );
    activate(ds);
    let resolvePin!: (value: boolean) => void;
    pinMessageMock.mockImplementation((appId: string, messageId: string) => {
      if (appId === 'app-pin' && messageId === 'om_current') {
        return new Promise<boolean>(resolve => { resolvePin = resolve; });
      }
      return Promise.resolve(true);
    });

    getBotMock.mockReturnValue({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: true } } as any);
    reconcileBotStreamingCardPins('app-pin', true);
    await drainMicrotasks();

    expect(pinMessageMock).toHaveBeenCalledWith('app-pin', 'om_current');
    expect(unpinMessageMock).not.toHaveBeenCalled();

    getBotMock.mockReturnValue({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: false } } as any);
    reconcileBotStreamingCardPins('app-pin', false);
    await drainMicrotasks(1);

    expect(unpinMessageMock).not.toHaveBeenCalled();

    resolvePin(true);
    await __testOnly_waitForPinStreamingCardIdle();

    expect(pinMessageMock).toHaveBeenCalledTimes(1);
    expect(unpinMessageMock.mock.calls.map(c => [c[0], c[1]])).toEqual([
      ['app-pin', 'om_current'],
    ]);
  });
});
