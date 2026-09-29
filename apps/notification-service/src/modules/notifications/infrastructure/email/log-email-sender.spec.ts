import { Logger } from '@nestjs/common';
import { LogEmailSender } from './log-email-sender';

describe('LogEmailSender', () => {
  it('logs ids and sizes only (never the address or the body) and returns a fake id', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    const receipt = await new LogEmailSender().send({
      idempotencyKey: 'n1',
      to: 'ana@example.com',
      subject: 'assunto',
      html: '<p>Olá, Ana</p>',
      text: 'Olá, Ana',
      correlationId: 'cid',
    });

    expect(receipt).toEqual({ providerMessageId: 'log:n1' });
    expect(log).toHaveBeenCalledWith({
      msg: 'E-mail not sent (EMAIL_PROVIDER=log)',
      notificationId: 'n1',
      subject: 'assunto',
      htmlLength: 15,
      textLength: 8,
    });
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/ana@example\.com|Olá, Ana/);
  });
});
