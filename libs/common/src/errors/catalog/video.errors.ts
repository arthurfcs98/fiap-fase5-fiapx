import { AppError } from '../app-error';
import { AppErrorException } from '../app-error.exception';

/** Prefixo V: vídeos (upload, consulta, download) — contratos.md, seção 4. */
export class VideoErrors {
  static NOT_FOUND(id: string): AppErrorException {
    // Também usado quando o vídeo é de outro usuário (não revela a existência).
    return new AppErrorException(
      new AppError(404, 'VIDEO_NOT_FOUND', 'V0001', 'Vídeo não encontrado.', { id }),
    );
  }

  static UNSUPPORTED_FORMAT(allowed: readonly string[]): AppErrorException {
    return new AppErrorException(
      new AppError(400, 'UNSUPPORTED_FORMAT', 'V0002', 'Formato de vídeo não suportado.', {
        allowed: [...allowed],
      }),
    );
  }

  /**
   * Sem `maxMb` (ex.: 413 genérico do parser, convertido pelo filtro global), a descrição não
   * cita o limite e `metadata` fica vazio.
   */
  static FILE_TOO_LARGE(maxMb?: number): AppErrorException {
    const description =
      maxMb === undefined
        ? 'O arquivo excede o tamanho máximo permitido.'
        : `O arquivo excede o limite de ${maxMb} MB.`;
    return new AppErrorException(
      new AppError(
        413,
        'FILE_TOO_LARGE',
        'V0003',
        description,
        maxMb === undefined ? {} : { maxMb },
      ),
    );
  }

  static NOT_READY(id: string, status: string): AppErrorException {
    return new AppErrorException(
      new AppError(409, 'VIDEO_NOT_READY', 'V0004', 'O vídeo ainda não terminou de processar.', {
        id,
        status,
      }),
    );
  }

  static INVALID_DOWNLOAD_SIGNATURE(): AppErrorException {
    return new AppErrorException(
      new AppError(
        403,
        'INVALID_DOWNLOAD_SIGNATURE',
        'V0005',
        'Link de download inválido ou expirado.',
      ),
    );
  }
}
