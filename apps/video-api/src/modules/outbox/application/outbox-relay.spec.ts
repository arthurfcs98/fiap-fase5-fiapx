import { videoCompletedFixture, videoUploadedFixture } from '@fiapx/contracts/fixtures';
import { PublishError } from '@fiapx/messaging';
import { RecordingEventPublisher } from '@fiapx/messaging/testing';
import type { OutboxRecord, OutboxStore } from '../domain/outbox.ports';
import {
  backoffMs,
  OUTBOX_BATCH_SIZE,
  OUTBOX_LEASE_MS,
  OutboxRelay,
  toEnvelope,
} from './outbox-relay';

function record(
  fixture: typeof videoUploadedFixture | typeof videoCompletedFixture,
  attempts = 0,
): OutboxRecord {
  return {
    id: fixture.id,
    aggregateId: fixture.payload.videoId,
    eventType: fixture.type,
    payload: fixture.payload,
    correlationId: fixture.correlationId,
    createdAt: new Date(fixture.occurredAt),
    attempts,
  };
}

function store(batch: OutboxRecord[]): jest.Mocked<OutboxStore> {
  return {
    claimBatch: jest.fn().mockResolvedValue(batch),
    markPublished: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    countPending: jest.fn(),
    purgePublishedBefore: jest.fn(),
  };
}

describe('OutboxRelay', () => {
  it('claims 50 with a 30 s lease, publishes each envelope unchanged and marks it published', async () => {
    const outbox = store([record(videoUploadedFixture), record(videoCompletedFixture)]);
    const publisher = new RecordingEventPublisher();

    await expect(new OutboxRelay(outbox, publisher).relayBatch()).resolves.toEqual({
      claimed: 2,
      published: 2,
      failed: 0,
    });

    expect(outbox.claimBatch).toHaveBeenCalledWith(OUTBOX_BATCH_SIZE, OUTBOX_LEASE_MS);
    expect(OUTBOX_BATCH_SIZE).toBe(50);
    expect(publisher.events).toEqual([videoUploadedFixture, videoCompletedFixture]);
    expect(outbox.markPublished.mock.calls).toEqual([
      [videoUploadedFixture.id],
      [videoCompletedFixture.id],
    ]);
  });

  it('broker failure: backoff on the failed row, releases the rest and stops the batch', async () => {
    const outbox = store([record(videoUploadedFixture, 2), record(videoCompletedFixture)]);
    const publisher = new RecordingEventPublisher().failNextWith(
      new PublishError('fiapx.events', 'video.uploaded'),
    );

    await expect(new OutboxRelay(outbox, publisher).relayBatch()).resolves.toEqual({
      claimed: 2,
      published: 0,
      failed: 1,
    });

    expect(outbox.markFailed).toHaveBeenCalledWith(
      videoUploadedFixture.id,
      expect.stringContaining('PublishError'),
      backoffMs(3),
    );
    expect(outbox.release).toHaveBeenCalledWith([videoCompletedFixture.id]);
    expect(outbox.markPublished).not.toHaveBeenCalled();
    expect(publisher.events).toHaveLength(0);
  });

  it('non-Error failures are recorded too', async () => {
    const outbox = store([record(videoUploadedFixture)]);
    const publisher = { publishEvent: jest.fn().mockRejectedValue('nack') };
    await new OutboxRelay(outbox, publisher).relayBatch();
    expect(outbox.markFailed).toHaveBeenCalledWith(videoUploadedFixture.id, 'nack', 1_000);
  });

  it('empty outbox → nothing to do', async () => {
    await expect(
      new OutboxRelay(store([]), new RecordingEventPublisher()).relayBatch(),
    ).resolves.toEqual({
      claimed: 0,
      published: 0,
      failed: 0,
    });
  });

  it('backoff doubles from 1 s up to 60 s', () => {
    expect([1, 2, 3, 6, 7, 20].map(backoffMs)).toEqual([
      1_000, 2_000, 4_000, 32_000, 60_000, 60_000,
    ]);
    expect(backoffMs(0)).toBe(1_000);
  });

  it('toEnvelope rebuilds the v1 envelope (occurredAt = created_at)', () => {
    expect(toEnvelope(record(videoUploadedFixture))).toEqual(videoUploadedFixture);
  });
});
