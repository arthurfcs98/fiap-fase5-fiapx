import { DependencyUnavailableError, RetryableError } from '@fiapx/common';
import { EmailRejectedError } from '../../domain/email-rejected.error';
import type { EmailMessage } from '../../domain/ports/email-sender.port';
import type { SmtpMail } from './smtp-email-sender';
import {
  createSmtpTransport,
  MESSAGE_ID_DOMAIN,
  SmtpEmailSender,
  smtpFailure,
} from './smtp-email-sender';

const MESSAGE: EmailMessage = {
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
  to: 'ana@example.com',
  subject: 's',
  html: '<p>h</p>',
  text: 't',
  correlationId: 'cid-1',
};

/** nodemailer-like error (the fields nodemailer adds to Error). */
function nodemailerError(message: string, fields: Record<string, unknown>): Error {
  return Object.assign(new Error(message), fields);
}

describe('SmtpEmailSender', () => {
  it('sends with the notification id in the Message-ID and the correlation id header', async () => {
    const sendMail = jest.fn((mail: SmtpMail) => Promise.resolve({ messageId: mail.messageId }));
    const smtp = new SmtpEmailSender(
      { sendMail },
      { from: 'FIAP Frames <nao-responda@fiapx.local>' },
    );

    await expect(smtp.send(MESSAGE)).resolves.toEqual({
      providerMessageId: `<${MESSAGE.idempotencyKey}@${MESSAGE_ID_DOMAIN}>`,
    });
    expect(sendMail).toHaveBeenCalledWith({
      from: 'FIAP Frames <nao-responda@fiapx.local>',
      to: 'ana@example.com',
      subject: 's',
      html: '<p>h</p>',
      text: 't',
      messageId: `<${MESSAGE.idempotencyKey}@fiapx.notification>`,
      headers: { 'X-Correlation-Id': 'cid-1' },
    });
    expect(smtp.provider).toBe('smtp');
  });

  it('throws the classified failure instead of swallowing it', async () => {
    const smtp = new SmtpEmailSender(
      {
        sendMail: () =>
          Promise.reject(
            nodemailerError('Connection closed', { code: 'ECONNECTION', rejected: [MESSAGE.to] }),
          ),
      },
      { from: 'x@y.z' },
    );

    const error = await smtp.send(MESSAGE).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DependencyUnavailableError);
    expect((error as DependencyUnavailableError).reason).toBe(
      'DEPENDENCY_UNAVAILABLE (smtp): SMTP ECONNECTION: Connection closed',
    );
  });
});

describe('smtpFailure', () => {
  it.each([
    [
      'reply 451 (greylisting/throttling) → transient',
      nodemailerError(
        "Can't send mail - all recipients were rejected: 451 4.7.1 <ana@example.com> try later",
        { code: 'EENVELOPE', responseCode: 451, rejected: ['ana@example.com'] },
      ),
      RetryableError,
      "SMTP EENVELOPE 451: Can't send mail - all recipients were rejected: 451 4.7.1 <[email]> try later",
    ],
    [
      'reply 550 → permanent',
      nodemailerError('550 5.1.1 <ana@example.com>: user unknown', {
        code: 'EENVELOPE',
        responseCode: 550,
      }),
      EmailRejectedError,
      'smtp rejected the e-mail: SMTP EENVELOPE 550: 550 5.1.1 <[email]>: user unknown',
    ],
    [
      'reply 454 on auth → transient',
      nodemailerError('temporary auth failure', { code: 'EAUTH', responseCode: 454 }),
      RetryableError,
      'SMTP EAUTH 454: temporary auth failure',
    ],
    [
      'connection refused → the server is down (outage: the consumer pauses)',
      nodemailerError('connect ECONNREFUSED 127.0.0.1:1025', { code: 'ESOCKET' }),
      DependencyUnavailableError,
      'DEPENDENCY_UNAVAILABLE (smtp): SMTP ESOCKET: connect ECONNREFUSED 127.0.0.1:1025',
    ],
    [
      'reply 421 (service not available) → outage',
      nodemailerError('421 4.3.2 Service not available', { code: 'EPROTOCOL', responseCode: 421 }),
      DependencyUnavailableError,
      'DEPENDENCY_UNAVAILABLE (smtp): SMTP EPROTOCOL 421: 421 4.3.2 Service not available',
    ],
    [
      'no recipients → permanent',
      nodemailerError('No recipients defined', { code: 'EENVELOPE' }),
      EmailRejectedError,
      'smtp rejected the e-mail: SMTP EENVELOPE: No recipients defined',
    ],
    [
      'auth without reply code → permanent',
      nodemailerError('Missing credentials', { code: 'EAUTH' }),
      EmailRejectedError,
      'smtp rejected the e-mail: SMTP EAUTH: Missing credentials',
    ],
    ['plain error → transient', new Error('boom'), RetryableError, 'SMTP: boom'],
    ['non-error value → transient', 'weird', RetryableError, 'SMTP: weird'],
    ['null → transient', null, RetryableError, 'SMTP: null'],
  ])('%s', (_case, error, type, reason) => {
    const failure = smtpFailure(error);
    expect(failure).toBeInstanceOf(type);
    expect(failure instanceof RetryableError ? failure.reason : failure.message).toBe(reason);
  });
});

describe('createSmtpTransport', () => {
  it('builds a nodemailer transport with bounded timeouts (no connection on creation)', () => {
    const transport = createSmtpTransport({ host: 'mailpit', port: 1025 }) as unknown as {
      sendMail: unknown;
      options: Record<string, unknown>;
    };
    expect(typeof transport.sendMail).toBe('function');
    expect(transport.options).toMatchObject({
      host: 'mailpit',
      port: 1025,
      secure: false,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    const implicitTls = createSmtpTransport({ host: 'smtp', port: 465 }) as unknown as {
      options: Record<string, unknown>;
    };
    expect(implicitTls.options['secure']).toBe(true);
  });
});
