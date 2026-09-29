import { NonRetryableError } from '@fiapx/common';
import { parseEvent } from '@fiapx/contracts';
import { runWithCorrelation } from '@fiapx/observability';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { z } from 'zod';
import type { AmqpConnection } from '../connection/amqp-connection';
import type { MessageHeaders } from '../headers';
import {
  MESSAGE_HEADERS,
  readDeliveryCount,
  readLastDeathReason,
  readRetryCount,
  retryHeaders,
  stripBrokerHeaders,
} from '../headers';
import type { MessagingLogger } from '../messaging.logger';
import { defaultLogger, describeError } from '../messaging.logger';
import type { ConsumeResult, MessagingMetrics } from '../messaging.metrics';
import type { RawMessagePublisher } from '../publisher/message-publisher';
import { decideRetry } from '../retry-decision';
import { MAX_RETRIES } from '../topology';
import type { ConsumableEvent, ConsumerDefinition, MessageContext } from './consumer.types';

/** Parte do canal amqplib usada para confirmar a entrega (sempre no canal que a recebeu). */
export type AckChannel = Pick<Channel, 'ack' | 'nack' | 'reject'>;

export interface ConsumerRunnerDependencies {
  connection: AmqpConnection;
  /** Publica a cópia de retry com confirm (normalmente o `MessagePublisher` do serviço). */
  publisher: RawMessagePublisher;
  metrics?: MessagingMetrics;
  logger?: MessagingLogger;
  /** Espera antes de consumir a cada (re)conexão (ex.: topologia declarada). */
  beforeConsume?: () => Promise<void>;
  /** Padrão do módulo para {@link ConsumerDefinition.shutdownTimeoutMs}. Padrão: 30 s. */
  shutdownTimeoutMs?: number;
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Executa um {@link ConsumerDefinition} numa fila, aplicando as regras de consumo do contrato
 * (corrige o requeue infinito da Fase 4):
 *
 * 1. ack só depois do efeito (`handle` resolveu);
 * 2. `RetryableError` (ou erro desconhecido): `x-retry-count < 3` → cópia em
 *    `<fila>.retry.<n+1>` pela default exchange (confirm) com `x-retry-count = n+1`, depois ack;
 *    esgotou → `nack(requeue=false)` → DLX;
 * 3. `NonRetryableError`: `onPermanentFailure` + ack; envelope inválido → `nack(requeue=false)`;
 * 4. crash (canal fechado sem ack): o broker reentrega; `x-delivery-limit` evita loop infinito.
 *    Se a cópia de retry não for confirmada, `reject(requeue=true)`: no RabbitMQ 4.3 o
 *    `basic.reject` conta no `x-delivery-limit` (o `basic.nack` com requeue não conta).
 *
 * O handler roda em `runWithCorrelation(event.correlationId)`: logs e publicações feitos por
 * ele carregam o correlation id da requisição original.
 */
export class ConsumerRunner<TSchema extends z.ZodType<ConsumableEvent>> {
  private readonly logger: MessagingLogger;
  private readonly prefetch: number;
  private readonly inFlight = new Set<Promise<void>>();
  private wrapper?: ChannelWrapper;
  private consumer?: { channel: Channel; consumerTag: string };
  private stopping = false;

  constructor(
    private readonly definition: ConsumerDefinition<TSchema>,
    private readonly deps: ConsumerRunnerDependencies,
  ) {
    this.logger = deps.logger ?? defaultLogger(`Consumer:${definition.queue}`);
    this.prefetch = definition.prefetch ?? 1;
    if (!Number.isInteger(this.prefetch) || this.prefetch < 1) {
      throw new RangeError(`prefetch inválido para ${definition.queue}: ${this.prefetch}`);
    }
  }

  get queue(): string {
    return this.definition.queue;
  }

  /** Mensagens recebidas e ainda não confirmadas por este consumidor. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** `true` enquanto houver um consumer ativo no broker. */
  get isConsuming(): boolean {
    return this.consumer !== undefined && !this.stopping;
  }

  /**
   * Registra o consumidor. Não bloqueia: sem conexão, começa a consumir quando o broker voltar
   * (e de novo a cada reconexão).
   */
  start(): void {
    if (this.wrapper) throw new Error(`Consumidor de ${this.queue} já iniciado`);
    this.stopping = false;
    this.wrapper = this.deps.connection.createChannel({
      name: `consumer:${this.queue}`,
      confirm: false,
      setup: (channel) => this.setup(channel),
    });
  }

  /**
   * Graceful shutdown: cancela o consumer (o broker para de entregar), espera as mensagens em
   * processamento até o timeout e fecha o canal. O que ficar sem ack volta para a fila.
   */
  async stop(timeoutMs?: number): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    const consumer = this.consumer;
    this.consumer = undefined;
    if (consumer) {
      try {
        await consumer.channel.cancel(consumer.consumerTag);
      } catch (error) {
        this.logger.warn({ msg: 'Falha ao cancelar o consumer', error: describeError(error) });
      }
    }

    const limit =
      timeoutMs ??
      this.definition.shutdownTimeoutMs ??
      this.deps.shutdownTimeoutMs ??
      DEFAULT_SHUTDOWN_TIMEOUT_MS;
    const drained = await waitAll([...this.inFlight], limit);
    if (!drained) {
      this.logger.warn({
        msg: `${this.inFlight.size} mensagem(ns) ainda em processamento após ${limit} ms; o broker reentrega`,
        queue: this.queue,
      });
    }

    const wrapper = this.wrapper;
    this.wrapper = undefined;
    await wrapper?.close().catch(() => undefined);
    this.logger.log(`Consumidor de ${this.queue} encerrado`);
  }

  /**
   * Processa UMA entrega e confirma no canal de origem. Público para testes; em produção é
   * chamado pelo callback do `channel.consume`.
   */
  async handleDelivery(channel: AckChannel, message: ConsumeMessage): Promise<ConsumeResult> {
    const result = await this.process(channel, message);
    this.deps.metrics?.consumed(this.queue, result);
    return result;
  }

  private async setup(channel: Channel): Promise<void> {
    await this.deps.beforeConsume?.();
    if (this.stopping) return;
    await channel.prefetch(this.prefetch);
    const { consumerTag } = await channel.consume(
      this.queue,
      (message) => this.onDelivery(channel, message),
      { noAck: false },
    );
    this.consumer = { channel, consumerTag };
    this.logger.log(`Consumindo ${this.queue} (prefetch ${this.prefetch})`);
  }

  private onDelivery(channel: Channel, message: ConsumeMessage | null): void {
    if (message === null) {
      // Consumer cancelado pelo broker (ex.: fila apagada). Volta na próxima reconexão.
      this.logger.warn({ msg: 'Consumer cancelado pelo broker', queue: this.queue });
      this.consumer = undefined;
      return;
    }
    const task = this.handleDelivery(channel, message)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.logger.error({
          msg: 'Erro inesperado no processamento da mensagem',
          queue: this.queue,
          error: describeError(error),
        });
      })
      .finally(() => {
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
  }

  private async process(channel: AckChannel, message: ConsumeMessage): Promise<ConsumeResult> {
    const headers: MessageHeaders = message.properties.headers ?? {};
    const parsed = parseEvent(this.definition.schema, message.content);

    if (!parsed.success) {
      const candidate: unknown =
        message.properties.correlationId ?? headers[MESSAGE_HEADERS.correlationId];
      return runWithCorrelation(stringOrUndefined(candidate), () => {
        this.logger.warn({
          msg: 'Envelope inválido: mensagem enviada ao DLX sem retry',
          queue: this.queue,
          messageId: stringOrUndefined(message.properties.messageId),
          reason: parsed.error,
        });
        this.settle(channel, message, 'dead-letter');
        return 'invalid' as const;
      });
    }

    const event = parsed.event;
    const context: MessageContext = {
      queue: this.queue,
      messageId: stringOrUndefined(message.properties.messageId) ?? event.id,
      correlationId: event.correlationId,
      retryCount: readRetryCount(headers),
      deliveryCount: readDeliveryCount(headers),
      redelivered: message.fields.redelivered,
      deathReason: readLastDeathReason(headers),
      headers,
    };

    return runWithCorrelation(event.correlationId, async () => {
      try {
        await this.definition.handle(event, context);
        this.settle(channel, message, 'ack');
        return 'success';
      } catch (error) {
        return this.onHandlerError(channel, message, event, context, error);
      }
    });
  }

  private async onHandlerError(
    channel: AckChannel,
    message: ConsumeMessage,
    event: z.output<TSchema>,
    context: MessageContext,
    error: unknown,
  ): Promise<ConsumeResult> {
    if (!(error instanceof NonRetryableError)) {
      return this.retryOrDeadLetter(channel, message, event, context, error);
    }

    try {
      if (this.definition.onPermanentFailure) {
        await this.definition.onPermanentFailure(event, error, context);
      }
      this.logger.warn({
        msg: 'Falha permanente tratada como resultado de negócio (ack, sem retry)',
        queue: this.queue,
        messageId: context.messageId,
        code: error.appError.code,
        error: describeError(error),
      });
      this.settle(channel, message, 'ack');
      return 'permanent_failure';
    } catch (followUpError) {
      this.logger.warn({
        msg: 'onPermanentFailure falhou; a mensagem segue o caminho de retry',
        queue: this.queue,
        messageId: context.messageId,
        error: describeError(followUpError),
      });
      return this.retryOrDeadLetter(channel, message, event, context, followUpError);
    }
  }

  private async retryOrDeadLetter(
    channel: AckChannel,
    message: ConsumeMessage,
    event: z.output<TSchema>,
    context: MessageContext,
    error: unknown,
  ): Promise<ConsumeResult> {
    const decision = decideRetry(this.queue, context.retryCount);
    if (decision.action === 'dead-letter') {
      this.logger.error({
        msg: `Retries esgotados (${MAX_RETRIES}); mensagem enviada ao DLX`,
        queue: this.queue,
        messageId: context.messageId,
        retryCount: context.retryCount,
        error: describeError(error),
      });
      this.settle(channel, message, 'dead-letter');
      return 'dead_letter';
    }

    const headers = retryHeaders(
      {
        [MESSAGE_HEADERS.correlationId]: event.correlationId,
        ...stripBrokerHeaders(context.headers),
      },
      decision.nextRetryCount,
      describeError(error),
    );
    const timestamp: unknown = message.properties.timestamp;
    try {
      await this.deps.publisher.publish({
        exchange: '',
        routingKey: decision.retryQueue,
        content: message.content,
        messageId: context.messageId,
        correlationId: event.correlationId,
        type: stringOrUndefined(message.properties.type) ?? event.type,
        headers,
        timestampMs: typeof timestamp === 'number' ? timestamp * 1000 : undefined,
        timeoutMs: this.definition.retryPublishTimeoutMs,
      });
    } catch (publishError) {
      this.logger.error({
        msg: 'Cópia de retry não confirmada pelo broker; mensagem devolvida à fila (reject)',
        queue: this.queue,
        messageId: context.messageId,
        error: describeError(publishError),
      });
      this.settle(channel, message, 'requeue');
      return 'requeued';
    }

    this.settle(channel, message, 'ack');
    this.logger.warn({
      msg: `Falha transitória; retry ${decision.nextRetryCount}/${MAX_RETRIES} em ${decision.delayMs} ms`,
      queue: this.queue,
      messageId: context.messageId,
      retryQueue: decision.retryQueue,
      error: describeError(error),
    });
    return 'retry';
  }

  /** ack/nack/reject no canal que recebeu a mensagem; canal já fechado → o broker reentrega. */
  private settle(
    channel: AckChannel,
    message: ConsumeMessage,
    action: 'ack' | 'dead-letter' | 'requeue',
  ): void {
    try {
      if (action === 'ack') channel.ack(message);
      else if (action === 'dead-letter') channel.nack(message, false, false);
      else channel.reject(message, true);
    } catch (error) {
      this.logger.warn({
        msg: `Não foi possível confirmar (${action}): canal fechado; o broker reentrega`,
        queue: this.queue,
        error: describeError(error),
      });
    }
  }
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Espera todas as promessas (que nunca rejeitam) até `timeoutMs`; `true` se terminaram. */
async function waitAll(tasks: Promise<void>[], timeoutMs: number): Promise<boolean> {
  if (tasks.length === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([Promise.all(tasks).then(() => true as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
