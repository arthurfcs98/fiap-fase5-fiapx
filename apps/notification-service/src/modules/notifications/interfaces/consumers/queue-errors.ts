import { NonRetryableError, RetryableError } from '@fiapx/common';
import { describeFailure } from '../../domain/personal-data';

/**
 * Makes any handler failure safe for the queue runner, which logs `Name: message` and copies it
 * into the `x-last-error` header of the retry copy. Classified errors pass through (their texts
 * are already redacted); anything else (database down, driver errors, bugs) becomes a
 * `RetryableError` with a redacted message and no `cause`, so query parameters or e-mail
 * addresses carried by the original error can never reach a log line or a header.
 */
export function toQueueError(error: unknown): RetryableError | NonRetryableError {
  if (error instanceof RetryableError || error instanceof NonRetryableError) return error;
  return new RetryableError(describeFailure(error));
}
