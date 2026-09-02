import type { DaemonSession } from '../../core/types.js';

/** Narrow, executable ownership seam shared by new-topic and thread ingress. */
export async function routeBtwIngress(input: {
  cmd: string;
  ds: DaemonSession | undefined;
  commandContent: string;
  requestId: string;
  invoke(ds: DaemonSession, commandContent: string, requestId: string): Promise<unknown>;
  noSession(): Promise<unknown>;
}): Promise<boolean> {
  if (input.cmd !== '/btw') return false;
  if (!input.ds) {
    await input.noSession();
    return true;
  }
  await input.invoke(input.ds, input.commandContent, input.requestId);
  return true;
}
