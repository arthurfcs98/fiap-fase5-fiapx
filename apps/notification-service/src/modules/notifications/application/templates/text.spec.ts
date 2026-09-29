import { escapeHtml, singleLine, truncateText } from './text';

describe('template text helpers', () => {
  it('escapes the five HTML-significant characters', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;',
    );
    expect(escapeHtml('Ação é ok')).toBe('Ação é ok');
  });

  it('flattens control characters and extra whitespace into one line', () => {
    expect(singleLine('  Ana\r\nBcc: x\u0000y\t z  ')).toBe('Ana Bcc: x y z');
  });

  it('truncates by code points with an ellipsis', () => {
    expect(truncateText('abc', 3)).toBe('abc');
    expect(truncateText('abcdef', 4)).toBe('abc…');
    expect(truncateText('🎬🎬🎬🎬', 3)).toBe('🎬🎬…');
  });
});
