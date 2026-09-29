import {
  DependencyUnavailableError,
  isConnectivityError,
  NonRetryableError,
  RetryableError,
} from '@fiapx/common';
import { describeFailure } from '../../domain/personal-data';

/**
 * Makes any handler failure safe for the queue runner, which logs `Name: message` and copies it
 * into the `x-last-error` header of the retry copy. Classified errors pass through (their texts
 * are already redacted); the database unreachable becomes a `DependencyUnavailableError` (the
 * consumer pauses instead of spending retries); anything else (driver errors, bugs) becomes a
 * `RetryableError`. Both with a redacted message and no `cause`, so query parameters or e-mail
 * addresses carried by the original error can never reach a log line or a header.
 */
export function toQueueError(error: unknown): RetryableError | NonRetryableError {
  if (error instanceof RetryableError || error instanceof NonRetryableError) return error;
  if (isConnectivityError(error)) {
    return new DependencyUnavailableError('postgres', { detail: describeFailure(error) });
  }
  return new RetryableError(describeFailure(error));
}
