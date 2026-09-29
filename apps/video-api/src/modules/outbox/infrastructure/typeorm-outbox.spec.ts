import { createEvent } from '@fiapx/contracts';
import { videoUploadedFixture } from '@fiapx/contracts/fixtures';
import { InvalidEventError } from '@fiapx/messaging';
import type { EntityManager } from 'typeorm';
import { TypeOrmOutboxStore } from './typeorm-outbox.store';
import { TypeOrmOutboxWriter } from './typeorm-outbox.writer';

function manager(result: unknown = []) {
  const query = jest.fn().mockResolvedValue(result);
  return { query, manager: { query } as unknown as EntityManager };
}

describe('TypeOrmOutboxWriter', () => {
  it('validates against the contract and inserts payload + correlation id, created_at = occurredAt', async () => {
    const { query, manager: em } = manager();
    await new TypeOrmOutboxWriter(em).add(
      videoUploadedFixture,
      videoUploadedFixture.payload.videoId,
    );

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain(
      'INSERT INTO outbox_events (id, aggregate_id, event_type, payload, correlation_id, created_at)',
    );
    expect(params).toEqual([
      videoUploadedFixture.id,
      videoUploadedFixture.payload.videoId,
      'video.uploaded',
      JSON.stringify(videoUploadedFixture.payload),
      videoUploadedFixture.correlationId,
      new Date(videoUploadedFixture.occurredAt),
    ]);
  });

  it('refuses an event outside the contract (rolls the business transaction back)', async () => {
    const { query, manager: em } = manager();
    const invalid = createEvent('user.deleted', { userId: 'not-a-uuid' }, 'cid');
    await expect(new TypeOrmOutboxWriter(em).add(invalid, 'x')).rejects.toBeInstanceOf(
      InvalidEventError,
    );
    expect(query).not.toHaveBeenCalled();
  });

  it('deletes the rows of the given aggregates (LGPD)', async () => {
    const { query, manager: em } = manager([[], 3]);
    const writer = new TypeOrmOutboxWriter(em);
    await expect(writer.deleteByAggregateIds([])).resolves.toBe(0);
    await expect(writer.deleteByAggregateIds(['a', 'b'])).resolves.toBe(3);
    expect(query).toHaveBeenCalledWith(
      'DELETE FROM outbox_events WHERE aggregate_id = ANY($1::uuid[])',
      [['a', 'b']],
    );
  });
});

describe('TypeOrmOutboxStore', () => {
  it('claims with FOR UPDATE SKIP LOCKED + lease and returns the oldest first', async () => {
    const newer = {
      id: 'b',
      aggregate_id: 'v',
      event_type: 'video.uploaded',
      payload: {},
      correlation_id: 'c',
      created_at: new Date(2000),
      attempts: 0,
    };
    const older = { ...newer, id: 'a', created_at: new Date(1000), attempts: 2 };
    const tie = { ...newer, id: 'c', created_at: new Date(2000) };
    const { query, manager: em } = manager([[tie, newer, older], 3]);

    const batch = await new TypeOrmOutboxStore(em).claimBatch(50, 30_000);

    expect(batch.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(batch[0]).toEqual({
      id: 'a',
      aggregateId: 'v',
      eventType: 'video.uploaded',
      payload: {},
      correlationId: 'c',
      createdAt: new Date(1000),
      attempts: 2,
    });
    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('published_at IS NULL');
    expect(sql).toContain('locked_until IS NULL OR locked_until < now()');
    expect(params).toEqual([50, 30_000]);
  });

  it('marks published, failed (with backoff and truncated error) and releases leases', async () => {
    const { query, manager: em } = manager();
    const store = new TypeOrmOutboxStore(em);

    await store.markPublished('a');
    await store.markFailed('a', 'x'.repeat(900), 4_000);
    await store.release([]);
    await store.release(['b', 'c']);

    expect(query.mock.calls[0]).toEqual([
      'UPDATE outbox_events SET published_at = now(), locked_until = NULL WHERE id = $1',
      ['a'],
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual(['a', 'x'.repeat(500), 4_000]);
    expect(query.mock.calls[1]?.[0]).toContain('attempts = attempts + 1');
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]?.[1]).toEqual([['b', 'c']]);
  });

  it('counts pending rows and purges old published rows', async () => {
    const counting = manager([{ pending: 7 }]);
    await expect(new TypeOrmOutboxStore(counting.manager).countPending()).resolves.toBe(7);
    const empty = manager([]);
    await expect(new TypeOrmOutboxStore(empty.manager).countPending()).resolves.toBe(0);

    const purging = manager([[], 4]);
    const cutoff = new Date(0);
    await expect(
      new TypeOrmOutboxStore(purging.manager).purgePublishedBefore(cutoff),
    ).resolves.toBe(4);
    expect(purging.query).toHaveBeenCalledWith(
      'DELETE FROM outbox_events WHERE published_at IS NOT NULL AND published_at < $1',
      [cutoff],
    );
  });
});
