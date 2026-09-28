import { AppError } from '../app-error';
import { NonRetryableError } from '../processing-errors';

/**
 * Prefixo P: falhas de processamento, gravadas em `videos.error_code` (contratos.md, seção 4).
 * Não são respostas HTTP diretas: viram {@link NonRetryableError} no worker/consumidores
 * (422 é só o status semântico caso algum dia sejam expostas).
 */
export class ProcessingErrors {
  static INVALID_VIDEO(detail?: string): NonRetryableError {
    return failure(
      'INVALID_VIDEO',
      'P0001',
      'O arquivo não é um vídeo válido ou está corrompido.',
      detail ? { detail } : {},
    );
  }

  static NO_FRAMES(): NonRetryableError {
    return failure('NO_FRAMES', 'P0002', 'Nenhum frame pôde ser extraído do vídeo.');
  }

  static VIDEO_TOO_LONG(durationS: number, maxDurationS: number): NonRetryableError {
    return failure('VIDEO_TOO_LONG', 'P0003', `O vídeo excede ${maxDurationS} s de duração.`, {
      durationS,
      maxDurationS,
    });
  }

  static FFMPEG_TIMEOUT(timeoutMs: number): NonRetryableError {
    return failure('FFMPEG_TIMEOUT', 'P0004', 'A extração de frames excedeu o tempo limite.', {
      timeoutMs,
    });
  }

  static SOURCE_NOT_FOUND(): NonRetryableError {
    return failure('SOURCE_NOT_FOUND', 'P0005', 'O vídeo original não foi encontrado no storage.');
  }

  static RETRIES_EXHAUSTED(attempts: number): NonRetryableError {
    return failure(
      'RETRIES_EXHAUSTED',
      'P0098',
      'O processamento falhou após todas as tentativas.',
      { attempts },
    );
  }

  static PROCESSING_ABORTED(): NonRetryableError {
    return failure(
      'PROCESSING_ABORTED',
      'P0099',
      'O processamento foi abortado (mensagem enviada para dead-letter).',
    );
  }
}

function failure(
  message: string,
  code: string,
  description: string,
  metadata: Record<string, unknown> = {},
): NonRetryableError {
  return new NonRetryableError(new AppError(422, message, code, description, metadata));
}
