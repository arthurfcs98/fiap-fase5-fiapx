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

  /**
   * Senha de confirmação errada no `DELETE /api/me` (LGPD, contratos.md, seção 12).
   *
   * **400, não 401**, de propósito: o token JWT é válido, só a confirmação falhou. O frontend
   * trata todo 401 numa chamada autenticada como sessão expirada e desloga o usuário; um erro de
   * digitação na confirmação não deve encerrar a sessão. Corpo sem `password` continua sendo
   * `400 X0001` (validação); este código é só para senha presente e incorreta.
   */
  static INVALID_PASSWORD_CONFIRMATION(): AppErrorException {
    return new AppErrorException(
      new AppError(
        400,
        'INVALID_PASSWORD_CONFIRMATION',
        'A0004',
        'Senha de confirmação incorreta.',
      ),
    );
  }
}
