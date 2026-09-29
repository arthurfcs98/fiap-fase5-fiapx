import type { EmailMessage, EmailReceipt, EmailSender } from '../../domain/ports/email-sender.port';

/**
 * `EMAIL_TO_OVERRIDE` (dev only): every e-mail goes to one fixed address. The notification row
 * keeps the real recipient, so the LGPD anonymization still applies to it.
 */
export class OverridingEmailSender implements EmailSender {
  constructor(
    private readonly inner: EmailSender,
    private readonly overrideTo: string,
  ) {}

  get provider(): string {
    return this.inner.provider;
  }

  send(message: EmailMessage): Promise<EmailReceipt> {
    return this.inner.send({ ...message, to: this.overrideTo });
  }
}
