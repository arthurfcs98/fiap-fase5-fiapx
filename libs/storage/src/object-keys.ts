/** Buckets privados do FIAP X (criados pelo init do Garage). */
export const BUCKETS = {
  /** Vídeos originais enviados pelo usuário. */
  raw: 'fiapx-raw',
  /** Zips com os frames extraídos. */
  zips: 'fiapx-zips',
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXTENSION = /^[a-z0-9]{2,5}$/;

function assertUuid(label: string, value: string): void {
  if (!UUID.test(value)) throw new Error(`${label} inválido para chave de storage: "${value}"`);
}

/**
 * Chave do vídeo original: `<userId>/<videoId>.<ext>`. Só UUIDs e extensão alfanumérica,
 * então o nome enviado pelo usuário nunca vira caminho no storage (sem path traversal).
 */
export function rawVideoKey(userId: string, videoId: string, extension: string): string {
  assertUuid('userId', userId);
  assertUuid('videoId', videoId);
  const ext = extension.replace(/^\./, '').toLowerCase();
  if (!EXTENSION.test(ext))
    throw new Error(`Extensão inválida para chave de storage: "${extension}"`);
  return `${userId}/${videoId}.${ext}`;
}

/** Chave determinística do zip (base da idempotência do worker): `<userId>/<videoId>.zip`. */
export function zipKey(userId: string, videoId: string): string {
  assertUuid('userId', userId);
  assertUuid('videoId', videoId);
  return `${userId}/${videoId}.zip`;
}
