import { parseEvent } from '../envelope';
import {
  processingCompletedFixture,
  processingFailedFixture,
  processingStartedFixture,
  videoCompletedFixture,
  videoFailedFixture,
  videoUploadedFixture,
} from '../fixtures';
import {
  EVENT_TYPES,
  notificationEvent,
  processingCompletedEvent,
  processingEvent,
  processingFailedEvent,
  processingStartedEvent,
  videoCompletedEvent,
  videoFailedEvent,
  videoUploadedEvent,
} from './video.events';

describe('eventos de vídeo v1 (contrato)', () => {
  it.each([
    ['video.uploaded', videoUploadedEvent, videoUploadedFixture],
    ['video.processing.started', processingStartedEvent, processingStartedFixture],
    ['video.processing.completed', processingCompletedEvent, processingCompletedFixture],
    ['video.processing.failed', processingFailedEvent, processingFailedFixture],
    ['video.failed', videoFailedEvent, videoFailedFixture],
    ['video.completed', videoCompletedEvent, videoCompletedFixture],
  ] as const)('a fixture de %s é válida e o type é a routing key', (type, schema, fixture) => {
    expect(schema.parse(fixture)).toEqual(fixture);
    expect(fixture.type).toBe(type);
    expect(Object.values(EVENT_TYPES)).toContain(type);
  });

  it.each([
    ['videoId não-UUID', { videoId: '123' }],
    ['tamanho zero', { sizeBytes: 0 }],
    ['nome vazio', { originalName: '' }],
    ['nome longo demais', { originalName: 'a'.repeat(256) }],
    ['sem zipKey', { zipKey: '' }],
  ])('video.uploaded rejeita %s', (_caso, patch) => {
    const event = {
      ...videoUploadedFixture,
      payload: { ...videoUploadedFixture.payload, ...patch },
    };
    expect(parseEvent(videoUploadedEvent, event).success).toBe(false);
  });

  it('video.processing.failed exige código de erro no formato P0001', () => {
    const bad = {
      ...processingFailedFixture,
      payload: { ...processingFailedFixture.payload, errorCode: 'erro' },
    };
    const result = parseEvent(processingFailedEvent, bad);
    expect(result).toMatchObject({ success: false, error: expect.stringContaining('P0001') });
  });

  it('video.failed exige e-mail válido', () => {
    const bad = {
      ...videoFailedFixture,
      payload: { ...videoFailedFixture.payload, userEmail: 'x' },
    };
    expect(parseEvent(videoFailedEvent, bad).success).toBe(false);
  });

  it('api.video-processing aceita os 3 eventos de processamento (união discriminada)', () => {
    for (const fixture of [
      processingStartedFixture,
      processingCompletedFixture,
      processingFailedFixture,
    ]) {
      expect(processingEvent.parse(fixture).type).toBe(fixture.type);
    }
    expect(parseEvent(processingEvent, videoUploadedFixture).success).toBe(false);
  });

  it('notification.events aceita video.failed e video.completed', () => {
    expect(notificationEvent.parse(videoFailedFixture).type).toBe('video.failed');
    expect(notificationEvent.parse(videoCompletedFixture).type).toBe('video.completed');
    expect(parseEvent(notificationEvent, processingStartedFixture).success).toBe(false);
  });
});
