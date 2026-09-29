import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Bytes of the regular files directly inside `dir` (the frames folder has no subfolders).
 * A missing folder counts as 0, and a file removed between the listing and its `stat` is
 * skipped: the folder is being written (ffmpeg) or cleaned while it is measured.
 */
export async function directorySizeBytes(dir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      total += (await stat(join(dir, entry.name))).size;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return total;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
