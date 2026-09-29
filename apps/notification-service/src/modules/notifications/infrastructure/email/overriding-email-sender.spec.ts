import type { EmailSender } from '../../domain/ports/email-sender.port';
import { OverridingEmailSender } from './overriding-email-sender';

describe('OverridingEmailSender', () => {
  it('sends every message to the override address and keeps the provider name', async () => {
    const inner: EmailSender = {
      provider: 'smtp',
      send: jest.fn().mockResolvedValue({ providerMessageId: 'id-1' }),
    };
    const sender = new OverridingEmailSender(inner, 'dev@example.com');
    const message = {
      idempotencyKey: 'n1',
      to: 'ana@example.com',
      subject: 's',
      html: 'h',
      text: 't',
      correlationId: 'c',
    };

    await expect(sender.send(message)).resolves.toEqual({ providerMessageId: 'id-1' });
    expect(inner.send).toHaveBeenCalledWith({ ...message, to: 'dev@example.com' });
    expect(sender.provider).toBe('smtp');
  });
});
