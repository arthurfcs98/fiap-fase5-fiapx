import type { EntityManager } from 'typeorm';
import type { OutboxRecord, OutboxStore } from '../domain/outbox.ports';

interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  correlation_id: string;
  created_at: Date;
  attempts: number;
}

/**
 * Relay queries on `outbox_events` (contratos.md, section 5). Each call is one autocommit
 * statement: the claim does not keep a transaction open while the broker confirms.
 */
export class TypeOrmOutboxStore implements OutboxStore {
  constructor(private readonly manager: EntityManager) {}

  async claimBatch(limit: number, leaseMs: number): Promise<OutboxRecord[]> {
    const [rows] = await this.manager.query<[OutboxRow[], number]>(
      `UPDATE outbox_events
          SET locked_until = now() + ($2::int * interval '1 millisecond')
        WHERE id IN (SELECT id FROM outbox_events
                      WHERE published_at IS NULL
                        AND (locked_until IS NULL OR locked_until < now())
                      ORDER BY created_at
                      LIMIT $1
                      FOR UPDATE SKIP LOCKED)
    RETURNING id, aggregate_id, event_type, payload, correlation_id, created_at, attempts`,
      [limit, leaseMs],
    );
    return rows
      .map(toRecord)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  }

  async markPublished(id: string): Promise<void> {
    await this.manager.query(
      `UPDATE outbox_events SET published_at = now(), locked_until = NULL WHERE id = $1`,
      [id],
    );
  }

  async markFailed(id: string, error: string, retryInMs: number): Promise<void> {
    await this.manager.query(
      `UPDATE outbox_events
          SET attempts = attempts + 1,
              last_error = $2,
              locked_until = now() + ($3::int * interval '1 millisecond')
        WHERE id = $1`,
      [id, error.slice(0, 500), retryInMs],
    );
  }

  async release(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.manager.query(
      `UPDATE outbox_events SET locked_until = NULL WHERE id = ANY($1::uuid[]) AND published_at IS NULL`,
      [[...ids]],
    );
  }

  async countPending(): Promise<number> {
    const rows = await this.manager.query<{ pending: number }[]>(
      `SELECT count(*)::int AS pending FROM outbox_events WHERE published_at IS NULL`,
    );
    return rows[0]?.pending ?? 0;
  }

  async purgePublishedBefore(cutoff: Date): Promise<number> {
    const [, affected] = await this.manager.query<[unknown[], number]>(
      `DELETE FROM outbox_events WHERE published_at IS NOT NULL AND published_at < $1`,
      [cutoff],
    );
    return affected;
  }
}

function toRecord(row: OutboxRow): OutboxRecord {
  return {
    id: row.id,
    aggregateId: row.aggregate_id,
    eventType: row.event_type,
    payload: row.payload,
    correlationId: row.correlation_id,
    createdAt: row.created_at,
    attempts: row.attempts,
  };
}
