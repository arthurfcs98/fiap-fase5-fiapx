/** Injection token of {@link EmailSender}. */
export const EMAIL_SENDER = Symbol('EMAIL_SENDER');

export interface EmailMessage {
  /**
   * The notification id: Resend `Idempotency-Key` (a retry after a timeout is not sent twice)
   * and the SMTP `Message-ID`.
   */
  idempotencyKey: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Sent as the `X-Correlation-Id` header (end-to-end tracing up to the e-mail). */
  correlationId: string;
}

export interface EmailReceipt {
  /** Id returned by the provider (`notifications.provider_message_id`). */
  providerMessageId: string;
}

/**
 * Port for the e-mail providers (adapters: Resend, SMTP, Log). `send` resolves only when the
 * provider accepted the message. Failures are thrown, never swallowed (the Fase 4 bug):
 * `RetryableError` for transient ones (429, 5xx, timeout, connection) and `EmailRejectedError`
 * for permanent ones.
 */
export interface EmailSender {
  /** Provider name for logs (`resend`, `smtp`, `log`). */
  readonly provider: string;
  send(message: EmailMessage): Promise<EmailReceipt>;
}
