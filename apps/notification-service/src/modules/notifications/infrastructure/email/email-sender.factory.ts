import type { LoggerService } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { Resend } from 'resend';
import type { NotificationConfig } from '../../../../config/notification.config';
import type { EmailSender } from '../../domain/ports/email-sender.port';
import { LogEmailSender } from './log-email-sender';
import { OverridingEmailSender } from './overriding-email-sender';
import type { ResendEmailsApi } from './resend-email-sender';
import { ResendEmailSender } from './resend-email-sender';
import type { SmtpTransport } from './smtp-email-sender';
import { createSmtpTransport, SmtpEmailSender } from './smtp-email-sender';

export type EmailSenderConfig = Pick<
  NotificationConfig,
  | 'EMAIL_PROVIDER'
  | 'RESEND_API_KEY'
  | 'EMAIL_FROM'
  | 'SMTP_HOST'
  | 'SMTP_PORT'
  | 'EMAIL_TO_OVERRIDE'
>;

/** Seams for tests (the defaults build the real SDK clients). */
export interface EmailSenderFactoryDeps {
  resendEmails?: (apiKey: string) => ResendEmailsApi;
  smtpTransport?: (options: { host: string; port: number }) => SmtpTransport;
  logger?: Pick<LoggerService, 'log' | 'warn'>;
}

/** `EMAIL_PROVIDER` → adapter, wrapped by the override in dev (`EMAIL_TO_OVERRIDE`). */
export function createEmailSender(
  config: EmailSenderConfig,
  deps: EmailSenderFactoryDeps = {},
): EmailSender {
  const logger = deps.logger ?? new Logger('EmailSender');
  const sender = createProviderSender(config, deps);
  logger.log(`E-mail provider: ${sender.provider}`);
  if (config.EMAIL_TO_OVERRIDE === undefined) return sender;
  // The address itself is personal data and stays out of the logs.
  logger.warn('EMAIL_TO_OVERRIDE is set: every e-mail goes to the override address (dev only)');
  return new OverridingEmailSender(sender, config.EMAIL_TO_OVERRIDE);
}

function createProviderSender(
  config: EmailSenderConfig,
  deps: EmailSenderFactoryDeps,
): EmailSender {
  switch (config.EMAIL_PROVIDER) {
    case 'resend': {
      if (config.RESEND_API_KEY === undefined) {
        throw new Error('RESEND_API_KEY is required with EMAIL_PROVIDER=resend');
      }
      const emails = (deps.resendEmails ?? resendEmails)(config.RESEND_API_KEY);
      return new ResendEmailSender(emails, { from: config.EMAIL_FROM });
    }
    case 'smtp': {
      if (config.SMTP_HOST === undefined) {
        throw new Error('SMTP_HOST is required with EMAIL_PROVIDER=smtp');
      }
      const transport = (deps.smtpTransport ?? createSmtpTransport)({
        host: config.SMTP_HOST,
        port: config.SMTP_PORT,
      });
      return new SmtpEmailSender(transport, { from: config.EMAIL_FROM });
    }
    case 'log':
      return new LogEmailSender();
  }
}

function resendEmails(apiKey: string): ResendEmailsApi {
  return new Resend(apiKey).emails;
}
