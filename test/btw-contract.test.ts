import { describe, expect, it } from 'vitest';

import { supportsManagedBtw, type BtwAdapter } from '../src/adapters/cli/btw.js';
import {
  MAX_INITIAL_CARD_CREATE_ATTEMPTS,
  deriveBtwIdentifiers,
  type BtwSessionAttachmentState,
} from '../src/features/btw/types.js';
import {
  BTW_RUNTIME_PROTOCOL_VERSION,
  type BtwRuntimeCommand,
  type BtwRuntimeNotification,
} from '../src/features/btw/runtime-protocol.js';
import type { BtwCursorCommitAck, BtwCursorCommitRequest, DaemonToWorker, Session, WorkerToDaemon } from '../src/types.js';
import {
  ALL_BTW_CAPABILITY_COMBINATIONS,
  makeBtwOperation,
  makeBtwScope,
} from './fixtures/btw-fixtures.js';

describe('managed BTW contracts', () => {
  it.each(ALL_BTW_CAPABILITY_COMBINATIONS)(
    'manages only the all-true capability row %#',
    ({ capabilities, managed }) => {
      expect(supportsManagedBtw(capabilities)).toBe(managed);
    },
  );

  it('derives stable, domain-separated identifiers from app + session + request', () => {
    const scope = makeBtwScope();
    const first = deriveBtwIdentifiers(scope, 'om_request_1');
    expect(deriveBtwIdentifiers(scope, 'om_request_1')).toEqual(first);
    expect(new Set(Object.values(first)).size).toBe(5);
    expect(deriveBtwIdentifiers({ ...scope, larkAppId: 'cli_other' }, 'om_request_1'))
      .not.toEqual(first);
    expect(deriveBtwIdentifiers({ ...scope, botmuxSessionId: 'other' }, 'om_request_1'))
      .not.toEqual(first);
    expect(Object.values(first).every(value => /^[a-z][a-z0-9-]*_[0-9a-f]+$/.test(value))).toBe(true);
    expect(first.createUuid.length).toBeLessThanOrEqual(50);
    expect(first.replacementUuid.length).toBeLessThanOrEqual(50);
    expect(first.reminderUuid.length).toBeLessThanOrEqual(50);
    expect(first).toEqual({
      btwOpId: 'btwop_958dc0b8475a1e7a7077799ec1703bb396e6ba94ad48',
      nativeTurnId: 'btwturn_c0dc510bc1e9c15eb550aabb9e1e6051fe4432e5fe',
      createUuid: 'btwcard_398a21478f4e7c7a257df3481e5f74d2f263838333',
      replacementUuid: 'btwreplace_f3bbcfe89f07610d327447ab1e5f58d18709f3c',
      reminderUuid: 'btwremind_6df7c85d8d6faefb4455259b800ee33b4124a241',
    });
  });

  it('freezes deterministic operation defaults and the initial-card ceiling', () => {
    expect(MAX_INITIAL_CARD_CREATE_ATTEMPTS).toBe(8);
    expect(makeBtwOperation()).toEqual({
      schemaVersion: 1,
      revision: 1,
      btwOpId: 'btwop_958dc0b8475a1e7a7077799ec1703bb396e6ba94ad48',
      requestId: 'om_request_1',
      question: 'What changed in the upstream delivery path?',
      parent: {
        botmuxSessionId: 'btw_session_1',
        cliId: 'traex',
        nativeThreadId: 'thread_parent_1',
        runtimeEpoch: 'runtime_epoch_1',
        configHash: `sha256:${'a'.repeat(64)}`,
        cwd: '/repo/botmux',
      },
      replyTarget: {
        larkAppId: 'cli_app',
        chatId: 'oc_chat_1',
        rootMessageId: 'om_root_1',
        replyToMessageId: 'om_reply_1',
        chatType: 'group',
        brand: 'feishu',
      },
      card: {
        createUuid: 'btwcard_398a21478f4e7c7a257df3481e5f74d2f263838333',
        createAttempt: 0,
        replacementUuid: 'btwreplace_f3bbcfe89f07610d327447ab1e5f58d18709f3c',
        replacementState: 'none',
      },
      execution: {
        state: 'card_pending',
        nativeTurnId: 'btwturn_c0dc510bc1e9c15eb550aabb9e1e6051fe4432e5fe',
        attempt: 0,
        frameState: 'not_started',
      },
      projection: {
        desiredRevision: 1,
        patchedRevision: 0,
        retryAttempt: 0,
        reminderUuid: 'btwremind_6df7c85d8d6faefb4455259b800ee33b4124a241',
        reminderState: 'none',
        reminderAttempt: 0,
      },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('keeps runtime commands and notifications as closed discriminated unions', () => {
    const commands = [
      { type: 'ensure_session', profile: {} as never },
      { type: 'attach_session', sessionId: 'session', cursor: 0 },
      { type: 'watch_projection_wakes', larkAppId: 'app' },
      { type: 'detach_session', sessionId: 'session' },
      { type: 'quiesce_session', sessionId: 'session' },
      { type: 'close_session', sessionId: 'session' },
      { type: 'submit_first_turn', sessionId: 'session', content: 'one', identity: {} as never },
      { type: 'submit_main_turn', sessionId: 'session', content: 'two', identity: {} as never },
      { type: 'prepare_btw', input: {} as never },
      { type: 'record_initial_card_attempt', scope: makeBtwScope(), btwOpId: 'op', outcome: {} as never },
      { type: 'record_card', scope: makeBtwScope(), btwOpId: 'op', messageId: 'message' },
      { type: 'submit_btw', scope: makeBtwScope(), btwOpId: 'op' },
      { type: 'list_pending_projections', larkAppId: 'app' },
      { type: 'list_pending_initial_cards', larkAppId: 'app' },
      { type: 'record_projection_failure', scope: makeBtwScope(), btwOpId: 'op', expected: { operationRevision: 1, projectionRevision: 1 }, failure: {} as never },
      { type: 'ack_projection', scope: makeBtwScope(), btwOpId: 'op', expected: { operationRevision: 1, projectionRevision: 1 }, outcome: { kind: 'patched' } },
      { type: 'read_thread_metadata', sessionId: 'session' },
      { type: 'set_thread_name', sessionId: 'session', name: 'name' },
      { type: 'ack_events', sessionId: 'session', seq: 4 },
      { type: 'answer_user_input', sessionId: 'session', requestId: 'request', result: null },
      { type: 'quiesce_all' },
      { type: 'quiesce_app', larkAppId: 'app' },
      { type: 'close_app', larkAppId: 'app' },
      { type: 'shutdown_runtime' },
    ] satisfies BtwRuntimeCommand[];
    const notifications = [
      { sessionId: 'session', fromSeq: 2, throughSeq: 4, kind: 'main_event', payload: { type: 'delta', text: 'answer' } },
      { sessionId: 'session', fromSeq: 5, throughSeq: 5, kind: 'main_terminal', payload: {} as never },
      { sessionId: 'session', fromSeq: 6, throughSeq: 6, kind: 'request_user_input', payload: { requestId: 'request', params: null } },
      { sessionId: 'session', fromSeq: 7, throughSeq: 7, kind: 'app_server_dead', payload: { errorCode: 'dead', message: 'stopped' } },
    ] satisfies BtwRuntimeNotification[];
    expect(BTW_RUNTIME_PROTOCOL_VERSION).toBe(1);
    expect(commands.map(command => command.type)).toEqual([
      'ensure_session', 'attach_session', 'watch_projection_wakes', 'detach_session',
      'quiesce_session', 'close_session', 'submit_first_turn', 'submit_main_turn',
      'prepare_btw', 'record_initial_card_attempt', 'record_card', 'submit_btw',
      'list_pending_projections', 'list_pending_initial_cards', 'record_projection_failure',
      'ack_projection', 'read_thread_metadata', 'set_thread_name', 'ack_events',
      'answer_user_input', 'quiesce_all', 'quiesce_app', 'close_app', 'shutdown_runtime',
    ]);
    expect(notifications.map(notification => notification.kind)).toEqual([
      'main_event', 'main_terminal', 'request_user_input', 'app_server_dead',
    ]);
    expect(notifications[0]).toMatchObject({ fromSeq: 2, throughSeq: 4 });
  });

  it('carries durable attachment and exact cursor IPC discriminants', () => {
    const attachment: BtwSessionAttachmentState = {
      socket: '/tmp/btw.sock',
      epoch: 'epoch-1',
      protocolVersion: 1,
      buildId: 'build-1',
      configHash: 'sha256:abc',
      notificationCursor: 9,
    };
    const session = { btwRuntime: attachment } satisfies Pick<Session, 'btwRuntime'>;
    const init = {
      type: 'init', sessionId: 'session', chatId: 'chat', rootMessageId: 'root',
      workingDir: '/repo', cliId: 'traex', backendType: 'pty', prompt: '',
      larkAppId: 'app', larkAppSecret: 'secret', btwRuntime: attachment, workerGeneration: 3,
    } satisfies DaemonToWorker;
    const request: BtwCursorCommitRequest = {
      type: 'btw_notification_cursor_commit', requestId: 'request', sessionId: 'session',
      workerGeneration: 3, runtimeEpoch: 'epoch-1', fromSeq: 7, throughSeq: 9,
    };
    const ack: BtwCursorCommitAck = {
      type: 'btw_notification_cursor_persisted', requestId: 'request', sessionId: 'session',
      workerGeneration: 3, runtimeEpoch: 'epoch-1', fromSeq: 7, throughSeq: 9,
      ok: true, persistedSeq: 9,
    };
    const workerMessage: WorkerToDaemon = request;
    const daemonMessage: DaemonToWorker = ack;
    expect(session.btwRuntime).toEqual(attachment);
    expect(init.workerGeneration).toBe(3);
    expect(request.type).toBe('btw_notification_cursor_commit');
    expect(ack.type).toBe('btw_notification_cursor_persisted');
    expect(workerMessage.type).toBe('btw_notification_cursor_commit');
    expect(daemonMessage.type).toBe('btw_notification_cursor_persisted');
  });

  it('allows independent adapter calls to complete out of order without transport fields', async () => {
    const resolvers = new Map<string, (answer: string) => void>();
    const adapter: BtwAdapter = {
      run: ({ requestId }) => new Promise(resolve => {
        resolvers.set(requestId, answer => resolve({ status: 'completed', answer }));
      }),
    };
    const first = adapter.run({ requestId: 'first', question: 'one?' });
    const second = adapter.run({ requestId: 'second', question: 'two?' });
    resolvers.get('second')?.('answer two');
    resolvers.get('first')?.('answer one');
    const outcomes = await Promise.all([first, second]);
    expect(outcomes).toEqual([
      { status: 'completed', answer: 'answer one' },
      { status: 'completed', answer: 'answer two' },
    ]);
    expect(Object.keys(outcomes[0]!)).toEqual(['status', 'answer']);
  });
});
