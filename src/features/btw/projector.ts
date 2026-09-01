import type { Locale } from '../../i18n/index.js';
import { localeForBot, t } from '../../i18n/index.js';
import {
  MessageWithdrawnError,
  replyMessage as defaultReplyMessage,
  sendMessage as defaultSendMessage,
  updateMessage as defaultUpdateMessage,
} from '../../im/lark/client.js';
import { buildBtwCard } from './card.js';
import type { BtwRuntimeClient } from './runtime-protocol.js';
import type {
  BtwInitialCardAttemptOutcome,
  BtwOperation,
  BtwOperationScope,
  BtwProjectionItem,
  BtwProjectionProviderOutcome,
} from './types.js';

const MAX_CARD_JSON_BYTES = 100_000;
const MAX_DIAGNOSTIC_CHARS = 500;
const MAX_RETRY_DELAY_MS = 60_000;

type InitialCardResult =
  | { kind: 'recorded'; operation: BtwOperation }
  | { kind: 'pending' | 'unknown'; operation: BtwOperation };

type ProjectorRuntime = Pick<
  BtwRuntimeClient,
  'recordInitialCardAttempt' | 'recordCard' | 'listPendingProjections'
  | 'recordProjectionFailure' | 'ackProjection'
>;

type SendMessage = typeof defaultSendMessage;
type ReplyMessage = typeof defaultReplyMessage;
type UpdateMessage = typeof defaultUpdateMessage;

export interface BtwProjector {
  ensureInitialCard(operation: BtwOperation): Promise<InitialCardResult>;
  drainApp(larkAppId: string): Promise<void>;
}

export interface BtwProjectorOptions {
  runtime: ProjectorRuntime;
  sendMessage?: SendMessage;
  replyMessage?: ReplyMessage;
  updateMessage?: UpdateMessage;
  localeForApp?: (larkAppId: string) => Locale;
  now?: () => Date;
}

interface ClassifiedError {
  kind: 'retryable' | 'permanent';
  responseKnown: boolean;
  errorCode: string;
  message: string;
}

function operationScope(operation: BtwOperation): BtwOperationScope {
  return {
    larkAppId: operation.replyTarget.larkAppId,
    botmuxSessionId: operation.parent.botmuxSessionId,
  };
}

function operationKey(operation: BtwOperation): string {
  const scope = operationScope(operation);
  return `${scope.larkAppId}\0${scope.botmuxSessionId}\0${operation.btwOpId}`;
}

function boundedMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? 'unknown provider error');
  return message.length <= MAX_DIAGNOSTIC_CHARS
    ? message
    : `${message.slice(0, MAX_DIAGNOSTIC_CHARS - 1)}…`;
}

function classifyProviderError(error: unknown): ClassifiedError {
  const value = error as {
    isAxiosError?: boolean;
    name?: string;
    message?: string;
    response?: { status?: number; data?: { code?: number; msg?: string } };
    status?: number;
    code?: string | number;
    config?: unknown;
  } | null | undefined;
  const status = value?.response?.status ?? value?.status;
  const detail = boundedMessage(value?.response?.data?.msg ?? value?.message ?? error);
  const looksTransport = value?.isAxiosError === true
    || value?.name === 'AxiosError'
    || value?.config !== undefined
    || typeof value?.code === 'string';

  if (status === 429 || (status !== undefined && status >= 500 && status <= 599)) {
    return { kind: 'retryable', responseKnown: true, errorCode: `http_${status}`, message: detail };
  }
  if (looksTransport && status === undefined) {
    return { kind: 'retryable', responseKnown: false, errorCode: 'transport_unknown', message: detail };
  }
  return { kind: 'permanent', responseKnown: status !== undefined, errorCode: 'provider_rejected', message: detail };
}

function retryAt(now: Date, attempt: number): string {
  const delay = Math.min(MAX_RETRY_DELAY_MS, 1_000 * (2 ** Math.min(Math.max(attempt, 0), 10)));
  return new Date(now.getTime() + delay).toISOString();
}

function isCardOversized(cardJson: string): boolean {
  return Buffer.byteLength(cardJson, 'utf8') > MAX_CARD_JSON_BYTES;
}

export function createBtwProjector(options: BtwProjectorOptions): BtwProjector {
  const send = options.sendMessage ?? defaultSendMessage;
  const reply = options.replyMessage ?? defaultReplyMessage;
  const update = options.updateMessage ?? defaultUpdateMessage;
  const resolveLocale = options.localeForApp ?? localeForBot;
  const now = options.now ?? (() => new Date());
  const inFlight = new Map<string, Promise<unknown>>();

  function singleFlight<T>(operation: BtwOperation, action: () => Promise<T>): Promise<T> {
    const key = operationKey(operation);
    const existing = inFlight.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const current = action().finally(() => {
      if (inFlight.get(key) === current) inFlight.delete(key);
    });
    inFlight.set(key, current);
    return current;
  }

  async function createAtFrozenTarget(operation: BtwOperation, cardJson: string, uuid: string): Promise<string> {
    const target = operation.replyTarget;
    if (target.replyToMessageId) {
      return reply(
        target.larkAppId, target.replyToMessageId, cardJson, 'interactive',
        target.rootMessageId !== null, uuid,
      );
    }
    return send(target.larkAppId, target.chatId, cardJson, 'interactive', uuid);
  }

  async function sendReminder(operation: BtwOperation, expected: { operationRevision: number; projectionRevision: number }): Promise<void> {
    const content = t('btw.reminder.completed', undefined, resolveLocale(operation.replyTarget.larkAppId));
    try {
      const target = operation.replyTarget;
      if (target.replyToMessageId) {
        await reply(
          target.larkAppId, target.replyToMessageId, content, 'text',
          target.rootMessageId !== null, operation.projection.reminderUuid,
        );
      } else {
        await send(target.larkAppId, target.chatId, content, 'text', operation.projection.reminderUuid);
      }
      await options.runtime.ackProjection(
        operationScope(operation), operation.btwOpId, expected, { kind: 'reminder_sent' },
      );
    } catch (error) {
      const classified = classifyProviderError(error);
      const outcome: BtwProjectionProviderOutcome = classified.responseKnown
        ? { kind: 'reminder_definitely_unsent', retryAt: retryAt(now(), operation.projection.reminderAttempt) }
        : { kind: 'reminder_unknown' };
      await options.runtime.ackProjection(operationScope(operation), operation.btwOpId, expected, outcome);
    }
  }

  async function handleProjection(item: BtwProjectionItem): Promise<void> {
    const operation = item.operation;
    const scope = operationScope(operation);
    const expected = {
      operationRevision: item.expectedOperationRevision,
      projectionRevision: item.projectionRevision,
    };

    if (
      operation.projection.patchedRevision === item.projectionRevision
      && operation.projection.reminderState === 'pending'
    ) {
      await sendReminder(operation, expected);
      return;
    }

    const locale = resolveLocale(operation.replyTarget.larkAppId);
    const cardJson = buildBtwCard(operation, locale);
    if (isCardOversized(cardJson)) {
      await options.runtime.recordProjectionFailure(scope, operation.btwOpId, expected, {
        kind: 'visible_fallback',
        errorCode: 'payload_too_large',
        message: t('btw.card.payload_too_large', undefined, locale),
      });
      return;
    }

    if (
      operation.card.replacementState === 'pending'
      && operation.card.replacementForRevision === item.projectionRevision
    ) {
      try {
        const messageId = await createAtFrozenTarget(operation, cardJson, operation.card.replacementUuid);
        await options.runtime.ackProjection(scope, operation.btwOpId, expected, { kind: 'replacement_created', messageId });
      } catch (error) {
        const classified = classifyProviderError(error);
        if (classified.kind === 'retryable') {
          await options.runtime.ackProjection(scope, operation.btwOpId, expected, {
            kind: 'retryable_failure', errorCode: classified.errorCode, message: classified.message,
            retryAt: retryAt(now(), operation.projection.retryAttempt),
          });
        } else {
          await options.runtime.recordProjectionFailure(scope, operation.btwOpId, expected, {
            kind: 'provider_permanent', errorCode: classified.errorCode, message: classified.message,
          });
        }
      }
      return;
    }

    const targetMessageId = operation.card.replacementState === 'created'
      ? operation.card.replacementMessageId
      : operation.card.messageId;
    if (!targetMessageId) return;

    try {
      await update(operation.replyTarget.larkAppId, targetMessageId, cardJson);
      await options.runtime.ackProjection(scope, operation.btwOpId, expected, { kind: 'patched' });
    } catch (error) {
      if (error instanceof MessageWithdrawnError && operation.card.replacementState === 'none') {
        await options.runtime.ackProjection(scope, operation.btwOpId, expected, { kind: 'withdrawn' });
        return;
      }
      const classified = classifyProviderError(error);
      if (classified.kind === 'retryable') {
        await options.runtime.ackProjection(scope, operation.btwOpId, expected, {
          kind: 'retryable_failure', errorCode: classified.errorCode, message: classified.message,
          retryAt: retryAt(now(), operation.projection.retryAttempt),
        });
      } else {
        await options.runtime.recordProjectionFailure(scope, operation.btwOpId, expected, {
          kind: 'provider_permanent',
          errorCode: error instanceof MessageWithdrawnError ? 'replacement_withdrawn' : classified.errorCode,
          message: classified.message,
        });
      }
    }
  }

  return {
    ensureInitialCard(operation): Promise<InitialCardResult> {
      return singleFlight(operation, async () => {
        const locale = resolveLocale(operation.replyTarget.larkAppId);
        try {
          const messageId = await createAtFrozenTarget(
            operation, buildBtwCard(operation, locale), operation.card.createUuid,
          );
          const recorded = await options.runtime.recordCard(operationScope(operation), operation.btwOpId, messageId);
          return { kind: 'recorded', operation: recorded };
        } catch (error) {
          const classified = classifyProviderError(error);
          const outcome: BtwInitialCardAttemptOutcome = {
            kind: classified.kind === 'retryable' && !classified.responseKnown ? 'unknown' : 'definitely_unsent',
            errorCode: classified.errorCode,
            message: classified.message,
            retryAt: retryAt(now(), operation.card.createAttempt),
          };
          const recorded = await options.runtime.recordInitialCardAttempt(
            operationScope(operation), operation.btwOpId, outcome,
          );
          return { kind: outcome.kind === 'unknown' ? 'unknown' : 'pending', operation: recorded };
        }
      });
    },

    async drainApp(larkAppId: string): Promise<void> {
      while (true) {
        const items = await options.runtime.listPendingProjections(larkAppId);
        if (items.length === 0) return;
        await Promise.all(items.map(item => singleFlight(item.operation, () => handleProjection(item))));
      }
    },
  };
}
