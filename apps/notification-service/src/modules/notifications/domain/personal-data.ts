/**
 * LGPD (contratos.md, section 12): e-mail addresses must never reach logs, AMQP headers
 * (`x-last-error`) or `last_error`. Provider and SMTP errors often quote the recipient
 * (`550 <ana@example.com>: mailbox unavailable`), so every error text coming from outside is
 * passed through {@link safeErrorText} before it is logged or stored.
 */

/** Written in place of an e-mail address found in free text. */
export const REDACTED_EMAIL = '[email]';

/**
 * Anything shaped like `local@domain` (deliberately broad: unicode local parts, and the local
 * part may be empty so the domain of a quoted `"x"@domain` is still hidden). Redacting a false
 * positive is harmless, leaking an address is not.
 */
const EMAIL_ADDRESS = /[^\s<>()[\]\\,;:"'`@]*@[^\s<>()[\]\\,;:"'`@]+/gu;

export function redactEmailAddresses(text: string): string {
  return text.replace(EMAIL_ADDRESS, REDACTED_EMAIL);
}

/** Error text safe to log and store: addresses redacted, one line, at most `maxLength`. */
export function safeErrorText(text: string, maxLength = 500): string {
  const oneLine = redactEmailAddresses(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength - 1)}…` : oneLine;
}

/** `Name: message` of an error (no stack, no enumerable fields such as `rejected` addresses). */
export function describeFailure(error: unknown): string {
  if (error instanceof Error) return safeErrorText(`${error.name}: ${error.message}`);
  return safeErrorText(String(error));
}
