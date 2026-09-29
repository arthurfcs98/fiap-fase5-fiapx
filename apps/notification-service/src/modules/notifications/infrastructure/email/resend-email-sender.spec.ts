import { RetryableError } from '@fiapx/common';
import type { CreateEmailResponse } from 'resend';
import { EmailRejectedError } from '../../domain/email-rejected.error';
import type { EmailMessage } from '../../domain/ports/email-sender.port';
import type { ResendEmailsApi, ResendErrorLike } from './resend-email-sender';
import { isTransientResendError, ResendEmailSender, resendFailure } from './resend-email-sender';

const MESSAGE: EmailMessage = {
  idempotencyKey: '00000000-0000-4000-8000-000000000001',
  to: 'ana@example.com',
  subject: 'FIAP Frames: não foi possível processar o seu vídeo',
  html: '<p>html</p>',
  text: 'text',
  correlationId: 'cid-1',
};

function ok(id: string): CreateEmailResponse {
  return { data: { id }, error: null, headers: null };
}

function failed(error: ResendErrorLike): CreateEmailResponse {
  return { data: null, error, headers: null } as CreateEmailResponse;
}

function sender(send: ResendEmailsApi['send'], timeoutMs?: number): ResendEmailSender {
  return new ResendEmailSender({ send }, { from: 'FIAP Frames <fiapx@asdevit.com>', timeoutMs });
}

describe('ResendEmailSender', () => {
  it('sends with the notification id as Idempotency-Key and returns the Resend id', async () => {
    const send = jest.fn<ReturnType<ResendEmailsApi['send']>, Parameters<ResendEmailsApi['send']>>(
      () => Promise.resolve(ok('re_123')),
    );

    await expect(sender(send).send(MESSAGE)).resolves.toEqual({ providerMessageId: 're_123' });

    expect(send).toHaveBeenCalledWith(
      {
        from: 'FIAP Frames <fiapx@asdevit.com>',
        to: ['ana@example.com'],
        subject: MESSAGE.subject,
        html: MESSAGE.html,
        text: MESSAGE.text,
        headers: { 'X-Correlation-Id': 'cid-1' },
      },
      { idempotencyKey: MESSAGE.idempotencyKey },
    );
  });

  it('throws (never swallows) the SDK error: the Fase 4 bug', async () => {
    const send = jest.fn(() =>
      Promise.resolve(
        failed({ name: 'rate_limit_exceeded', statusCode: 429, message: 'Too many requests' }),
      ),
    );

    await expect(sender(send).send(MESSAGE)).rejects.toThrow(
      new RetryableError('Resend rate_limit_exceeded (429): Too many requests'),
    );
  });

  it('rejects permanently on a validation error, with the address redacted', async () => {
    const send = jest.fn(() =>
      Promise.resolve(
        failed({
          name: 'validation_error',
          statusCode: 422,
          message: 'Invalid `to` field: ana@example.com is not allowed',
        }),
      ),
    );

    const failure = sender(send).send(MESSAGE);
    await expect(failure).rejects.toBeInstanceOf(EmailRejectedError);
    await expect(failure).rejects.toThrow(
      'resend rejected the e-mail: validation_error (422): Invalid `to` field: [email] is not allowed',
    );
  });

  it('turns a missing answer into a retryable timeout (idempotency key covers a late send)', async () => {
    const send = jest.fn(() => new Promise<CreateEmailResponse>(() => undefined));

    await expect(sender(send, 15).send(MESSAGE)).rejects.toThrow(
      new RetryableError('Resend did not answer within 15 ms'),
    );
  });

  it('treats an exception from the SDK as transient (redacted)', async () => {
    const send = jest.fn(() => Promise.reject(new TypeError('bad header for ana@example.com')));

    await expect(sender(send).send(MESSAGE)).rejects.toThrow(
      new RetryableError('Resend SDK error: TypeError: bad header for [email]'),
    );
  });

  it('retries when Resend answers without an id', async () => {
    const send = jest.fn(() => Promise.resolve(ok('')));

    await expect(sender(send).send(MESSAGE)).rejects.toThrow(
      new RetryableError('Resend answered without an e-mail id'),
    );
  });
});

describe('Resend error classification', () => {
  it.each([
    [{ name: 'application_error', statusCode: null }, true],
    [{ name: 'rate_limit_exceeded', statusCode: 429 }, true],
    [{ name: 'daily_quota_exceeded', statusCode: 429 }, true],
    [{ name: 'internal_server_error', statusCode: 500 }, true],
    [{ name: 'application_error', statusCode: 503 }, true],
    [{ name: 'application_error', statusCode: 408 }, true],
    [{ name: 'concurrent_idempotent_requests', statusCode: 409 }, true],
    [{ name: 'invalid_idempotent_request', statusCode: 409 }, false],
    [{ name: 'validation_error', statusCode: 422 }, false],
    [{ name: 'invalid_from_address', statusCode: 403 }, false],
    [{ name: 'invalid_api_key', statusCode: 403 }, false],
    [{ name: 'missing_api_key', statusCode: 401 }, false],
    [{ name: 'not_found', statusCode: 404 }, false],
  ] as const)('%p → transient=%p', (error, transient) => {
    expect(isTransientResendError(error)).toBe(transient);
    const failure = resendFailure({ ...error, message: 'm' });
    expect(failure).toBeInstanceOf(transient ? RetryableError : EmailRejectedError);
  });

  it('says "no response" when there was no HTTP status', () => {
    expect(
      resendFailure({ name: 'application_error', statusCode: null, message: 'Unable to fetch' })
        .message,
    ).toBe('Falha transitória: Resend application_error (no response): Unable to fetch');
  });
});
