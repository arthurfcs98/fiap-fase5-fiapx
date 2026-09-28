/**
 * Erro de domínio estruturado (padrão herdado da Fase 2).
 *
 * `message` é o identificador estável (ex.: `VIDEO_NOT_FOUND`), `code` é o código com prefixo
 * de domínio (A = Auth, V = Video, P = Processamento, X = Comum) e `description` é o texto
 * legível. `metadata` carrega dados de contexto não sensíveis (ids, limites).
 */
export interface AppErrorPayload {
  message: string;
  code: string;
  description: string;
  metadata: Record<string, unknown>;
}

export const APP_ERROR_CODE_PATTERN = /^[AVPX]\d{4}$/;

export class AppError {
  constructor(
    public readonly httpStatus: number,
    public readonly message: string,
    public readonly code: string,
    public readonly description: string,
    public readonly metadata: Record<string, unknown> = {},
  ) {
    if (!APP_ERROR_CODE_PATTERN.test(code)) {
      throw new Error(`Código de erro inválido: "${code}" (esperado prefixo A/V/P/X + 4 dígitos)`);
    }
  }

  toPayload(): AppErrorPayload {
    return {
      message: this.message,
      code: this.code,
      description: this.description,
      metadata: this.metadata,
    };
  }
}
