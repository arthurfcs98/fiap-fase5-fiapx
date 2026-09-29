import { DependencyUnavailableError, isConnectivityError, NonRetryableError } from '@fiapx/common';
import { parseEvent } from '@fiapx/contracts';
import { runWithCorrelation } from '@fiapx/observability';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { z } from 'zod';
import type { AmqpConnection } from '../connection/amqp-connection';
import type { MessageHeaders } from '../headers';
import {
  effectiveRetryCount,
  MESSAGE_HEADERS,
  readDeliveryCount,
  readOriginDeathReason,
  RETRY_EXPIRED_REASON,
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
  /**
   * Declara a topologia de novo antes de re-assinar um consumer cancelado pelo broker (a fila
   * pode ter sido apagada e recriada). Sem ele, só tenta consumir de novo.
   */
  ensureTopology?: () => Promise<void>;
  /** Padrão do módulo para {@link ConsumerDefinition.shutdownTimeoutMs}. Padrão: 30 s. */
  shutdownTimeoutMs?: number;
  /** Tempos (testes). Padrões em {@link DEFAULT_TIMINGS}. */
  timings?: Partial<ConsumerTimings>;
  /** Relógio (testes). */
  now?: () => number;
}

export interface ConsumerTimings {
  /** 1ª pausa depois de uma dependência fora; dobra a cada pausa seguida. */
  pauseInitialMs: number;
  /** Teto da pausa. */
  pauseMaxMs: number;
  /** 1ª tentativa de re-assinar um consumer cancelado pelo broker; dobra a cada falha. */
  resubscribeInitialMs: number;
  resubscribeMaxMs: number;
  /**
   * Sem consumer ativo por mais que isto, com o broker conectado e sem pausa proposital, o
   * `/health` do serviço falha (o Kubernetes reinicia o pod).
   */
  unhealthyAfterMs: number;
}

export const DEFAULT_TIMINGS: Readonly<ConsumerTimings> = {
  pauseInitialMs: 5_000,
  pauseMaxMs: 60_000,
  resubscribeInitialMs: 1_000,
  resubscribeMaxMs: 30_000,
  unhealthyAfterMs: 60_000,
};

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

/** Motivo do abort das entregas de um canal que fechou. */
export class ChannelClosedError extends Error {
  constructor(queue: string) {
    super(`Canal AMQP de ${queue} fechado: o broker reentrega as mensagens sem ack`);
    this.name = 'ChannelClosedError';
  }
}

/** Sinal que nunca aborta (entregas chamadas direto, ex.: testes). */
const NEVER_ABORTED = new AbortController().signal;

/**
 * Executa um {@link ConsumerDefinition} numa fila, aplicando as regras de consumo do contrato
 * (corrige o requeue infinito da Fase 4):
 *
 * 1. ack só depois do efeito (`handle` resolveu);
 * 2. `RetryableError` (ou erro desconhecido): retries do ciclo atual `< 3` → cópia em
 *    `<fila>.retry.<n+1>` pela default exchange (confirm) com `x-retry-count = n+1`, depois ack;
 *    esgotou → `nack(requeue=false)` → DLX. Mensagem que chegou por dead-letter começa do 0;
 * 2b. dependência fora (`DependencyUnavailableError` ou erro de conexão): `nack(requeue=true)`
 *    (no RabbitMQ 4.3 não conta no `x-delivery-limit`) e o consumo PAUSA com backoff (5 s → 60 s):
 *    uma queda longa do Postgres não queima os retries de todas as mensagens;
 * 3. `NonRetryableError`: `onPermanentFailure` + ack; envelope inválido → `nack(requeue=false)`;
 * 4. crash (canal fechado sem ack): o broker reentrega; `x-delivery-limit` evita loop infinito.
 *    Se a cópia de retry não for confirmada, `reject(requeue=true)`: no RabbitMQ 4.3 o
 *    `basic.reject` conta no `x-delivery-limit` (o `basic.nack` com requeue não conta).
 *
 * Robustez a quedas do broker:
 * - cada entrega recebe um `signal` que aborta quando o SEU canal fecha. Depois disso o runner
 *   não confirma nem publica nada (o broker já vai reentregar), e o handler deve parar;
 * - entregas com o mesmo `messageId` rodam uma depois da outra no processo (a reentrega espera a
 *   entrega antiga, abortada, terminar): nunca dois jobs da mesma mensagem ao mesmo tempo;
 * - consumer cancelado pelo broker (fila apagada/recriada, `consumer_timeout`) é re-assinado
 *   (topologia declarada de novo antes); {@link isHealthy} fica falso se ele não voltar.
 *
 * O handler roda em `runWithCorrelation(event.correlationId)`: logs e publicações feitos por
 * ele carregam o correlation id da requisição original.
 */
export class ConsumerRunner<TSchema extends z.ZodType<ConsumableEvent>> {
  private readonly logger: MessagingLogger;
  private readonly prefetch: number;
  private readonly timings: ConsumerTimings;
  private readonly now: () => number;
  private readonly inFlight = new Set<Promise<void>>();
  /** Última entrega de cada `messageId` ainda em andamento (serialização por mensagem). */
  private readonly byMessageId = new Map<string, Promise<void>>();
  private wrapper?: ChannelWrapper;
  /** Canal da conexão atual (do último `setup`) e o sinal que aborta quando ele fecha. */
  private channel?: { channel: Channel; signal: AbortSignal };
  private consumer?: { channel: Channel; consumerTag: string };
  private started = false;
  private stopping = false;
  private paused = false;
  private pauseDelayMs: number;
  private resumeTimer?: NodeJS.Timeout;
  private resubscribeTimer?: NodeJS.Timeout;
  /** Desde quando não há consumer ativo (`undefined` enquanto consome). */
  private noConsumerSince?: number;

  constructor(
    private readonly definition: ConsumerDefinition<TSchema>,
    private readonly deps: ConsumerRunnerDependencies,
  ) {
    this.logger = deps.logger ?? defaultLogger(`Consumer:${definition.queue}`);
    this.prefetch = definition.prefetch ?? 1;
    if (!Number.isInteger(this.prefetch) || this.prefetch < 1) {
      throw new RangeError(`prefetch inválido para ${definition.queue}: ${this.prefetch}`);
    }
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.now = deps.now ?? Date.now;
    this.pauseDelayMs = this.timings.pauseInitialMs;
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

  /** Consumo pausado de propósito (dependência fora), esperando o backoff. */
  get isPaused(): boolean {
    return this.paused;
  }

  /**
   * `false` quando o broker está conectado, o consumo não está pausado nem parando e mesmo assim
   * não há consumer há mais de `unhealthyAfterMs` (ex.: re-assinatura falhando). Vai para o
   * `/health` do serviço: o Kubernetes reinicia o pod. Broker fora não conta (reiniciar não
   * resolve e a reconexão é automática).
   */
  get isHealthy(): boolean {
    if (!this.started || this.stopping || this.paused || this.consumer) return true;
    if (!this.deps.connection.isConnected()) return true;
    const since = this.noConsumerSince;
    return since === undefined || this.now() - since < this.timings.unhealthyAfterMs;
  }

  /**
   * Registra o consumidor. Não bloqueia: sem conexão, começa a consumir quando o broker voltar
   * (e de novo a cada reconexão).
   */
  start(): void {
    if (this.wrapper) throw new Error(`Consumidor de ${this.queue} já iniciado`);
    this.stopping = false;
    this.started = true;
    this.noConsumerSince = this.now();
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
    clearTimeout(this.resumeTimer);
    clearTimeout(this.resubscribeTimer);
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
   * chamado pelo callback do `channel.consume`, com o sinal do canal que entregou.
   */
  async handleDelivery(
    channel: AckChannel,
    message: ConsumeMessage,
    signal: AbortSignal = NEVER_ABORTED,
  ): Promise<ConsumeResult> {
    const result = await this.process(channel, message, signal);
    this.deps.metrics?.consumed(this.queue, result);
    if (result === 'success') this.pauseDelayMs = this.timings.pauseInitialMs;
    return result;
  }

  private async setup(channel: Channel): Promise<void> {
    await this.deps.beforeConsume?.();
    if (this.stopping) return;
    const controller = new AbortController();
    channel.once('close', () => controller.abort(new ChannelClosedError(this.queue)));
    this.channel = { channel, signal: controller.signal };
    // O consumer anterior morreu com o canal antigo.
    this.consumer = undefined;
    this.noConsumerSince ??= this.now();
    clearTimeout(this.resubscribeTimer);
    await channel.prefetch(this.prefetch);
    if (this.paused) return; // o resume assina quando a pausa acabar
    await this.consume(channel, controller.signal);
  }

  private async consume(channel: Channel, signal: AbortSignal): Promise<void> {
    const { consumerTag } = await channel.consume(
      this.queue,
      (message) => this.onDelivery(channel, signal, message),
      { noAck: false },
    );
    this.consumer = { channel, consumerTag };
    this.noConsumerSince = undefined;
    this.logger.log(`Consumindo ${this.queue} (prefetch ${this.prefetch})`);
  }

  private onDelivery(channel: Channel, signal: AbortSignal, message: ConsumeMessage | null): void {
    if (message === null) {
      this.onBrokerCancel(channel);
      return;
    }
    const messageId = stringOrUndefined(message.properties.messageId);
    const previous = messageId ? this.byMessageId.get(messageId) : undefined;
    if (previous) {
      this.logger.warn({
        msg: 'Reentrega de uma mensagem ainda em processamento neste processo: espera a anterior terminar',
        queue: this.queue,
        messageId,
      });
    }
    const run = () => this.handleDelivery(channel, message, signal);
    const task: Promise<void> = (previous ? previous.then(run) : run())
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
        if (messageId && this.byMessageId.get(messageId) === task) {
          this.byMessageId.delete(messageId);
        }
      });
    this.inFlight.add(task);
    if (messageId) this.byMessageId.set(messageId, task);
  }

  private async process(
    channel: AckChannel,
    message: ConsumeMessage,
    signal: AbortSignal,
  ): Promise<ConsumeResult> {
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
      retryCount: effectiveRetryCount(headers),
      deliveryCount: readDeliveryCount(headers),
      redelivered: message.fields.redelivered,
      deathReason: readOriginDeathReason(headers),
      headers,
      signal,
    };

    return runWithCorrelation(event.correlationId, async () => {
      if (signal.aborted) return this.abandoned(context);
      try {
        await this.definition.handle(event, context);
      } catch (error) {
        if (signal.aborted) return this.abandoned(context, error);
        return this.onHandlerError(channel, message, event, context, error);
      }
      if (signal.aborted) return this.abandoned(context);
      this.settle(channel, message, 'ack');
      return 'success';
    });
  }

  private async onHandlerError(
    channel: AckChannel,
    message: ConsumeMessage,
    event: z.output<TSchema>,
    context: MessageContext,
    error: unknown,
  ): Promise<ConsumeResult> {
    if (isDependencyOutage(error)) return this.defer(channel, message, context, error);
    if (!(error instanceof NonRetryableError)) {
      return this.retryOrDeadLetter(channel, message, event, context, error);
    }

    try {
      if (this.definition.onPermanentFailure) {
        await this.definition.onPermanentFailure(event, error, context);
      }
    } catch (followUpError) {
      if (context.signal.aborted) return this.abandoned(context, followUpError);
      if (isDependencyOutage(followUpError)) {
        return this.defer(channel, message, context, followUpError);
      }
      this.logger.warn({
        msg: 'onPermanentFailure falhou; a mensagem segue o caminho de retry',
        queue: this.queue,
        messageId: context.messageId,
        error: describeError(followUpError),
      });
      return this.retryOrDeadLetter(channel, message, event, context, followUpError);
    }
    if (context.signal.aborted) return this.abandoned(context, error);
    this.logger.warn({
      msg: 'Falha permanente tratada como resultado de negócio (ack, sem retry)',
      queue: this.queue,
      messageId: context.messageId,
      code: error.appError.code,
      error: describeError(error),
    });
    this.settle(channel, message, 'ack');
    return 'permanent_failure';
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

    const origin =
      context.deathReason !== undefined && context.deathReason !== RETRY_EXPIRED_REASON
        ? { [MESSAGE_HEADERS.originDeathReason]: context.deathReason }
        : {};
    const headers = retryHeaders(
      {
        [MESSAGE_HEADERS.correlationId]: event.correlationId,
        ...stripBrokerHeaders(context.headers),
        ...origin,
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

  /** Regra 2b: devolve sem gastar retry nem delivery-limit e pausa o consumo. */
  private defer(
    channel: AckChannel,
    message: ConsumeMessage,
    context: MessageContext,
    error: unknown,
  ): ConsumeResult {
    this.settle(channel, message, 'defer');
    this.pause(context, error);
    return 'deferred';
  }

  private pause(context: MessageContext, error: unknown): void {
    if (this.stopping || this.paused) return;
    this.paused = true;
    const delayMs = this.pauseDelayMs;
    this.pauseDelayMs = Math.min(this.pauseDelayMs * 2, this.timings.pauseMaxMs);
    this.logger.warn({
      msg: `Dependência indisponível: consumo de ${this.queue} pausado por ${delayMs} ms (as mensagens voltam para a fila sem gastar retry)`,
      queue: this.queue,
      messageId: context.messageId,
      error: describeError(error),
    });
    const consumer = this.consumer;
    this.consumer = undefined;
    if (consumer) {
      consumer.channel.cancel(consumer.consumerTag).catch((cancelError: unknown) => {
        this.logger.warn({
          msg: 'Falha ao cancelar o consumer na pausa',
          error: describeError(cancelError),
        });
      });
    }
    this.resumeTimer = setTimeout(() => void this.resume(), delayMs);
    this.resumeTimer.unref();
  }

  private async resume(): Promise<void> {
    this.resumeTimer = undefined;
    if (this.stopping) return;
    this.paused = false;
    const current = this.channel;
    // Canal morto: o `setup` da reconexão assina de novo.
    if (!current || current.signal.aborted || this.consumer) return;
    try {
      await this.consume(current.channel, current.signal);
      this.logger.log(`Consumo de ${this.queue} retomado depois da pausa`);
    } catch (error) {
      this.logger.warn({
        msg: 'Falha ao retomar o consumo; nova tentativa em breve',
        queue: this.queue,
        error: describeError(error),
      });
      this.scheduleResubscribe(current.channel, 0);
    }
  }

  private onBrokerCancel(channel: Channel): void {
    if (this.consumer?.channel === channel) this.consumer = undefined;
    this.noConsumerSince ??= this.now();
    this.logger.warn({
      msg: 'Consumer cancelado pelo broker (fila apagada/recriada ou consumer_timeout); re-assinando',
      queue: this.queue,
    });
    if (this.stopping || this.paused) return;
    this.scheduleResubscribe(channel, 0);
  }

  private scheduleResubscribe(channel: Channel, attempt: number): void {
    clearTimeout(this.resubscribeTimer);
    const delayMs = Math.min(
      this.timings.resubscribeInitialMs * 2 ** attempt,
      this.timings.resubscribeMaxMs,
    );
    this.resubscribeTimer = setTimeout(() => void this.resubscribe(channel, attempt), delayMs);
    this.resubscribeTimer.unref();
  }

  private async resubscribe(channel: Channel, attempt: number): Promise<void> {
    const stillNeeded = () =>
      !this.stopping &&
      !this.paused &&
      this.consumer === undefined &&
      this.channel?.channel === channel &&
      !this.channel.signal.aborted;
    if (!stillNeeded()) return;
    try {
      await this.deps.ensureTopology?.();
      const current = this.channel;
      if (!stillNeeded() || !current) return;
      await this.consume(channel, current.signal);
      this.logger.log(`Consumer de ${this.queue} re-assinado`);
    } catch (error) {
      this.logger.warn({
        msg: 'Falha ao re-assinar o consumer; nova tentativa com backoff',
        queue: this.queue,
        attempt: attempt + 1,
        error: describeError(error),
      });
      this.scheduleResubscribe(channel, attempt + 1);
    }
  }

  private abandoned(context: MessageContext, error?: unknown): ConsumeResult {
    this.logger.warn({
      msg: 'Canal fechado durante o processamento: resultado descartado (sem ack nem publicação), o broker reentrega',
      queue: this.queue,
      messageId: context.messageId,
      ...(error === undefined ? {} : { error: describeError(error) }),
    });
    return 'aborted';
  }

  /** ack/nack/reject no canal que recebeu a mensagem; canal já fechado → o broker reentrega. */
  private settle(
    channel: AckChannel,
    message: ConsumeMessage,
    action: 'ack' | 'dead-letter' | 'requeue' | 'defer',
  ): void {
    try {
      if (action === 'ack') channel.ack(message);
      else if (action === 'dead-letter') channel.nack(message, false, false);
      else if (action === 'defer') channel.nack(message, false, true);
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

/** Regra 2b: falha da dependência inteira, não desta mensagem. */
export function isDependencyOutage(error: unknown): boolean {
  return error instanceof DependencyUnavailableError || isConnectivityError(error);
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
