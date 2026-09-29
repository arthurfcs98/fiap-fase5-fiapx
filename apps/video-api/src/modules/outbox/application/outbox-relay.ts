import type { EventPublisher } from '@fiapx/messaging';
import { EVENT_PUBLISHER } from '@fiapx/messaging';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Clock } from '../../../shared/domain/clock';
import { CLOCK } from '../../../shared/domain/clock';
import type { OutboxRecord, OutboxStore } from '../domain/outbox.ports';
import { OUTBOX_STORE } from '../domain/outbox.ports';

/** contratos.md, section 5: batches of 50. */
export const OUTBOX_BATCH_SIZE = 50;
/** Lease of a claimed batch: another replica may retake the rows only after it expires. */
export const OUTBOX_LEASE_MS = 30_000;
/**
 * A publish may take up to the confirm timeout (5 s): no publish STARTS in the last 10 s of the
 * lease, so a slow batch never overlaps another replica retaking the same rows.
 */
export const OUTBOX_LEASE_SAFETY_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;

export interface RelayResult {
  claimed: number;
  published: number;
  failed: number;
}

/** Retry delay after the n-th failed publication: 1 s, 2 s, 4 s ... up to 60 s. */
export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.max(0, Math.min(attempts - 1, 6)));
}

/**
 * Outbox relay (contratos.md, section 5): claims up to 50 pending rows with a lease
 * (`FOR UPDATE SKIP LOCKED`, safe with N replicas), publishes each one with publisher confirm
 * and only then marks `published_at`. On the first failure (broker down, no confirm) the row
 * gets a backoff, the rest of the batch is released and the relay stops until the next tick.
 * A slow batch (confirms near the timeout) releases what is left before the lease runs out, so
 * two replicas never publish the same row in normal operation. At-least-once: a crash between
 * the confirm and the UPDATE republishes after the lease; the consumers dedupe by `messageId`
 * (= outbox id).
 */
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);

  constructor(
    @Inject(OUTBOX_STORE) private readonly store: OutboxStore,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async relayBatch(): Promise<RelayResult> {
    const claimedAt = this.clock.now().getTime();
    const batch = await this.store.claimBatch(OUTBOX_BATCH_SIZE, OUTBOX_LEASE_MS);
    let published = 0;
    for (const [index, record] of batch.entries()) {
      if (this.clock.now().getTime() - claimedAt > OUTBOX_LEASE_MS - OUTBOX_LEASE_SAFETY_MS) {
        await this.store.release(batch.slice(index).map((pending) => pending.id));
        this.logger.warn({
          msg: 'Lote do outbox lento: o resto volta para a fila antes de o lease vencer',
          published,
          released: batch.length - index,
        });
        return { claimed: batch.length, published, failed: 0 };
      }
      try {
        await this.publisher.publishEvent(toEnvelope(record));
      } catch (error) {
        const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        const attempts = record.attempts + 1;
        await this.store.markFailed(record.id, reason, backoffMs(attempts));
        await this.store.release(batch.slice(index + 1).map((pending) => pending.id));
        this.logger.warn({
          msg: 'Falha ao publicar evento do outbox (nova tentativa com backoff)',
          outboxId: record.id,
          eventType: record.eventType,
          aggregateId: record.aggregateId,
          attempts,
          error: reason,
        });
        return { claimed: batch.length, published, failed: 1 };
      }
      await this.store.markPublished(record.id);
      published += 1;
    }
    return { claimed: batch.length, published, failed: 0 };
  }
}

/** Rebuilds the envelope exactly as it was validated when written (id, type, occurredAt). */
export function toEnvelope(record: OutboxRecord) {
  return {
    id: record.id,
    type: record.eventType,
    version: 1 as const,
    occurredAt: record.createdAt.toISOString(),
    correlationId: record.correlationId,
    payload: record.payload,
  };
}
