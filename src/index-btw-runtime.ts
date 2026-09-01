import { resolveBotmuxDataDir } from './core/data-dir.js';
import { runBtwRuntime, shutdownRuntime } from './features/btw/runtime-server.js';

const dataDir = resolveBotmuxDataDir();
await runBtwRuntime({ dataDir });
let shuttingDown = false;
const stop = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  void shutdownRuntime({ dataDir }).finally(() => process.exit(0));
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
await new Promise<never>(() => {});
