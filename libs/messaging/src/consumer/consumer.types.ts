import type { NonRetryableError } from '@fiapx/common';
import type { z } from 'zod';
import type { MessageHeaders } from '../headers';

/** Metadados da entrega, passados ao handler junto com o evento já validado. */
export interface MessageContext {
  queue: string;
  /** AMQP `messageId` (= `event.id`): chave de idempotência (`processed_messages`). */
  messageId: string;
  correlationId: string;
  /**
   * Retries já feitos por falha transitória no ciclo atual (0 na 1ª tentativa). Mensagem que
   * chegou por dead-letter ou redrive de DLQ começa em 0 (`effectiveRetryCount`).
   */
  retryCount: number;
  /** `x-delivery-count` da quorum queue: devoluções por crash/canal fechado sem ack. */
  deliveryCount: number;
  redelivered: boolean;
  /**
   * Motivo do dead-letter que trouxe a mensagem (`rejected` = retries esgotados,
   * `delivery_limit` = crash em loop...) quando ela veio do DLX (ex.: `api.video-deadletter`),
   * preservado entre os retries (`readOriginDeathReason`). Nas filas comuns: `undefined` ou
   * `expired` (voltou de uma `.retry.N`).
   */
  deathReason?: string;
  headers: MessageHeaders;
  /**
   * Abortado quando o canal que entregou a mensagem fecha (queda do broker, reconexão): o
   * broker vai reentregá-la. O handler deve parar o trabalho em andamento (matar processos,
   * abortar uploads) e NUNCA publicar resultado depois disso; o runner não dá ack nem publica
   * cópia de retry de uma entrega abortada.
   */
  signal: AbortSignal;
}

/** Evento mínimo aceito pelo runner: o envelope do contrato. */
export interface ConsumableEvent {
  id: string;
  type: string;
  correlationId: string;
}

/**
 * Definição de um consumidor (uma por fila principal).
 *
 * Regras (contratos.md, seção 2): `handle` resolveu → ack. `RetryableError` ou erro
 * desconhecido → cópia na `.retry.N` + ack (esgotou → DLX). Dependência fora
 * (`DependencyUnavailableError` ou erro de conexão) → devolve à fila sem gastar retry e pausa o
 * consumo. `NonRetryableError` → `onPermanentFailure` (resultado de negócio) + ack. Envelope
 * inválido → DLX.
 */
export interface ConsumerDefinition<TSchema extends z.ZodType<ConsumableEvent>> {
  /** Fila principal (use `QUEUES.*`). */
  queue: string;
  /** Schema zod do envelope (ex.: `videoUploadedEvent`, `processingEvent`). */
  schema: TSchema;
  /** Mensagens não confirmadas por consumidor (padrão 1). */
  prefetch?: number;
  /**
   * Efeito durável da mensagem (commit no banco, zip gravado, e-mail enviado). Só depois dele o
   * runner dá ack. Roda dentro de `runWithCorrelation(event.correlationId)`.
   */
  handle(event: z.output<TSchema>, context: MessageContext): Promise<void>;
  /**
   * Falha permanente tratada como resultado de negócio (ex.: worker publica
   * `video.processing.failed`). Se ela própria falhar, a mensagem segue o caminho de retry.
   * Sem este callback, o runner só registra o erro e dá ack.
   */
  onPermanentFailure?(
    event: z.output<TSchema>,
    error: NonRetryableError,
    context: MessageContext,
  ): Promise<void>;
  /**
   * Quanto esperar as mensagens em processamento no shutdown antes de fechar o canal
   * (o broker reentrega o que ficar sem ack). Padrão: o do módulo (30 s).
   */
  shutdownTimeoutMs?: number;
  /** Timeout do confirm da cópia de retry. Padrão: o do publicador (5 s). */
  retryPublishTimeoutMs?: number;
}
