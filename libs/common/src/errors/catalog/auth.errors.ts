import { AppError } from '../app-error';
import { AppErrorException } from '../app-error.exception';

/** Prefixo A: autenticação e cadastro (docs/arquitetura/contratos.md, seção 4). */
export class AuthErrors {
  static INVALID_CREDENTIALS(): AppErrorException {
    // Mensagem genérica de propósito: não revela se o e-mail existe.
    return new AppErrorException(
      new AppError(401, 'INVALID_CREDENTIALS', 'A0001', 'E-mail ou senha inválidos.'),
    );
  }

  static EMAIL_ALREADY_REGISTERED(): AppErrorException {
    // O e-mail não vai em metadata para não ecoar dado pessoal na resposta/log.
    return new AppErrorException(
      new AppError(409, 'EMAIL_ALREADY_REGISTERED', 'A0002', 'Este e-mail já está cadastrado.'),
    );
  }

  static UNAUTHORIZED(): AppErrorException {
    return new AppErrorException(
      new AppError(401, 'UNAUTHORIZED', 'A0003', 'Autenticação necessária ou token inválido.'),
    );
  }
}
