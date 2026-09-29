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
 * Dependência compartilhada fora do ar (Postgres, storage, provedor de e-mail): a falha não é
 * desta mensagem, e sim de todas enquanto a dependência não voltar. O consumidor de fila não
 * gasta o orçamento de retry da mensagem: devolve-a à fila sem contar no `x-delivery-limit` e
 * pausa o consumo com backoff (contratos.md, seção 2, regra 2b). Continua sendo um
 * {@link RetryableError} para quem só distingue transitório de permanente.
 */
export class DependencyUnavailableError extends RetryableError {
  constructor(
    /** Nome curto da dependência (ex.: `postgres`, `storage`, `smtp`). Nunca dado pessoal. */
    public readonly dependency: string,
    /** `detail`: texto seguro para log/header (sem dado pessoal), anexado ao motivo. */
    options?: { cause?: unknown; detail?: string },
  ) {
    super(
      `DEPENDENCY_UNAVAILABLE (${dependency})${options?.detail ? `: ${options.detail}` : ''}`,
      options,
    );
    this.name = 'DependencyUnavailableError';
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

export function isDependencyUnavailableError(error: unknown): error is DependencyUnavailableError {
  return error instanceof DependencyUnavailableError;
}
