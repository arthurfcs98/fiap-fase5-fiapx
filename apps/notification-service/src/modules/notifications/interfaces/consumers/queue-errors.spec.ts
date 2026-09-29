import { NonRetryableError, ProcessingErrors, RetryableError } from '@fiapx/common';
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
});
