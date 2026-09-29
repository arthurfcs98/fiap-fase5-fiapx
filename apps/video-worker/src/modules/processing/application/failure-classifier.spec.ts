import { NonRetryableError, ProcessingErrors, RetryableError } from '@fiapx/common';
import { ObjectNotFoundError, ObjectStorageError } from '@fiapx/storage';
import type { MediaToolFailure } from '../domain/media-tool.error';
import { MediaToolError } from '../domain/media-tool.error';
import { classifyMediaToolError, toProcessingFailure } from './failure-classifier';

const code = (error: unknown) => (error as NonRetryableError).appError.code;

describe('classifyMediaToolError', () => {
  const context = { retryCount: 0, timeoutMs: 600_000 };

  it('first-attempt timeout is transient (maybe CPU contention)', () => {
    const error = classifyMediaToolError(
      new MediaToolError('ffmpeg', 'timeout', 'killed after 600000 ms'),
      context,
    );
    expect(error).toBeInstanceOf(RetryableError);
    expect((error as RetryableError).reason).toBe('FFMPEG_TIMEOUT after 600000 ms (first attempt)');
    expect(error.cause).toBeInstanceOf(MediaToolError);
  });

  it.each([1, 2, 3])('timeout on retry %i is permanent P0004 with the budget', (retryCount) => {
    const error = classifyMediaToolError(new MediaToolError('ffmpeg', 'timeout', 'x'), {
      retryCount,
      timeoutMs: 1_234,
    });
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(code(error)).toBe('P0004');
    expect((error as NonRetryableError).appError.metadata).toEqual({ timeoutMs: 1_234 });
  });

  it.each<[MediaToolFailure, string]>([
    ['killed', 'FFMPEG_KILLED: terminated by SIGKILL'],
    ['unavailable', 'FFMPEG_UNAVAILABLE: terminated by SIGKILL'],
    ['aborted', 'FFMPEG_ABORTED: terminated by SIGKILL'],
  ])('%s is transient', (failure, reason) => {
    const error = classifyMediaToolError(
      new MediaToolError('ffmpeg', failure, 'terminated by SIGKILL'),
      { ...context, retryCount: 3 },
    );
    expect(error).toBeInstanceOf(RetryableError);
    expect((error as RetryableError).reason).toBe(reason);
  });

  it('disk full is permanent P0006 (the frames of this video do not fit): no retries', () => {
    const error = classifyMediaToolError(
      new MediaToolError('ffmpeg', 'no_space', 'exit code 228: No space left on device'),
      context,
    );
    expect(error).toBeInstanceOf(NonRetryableError);
    expect(code(error)).toBe('P0006');
    expect((error as NonRetryableError).appError.metadata).toEqual({
      detail: 'WORK_DIR_FULL: exit code 228: No space left on device',
    });
  });

  it('non-zero exit is P0001 with the diagnostic in the metadata', () => {
    const error = classifyMediaToolError(
      new MediaToolError('ffprobe', 'failed', 'exit code 1: moov atom not found'),
      context,
    );
    expect(code(error)).toBe('P0001');
    expect((error as NonRetryableError).appError.metadata).toEqual({
      detail: 'exit code 1: moov atom not found',
    });
  });
});

describe('toProcessingFailure', () => {
  it('keeps errors that are already classified', () => {
    const retryable = new RetryableError('x');
    const permanent = ProcessingErrors.NO_FRAMES();
    expect(toProcessingFailure(retryable)).toBe(retryable);
    expect(toProcessingFailure(permanent)).toBe(permanent);
  });

  it('storage failures are transient', () => {
    const cause = new ObjectStorageError('head', 'fiapx-zips', 'k', { cause: new Error('503') });
    const error = toProcessingFailure(cause);
    expect(error).toBeInstanceOf(RetryableError);
    expect((error as RetryableError).reason).toMatch(/^STORAGE_UNAVAILABLE: /);
    expect(error.cause).toBe(cause);
  });

  it('unexpected errors (and non-errors) are transient', () => {
    expect((toProcessingFailure(new TypeError('boom')) as RetryableError).reason).toBe(
      'UNEXPECTED: TypeError: boom',
    );
    expect((toProcessingFailure('text') as RetryableError).reason).toBe('UNEXPECTED: text');
    expect(toProcessingFailure(new ObjectNotFoundError('b', 'k'))).toBeInstanceOf(RetryableError);
  });
});
