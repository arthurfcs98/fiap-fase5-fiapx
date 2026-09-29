import { AppError } from '../app-error';
import { NonRetryableError } from '../processing-errors';

/**
 * Todos os códigos P do catálogo (ex.: séries de métricas criadas em 0 no boot, para o
 * `increase()` do SLO enxergar a primeira falha de cada código).
 */
export const PROCESSING_ERROR_CODES = [
  'P0001',
  'P0002',
  'P0003',
  'P0004',
  'P0005',
  'P0006',
  'P0007',
  'P0098',
  'P0099',
] as const;

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

  /**
   * Os frames do vídeo não cabem no disco de trabalho do worker (ENOSPC). Depende do vídeo
   * (resolução, duração, conteúdo): repetir não adianta, então não gasta retries.
   */
  static OUTPUT_TOO_LARGE(detail?: string): NonRetryableError {
    return failure(
      'OUTPUT_TOO_LARGE',
      'P0006',
      'Os frames deste vídeo passam do espaço de processamento disponível. Envie um vídeo mais curto ou de menor resolução.',
      detail ? { detail } : {},
    );
  }

  /**
   * O bucket dos zips atingiu a quota: é capacidade do sistema (conta no SLO do pipeline), mas
   * repetir em minutos não resolve (a retenção libera espaço em horas/dias).
   */
  static STORAGE_FULL(): NonRetryableError {
    return failure(
      'STORAGE_FULL',
      'P0007',
      'O armazenamento dos resultados está cheio no momento. Tente enviar o vídeo mais tarde.',
    );
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
