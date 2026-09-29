import { createEnvelope } from '../envelope';
import type { EventOf, PayloadOf } from './event-registry';
import type { EventType } from './event-types';

export interface CreateEventOptions {
  /** Padrão: UUID v4 aleatório (vira o `messageId` do AMQP e a chave de idempotência). */
  id?: string;
  now?: () => Date;
}

/**
 * Monta um envelope v1 tipado pelo `type`:
 * `createEvent('video.uploaded', { videoId, ... }, correlationId)`.
 * Não valida (a validação acontece no publicador, com o schema de `EVENT_SCHEMAS`).
 */
export function createEvent<K extends EventType>(
  type: K,
  payload: PayloadOf<K>,
  correlationId: string,
  options: CreateEventOptions = {},
): EventOf<K> {
  return createEnvelope({ type, payload, correlationId, ...options }) as EventOf<K>;
}
