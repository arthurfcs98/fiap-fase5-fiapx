import type {
  ProcessingCompletedEvent,
  ProcessingFailedEvent,
  ProcessingStartedEvent,
  VideoCompletedEvent,
  VideoFailedEvent,
  VideoUploadedEvent,
} from '../events/video.events';

/**
 * Fixtures versionadas (v1) de cada evento: produtor e consumidor testam contra elas.
 * Também servem de exemplo nos testes de integração/BDD das próximas etapas.
 */
const USER_ID = '1a2b3c4d-5e6f-4a0b-9c1d-2e3f4a5b6c7d';
const VIDEO_ID = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const CORRELATION_ID = 'c0a8016e-4b1f-4f3e-9d2a-7a1b2c3d4e5f';
const OCCURRED_AT = '2026-10-10T12:00:00.000Z';

export const videoUploadedFixture: VideoUploadedEvent = {
  id: '0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b',
  type: 'video.uploaded',
  version: 1,
  occurredAt: OCCURRED_AT,
  correlationId: CORRELATION_ID,
  payload: {
    videoId: VIDEO_ID,
    userId: USER_ID,
    originalName: 'demo.mp4',
    rawBucket: 'fiapx-raw',
    rawKey: `${USER_ID}/${VIDEO_ID}.mp4`,
    zipBucket: 'fiapx-zips',
    zipKey: `${USER_ID}/${VIDEO_ID}.zip`,
    sizeBytes: 10_485_760,
  },
};

export const processingStartedFixture: ProcessingStartedEvent = {
  id: '1e2d3c4b-5a69-4788-9766-554433221100',
  type: 'video.processing.started',
  version: 1,
  occurredAt: OCCURRED_AT,
  correlationId: CORRELATION_ID,
  payload: { videoId: VIDEO_ID, attempt: 1, workerId: 'video-worker-7f9c' },
};

export const processingCompletedFixture: ProcessingCompletedEvent = {
  id: '2f3e4d5c-6b7a-4899-8a77-665544332211',
  type: 'video.processing.completed',
  version: 1,
  occurredAt: OCCURRED_AT,
  correlationId: CORRELATION_ID,
  payload: {
    videoId: VIDEO_ID,
    zipKey: `${USER_ID}/${VIDEO_ID}.zip`,
    frameCount: 3,
    zipSizeBytes: 245_760,
    durationMs: 1_830,
  },
};

export const processingFailedFixture: ProcessingFailedEvent = {
  id: '3a4b5c6d-7e8f-4a0b-9c1d-2e3f4a5b6c7e',
  type: 'video.processing.failed',
  version: 1,
  occurredAt: OCCURRED_AT,
  correlationId: CORRELATION_ID,
  payload: {
    videoId: VIDEO_ID,
    attempt: 1,
    errorCode: 'P0001',
    errorMessage: 'O arquivo não é um vídeo válido ou está corrompido.',
  },
};

export const videoFailedFixture: VideoFailedEvent = {
  id: '4b5c6d7e-8f90-4a1b-8c2d-3e4f5a6b7c8d',
  type: 'video.failed',
  version: 1,
  occurredAt: OCCURRED_AT,
  correlationId: CORRELATION_ID,
  payload: {
    videoId: VIDEO_ID,
    userId: USER_ID,
    userEmail: 'arthur@example.com',
    userName: 'Arthur',
    originalName: 'demo.mp4',
    errorCode: 'P0001',
    errorMessage: 'O arquivo não é um vídeo válido ou está corrompido.',
  },
};

export const videoCompletedFixture: VideoCompletedEvent = {
  id: '5c6d7e8f-9a0b-4c1d-9e2f-3a4b5c6d7e8f',
  type: 'video.completed',
  version: 1,
  occurredAt: OCCURRED_AT,
  correlationId: CORRELATION_ID,
  payload: {
    videoId: VIDEO_ID,
    userId: USER_ID,
    userEmail: 'arthur@example.com',
    userName: 'Arthur',
    originalName: 'demo.mp4',
    frameCount: 3,
  },
};
