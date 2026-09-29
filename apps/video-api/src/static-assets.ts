import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Folder of the static frontend (contratos.md, section 8: `GET /`). In the image the build
 * copies `apps/video-api/public` next to the bundle (`dist/public`); from the sources (tests,
 * ts-node) it is `apps/video-api/public`.
 */
export function resolvePublicDir(
  baseDir: string = __dirname,
  exists: (dir: string) => boolean = existsSync,
): string {
  const candidates = [path.join(baseDir, 'public'), path.join(baseDir, '..', 'public')];
  return candidates.find((dir) => exists(dir)) ?? candidates[0];
}
