import type { EventEnvelope } from '@fiapx/contracts';
import type { PublishEventOptions } from './message-publisher';

/**
 * Porta de publicação de eventos (Clean Architecture): casos de uso e o outbox relay dependem
 * dela, não do `MessagePublisher`. Injetar com `@Inject(EVENT_PUBLISHER)`; em testes, usar o
 * `RecordingEventPublisher` de `@fiapx/messaging/testing`.
 */
export interface EventPublisher {
  /** Valida contra o contrato e publica com confirm (ver `MessagePublisher.publishEvent`). */
  publishEvent(event: EventEnvelope<string, unknown>, options?: PublishEventOptions): Promise<void>;
}

/** Token de injeção de {@link EventPublisher} (provido pelo `MessagingModule`). */
export const EVENT_PUBLISHER = Symbol('EVENT_PUBLISHER');
