import { RetryableError } from '@fiapx/common';
import { createTransport } from 'nodemailer';
import { EmailRejectedError } from '../../domain/email-rejected.error';
import { safeErrorText } from '../../domain/personal-data';
import type { EmailMessage, EmailReceipt, EmailSender } from '../../domain/ports/email-sender.port';

/** Mail handed to the transport (the fields nodemailer needs here). */
export interface SmtpMail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  messageId: string;
  headers: Record<string, string>;
}

/** The slice of a nodemailer transporter this adapter uses. */
export interface SmtpTransport {
  sendMail(mail: SmtpMail): Promise<{ messageId: string }>;
}

/** Bounded SMTP waits (nodemailer defaults are up to 2 minutes). */
export const SMTP_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
} as const;

/** Right-hand side of the `Message-ID` (`<notification-id@fiapx.notification>`). */
export const MESSAGE_ID_DOMAIN = 'fiapx.notification';

/**
 * nodemailer error codes that no retry can fix (bad envelope/message, auth or config). Without
 * an SMTP reply code, anything else (ECONNECTION, ETIMEDOUT, ESOCKET, EDNS, ETLS...) is transient.
 */
const PERMANENT_ERROR_CODES = new Set([
  'EENVELOPE',
  'EMESSAGE',
  'EAUTH',
  'ENOAUTH',
  'ECONFIG',
  'EREQUIRETLS',
  'EMAXRECIPIENTS',
]);

export function createSmtpTransport(options: { host: string; port: number }): SmtpTransport {
  return createTransport({
    host: options.host,
    port: options.port,
    secure: options.port === 465,
    ...SMTP_TIMEOUTS,
  });
}

/**
 * SMTP adapter (nodemailer → Mailpit in dev/CI). The `Message-ID` carries the notification id,
 * so a duplicate is easy to spot in the mailbox.
 */
export class SmtpEmailSender implements EmailSender {
  readonly provider = 'smtp';

  constructor(
    private readonly transport: SmtpTransport,
    private readonly options: { from: string },
  ) {}

  async send(message: EmailMessage): Promise<EmailReceipt> {
    try {
      const info = await this.transport.sendMail({
        from: this.options.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        messageId: `<${message.idempotencyKey}@${MESSAGE_ID_DOMAIN}>`,
        headers: { 'X-Correlation-Id': message.correlationId },
      });
      return { providerMessageId: info.messageId };
    } catch (error) {
      throw smtpFailure(error);
    }
  }
}

/**
 * Classifies a nodemailer failure: SMTP reply 4xx → transient, 5xx → permanent; without a reply
 * code, by nodemailer error code (unknown → transient). The reason is redacted: SMTP replies
 * often quote the recipient address, and nodemailer adds it to `rejected` (never logged here).
 */
export function smtpFailure(error: unknown): RetryableError | EmailRejectedError {
  const fields = (typeof error === 'object' && error !== null ? error : {}) as {
    code?: unknown;
    responseCode?: unknown;
  };
  const code = typeof fields.code === 'string' ? fields.code : undefined;
  const responseCode = typeof fields.responseCode === 'number' ? fields.responseCode : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const reason = ['SMTP', code, responseCode === undefined ? undefined : String(responseCode)]
    .filter((part) => part !== undefined)
    .join(' ')
    .concat(`: ${message}`);

  const permanent =
    responseCode !== undefined
      ? responseCode >= 500
      : code !== undefined && PERMANENT_ERROR_CODES.has(code);
  return permanent
    ? new EmailRejectedError('smtp', reason)
    : new RetryableError(safeErrorText(reason));
}
