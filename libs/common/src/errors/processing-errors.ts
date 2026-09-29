import type { AppError } from './app-error';

/**
 * Falha transitória (broker, storage, timeout na 1ª tentativa, OOM do ffmpeg...).
 * O consumidor deve reagendar a mensagem na fila `.retry.N` correspondente.
 */
export class RetryableError extends Error {
  readonly retryable = true as const;

  constructor(
    public readonly reason: string,
    options?: { cause?: unknown },
  ) {
    super(`Falha transitória: ${reason}`, options);
    this.name = 'RetryableError';
  }
}

/**
 * Falha permanente (vídeo inválido, sem frames...). Não adianta tentar de novo:
 * o consumidor rejeita a mensagem e o vídeo termina em FAILED com `appError.code`.
 */
export class NonRetryableError extends Error {
  readonly retryable = false as const;

  constructor(
    public readonly appError: AppError,
    options?: { cause?: unknown },
  ) {
    super(`${appError.code} ${appError.message}: ${appError.description}`, options);
    this.name = 'NonRetryableError';
  }
}

export function isRetryableError(error: unknown): error is RetryableError {
  return error instanceof RetryableError;
}

export function isNonRetryableError(error: unknown): error is NonRetryableError {
  return error instanceof NonRetryableError;
}
