import type { BtwProjector } from './projector.js';
import type { BtwRuntimeClient } from './runtime-protocol.js';

type RuntimeConnection = {
  client: BtwRuntimeClient;
  close(): void;
};

export interface BtwProjectorServiceOptions {
  larkAppId: string;
  connect(): Promise<RuntimeConnection>;
  createProjector(runtime: RuntimeConnection['client']): BtwProjector;
  onError?: (error: unknown) => void;
}

/**
 * Owns one app's daemon-side Lark projection connection. Durable state remains
 * in the runtime; this object only watches, scans, and schedules the next scan.
 */
export class BtwProjectorService {
  private stopped = false;
  private started = false;
  private connection?: RuntimeConnection;
  private projector?: BtwProjector;
  private wakeIterator?: AsyncIterator<unknown>;
  private loop?: Promise<void>;
  private drain?: Promise<void>;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private firstScan?: Promise<void>;
  private resolveFirstScan?: () => void;

  constructor(private readonly options: BtwProjectorServiceOptions) {}

  async start(): Promise<void> {
    if (this.stopped) return;
    this.started = true;
    if (!this.loop) {
      this.firstScan = new Promise(resolve => { this.resolveFirstScan = resolve; });
      this.loop = this.run().finally(() => { this.loop = undefined; });
    }
    await this.firstScan;
  }

  wake(): void {
    if (!this.stopped && this.started) void this.drainNow();
  }

  async ensureInitialCard(operation: Parameters<BtwProjector['ensureInitialCard']>[0]) {
    await this.start();
    if (!this.projector) throw new Error('BTW projector service is not connected');
    return await this.projector.ensureInitialCard(operation);
  }

  async runtime(): Promise<BtwRuntimeClient> {
    await this.start();
    if (!this.connection) throw new Error('BTW projector service is not connected');
    return this.connection.client;
  }

  async stop(input: { drainMs?: number } = {}): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    await this.wakeIterator?.return?.();
    this.connection?.close();
    this.connection = undefined;
    this.projector = undefined;
    if (this.drain && input.drainMs && input.drainMs > 0) {
      await Promise.race([this.drain.catch(() => undefined), new Promise(resolve => setTimeout(resolve, input.drainMs))]);
    }
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        const connection = await this.options.connect();
        if (this.stopped) { connection.close(); return; }
        this.connection?.close();
        this.connection = connection;
        this.projector = this.options.createProjector(connection.client);
        const wakes = connection.client.watchProjectionWakes(this.options.larkAppId);
        this.wakeIterator = wakes[Symbol.asyncIterator]();
        const ready = (wakes as { ready?: Promise<void> }).ready;
        await ready;
        // The durable scan happens only after the subscription is acknowledged:
        // pre-subscription mutations are caught by the scan, later mutations by
        // the queued payload-free wake.
        await this.drainNow();
        this.resolveFirstScan?.();
        this.resolveFirstScan = undefined;
        while (!this.stopped) {
          const next = await this.wakeIterator.next();
          if (next.done) break;
          await this.drainNow();
        }
      } catch (error) {
        if (!this.stopped) this.options.onError?.(error);
        this.resolveFirstScan?.();
        this.resolveFirstScan = undefined;
      } finally {
        this.wakeIterator = undefined;
        this.connection?.close();
        this.connection = undefined;
        this.projector = undefined;
      }
      if (!this.stopped) await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  private async drainNow(): Promise<void> {
    if (this.drain) return await this.drain;
    const current = (async () => {
      const connection = this.connection;
      if (!connection || this.stopped) return;
      const projector = this.projector;
      if (!projector) return;
      const initialCards = await connection.client.listPendingInitialCards(this.options.larkAppId);
      for (const operation of initialCards) await projector.ensureInitialCard(operation);
      await projector.drainApp(this.options.larkAppId);
      this.armRetry(await connection.client.nextBtwRetryAt(this.options.larkAppId));
    })().finally(() => { this.drain = undefined; });
    this.drain = current;
    return await current;
  }

  private armRetry(retryAt: string | undefined): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    if (!retryAt || this.stopped) return;
    const delay = Math.max(0, Date.parse(retryAt) - Date.now());
    this.retryTimer = setTimeout(() => this.wake(), delay);
    this.retryTimer.unref?.();
  }
}
