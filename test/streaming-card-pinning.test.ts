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
  CARD_POSTING_SENTINEL, pinStreamingCardIfEnabled, reconcileStreamingCardPins, setActiveSessionsRegistry,
} from '../src/core/worker-pool.js';
import { getBot } from '../src/bot-registry.js';

function makeDs(card = 'om_current', frozenCards?: Map<string, FrozenCard>): DaemonSession {
  return { session: { sessionId: 'pin-session', rootMessageId: 'om_root', chatId: 'oc_chat', title: 'pin', status: 'active', createdAt: Date.now(), updatedAt: Date.now(), pid: null, chatType: 'group' }, worker: null, workerPort: null, workerToken: null, larkAppId: 'app-pin', chatId: 'oc_chat', chatType: 'group', spawnedAt: Date.now(), cliVersion: 'test', lastMessageAt: Date.now(), hasHistory: true, streamCardId: card, frozenCards } as any;
}
function activate(ds: DaemonSession) { setActiveSessionsRegistry(new Map([[activeSessionKey(ds), ds]])); }

describe('streaming-card pin policy', () => {
  beforeEach(() => { vi.clearAllMocks(); pinMessageMock.mockResolvedValue(true); unpinMessageMock.mockResolvedValue(true); vi.mocked(getBot).mockReturnValue({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: true } } as any); });
  it('does nothing when disabled, sentinel, inactive, displaced, or changed', async () => {
    const ds = makeDs(); activate(ds);
    vi.mocked(getBot).mockReturnValue({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: false } } as any);
    expect(await pinStreamingCardIfEnabled(ds, 'om_current')).toBe(false);
    vi.mocked(getBot).mockReturnValue({ config: { larkAppId: 'app-pin', cliId: 'claude-code', pinStreamingCard: true } } as any);
    ds.streamCardId = CARD_POSTING_SENTINEL; expect(await pinStreamingCardIfEnabled(ds, CARD_POSTING_SENTINEL)).toBe(false);
    ds.streamCardId = 'om_current'; ds.session.status = 'closed'; expect(await pinStreamingCardIfEnabled(ds, 'om_current')).toBe(false);
    ds.session.status = 'active'; setActiveSessionsRegistry(new Map()); expect(await pinStreamingCardIfEnabled(ds, 'om_current')).toBe(false);
    expect(pinMessageMock).not.toHaveBeenCalled();
  });
  it('pins only the active owned current card and compensates a stale success', async () => {
    const ds = makeDs(); activate(ds);
    let resolvePin!: (value: boolean) => void; pinMessageMock.mockImplementation(() => new Promise(resolve => { resolvePin = resolve; }));
    const pending = pinStreamingCardIfEnabled(ds, 'om_current');
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
    expect(new Set(unpinMessageMock.mock.calls.map(c => c[1]))).toEqual(new Set(['om_current', 'om_same_topic', 'om_other_topic']));
  });
});
