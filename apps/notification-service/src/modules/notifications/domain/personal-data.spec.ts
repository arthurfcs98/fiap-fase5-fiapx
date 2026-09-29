import {
  describeFailure,
  REDACTED_EMAIL,
  redactEmailAddresses,
  safeErrorText,
} from './personal-data';

describe('personal data redaction', () => {
  it.each([
    [
      "Can't send mail - all recipients were rejected: 550 5.1.1 <ana.souza+fiapx@example.com>: unknown",
      "Can't send mail - all recipients were rejected: 550 5.1.1 <[email]>: unknown",
    ],
    ['to: joão@exemplo.com.br, bia@x.io', 'to: [email], [email]'],
    ['Invalid `to` field (user@localhost)', 'Invalid `to` field ([email])'],
    ['"quoted"@example.com', '"quoted"[email]'],
    ['no address here: VIDEO_FAILED:6f1c', 'no address here: VIDEO_FAILED:6f1c'],
  ])('redacts addresses in %p', (input, expected) => {
    expect(redactEmailAddresses(input)).toBe(expected);
  });

  it('never leaves an @ followed by a domain behind', () => {
    const text = 'a@b.c d@e.f <g@h.i>';
    expect(redactEmailAddresses(text)).toBe(
      `${REDACTED_EMAIL} ${REDACTED_EMAIL} <${REDACTED_EMAIL}>`,
    );
  });

  it('safeErrorText redacts, flattens to one line and truncates', () => {
    expect(safeErrorText('line 1\n\tline 2 ana@example.com  ')).toBe('line 1 line 2 [email]');
    const long = safeErrorText('x'.repeat(600));
    expect(long).toHaveLength(500);
    expect(long.endsWith('…')).toBe(true);
    expect(safeErrorText('x'.repeat(20), 10)).toBe(`${'x'.repeat(9)}…`);
  });

  it('describeFailure keeps name and message only (no enumerable fields)', () => {
    const error = Object.assign(new Error('rejected ana@example.com'), {
      rejected: ['ana@example.com'],
    });
    expect(describeFailure(error)).toBe('Error: rejected [email]');
    expect(describeFailure('plain bia@example.com')).toBe('plain [email]');
  });
});
