import type { ConsumeMessage } from 'amqplib';
import type { MessageContext } from '../consumer/consumer.types';
import type { AckChannel } from '../consumer/consumer-runner';
import type { MessageHeaders } from '../headers';

interface EnvelopeLike {
  id: string;
  type: string;
  correlationId: string;
}

/** Contexto de entrega para chamar `definition.handle(event, context)` direto no teste. */
export function messageContext(
  event: EnvelopeLike,
  overrides: Partial<MessageContext> = {},
): MessageContext {
  return {
    queue: 'test.queue',
    messageId: event.id,
    correlationId: event.correlationId,
    retryCount: 0,
    deliveryCount: 0,
    redelivered: false,
    deathReason: undefined,
    headers: {},
    ...overrides,
  };
}

export interface ConsumeMessageOptions {
  headers?: MessageHeaders;
  redelivered?: boolean;
  /** Corpo cru (ex.: JSON inválido) em vez do envelope serializado. */
  rawContent?: Buffer;
}

/** Entrega amqplib com o envelope serializado e as propriedades que o publicador real grava. */
export function consumeMessageFor(
  event: EnvelopeLike,
  options: ConsumeMessageOptions = {},
): ConsumeMessage {
  return {
    content: options.rawContent ?? Buffer.from(JSON.stringify(event)),
    fields: {
      deliveryTag: 1,
      redelivered: options.redelivered ?? false,
      exchange: 'fiapx.events',
      routingKey: event.type,
      consumerTag: 'test',
    },
    properties: {
      contentType: 'application/json',
      contentEncoding: undefined,
      headers: { 'x-correlation-id': event.correlationId, ...options.headers },
      deliveryMode: 2,
      priority: undefined,
      correlationId: event.correlationId,
      replyTo: undefined,
      expiration: undefined,
      messageId: event.id,
      timestamp: Math.floor(Date.now() / 1000),
      type: event.type,
      userId: undefined,
      appId: 'test',
      clusterId: undefined,
    },
  };
}

/** Canal que só registra ack/nack/reject (para `ConsumerRunner.handleDelivery`). */
export class RecordingAckChannel implements AckChannel {
  readonly acks: ConsumeMessage[] = [];
  readonly deadLettered: ConsumeMessage[] = [];
  readonly requeued: ConsumeMessage[] = [];

  ack(message: ConsumeMessage): void {
    this.acks.push(message);
  }

  nack(message: ConsumeMessage, _allUpTo?: boolean, requeue?: boolean): void {
    (requeue === false ? this.deadLettered : this.requeued).push(message);
  }

  reject(message: ConsumeMessage, requeue?: boolean): void {
    (requeue === false ? this.deadLettered : this.requeued).push(message);
  }
}
