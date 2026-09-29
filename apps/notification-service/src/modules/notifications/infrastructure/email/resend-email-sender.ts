import { DependencyUnavailableError, RetryableError } from '@fiapx/common';
import type { CreateEmailOptions, CreateEmailRequestOptions, CreateEmailResponse } from 'resend';
import { EmailRejectedError } from '../../domain/email-rejected.error';
import { describeFailure, safeErrorText } from '../../domain/personal-data';
import type { EmailMessage, EmailReceipt, EmailSender } from '../../domain/ports/email-sender.port';
import { withTimeout } from './with-timeout';

/** The slice of the Resend SDK this adapter uses (`new Resend(key).emails`). */
export interface ResendEmailsApi {
  send(
    payload: CreateEmailOptions,
    options?: CreateEmailRequestOptions,
  ): Promise<CreateEmailResponse>;
}

/** Shape of `error` in a Resend SDK response (`{ data, error }`). */
export interface ResendErrorLike {
  name: string;
  message: string;
  /** `null` when the request never got an HTTP answer (network error). */
  statusCode: number | null;
}

/** The SDK has no timeout of its own. */
export const RESEND_TIMEOUT_MS = 10_000;

export interface ResendEmailSenderOptions {
  /** `EMAIL_FROM` (a domain verified in Resend). */
  from: string;
  timeoutMs?: number;
}

/**
 * Production e-mail adapter (Resend). The SDK never throws: it returns `{ data, error }`. The
 * Fase 4 adapter logged `error` and returned, so the message was acked and the e-mail lost; this
 * one inspects `error` and throws the classified failure:
 * - Resend down or throttling us (network error, timeout, 5xx, 408, 429) →
 *   `DependencyUnavailableError`: the consumer pauses instead of spending retries (a spent daily
 *   quota must not turn failure e-mails into FAILED rows);
 * - `concurrent_idempotent_requests` → `RetryableError` (this e-mail only);
 * - any other 4xx (e.g. `validation_error`, `invalid_from_address`) → `EmailRejectedError`.
 *
 * `Idempotency-Key` = notification id: a retry after a timeout (the first request may still
 * have been delivered) is deduplicated by Resend.
 */
export class ResendEmailSender implements EmailSender {
  readonly provider = 'resend';

  constructor(
    private readonly emails: ResendEmailsApi,
    private readonly options: ResendEmailSenderOptions,
  ) {}

  async send(message: EmailMessage): Promise<EmailReceipt> {
    const timeoutMs = this.options.timeoutMs ?? RESEND_TIMEOUT_MS;
    let response: CreateEmailResponse;
    try {
      response = await withTimeout(
        this.emails.send(
          {
            from: this.options.from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
            headers: { 'X-Correlation-Id': message.correlationId },
          },
          { idempotencyKey: message.idempotencyKey },
        ),
        timeoutMs,
        () =>
          new DependencyUnavailableError('resend', {
            detail: `no answer within ${timeoutMs} ms`,
          }),
      );
    } catch (error) {
      if (error instanceof RetryableError) throw error;
      throw new RetryableError(`Resend SDK error: ${describeFailure(error)}`);
    }

    if (response.error !== null) throw resendFailure(response.error);
    if (!response.data.id) throw new RetryableError('Resend answered without an e-mail id');
    return { providerMessageId: response.data.id };
  }
}

export function isTransientResendError(
  error: Pick<ResendErrorLike, 'name' | 'statusCode'>,
): boolean {
  const { statusCode } = error;
  if (statusCode === null) return true;
  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) return true;
  // 409 with the same Idempotency-Key still being processed: try again later.
  return error.name === 'concurrent_idempotent_requests';
}

/** Resend itself is unavailable or throttling (not a problem of this e-mail). */
export function isResendOutage(error: Pick<ResendErrorLike, 'statusCode'>): boolean {
  const { statusCode } = error;
  return statusCode === null || statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

/** Classified exception for a Resend `error` (reason redacted: it may quote the address). */
export function resendFailure(error: ResendErrorLike): RetryableError | EmailRejectedError {
  const status = error.statusCode === null ? 'no response' : String(error.statusCode);
  const reason = `${error.name} (${status}): ${error.message}`;
  if (isResendOutage(error)) {
    return new DependencyUnavailableError('resend', { detail: safeErrorText(reason) });
  }
  return isTransientResendError(error)
    ? new RetryableError(safeErrorText(`Resend ${reason}`))
    : new EmailRejectedError('resend', reason);
}
