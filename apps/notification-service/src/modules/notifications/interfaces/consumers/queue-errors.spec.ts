import {
  DependencyUnavailableError,
  NonRetryableError,
  ProcessingErrors,
  RetryableError,
} from '@fiapx/common';
import { toQueueError } from './queue-errors';

describe('toQueueError', () => {
  it('passes classified errors through unchanged', () => {
    const retryable = new RetryableError('down');
    const permanent = new NonRetryableError(ProcessingErrors.INVALID_VIDEO('x').appError);

    expect(toQueueError(retryable)).toBe(retryable);
    expect(toQueueError(permanent)).toBe(permanent);
  });

  it('turns anything else into a redacted RetryableError without cause', () => {
    const driverError = Object.assign(new Error('insert failed for ana@example.com'), {
      name: 'QueryFailedError',
      parameters: ['ana@example.com'],
    });

    const error = toQueueError(driverError);

    expect(error).toBeInstanceOf(RetryableError);
    expect(error.message).toBe('Falha transitória: QueryFailedError: insert failed for [email]');
    expect(error.cause).toBeUndefined();
  });

  it('database unreachable → DependencyUnavailableError (the consumer pauses), still without cause', () => {
    const refused = Object.assign(new Error('getaddrinfo ENOTFOUND postgres'), {
      code: 'ENOTFOUND',
    });

    const error = toQueueError(refused);

    expect(error).toBeInstanceOf(DependencyUnavailableError);
    expect((error as DependencyUnavailableError).dependency).toBe('postgres');
    expect(error.message).toBe(
      'Falha transitória: DEPENDENCY_UNAVAILABLE (postgres): Error: getaddrinfo ENOTFOUND postgres',
    );
    expect(error.cause).toBeUndefined();
  });
});
