const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes user content for HTML text and attribute values (quotes included). */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/** Control characters (CR/LF, tab, NUL...) become spaces, then whitespace is collapsed. */
export function singleLine(value: string): string {
  return value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Truncates by code points (never splits an emoji or accented char) with an ellipsis. */
export function truncateText(value: string, maxLength: number): string {
  const chars = Array.from(value);
  return chars.length > maxLength ? `${chars.slice(0, maxLength - 1).join('')}…` : value;
}

/**
 * Text that no mail client can turn into a link: only letters (with accents), digits, spaces,
 * apostrophes, hyphens and underscores survive; everything else (`.`, `/`, `:`, `@`, `<`...)
 * becomes a space. The e-mails go out from our domain to an address nobody verified, so user
 * text in them must never carry a URL, a domain or an address (anti-phishing).
 */
export function linkSafeText(value: string): string {
  return singleLine(value)
    .replace(/[^\p{L}\p{M}\p{N}\s'_-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
