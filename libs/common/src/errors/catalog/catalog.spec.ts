import type { AppError } from '../app-error';
import { AppErrorException } from '../app-error.exception';
import { NonRetryableError } from '../processing-errors';
import {
  AuthErrors,
  CommonErrors,
  PROCESSING_ERROR_CODES,
  ProcessingErrors,
  VideoErrors,
} from './index';

type HttpCase = [() => AppErrorException, number, string, string];
type ProcessingCase = [() => NonRetryableError, string, string];

/** Catálogo exatamente como em docs/arquitetura/contratos.md, seção 4. */
const httpErrors: HttpCase[] = [
  [() => AuthErrors.INVALID_CREDENTIALS(), 401, 'A0001', 'INVALID_CREDENTIALS'],
  [() => AuthErrors.EMAIL_ALREADY_REGISTERED(), 409, 'A0002', 'EMAIL_ALREADY_REGISTERED'],
  [() => AuthErrors.UNAUTHORIZED(), 401, 'A0003', 'UNAUTHORIZED'],
  [() => AuthErrors.INVALID_PASSWORD_CONFIRMATION(), 400, 'A0004', 'INVALID_PASSWORD_CONFIRMATION'],
  [() => VideoErrors.NOT_FOUND('v1'), 404, 'V0001', 'VIDEO_NOT_FOUND'],
  [() => VideoErrors.UNSUPPORTED_FORMAT(['.mp4']), 400, 'V0002', 'UNSUPPORTED_FORMAT'],
  [() => VideoErrors.FILE_TOO_LARGE(95), 413, 'V0003', 'FILE_TOO_LARGE'],
  [() => VideoErrors.NOT_READY('v1', 'PROCESSING'), 409, 'V0004', 'VIDEO_NOT_READY'],
  [() => VideoErrors.INVALID_DOWNLOAD_SIGNATURE(), 403, 'V0005', 'INVALID_DOWNLOAD_SIGNATURE'],
  [() => VideoErrors.ZIP_EXPIRED('v1'), 410, 'V0006', 'ZIP_EXPIRED'],
  [() => VideoErrors.TOO_MANY_PENDING_VIDEOS(5, 15), 429, 'V0007', 'TOO_MANY_PENDING_VIDEOS'],
  [() => CommonErrors.VALIDATION(['campo']), 400, 'X0001', 'VALIDATION'],
  [() => CommonErrors.INTERNAL(), 500, 'X0002', 'INTERNAL'],
  [() => CommonErrors.UNAVAILABLE(5), 503, 'X0003', 'UNAVAILABLE'],
];

const processingErrors: ProcessingCase[] = [
  [() => ProcessingErrors.INVALID_VIDEO(), 'P0001', 'INVALID_VIDEO'],
  [() => ProcessingErrors.NO_FRAMES(), 'P0002', 'NO_FRAMES'],
  [() => ProcessingErrors.VIDEO_TOO_LONG(900, 600), 'P0003', 'VIDEO_TOO_LONG'],
  [() => ProcessingErrors.FFMPEG_TIMEOUT(600_000), 'P0004', 'FFMPEG_TIMEOUT'],
  [() => ProcessingErrors.SOURCE_NOT_FOUND(), 'P0005', 'SOURCE_NOT_FOUND'],
  [() => ProcessingErrors.OUTPUT_TOO_LARGE(), 'P0006', 'OUTPUT_TOO_LARGE'],
  [() => ProcessingErrors.STORAGE_FULL(), 'P0007', 'STORAGE_FULL'],
  [() => ProcessingErrors.RETRIES_EXHAUSTED(4), 'P0098', 'RETRIES_EXHAUSTED'],
  [() => ProcessingErrors.PROCESSING_ABORTED(), 'P0099', 'PROCESSING_ABORTED'],
];

describe('Catálogo de erros', () => {
  it.each(httpErrors)('%# → HTTP %i %s %s', (factory, status, code, message) => {
    const exception = factory();
    expect(exception).toBeInstanceOf(AppErrorException);
    expect(exception.getStatus()).toBe(status);
    expect(exception.appError.code).toBe(code);
    expect(exception.appError.message).toBe(message);
    expect(exception.appError.description.length).toBeGreaterThan(0);
  });

  it.each(processingErrors)('%# → %s %s (permanente)', (factory, code, message) => {
    const error = factory();
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(error.retryable).toBe(false);
    expect(error.appError.code).toBe(code);
    expect(error.appError.message).toBe(message);
    expect(error.appError.httpStatus).toBe(422);
  });

  it('PROCESSING_ERROR_CODES lista exatamente os códigos P do catálogo', () => {
    expect([...PROCESSING_ERROR_CODES]).toEqual(processingErrors.map(([, code]) => code));
  });

  it('não repete códigos entre domínios', () => {
    const all: AppError[] = [
      ...httpErrors.map(([factory]) => factory().appError),
      ...processingErrors.map(([factory]) => factory().appError),
    ];
    const codes = all.map((error) => error.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('inclui metadata útil sem dados pessoais', () => {
    expect(VideoErrors.NOT_FOUND('v1').appError.metadata).toEqual({ id: 'v1' });
    expect(VideoErrors.UNSUPPORTED_FORMAT(['.mp4', '.mkv']).appError.metadata).toEqual({
      allowed: ['.mp4', '.mkv'],
    });
    expect(VideoErrors.FILE_TOO_LARGE(95).appError.description).toContain('95 MB');
    expect(VideoErrors.FILE_TOO_LARGE(95).appError.metadata).toEqual({ maxMb: 95 });
    expect(VideoErrors.FILE_TOO_LARGE().appError.description).toBe(
      'O arquivo excede o tamanho máximo permitido.',
    );
    expect(VideoErrors.FILE_TOO_LARGE().appError.metadata).toEqual({});
    expect(VideoErrors.NOT_READY('v1', 'QUEUED').appError.metadata).toEqual({
      id: 'v1',
      status: 'QUEUED',
    });
    expect(CommonErrors.UNAVAILABLE(5).appError.metadata).toEqual({ retryAfterSeconds: 5 });
    expect(VideoErrors.TOO_MANY_PENDING_VIDEOS(5, 15).appError.metadata).toEqual({
      limit: 5,
      retryAfterSeconds: 15,
    });
    expect(ProcessingErrors.OUTPUT_TOO_LARGE('ENOSPC').appError.metadata).toEqual({
      detail: 'ENOSPC',
    });
    expect(ProcessingErrors.OUTPUT_TOO_LARGE().appError.metadata).toEqual({});
    expect(CommonErrors.VALIDATION().appError.metadata).toEqual({ fields: [] });
    expect(AuthErrors.EMAIL_ALREADY_REGISTERED().appError.metadata).toEqual({});
    expect(AuthErrors.INVALID_PASSWORD_CONFIRMATION().appError.metadata).toEqual({});
    expect(VideoErrors.ZIP_EXPIRED('v1').appError.metadata).toEqual({ id: 'v1' });
    expect(ProcessingErrors.INVALID_VIDEO('moov atom not found').appError.metadata).toEqual({
      detail: 'moov atom not found',
    });
    expect(ProcessingErrors.VIDEO_TOO_LONG(900, 600).appError.metadata).toEqual({
      durationS: 900,
      maxDurationS: 600,
    });
    expect(ProcessingErrors.FFMPEG_TIMEOUT(1000).appError.metadata).toEqual({ timeoutMs: 1000 });
    expect(ProcessingErrors.RETRIES_EXHAUSTED(4).appError.metadata).toEqual({ attempts: 4 });
  });
});
