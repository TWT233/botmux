import { t, type Locale } from '../../i18n/index.js';
import type { BtwOperation } from './types.js';

interface BtwCardView {
  statusKey: string;
  template: 'yellow' | 'blue' | 'green' | 'red' | 'grey' | 'orange';
  bodyKey: string;
  body: string;
}

function operationView(operation: BtwOperation, locale: Locale): BtwCardView {
  const failure = operation.projection.deliveryFailure;
  if (failure?.kind === 'visible_fallback') {
    return {
      statusKey: 'btw.card.delivery_failed',
      template: 'red',
      bodyKey: 'btw.card.detail',
      body: failure.message,
    };
  }

  switch (operation.execution.state) {
    case 'card_pending':
    case 'accepted':
      return {
        statusKey: 'btw.card.received', template: 'yellow', bodyKey: 'btw.card.status',
        body: t('btw.card.received', undefined, locale),
      };
    case 'submit_prepared':
    case 'running':
      return {
        statusKey: 'btw.card.running', template: 'blue', bodyKey: 'btw.card.status',
        body: t('btw.card.running', undefined, locale),
      };
    case 'completed':
      return {
        statusKey: 'btw.card.completed', template: 'green', bodyKey: 'btw.card.answer',
        body: operation.execution.answer ?? '',
      };
    case 'failed':
      return {
        statusKey: 'btw.card.failed', template: 'red', bodyKey: 'btw.card.detail',
        body: operation.execution.message ?? t('btw.card.default_failed', undefined, locale),
      };
    case 'cancelled':
      return {
        statusKey: 'btw.card.cancelled', template: 'grey', bodyKey: 'btw.card.detail',
        body: operation.execution.message ?? t('btw.card.default_cancelled', undefined, locale),
      };
    case 'interrupted':
      return {
        statusKey: 'btw.card.interrupted', template: 'orange', bodyKey: 'btw.card.detail',
        body: operation.execution.message ?? t('btw.card.default_interrupted', undefined, locale),
      };
    case 'submission_unknown':
      return {
        statusKey: 'btw.card.submission_unknown', template: 'orange', bodyKey: 'btw.card.detail',
        body: operation.execution.message ?? t('btw.card.default_submission_unknown', undefined, locale),
      };
    case 'card_unknown':
      return {
        statusKey: 'btw.card.card_unknown', template: 'red', bodyKey: 'btw.card.detail',
        body: operation.execution.message ?? t('btw.card.default_card_unknown', undefined, locale),
      };
  }
}

/** Render one independent, display-only BTW card from the durable operation. */
export function buildBtwCard(operation: BtwOperation, locale: Locale): string {
  const view = operationView(operation, locale);
  const title = t('btw.card.title', undefined, locale);
  const status = t(view.statusKey, undefined, locale);
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `💬 ${title} · ${status}` },
      template: view.template,
    },
    elements: [
      { tag: 'markdown', content: `**${t('btw.card.question', undefined, locale)}**\n${operation.question}` },
      { tag: 'markdown', content: `**${t(view.bodyKey, undefined, locale)}**\n${view.body}` },
    ],
  });
}
