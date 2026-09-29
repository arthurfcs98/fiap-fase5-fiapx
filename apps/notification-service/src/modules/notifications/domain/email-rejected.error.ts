import { safeErrorText } from './personal-data';

/**
 * Permanent rejection by the e-mail provider (invalid address, 4xx from Resend other than 429,
 * SMTP 5xx): retrying cannot succeed, so the notification becomes FAILED and the message is
 * acknowledged. Transient failures are thrown as `RetryableError` (`@fiapx/common`) instead.
 *
 * The reason is redacted on construction, so it is safe to log and to store in `last_error`.
 */
export class EmailRejectedError extends Error {
  readonly reason: string;

  constructor(
    readonly provider: string,
    reason: string,
  ) {
    const safeReason = safeErrorText(reason);
    super(`${provider} rejected the e-mail: ${safeReason}`);
    this.name = 'EmailRejectedError';
    this.reason = safeReason;
  }
}
