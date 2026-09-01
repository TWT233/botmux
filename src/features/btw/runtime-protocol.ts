import type { BtwCapabilities } from '../../adapters/cli/btw.js';
import type { CodexRpcTurnIdentity, CodexRpcTurnTerminal } from '../../codex-rpc-engine.js';
import type { SessionMcpRuntimeManifest } from '../../core/plugins/mcp/session-runtime.js';
import type { CotEntry } from '../../types.js';
import type {
  BtwInitialCardAttemptOutcome,
  BtwOperation,
  BtwOperationScope,
  BtwProjectionFailure,
  BtwProjectionItem,
  BtwProjectionProviderOutcome,
  BtwQuiesceResult,
  PrepareBtwInput,
  PrepareBtwResult,
} from './types.js';

export const BTW_RUNTIME_PROTOCOL_VERSION = 1 as const;

export interface BtwRuntimeDescriptor {
  pid: number;
  startIdentity: string;
  socket: string;
  protocolVersion: typeof BTW_RUNTIME_PROTOCOL_VERSION;
  buildId: string;
  epoch: string;
}

export interface BtwRuntimeAttachment {
  runtime: BtwRuntimeDescriptor;
  appServerUrl: string;
  nativeThreadId: string;
  configHash: string;
  notificationCursor: number;
}

export type BtwMainEvent =
  | { type: 'delta'; text: string }
  | { type: 'cot'; entries: CotEntry[] };

export interface FrozenBtwSessionProfile {
  sessionId: string;
  larkAppId: string;
  cliId: 'traex';
  cliBin: string;
  cwd: string;
  env: Record<string, string>;
  ownerOpenId?: string;
  model?: string;
  reasoningEffort?: string;
  appServerFeatures: string[];
  nativeThreadId?: string;
  configHash: string;
  mcpManifest: SessionMcpRuntimeManifest | null;
  mcpManifestDigest: string;
}

export type BtwFirstTurnResult =
  | { outcome: 'accepted'; nativeTurnId?: string }
  | { outcome: 'not-sent' }
  | { outcome: 'ambiguous' };

export type BtwRuntimeCommand =
  | { type: 'ensure_session'; profile: FrozenBtwSessionProfile }
  | { type: 'attach_session'; sessionId: string; cursor: number }
  | { type: 'watch_projection_wakes'; larkAppId: string }
  | { type: 'detach_session'; sessionId: string }
  | { type: 'quiesce_session'; sessionId: string }
  | { type: 'close_session'; sessionId: string }
  | { type: 'submit_first_turn'; sessionId: string; content: string; identity: CodexRpcTurnIdentity }
  | { type: 'submit_main_turn'; sessionId: string; content: string; identity: CodexRpcTurnIdentity }
  | { type: 'prepare_btw'; input: PrepareBtwInput }
  | { type: 'record_initial_card_attempt'; scope: BtwOperationScope; btwOpId: string; outcome: BtwInitialCardAttemptOutcome }
  | { type: 'record_card'; scope: BtwOperationScope; btwOpId: string; messageId: string }
  | { type: 'submit_btw'; scope: BtwOperationScope; btwOpId: string }
  | { type: 'list_pending_projections'; larkAppId: string }
  | { type: 'list_pending_initial_cards'; larkAppId: string }
  | { type: 'record_projection_failure'; scope: BtwOperationScope; btwOpId: string; expected: { operationRevision: number; projectionRevision: number }; failure: BtwProjectionFailure }
  | { type: 'ack_projection'; scope: BtwOperationScope; btwOpId: string; expected: { operationRevision: number; projectionRevision: number }; outcome: BtwProjectionProviderOutcome }
  | { type: 'read_thread_metadata'; sessionId: string; timeoutMs?: number }
  | { type: 'set_thread_name'; sessionId: string; name: string }
  | { type: 'ack_events'; sessionId: string; seq: number }
  | { type: 'answer_user_input'; sessionId: string; requestId: string; result: unknown }
  | { type: 'quiesce_all' }
  | { type: 'quiesce_app'; larkAppId: string }
  | { type: 'close_app'; larkAppId: string }
  | { type: 'shutdown_runtime' };

export interface BtwRuntimeEnvelope {
  requestId: string;
  protocolVersion: typeof BTW_RUNTIME_PROTOCOL_VERSION;
  runtimeEpoch: string;
  command: BtwRuntimeCommand;
}

export interface BtwRuntimeResultMap {
  ensure_session: { attachment: BtwRuntimeAttachment; capabilities: BtwCapabilities; configDrift: boolean };
  attach_session: { attachment: BtwRuntimeAttachment };
  watch_projection_wakes: { subscribed: true };
  detach_session: { done: true };
  quiesce_session: BtwQuiesceResult;
  close_session: { done: true };
  submit_first_turn: BtwFirstTurnResult;
  submit_main_turn: { nativeTurnId: string };
  prepare_btw: PrepareBtwResult;
  record_initial_card_attempt: BtwOperation;
  record_card: BtwOperation;
  submit_btw: BtwOperation;
  list_pending_initial_cards: BtwOperation[];
  list_pending_projections: BtwProjectionItem[];
  record_projection_failure: { kind: 'applied' | 'stale'; operation: BtwOperation };
  ack_projection: { kind: 'applied' | 'stale'; operation: BtwOperation };
  read_thread_metadata: { name?: string; preview?: string; updatedAt?: number };
  set_thread_name: { done: true };
  ack_events: { done: true };
  answer_user_input: { done: true };
  quiesce_all: BtwQuiesceResult;
  quiesce_app: BtwQuiesceResult;
  close_app: { done: true };
  shutdown_runtime: { done: true };
}

export type BtwRuntimeSuccessReply = {
  [K in keyof BtwRuntimeResultMap]: {
    kind: 'reply';
    ok: true;
    requestId: string;
    commandType: K;
    result: BtwRuntimeResultMap[K];
  }
}[keyof BtwRuntimeResultMap];

export type BtwRuntimeFrame =
  | BtwRuntimeSuccessReply
  | { kind: 'reply'; ok: false; requestId: string; commandType: BtwRuntimeCommand['type']; error: { code: string; message: string } }
  | { kind: 'session_notification'; notification: BtwRuntimeNotification }
  | { kind: 'projection_wake'; larkAppId: string; wake: BtwProjectionWake };

type SequencedBtwRuntimeNotification<TKind extends string, TPayload> = {
  sessionId: string;
  fromSeq: number;
  throughSeq: number;
  kind: TKind;
  payload: TPayload;
};

export type BtwRuntimeNotification =
  | SequencedBtwRuntimeNotification<'main_event', BtwMainEvent>
  | SequencedBtwRuntimeNotification<'main_terminal', CodexRpcTurnTerminal>
  | SequencedBtwRuntimeNotification<'request_user_input', { requestId: string; params: unknown }>
  | SequencedBtwRuntimeNotification<'app_server_dead', { errorCode: string; message: string }>;

export interface BtwProjectionWake {
  kind: 'btw_projection_wake';
}

export interface AttachedBtwRuntimeSession {
  attachment: BtwRuntimeAttachment;
  notifications: AsyncIterable<BtwRuntimeNotification>;
  detach(): Promise<void>;
}

export interface BtwRuntimeClient {
  ensureSession(profile: FrozenBtwSessionProfile): Promise<{ attachment: BtwRuntimeAttachment; capabilities: BtwCapabilities; configDrift: boolean }>;
  attachSession(input: { sessionId: string; cursor: number }): Promise<AttachedBtwRuntimeSession>;
  detachSession(sessionId: string): Promise<void>;
  quiesceSession(sessionId: string): Promise<BtwQuiesceResult>;
  closeSession(sessionId: string): Promise<void>;
  submitFirstTurn(sessionId: string, content: string, identity: CodexRpcTurnIdentity): Promise<BtwFirstTurnResult>;
  submitMainTurn(sessionId: string, content: string, identity: CodexRpcTurnIdentity): Promise<{ nativeTurnId: string }>;
  prepareBtw(input: PrepareBtwInput): Promise<PrepareBtwResult>;
  recordInitialCardAttempt(scope: BtwOperationScope, btwOpId: string, outcome: BtwInitialCardAttemptOutcome): Promise<BtwOperation>;
  recordCard(scope: BtwOperationScope, btwOpId: string, messageId: string): Promise<BtwOperation>;
  submitBtw(scope: BtwOperationScope, btwOpId: string): Promise<BtwOperation>;
  listPendingInitialCards(larkAppId: string): Promise<BtwOperation[]>;
  listPendingProjections(larkAppId: string): Promise<BtwProjectionItem[]>;
  recordProjectionFailure(scope: BtwOperationScope, btwOpId: string, expected: { operationRevision: number; projectionRevision: number }, failure: BtwProjectionFailure): Promise<{ kind: 'applied' | 'stale'; operation: BtwOperation }>;
  ackProjection(scope: BtwOperationScope, btwOpId: string, expected: { operationRevision: number; projectionRevision: number }, outcome: BtwProjectionProviderOutcome): Promise<{ kind: 'applied' | 'stale'; operation: BtwOperation }>;
  readThreadMetadata(sessionId: string, timeoutMs?: number): Promise<{ name?: string; preview?: string; updatedAt?: number }>;
  setThreadName(sessionId: string, name: string): Promise<void>;
  ackEvents(sessionId: string, seq: number): Promise<void>;
  answerUserInput(sessionId: string, requestId: string, result: unknown): Promise<void>;
  quiesceAll(): Promise<BtwQuiesceResult>;
  quiesceApp(larkAppId: string): Promise<BtwQuiesceResult>;
  closeApp(larkAppId: string): Promise<void>;
  shutdownRuntime(): Promise<void>;
  watchProjectionWakes(larkAppId: string): AsyncIterable<BtwProjectionWake>;
}
