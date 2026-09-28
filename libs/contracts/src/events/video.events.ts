import { z } from 'zod';
import { eventEnvelopeSchema } from '../envelope';

/**
 * Eventos do fluxo de vídeo (docs/arquitetura/contratos.md, seção 2 — "Eventos").
 * O `type` de cada evento é igual à routing key usada no `fiapx.events`.
 */
export const EVENT_TYPES = {
  videoUploaded: 'video.uploaded',
  processingStarted: 'video.processing.started',
  processingCompleted: 'video.processing.completed',
  processingFailed: 'video.processing.failed',
  videoFailed: 'video.failed',
  videoCompleted: 'video.completed',
} as const;

const errorCode = z.string().regex(/^[A-Z]\d{4}$/, 'código de erro no formato P0001');
const objectKey = z.string().min(1).max(300);
const bucket = z.string().min(3).max(63);
const originalName = z.string().min(1).max(255);

/** video-api (outbox) → worker: comando de processamento. */
export const videoUploadedPayload = z.object({
  videoId: z.uuid(),
  userId: z.uuid(),
  originalName,
  rawBucket: bucket,
  rawKey: objectKey,
  zipBucket: bucket,
  zipKey: objectKey,
  sizeBytes: z.number().int().positive(),
});

/** worker → video-api. */
export const processingStartedPayload = z.object({
  videoId: z.uuid(),
  attempt: z.number().int().min(1),
  workerId: z.string().min(1).max(100),
});

/** worker → video-api. */
export const processingCompletedPayload = z.object({
  videoId: z.uuid(),
  zipKey: objectKey,
  frameCount: z.number().int().min(1),
  zipSizeBytes: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
});

/** worker → video-api. */
export const processingFailedPayload = z.object({
  videoId: z.uuid(),
  attempt: z.number().int().min(1),
  errorCode,
  errorMessage: z.string().max(500),
});

/** video-api (outbox) → notification-service (e-mail de falha, obrigatório). */
export const videoFailedPayload = z.object({
  videoId: z.uuid(),
  userId: z.uuid(),
  userEmail: z.email(),
  userName: z.string().min(1).max(120),
  originalName,
  errorCode,
  errorMessage: z.string().max(500),
});

/** video-api (outbox) → notification-service (e-mail de sucesso, opcional). */
export const videoCompletedPayload = z.object({
  videoId: z.uuid(),
  userId: z.uuid(),
  userEmail: z.email(),
  userName: z.string().min(1).max(120),
  originalName,
  frameCount: z.number().int().min(1),
});

export const videoUploadedEvent = eventEnvelopeSchema(
  EVENT_TYPES.videoUploaded,
  videoUploadedPayload,
);
export const processingStartedEvent = eventEnvelopeSchema(
  EVENT_TYPES.processingStarted,
  processingStartedPayload,
);
export const processingCompletedEvent = eventEnvelopeSchema(
  EVENT_TYPES.processingCompleted,
  processingCompletedPayload,
);
export const processingFailedEvent = eventEnvelopeSchema(
  EVENT_TYPES.processingFailed,
  processingFailedPayload,
);
export const videoFailedEvent = eventEnvelopeSchema(EVENT_TYPES.videoFailed, videoFailedPayload);
export const videoCompletedEvent = eventEnvelopeSchema(
  EVENT_TYPES.videoCompleted,
  videoCompletedPayload,
);

/** Mensagens que chegam em `api.video-processing` (binding `video.processing.*`). */
export const processingEvent = z.discriminatedUnion('type', [
  processingStartedEvent,
  processingCompletedEvent,
  processingFailedEvent,
]);

/** Mensagens que chegam em `notification.events`. */
export const notificationEvent = z.discriminatedUnion('type', [
  videoFailedEvent,
  videoCompletedEvent,
]);

export type VideoUploadedEvent = z.infer<typeof videoUploadedEvent>;
export type ProcessingStartedEvent = z.infer<typeof processingStartedEvent>;
export type ProcessingCompletedEvent = z.infer<typeof processingCompletedEvent>;
export type ProcessingFailedEvent = z.infer<typeof processingFailedEvent>;
export type VideoFailedEvent = z.infer<typeof videoFailedEvent>;
export type VideoCompletedEvent = z.infer<typeof videoCompletedEvent>;
export type ProcessingEvent = z.infer<typeof processingEvent>;
export type NotificationEvent = z.infer<typeof notificationEvent>;
