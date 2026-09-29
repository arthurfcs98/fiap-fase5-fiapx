import { Logger } from '@nestjs/common';
import type { EmailSenderConfig } from './email-sender.factory';
import { createEmailSender } from './email-sender.factory';
import { LogEmailSender } from './log-email-sender';
import { OverridingEmailSender } from './overriding-email-sender';
import { ResendEmailSender } from './resend-email-sender';
import { SmtpEmailSender } from './smtp-email-sender';

const BASE: EmailSenderConfig = {
  EMAIL_PROVIDER: 'log',
  RESEND_API_KEY: undefined,
  EMAIL_FROM: 'FIAP Frames <fiapx@asdevit.com>',
  SMTP_HOST: undefined,
  SMTP_PORT: 1025,
  EMAIL_TO_OVERRIDE: undefined,
};

function quietLogger() {
  return { log: jest.fn(), warn: jest.fn() };
}

describe('createEmailSender', () => {
  it('builds the Resend adapter from RESEND_API_KEY', () => {
    const resendEmails = jest.fn(() => ({ send: jest.fn() }));
    const logger = quietLogger();

    const sender = createEmailSender(
      { ...BASE, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_key' },
      { resendEmails, logger },
    );

    expect(sender).toBeInstanceOf(ResendEmailSender);
    expect(resendEmails).toHaveBeenCalledWith('re_key');
    expect(logger.log).toHaveBeenCalledWith('E-mail provider: resend');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('builds the SMTP adapter from SMTP_HOST/SMTP_PORT', () => {
    const smtpTransport = jest.fn(() => ({ sendMail: jest.fn() }));

    const sender = createEmailSender(
      { ...BASE, EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'mailpit', SMTP_PORT: 2525 },
      { smtpTransport, logger: quietLogger() },
    );

    expect(sender).toBeInstanceOf(SmtpEmailSender);
    expect(smtpTransport).toHaveBeenCalledWith({ host: 'mailpit', port: 2525 });
  });

  it('builds the log adapter', () => {
    expect(createEmailSender(BASE, { logger: quietLogger() })).toBeInstanceOf(LogEmailSender);
  });

  it('wraps the adapter with EMAIL_TO_OVERRIDE and warns without logging the address', () => {
    const logger = quietLogger();

    const sender = createEmailSender({ ...BASE, EMAIL_TO_OVERRIDE: 'dev@example.com' }, { logger });

    expect(sender).toBeInstanceOf(OverridingEmailSender);
    expect(sender.provider).toBe('log');
    expect(logger.warn).toHaveBeenCalledWith(
      'EMAIL_TO_OVERRIDE is set: every e-mail goes to the override address (dev only)',
    );
    expect(JSON.stringify([logger.log.mock.calls, logger.warn.mock.calls])).not.toContain(
      'dev@example.com',
    );
  });

  it.each([
    [
      { EMAIL_PROVIDER: 'resend' as const },
      'RESEND_API_KEY is required with EMAIL_PROVIDER=resend',
    ],
    [{ EMAIL_PROVIDER: 'smtp' as const }, 'SMTP_HOST is required with EMAIL_PROVIDER=smtp'],
  ])('fails fast without the provider settings (%p)', (patch, message) => {
    expect(() => createEmailSender({ ...BASE, ...patch }, { logger: quietLogger() })).toThrow(
      message,
    );
  });

  it('uses the real SDK clients and the Nest logger by default (no network on creation)', () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    expect(
      createEmailSender({ ...BASE, EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_test' }),
    ).toBeInstanceOf(ResendEmailSender);
    expect(
      createEmailSender({ ...BASE, EMAIL_PROVIDER: 'smtp', SMTP_HOST: '127.0.0.1' }),
    ).toBeInstanceOf(SmtpEmailSender);
    expect(log).toHaveBeenCalledWith('E-mail provider: smtp');
  });
});
