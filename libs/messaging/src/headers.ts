/** Headers AMQP padronizados. */
export const MESSAGE_HEADERS = {
  correlationId: 'x-correlation-id',
  retryCount: 'x-retry-count',
  lastError: 'x-last-error',
} as const;

const LAST_ERROR_MAX_LENGTH = 256;

export type MessageHeaders = Record<string, unknown>;

/** Lê `x-retry-count` de forma tolerante (número, string numérica); inválido → 0. */
export function readRetryCount(headers: MessageHeaders | undefined): number {
  const raw = headers?.[MESSAGE_HEADERS.retryCount];
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0;
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
