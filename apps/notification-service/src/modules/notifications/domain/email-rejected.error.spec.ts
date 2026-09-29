import { EmailRejectedError } from './email-rejected.error';

describe('EmailRejectedError', () => {
  it('redacts the provider reason on construction', () => {
    const error = new EmailRejectedError('smtp', '550 <ana@example.com>: mailbox unavailable');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('EmailRejectedError');
    expect(error.provider).toBe('smtp');
    expect(error.reason).toBe('550 <[email]>: mailbox unavailable');
    expect(error.message).toBe('smtp rejected the e-mail: 550 <[email]>: mailbox unavailable');
  });
});
