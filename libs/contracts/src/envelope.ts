import { randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Envelope comum a todo evento (docs/arquitetura/contratos.md, seção 2).
 * `id` também vai no `messageId` do AMQP e é a chave de idempotência do consumidor;
 * `type` é igual à routing key; `correlationId` atravessa HTTP → outbox → AMQP → worker → e-mail.
 */
export interface EventEnvelope<TType extends string, TPayload> {
  id: string;
  type: TType;
  version: 1;
  occurredAt: string;
  correlationId: string;
  payload: TPayload;
}

/**
 * Tamanho máximo do correlation id em todo o sistema: é o tamanho da coluna
 * `outbox_events.correlation_id varchar(100)` (contratos.md, seção 5). O resolvedor HTTP/AMQP
 * de `@fiapx/observability` usa o mesmo limite, então um id aceito na borda sempre cabe no outbox.
 */
export const CORRELATION_ID_MAX_LENGTH = 100;

/** Schema zod de um envelope com `type` fixo e `payload` tipado. */
export function eventEnvelopeSchema<TType extends string, TPayload extends z.ZodType>(
  type: TType,
  payload: TPayload,
) {
  return z.object({
    id: z.uuid(),
    type: z.literal(type),
    version: z.literal(1),
    occurredAt: z.iso.datetime(),
    correlationId: z.string().min(1).max(CORRELATION_ID_MAX_LENGTH),
    payload,
  });
}

export interface CreateEnvelopeParams<TType extends string, TPayload> {
  type: TType;
  payload: TPayload;
  correlationId: string;
  /** Padrão: UUID v4 aleatório. */
  id?: string;
  now?: () => Date;
}

export function createEnvelope<TType extends string, TPayload>(
  params: CreateEnvelopeParams<TType, TPayload>,
): EventEnvelope<TType, TPayload> {
  return {
    id: params.id ?? randomUUID(),
    type: params.type,
    version: 1,
    occurredAt: (params.now ?? (() => new Date()))().toISOString(),
    correlationId: params.correlationId,
    payload: params.payload,
  };
}

export type ParseEventResult<T> = { success: true; event: T } | { success: false; error: string };

/**
 * Valida o corpo de uma mensagem (Buffer/string JSON ou objeto já decodificado).
 * Envelope inválido é falha PERMANENTE: o consumidor faz `nack(requeue=false)`.
 */
export function parseEvent<S extends z.ZodType>(
  schema: S,
  body: unknown,
): ParseEventResult<z.output<S>> {
  let candidate: unknown = body;
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    try {
      candidate = JSON.parse(body.toString()) as unknown;
    } catch {
      return { success: false, error: 'corpo da mensagem não é JSON válido' };
    }
  }

  const result = schema.safeParse(candidate);
  if (result.success) return { success: true, event: result.data };
  return {
    success: false,
    error: result.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(raiz)'}: ${issue.message}`)
      .join('; '),
  };
}
