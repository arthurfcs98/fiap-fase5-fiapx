import type { FiapxEvent } from '@fiapx/contracts';
import { fiapxEvent } from '@fiapx/contracts';
import { InvalidEventError } from '@fiapx/messaging';
import type { EntityManager } from 'typeorm';
import type { OutboxWriter } from '../domain/outbox.ports';

/**
 * `outbox_events` writer (inside the unit of work). The envelope is validated against the
 * contract BEFORE the insert: an invalid event rolls the business transaction back instead of
 * becoming a row the relay could never publish. `created_at` = `occurredAt`, so the relay
 * rebuilds exactly the same envelope.
 */
export class TypeOrmOutboxWriter implements OutboxWriter {
  constructor(private readonly manager: EntityManager) {}

  async add(event: FiapxEvent, aggregateId: string): Promise<void> {
    const parsed = fiapxEvent.safeParse(event);
    if (!parsed.success) {
      throw new InvalidEventError(
        String(event.type),
        parsed.error.issues[0]?.message ?? 'inválido',
      );
    }
    await this.manager.query(
      `INSERT INTO outbox_events (id, aggregate_id, event_type, payload, correlation_id, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
      [
        event.id,
        aggregateId,
        event.type,
        JSON.stringify(parsed.data.payload),
        event.correlationId,
        new Date(event.occurredAt),
      ],
    );
  }

  async deleteByAggregateIds(aggregateIds: readonly string[]): Promise<number> {
    if (aggregateIds.length === 0) return 0;
    const [, affected] = await this.manager.query<[unknown[], number]>(
      `DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])`,
      [[...aggregateIds]],
    );
    return affected;
  }
}
