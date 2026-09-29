import { z } from 'zod';
import type { EventType } from './event-types';
import { EVENT_TYPES } from './event-types';
import { userDeletedEvent } from './user.events';
import {
  processingCompletedEvent,
  processingFailedEvent,
  processingStartedEvent,
  videoCompletedEvent,
  videoFailedEvent,
  videoUploadedEvent,
} from './video.events';

/**
 * Mensagens que chegam em `notification.events` (bindings `video.failed`, `video.completed` e
 * `user.deleted`): o notification-service consome com este schema e decide pelo `type`.
 */
export const notificationEvent = z.discriminatedUnion('type', [
  videoFailedEvent,
  videoCompletedEvent,
  userDeletedEvent,
]);

export type NotificationEvent = z.infer<typeof notificationEvent>;

/**
 * Registro `type → schema` de todos os eventos v1. Usado pelo publicador de `@fiapx/messaging`
 * para validar o envelope ANTES de publicar (produtor e consumidor validam o mesmo schema).
 */
export const EVENT_SCHEMAS = {
  [EVENT_TYPES.videoUploaded]: videoUploadedEvent,
  [EVENT_TYPES.processingStarted]: processingStartedEvent,
  [EVENT_TYPES.processingCompleted]: processingCompletedEvent,
  [EVENT_TYPES.processingFailed]: processingFailedEvent,
  [EVENT_TYPES.videoFailed]: videoFailedEvent,
  [EVENT_TYPES.videoCompleted]: videoCompletedEvent,
  [EVENT_TYPES.userDeleted]: userDeletedEvent,
} as const satisfies Record<EventType, z.ZodType>;

/** Qualquer evento v1 do FIAP X (união discriminada por `type`). */
export const fiapxEvent = z.discriminatedUnion('type', [
  videoUploadedEvent,
  processingStartedEvent,
  processingCompletedEvent,
  processingFailedEvent,
  videoFailedEvent,
  videoCompletedEvent,
  userDeletedEvent,
]);

export type FiapxEvent = z.infer<typeof fiapxEvent>;

/** Evento de um `type` específico, ex.: `EventOf<'video.uploaded'>`. */
export type EventOf<K extends EventType> = z.infer<(typeof EVENT_SCHEMAS)[K]>;

/** Payload de um `type` específico, ex.: `PayloadOf<'user.deleted'>`. */
export type PayloadOf<K extends EventType> = EventOf<K>['payload'];

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && Object.hasOwn(EVENT_SCHEMAS, value);
}
