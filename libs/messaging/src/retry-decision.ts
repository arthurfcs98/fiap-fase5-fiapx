import { MAX_RETRIES, RETRY_DELAYS_MS, retryQueueName } from './topology';

export type RetryDecision =
  | {
      action: 'retry';
      /** Fila `.retry.N` de destino (publicação direta pela default exchange). */
      retryQueue: string;
      /** Novo valor do header `x-retry-count`. */
      nextRetryCount: number;
      delayMs: number;
    }
  | { action: 'dead-letter' };

/**
 * Regra de consumo para `RetryableError` (contratos.md, seção 2, regra 2):
 * `x-retry-count < 3` → cópia em `<fila>.retry.<n+1>` com `x-retry-count = n+1` e ack do
 * original; esgotou → `nack(requeue=false)` → DLX.
 *
 * Regressão da Fase 4: o contador SEMPRE avança, então não existe requeue infinito.
 */
export function decideRetry(queue: string, retryCount: number): RetryDecision {
  const done = Number.isInteger(retryCount) && retryCount > 0 ? retryCount : 0;
  if (done >= MAX_RETRIES) return { action: 'dead-letter' };

  const level = done + 1;
  return {
    action: 'retry',
    retryQueue: retryQueueName(queue, level),
    nextRetryCount: level,
    delayMs: RETRY_DELAYS_MS[done],
  };
}
