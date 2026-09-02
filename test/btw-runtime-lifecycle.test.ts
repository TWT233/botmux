import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { connectBtwRuntime } from '../src/features/btw/runtime-client.js';

const tempDirs: string[] = [];

function newDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-btw-lifecycle-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dataDir of tempDirs.splice(0)) {
    const runtime = await connectBtwRuntime({ dataDir }).catch(() => null);
    if (runtime) {
      try { await runtime.client.shutdownRuntime(); } catch { /* best effort */ }
      runtime.close();
    }
    rmSync(dataDir, { recursive: true, force: true });
  }
});

describe('BTW runtime lifecycle protocol', () => {
  it('quiesces an exact session before close without using the global runtime scope', async () => {
    const runtime = await connectBtwRuntime({ dataDir: newDataDir() });

    await expect(runtime.client.quiesceSession('session-a')).resolves.toEqual({
      affectedAppIds: [],
      projectionWatermarks: [],
    });
    await expect(runtime.client.closeSession('session-a')).resolves.toBeUndefined();
    runtime.close();
  });

  it('quiesces an app scope and preserves the runtime for phase two', async () => {
    const runtime = await connectBtwRuntime({ dataDir: newDataDir() });

    await expect(runtime.client.quiesceApp('app-a')).resolves.toEqual({
      affectedAppIds: [],
      projectionWatermarks: [],
    });
    await expect(runtime.client.closeApp('app-a')).resolves.toBeUndefined();
    await expect(runtime.client.quiesceAll()).resolves.toEqual({
      affectedAppIds: [],
      projectionWatermarks: [],
    });
    runtime.close();
  });
});
