import { normalizeBrand } from '../../im/lark/lark-hosts.js';
import { localeForBot, t } from '../../i18n/index.js';
import { cliHasNoRawPassthroughSurface } from '../../core/passthrough-commands.js';
import { supportsManagedBtw, type BtwCapabilities } from '../../adapters/cli/btw.js';
import type { DaemonSession } from '../../core/types.js';
import type { DaemonToWorker } from '../../types.js';
import type { BtwRuntimeClient } from './runtime-protocol.js';
import type { BtwProjector } from './projector.js';
import type { FrozenBtwParent, FrozenBtwReplyTarget } from './types.js';

export type BtwInvocationResult = 'managed' | 'legacy' | 'unsupported' | 'usage';

export interface BtwCoordinatorDeps {
  runtime?: Pick<BtwRuntimeClient, 'prepareBtw' | 'submitBtw'>;
  projector: Pick<BtwProjector, 'ensureInitialCard'>;
  reply(content: string, msgType?: string): Promise<string>;
  sendLegacy(message: Extract<DaemonToWorker, { type: 'legacy_btw_raw_input' }>): boolean;
}

export interface BtwInvocationInput {
  ds: DaemonSession;
  commandContent: string;
  requestId: string;
  capabilities: BtwCapabilities;
  replyTarget: FrozenBtwReplyTarget;
  parent: FrozenBtwParent;
  deps: BtwCoordinatorDeps;
}

export async function handleBtwInvocation(input: BtwInvocationInput): Promise<'managed' | 'legacy' | 'unsupported' | 'usage'> {
  const question = input.commandContent.replace(/^\/btw\b/i, '').trim();
  if (!question) {
    await input.deps.reply(t('btw.usage', undefined, localeForBot(input.ds.larkAppId)), 'text');
    return 'usage';
  }

  if (supportsManagedBtw(input.capabilities)) {
    const runtime = input.deps.runtime;
    if (!runtime) throw new Error('managed BTW requires a runtime');
    const prepared = await runtime.prepareBtw({
      requestId: input.requestId,
      question,
      parent: input.parent,
      replyTarget: input.replyTarget,
    });
    const card = await input.deps.projector.ensureInitialCard(prepared.operation);
    if (card.kind === 'recorded') {
      await runtime.submitBtw(
        {
          larkAppId: prepared.operation.replyTarget.larkAppId,
          botmuxSessionId: prepared.operation.parent.botmuxSessionId,
        },
        prepared.operation.btwOpId,
      );
    }
    return 'managed';
  }

  const frozenCliId = input.ds.session.cliLaunchSnapshot?.cliId
    ?? input.ds.session.cliId
    ?? input.ds.initConfig?.cliId
    ?? input.parent.cliId;
  if (cliHasNoRawPassthroughSurface(frozenCliId)) {
    await input.deps.reply(t('btw.unsupported', undefined, localeForBot(input.ds.larkAppId)), 'text');
    return 'unsupported';
  }

  const accepted = input.deps.sendLegacy({
    type: 'legacy_btw_raw_input',
    content: input.commandContent,
  });
  if (!accepted) {
    await input.deps.reply(t('daemon.cmd_needs_active_cli', { cmd: '/btw' }, localeForBot(input.ds.larkAppId)), 'text');
    return 'unsupported';
  }
  await input.deps.reply(t('btw.legacy_warning', undefined, localeForBot(input.ds.larkAppId)), 'text');
  return 'legacy';
}

export function btwFrozenReplyTarget(ds: DaemonSession): FrozenBtwReplyTarget {
  return {
    larkAppId: ds.larkAppId,
    chatId: ds.chatId,
    rootMessageId: ds.scope === 'thread' ? sessionRootMessageId(ds) : null,
    replyToMessageId: sessionRootMessageId(ds),
    chatType: ds.chatType,
    brand: normalizeBrand(ds.initConfig?.brand),
  };
}

export function btwFrozenParent(ds: DaemonSession): FrozenBtwParent | null {
  const attachment = ds.session.btwRuntime;
  const cliId = ds.session.cliLaunchSnapshot?.cliId
    ?? ds.session.cliId
    ?? ds.initConfig?.cliId;
  const nativeThreadId = ds.session.cliSessionId;
  const cwd = ds.workingDir ?? ds.session.workingDir;
  if (!attachment || !cliId || !nativeThreadId || !cwd) return null;
  return {
    botmuxSessionId: ds.session.sessionId,
    cliId,
    nativeThreadId,
    runtimeEpoch: attachment.epoch,
    configHash: attachment.configHash,
    cwd,
  };
}

function sessionRootMessageId(ds: DaemonSession): string | null {
  return ds.scope === 'thread'
    ? ds.session.rootMessageId
    : (ds.session.rootMessageId ?? null);
}
