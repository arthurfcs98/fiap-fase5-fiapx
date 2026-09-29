/**
 * Accepted uploads (contratos.md, section 8): the extensions of the base project, and the
 * container detected from the magic bytes must belong to the same family as the extension
 * (a renamed text file, image or HLS playlist is refused with `400 V0002`).
 */
export const ALLOWED_EXTENSIONS = [
  '.mp4',
  '.avi',
  '.mov',
  '.mkv',
  '.wmv',
  '.flv',
  '.webm',
] as const;

export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];

/** Extension → containers (as named by `file-type`) accepted for it. */
export const ACCEPTED_CONTAINERS: Readonly<Record<AllowedExtension, readonly string[]>> = {
  '.mp4': ['mp4', 'm4v', 'mov', '3gp', '3g2', 'f4v'],
  '.mov': ['mov', 'mp4', 'm4v'],
  '.avi': ['avi'],
  '.mkv': ['mkv', 'webm'],
  '.webm': ['webm', 'mkv'],
  '.wmv': ['asf'],
  '.flv': ['flv'],
};

const ORIGINAL_NAME_MAX_LENGTH = 255;
// eslint-disable-next-line no-control-regex -- stripping control characters is the point here
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Lower-case extension with the dot (`.mp4`), or `''` when there is none. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 || dot === fileName.length - 1 ? '' : fileName.slice(dot).toLowerCase();
}

export function isAllowedExtension(extension: string): extension is AllowedExtension {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(extension);
}

export function containerMatchesExtension(
  extension: AllowedExtension,
  container: string | undefined,
): boolean {
  return container !== undefined && ACCEPTED_CONTAINERS[extension].includes(container);
}

/**
 * Name shown to the user and used in `Content-Disposition`: base name only (no path from old
 * browsers), no control characters, at most 255 characters. It never becomes a storage key.
 */
export function sanitizeOriginalName(raw: string): string {
  const baseName = raw.split(/[\\/]/).pop() ?? '';
  const clean = baseName.replace(CONTROL_CHARACTERS, '').trim();
  if (clean.length <= ORIGINAL_NAME_MAX_LENGTH) return clean;
  const extension = extensionOf(clean);
  const keep = extension.length < 16 ? extension : '';
  return clean.slice(0, ORIGINAL_NAME_MAX_LENGTH - keep.length) + keep;
}
