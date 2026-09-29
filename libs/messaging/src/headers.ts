/** Headers AMQP padronizados (contratos.md, seção 2). */
export const MESSAGE_HEADERS = {
  correlationId: 'x-correlation-id',
  retryCount: 'x-retry-count',
  lastError: 'x-last-error',
  /**
   * Motivo do dead-letter que trouxe a mensagem para a fila atual (`rejected`,
   * `delivery_limit`...), guardado na cópia de retry: o `x-death` da cópia é zerado de propósito
   * e, ao voltar da `.retry.N`, o broker registra só `expired`.
   */
  originDeathReason: 'x-origin-death-reason',
} as const;

/** Motivo de dead-letter das filas `.retry.N` (TTL): não inicia um ciclo novo de retries. */
export const RETRY_EXPIRED_REASON = 'expired';

const LAST_ERROR_MAX_LENGTH = 256;

export type MessageHeaders = Record<string, unknown>;

/** Lê `x-retry-count` de forma tolerante (número, string numérica); inválido → 0. */
export function readRetryCount(headers: MessageHeaders | undefined): number {
  const raw = headers?.[MESSAGE_HEADERS.retryCount];
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Retries já feitos NO CICLO ATUAL da mensagem. O `x-retry-count` vale enquanto ela circula
 * entre a fila e as `.retry.N` (volta delas com `x-last-death-reason=expired`). Uma mensagem que
 * chegou por dead-letter (`rejected`, `delivery_limit`, ex.: em `api.video-deadletter`) ou por
 * redrive de uma DLQ começa um ciclo NOVO (0): o `x-retry-count` herdado é da fila de origem, e
 * sem isso a primeira falha transitória iria direto para a DLQ.
 */
export function effectiveRetryCount(headers: MessageHeaders | undefined): number {
  const reason = readLastDeathReason(headers);
  if (reason !== undefined && reason !== RETRY_EXPIRED_REASON) return 0;
  return readRetryCount(headers);
}

/**
 * Motivo do dead-letter que trouxe a mensagem ao ciclo atual: o `x-last-death-reason` quando não
 * é `expired`; depois de um retry (a cópia volta da `.retry.N` como `expired`), o
 * `x-origin-death-reason` gravado na cópia; senão o próprio `x-last-death-reason` (ou nada).
 */
export function readOriginDeathReason(headers: MessageHeaders | undefined): string | undefined {
  const last = readLastDeathReason(headers);
  if (last !== undefined && last !== RETRY_EXPIRED_REASON) return last;
  const origin = headers?.[MESSAGE_HEADERS.originDeathReason];
  if (typeof origin === 'string' && origin.length > 0) return origin;
  return last;
}

/**
 * Headers para a cópia publicada na fila `.retry.N`: `x-retry-count` recebe o novo valor e
 * `x-last-error` a causa (truncada). Não altera o objeto original.
 */
export function retryHeaders(
  headers: MessageHeaders | undefined,
  nextRetryCount: number,
  lastError: string,
): MessageHeaders {
  return {
    ...headers,
    [MESSAGE_HEADERS.retryCount]: nextRetryCount,
    [MESSAGE_HEADERS.lastError]: lastError.slice(0, LAST_ERROR_MAX_LENGTH),
  };
}

/**
 * Headers que só o broker deve escrever (histórico de dead-letter e contadores das quorum
 * queues). São removidos da cópia publicada na `.retry.N`: assim o `x-death` da mensagem reflete
 * só o que o broker registrou, sem herdar entradas copiadas pelo cliente.
 */
export const BROKER_MANAGED_HEADERS = [
  'x-death',
  'x-first-death-queue',
  'x-first-death-reason',
  'x-first-death-exchange',
  'x-last-death-queue',
  'x-last-death-reason',
  'x-last-death-exchange',
  'x-delivery-count',
  'x-acquired-count',
] as const;

/** Cópia dos headers sem os {@link BROKER_MANAGED_HEADERS}. */
export function stripBrokerHeaders(headers: MessageHeaders | undefined): MessageHeaders {
  const copy: MessageHeaders = { ...headers };
  for (const name of BROKER_MANAGED_HEADERS) delete copy[name];
  return copy;
}

/**
 * `x-delivery-count` das quorum queues: devoluções malsucedidas já contadas pelo broker
 * (crash/canal fechado sem ack, `basic.reject`). Ausente ou inválido = 0.
 */
export function readDeliveryCount(headers: MessageHeaders | undefined): number {
  const raw = headers?.['x-delivery-count'];
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : 0;
}

/**
 * Motivo da morte MAIS RECENTE de uma mensagem vinda do DLX (`rejected`, `delivery_limit`,
 * `expired`...): `x-last-death-reason` e, na falta dele, a 1ª entrada de `x-death` (a mais
 * recente). Nunca usa `x-first-death-reason`, que acumula os `expired` das filas `.retry.N`.
 */
export function readLastDeathReason(headers: MessageHeaders | undefined): string | undefined {
  const last = headers?.['x-last-death-reason'];
  if (typeof last === 'string' && last.length > 0) return last;
  const deaths = headers?.['x-death'];
  if (!Array.isArray(deaths) || deaths.length === 0) return undefined;
  const first: unknown = deaths[0];
  if (typeof first !== 'object' || first === null) return undefined;
  const reason = (first as Record<string, unknown>)['reason'];
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
}
