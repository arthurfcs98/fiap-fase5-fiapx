import type { EventEnvelope, EventType, FiapxEvent } from '@fiapx/contracts';
import { EVENT_SCHEMAS, isEventType, parseEvent } from '@fiapx/contracts';
import { InvalidEventError } from '../messaging.errors';
import type { EventPublisher } from '../publisher/event-publisher.port';
import type {
  OutgoingMessage,
  PublishEventOptions,
  RawMessagePublisher,
} from '../publisher/message-publisher';

export interface RecordedEvent {
  event: FiapxEvent;
  options: PublishEventOptions;
}

/**
 * Dublê de {@link EventPublisher} (e do publicador cru usado pelo ConsumerRunner) para testes
 * unitários: valida contra o contrato como o real e guarda o que foi publicado.
 * `failNextWith(error)` simula broker fora / timeout de confirm.
 */
export class RecordingEventPublisher implements EventPublisher, RawMessagePublisher {
  readonly published: RecordedEvent[] = [];
  readonly rawMessages: OutgoingMessage[] = [];
  private failures: Error[] = [];

  /** Faz as próximas N publicações (uma por chamada) rejeitarem com os erros informados. */
  failNextWith(...errors: Error[]): this {
    this.failures.push(...errors);
    return this;
  }

  publishEvent(event: EventEnvelope<string, unknown>, options: PublishEventOptions = {}) {
    const failure = this.takeFailure();
    if (failure !== undefined) return Promise.reject(failure);
    if (!isEventType(event.type)) {
      return Promise.reject(new InvalidEventError(String(event.type), 'type fora de EVENT_TYPES'));
    }
    const parsed = parseEvent(EVENT_SCHEMAS[event.type], event);
    if (!parsed.success) return Promise.reject(new InvalidEventError(event.type, parsed.error));
    this.published.push({ event: parsed.event, options });
    return Promise.resolve();
  }

  publish(message: OutgoingMessage): Promise<void> {
    const failure = this.takeFailure();
    if (failure !== undefined) return Promise.reject(failure);
    this.rawMessages.push(message);
    return Promise.resolve();
  }

  /** Eventos publicados, na ordem. */
  get events(): FiapxEvent[] {
    return this.published.map((recorded) => recorded.event);
  }

  /** Eventos publicados de um `type`. */
  ofType<K extends EventType>(type: K): Extract<FiapxEvent, { type: K }>[] {
    return this.events.filter(
      (event): event is Extract<FiapxEvent, { type: K }> => event.type === type,
    );
  }

  clear(): void {
    this.published.length = 0;
    this.rawMessages.length = 0;
    this.failures = [];
  }

  private takeFailure(): Error | undefined {
    return this.failures.shift();
  }
}
