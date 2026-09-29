import type { EventType } from '@fiapx/contracts';
import { v5 as uuidv5 } from 'uuid';

/**
 * Namespace of the worker's deterministic event ids. Never change it: ids of events republished
 * after a crash would stop matching the ones already recorded by the video-api.
 */
export const WORKER_EVENT_NAMESPACE = '1106c6b7-d417-4138-9a23-6f235452a2a3';

/**
 * Deterministic id (UUID v5) of an event the worker publishes in reaction to a message.
 *
 * The worker has no database, so a crash between "publish" and "ack" makes the broker redeliver
 * the message and the worker publish the same event again. Deriving the id from the source
 * `messageId` (stable across retries and redeliveries), the event type and the attempt gives
 * the republished copy the same id, and the video-api inbox (`processed_messages`) drops it.
 */
export function workerEventId(sourceMessageId: string, type: EventType, attempt?: number): string {
  const name =
    attempt === undefined ? `${sourceMessageId}/${type}` : `${sourceMessageId}/${type}/${attempt}`;
  return uuidv5(name, WORKER_EVENT_NAMESPACE);
}
