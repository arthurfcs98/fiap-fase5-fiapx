import { Logger } from '@nestjs/common';
import type { EmailMessage, EmailReceipt, EmailSender } from '../../domain/ports/email-sender.port';

/**
 * `EMAIL_PROVIDER=log`: nothing is sent, only a log line with ids and sizes. Unlike the Fase 4
 * fallback, the address and the body are NOT logged (they carry personal data); use Mailpit
 * (`EMAIL_PROVIDER=smtp`) to read the rendered e-mail.
 */
export class LogEmailSender implements EmailSender {
  readonly provider = 'log';
  private readonly logger = new Logger(LogEmailSender.name);

  send(message: EmailMessage): Promise<EmailReceipt> {
    this.logger.log({
      msg: 'E-mail not sent (EMAIL_PROVIDER=log)',
      notificationId: message.idempotencyKey,
      subject: message.subject,
      htmlLength: message.html.length,
      textLength: message.text.length,
    });
    return Promise.resolve({ providerMessageId: `log:${message.idempotencyKey}` });
  }
}
