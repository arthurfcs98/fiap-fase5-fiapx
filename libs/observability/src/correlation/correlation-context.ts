import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { CORRELATION_ID_MAX_LENGTH } from '@fiapx/contracts';

/** Header HTTP (e, na E2, header AMQP) que carrega o correlation id entre serviços. */
export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Ids aceitos de fora: sem caracteres de controle (evita log/header injection) e com no máximo
 * {@link CORRELATION_ID_MAX_LENGTH} caracteres, o tamanho da coluna
 * `outbox_events.correlation_id` (um id maior quebraria o INSERT do outbox no upload).
 */
const SAFE_CORRELATION_ID = new RegExp(`^[A-Za-z0-9._:-]{1,${CORRELATION_ID_MAX_LENGTH}}$`);

export interface CorrelationContext {
  correlationId: string;
}

export const correlationStorage = new AsyncLocalStorage<CorrelationContext>();

/** Correlation id do contexto assíncrono atual (request HTTP ou mensagem em processamento). */
export function getCorrelationId(): string | undefined {
  return correlationStorage.getStore()?.correlationId;
}

/**
 * Executa `fn` dentro de um contexto de correlação. Usado pelos consumidores de fila (E2):
 * `runWithCorrelation(msg.properties.correlationId, () => handler(msg))` faz todos os logs
 * e publicações feitos pelo handler carregarem o mesmo id da requisição original.
 */
export function runWithCorrelation<T>(correlationId: string | undefined, fn: () => T): T {
  return correlationStorage.run({ correlationId: resolveCorrelationId(correlationId) }, fn);
}

/** Reaproveita o id recebido se for seguro; caso contrário gera um UUID novo. */
export function resolveCorrelationId(candidate: unknown): string {
  const value = Array.isArray(candidate) ? (candidate as unknown[])[0] : candidate;
  return typeof value === 'string' && SAFE_CORRELATION_ID.test(value) ? value : randomUUID();
}
