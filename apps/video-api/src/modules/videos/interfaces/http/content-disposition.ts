/**
 * `attachment; filename="<ASCII fallback>"; filename*=UTF-8''<RFC 5987>` (contratos.md,
 * section 8). The user-supplied name is only ever used here, percent-encoded, so it cannot
 * inject headers or paths.
 */
export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(fileName)}`;
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
