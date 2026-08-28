import { logger } from '../utils/logger.js';

export type PinStreamingCardChangeHandler =
  (larkAppId: string, enabled: boolean) => void | PromiseLike<void>;

let currentHandler: PinStreamingCardChangeHandler | null = null;

export function registerPinStreamingCardChangeHandler(
  handler: PinStreamingCardChangeHandler,
): () => void {
  currentHandler = handler;
  return () => {
    if (currentHandler === handler) currentHandler = null;
  };
}

export function notifyPinStreamingCardChanged(
  larkAppId: string,
  enabled: boolean,
): void {
  if (!currentHandler) return;
  try {
    Promise.resolve(currentHandler(larkAppId, enabled)).catch((error) => {
      logger.warn(
        `[pin-streaming-card] pinStreamingCard change handler failed `
        + `app=${larkAppId} enabled=${enabled}: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    });
  } catch (error) {
    logger.warn(
      `[pin-streaming-card] pinStreamingCard change handler failed `
      + `app=${larkAppId} enabled=${enabled}: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
