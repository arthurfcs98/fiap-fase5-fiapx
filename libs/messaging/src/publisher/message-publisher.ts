import type { EventEnvelope } from '@fiapx/contracts';
import { EVENT_SCHEMAS, isEventType, parseEvent } from '@fiapx/contracts';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { Channel, Message } from 'amqplib';
import type { AmqpConnection } from '../connection/amqp-connection';
import type { MessageHeaders } from '../headers';
import { MESSAGE_HEADERS } from '../headers';
import { InvalidEventError, PublishError, UnroutableMessageError } from '../messaging.errors';
import type { MessagingLogger } from '../messaging.logger';
import { defaultLogger } from '../messaging.logger';
import { EXCHANGES } from '../topology';
import type { EventPublisher } from './event-publisher.port';

/** Mensagem pronta para publicar (corpo já serializado). */
export interface OutgoingMessage {
  /** `''` = default exchange (publicação direta numa fila, ex.: `.retry.N`). */
  exchange: string;
  routingKey: string;
  content: Buffer;
  /** Obrigatório: vira o AMQP `messageId` (chave de idempotência do consumidor). */
  messageId: string;
  correlationId: string;
  /** AMQP `type` (= type do evento / routing key). */
  type: string;
  headers?: MessageHeaders;
  /** Momento do evento (ms). Vai no AMQP `timestamp` em segundos. Padrão: agora. */
  timestampMs?: number;
  /** Timeout do publisher confirm desta publicação. */
  timeoutMs?: number;
}

export interface PublishEventOptions {
  /** Padrão: `fiapx.events`. */
  exchange?: string;
  /** Padrão: `event.type` (routing key = type do evento). */
  routingKey?: string;
  /** Headers extras (o `x-correlation-id` é sempre gravado). */
  headers?: MessageHeaders;
  timeoutMs?: number;
}

export interface MessagePublisherOptions {
  /** Timeout padrão do publisher confirm. Padrão: 5 s. */
  confirmTimeoutMs?: number;
  /** AMQP `appId` (nome do serviço). */
  appId?: string;
  /** Espera antes de liberar publicações a cada (re)conexão (ex.: topologia declarada). */
  beforePublish?: () => Promise<void>;
  logger?: MessagingLogger;
}

/** Contrato mínimo de publicação usado pelo {@link ConsumerRunner} (cópias de retry). */
export interface RawMessagePublisher {
  publish(message: OutgoingMessage): Promise<void>;
}

const DEFAULT_CONFIRM_TIMEOUT_MS = 5_000;

/**
 * Publicador com as garantias da regra 5 do contrato: publisher confirms (a promessa só resolve
 * depois do `basic.ack` do broker), `persistent`, `mandatory` (sem fila de destino →
 * {@link UnroutableMessageError}, nunca descarte silencioso), `messageId`, `correlationId`,
 * `type`, `contentType: application/json`, `timestamp` e header `x-correlation-id`.
 *
 * Sem conexão, a publicação fica em buffer no `amqp-connection-manager` até o timeout do
 * confirm; depois disso rejeita com {@link PublishError} (o outbox tenta de novo mais tarde).
 */
export class MessagePublisher implements EventPublisher, RawMessagePublisher {
  private readonly channel: ChannelWrapper;
  private readonly confirmTimeoutMs: number;
  private readonly logger: MessagingLogger;
  /** messageIds devolvidos pelo broker (`basic.return`) aguardando a conferência do confirm. */
  private readonly returned = new Map<string, number>();

  constructor(
    connection: AmqpConnection,
    private readonly options: MessagePublisherOptions = {},
  ) {
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    this.logger = options.logger ?? defaultLogger(MessagePublisher.name);
    this.channel = connection.createChannel({
      name: 'publisher',
      confirm: true,
      publishTimeoutMs: this.confirmTimeoutMs,
      setup: async (channel: Channel) => {
        channel.on('return', (message: Message) => this.onReturn(message));
        await options.beforePublish?.();
      },
    });
  }

  /**
   * Valida o envelope com o schema do contrato (`EVENT_SCHEMAS[event.type]`) e publica no
   * `fiapx.events` com routing key = `event.type`. Resolve só após o confirm do broker.
   *
   * @throws InvalidEventError envelope fora do contrato (nada é publicado)
   * @throws UnroutableMessageError nenhuma fila ligada à routing key
   * @throws PublishError nack do broker, timeout do confirm ou canal fechado
   */
  async publishEvent(
    event: EventEnvelope<string, unknown>,
    options: PublishEventOptions = {},
  ): Promise<void> {
    if (!isEventType(event.type)) {
      throw new InvalidEventError(String(event.type), 'type fora de EVENT_TYPES');
    }
    const parsed = parseEvent(EVENT_SCHEMAS[event.type], event);
    if (!parsed.success) throw new InvalidEventError(event.type, parsed.error);

    const valid = parsed.event;
    await this.publish({
      exchange: options.exchange ?? EXCHANGES.events,
      routingKey: options.routingKey ?? valid.type,
      content: Buffer.from(JSON.stringify(valid)),
      messageId: valid.id,
      correlationId: valid.correlationId,
      type: valid.type,
      headers: { ...options.headers, [MESSAGE_HEADERS.correlationId]: valid.correlationId },
      timestampMs: Date.parse(valid.occurredAt),
      timeoutMs: options.timeoutMs,
    });
  }

  /** Publicação de baixo nível (corpo já serializado), com as mesmas garantias. */
  async publish(message: OutgoingMessage): Promise<void> {
    const { exchange, routingKey, messageId } = message;
    try {
      await this.channel.publish(exchange, routingKey, message.content, {
        persistent: true,
        mandatory: true,
        contentType: 'application/json',
        messageId,
        correlationId: message.correlationId,
        type: message.type,
        appId: this.options.appId,
        timestamp: Math.floor((message.timestampMs ?? Date.now()) / 1000),
        headers: message.headers ?? {},
        timeout: message.timeoutMs ?? this.confirmTimeoutMs,
      });
    } catch (error) {
      this.takeReturned(messageId);
      throw new PublishError(exchange, routingKey, { cause: error });
    }
    // O `basic.return` chega antes do `basic.ack` no mesmo canal: se a mensagem voltou, já está
    // registrada aqui quando o confirm resolve.
    if (this.takeReturned(messageId)) throw new UnroutableMessageError(exchange, routingKey);
  }

  async close(): Promise<void> {
    await this.channel.close();
  }

  private onReturn(message: Message): void {
    const messageId = message.properties.messageId as string | undefined;
    this.logger.warn({
      msg: 'Mensagem devolvida pelo broker (sem fila de destino)',
      exchange: message.fields.exchange,
      routingKey: message.fields.routingKey,
      messageId,
    });
    if (messageId) this.returned.set(messageId, (this.returned.get(messageId) ?? 0) + 1);
  }

  private takeReturned(messageId: string): boolean {
    const count = this.returned.get(messageId);
    if (!count) return false;
    if (count === 1) this.returned.delete(messageId);
    else this.returned.set(messageId, count - 1);
    return true;
  }
}
