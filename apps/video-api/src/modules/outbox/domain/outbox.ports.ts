import type { FiapxEvent } from '@fiapx/contracts';

/**
 * Writes events to `outbox_events` inside the business transaction (contratos.md, section 5):
 * the row and the state change commit together, and the relay publishes it afterwards.
 */
export interface OutboxWriter {
  /** @throws InvalidEventError when the event does not match the contract (bug). */
  add(event: FiapxEvent, aggregateId: string): Promise<void>;
  /** LGPD erasure: removes the rows (and the personal data in their payloads) of these aggregates. */
  deleteByAggregateIds(aggregateIds: readonly string[]): Promise<number>;
}

/** Pending row claimed by the relay. */
export interface OutboxRecord {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  correlationId: string;
  createdAt: Date;
  attempts: number;
}

/** Relay side of the outbox (outside the business transactions). */
export interface OutboxStore {
  /**
   * `SELECT ... FOR UPDATE SKIP LOCKED LIMIT n` + lease (`locked_until`): replicas never claim
   * the same row while the lease holds. Oldest first.
   */
  claimBatch(limit: number, leaseMs: number): Promise<OutboxRecord[]>;
  markPublished(id: string): Promise<void>;
  /** Keeps the row pending, counts the attempt and blocks it for `retryInMs` (backoff). */
  markFailed(id: string, error: string, retryInMs: number): Promise<void>;
  /** Gives the lease back (rows claimed but not attempted). */
  release(ids: readonly string[]): Promise<void>;
  /** `fiapx_outbox_pending`. */
  countPending(): Promise<number>;
  /** Housekeeping: published rows older than `cutoff` (their payloads carry e-mail and name). */
  purgePublishedBefore(cutoff: Date): Promise<number>;
}

export const OUTBOX_STORE = Symbol('OUTBOX_STORE');
