import { AppError } from '../app-error';
import { AppErrorException } from '../app-error.exception';

/**
 * Prefixo X: erros transversais (contratos.md, seção 4).
 * Faixa `X0<status HTTP>` (ex.: X0404, X0429): reservada ao fallback do filtro global para
 * HttpException genérica sem código de catálogo (401 → A0003 e 413 → V0003 não caem nela).
 */
export class CommonErrors {
  static VALIDATION(fields: unknown = []): AppErrorException {
    return new AppErrorException(
      new AppError(400, 'VALIDATION', 'X0001', 'Dados inválidos.', { fields }),
    );
  }

  static INTERNAL(): AppErrorException {
    return new AppErrorException(
      new AppError(500, 'INTERNAL', 'X0002', 'Erro interno inesperado.'),
    );
  }

  static UNAVAILABLE(retryAfterSeconds: number): AppErrorException {
    return new AppErrorException(
      new AppError(
        503,
        'UNAVAILABLE',
        'X0003',
        'Serviço temporariamente indisponível. Tente novamente em instantes.',
        { retryAfterSeconds },
      ),
    );
  }
}
