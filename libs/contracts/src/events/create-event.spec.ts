import { videoUploadedFixture } from '../fixtures';
import { createEvent } from './create-event';
import { EVENT_SCHEMAS } from './event-registry';

describe('createEvent', () => {
  it('monta um envelope v1 válido para o schema do type', () => {
    const event = createEvent(
      'video.uploaded',
      videoUploadedFixture.payload,
      videoUploadedFixture.correlationId,
    );

    expect(EVENT_SCHEMAS['video.uploaded'].parse(event)).toEqual(event);
    expect(event).toMatchObject({
      type: 'video.uploaded',
      version: 1,
      correlationId: videoUploadedFixture.correlationId,
      payload: videoUploadedFixture.payload,
    });
  });

  it('aceita id e relógio injetados (ids determinísticos no worker)', () => {
    const event = createEvent(
      'video.processing.started',
      { videoId: videoUploadedFixture.payload.videoId, attempt: 2, workerId: 'w-1' },
      'cid-1',
      { id: '00000000-0000-4000-8000-000000000009', now: () => new Date(0) },
    );

    expect(event.id).toBe('00000000-0000-4000-8000-000000000009');
    expect(event.occurredAt).toBe('1970-01-01T00:00:00.000Z');
  });
});
