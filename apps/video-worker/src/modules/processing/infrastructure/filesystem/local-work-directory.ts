import { randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { access, lstat, mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FrameFile } from '../../domain/frames';
import { sortFrames } from '../../domain/frames';
import type { IWorkDirectory, JobWorkspace } from '../../domain/ports/work-directory.port';

/** Job directories are named after the video id (a UUID): nothing else is ever swept. */
const JOB_DIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_EXTENSION = /^[a-z0-9]{1,5}$/;

/**
 * {@link IWorkDirectory} on the local filesystem: `<root>/<videoId>/<runId>/{source.<ext>, frames/}`.
 * Every run (attempt) gets its OWN folder: a redelivery of the same message never deletes or
 * mixes files with a run still finishing (e.g. the job of a delivery whose channel closed).
 * The root is resolved to an absolute path, so ffmpeg never sees a relative or option-like
 * argument.
 */
export class LocalWorkDirectory implements IWorkDirectory {
  readonly root: string;

  constructor(
    root: string,
    private readonly now: () => number = Date.now,
  ) {
    this.root = resolve(root);
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await access(this.root, constants.R_OK | constants.W_OK);
  }

  async prepare(videoId: string, sourceExtension: string): Promise<JobWorkspace> {
    if (!JOB_DIR_NAME.test(videoId)) {
      throw new Error(`videoId is not a UUID, refusing to use it as a path: "${videoId}"`);
    }
    const dir = join(this.root, videoId, randomUUID());
    const framesDir = join(dir, 'frames');
    await mkdir(framesDir, { recursive: true });
    const extension = sourceExtension.replace(/^\./, '').toLowerCase();
    const sourceName = SOURCE_EXTENSION.test(extension) ? `source.${extension}` : 'source';
    return { videoId, dir, sourcePath: join(dir, sourceName), framesDir };
  }

  async saveSource(workspace: JobWorkspace, body: Readable): Promise<number> {
    await pipeline(body, createWriteStream(workspace.sourcePath, { flags: 'wx' }));
    return (await stat(workspace.sourcePath)).size;
  }

  async listFrames(workspace: JobWorkspace): Promise<FrameFile[]> {
    const names = await readdir(workspace.framesDir);
    return sortFrames(names.map((name) => ({ name, path: join(workspace.framesDir, name) })));
  }

  async remove(workspace: JobWorkspace): Promise<void> {
    await rm(workspace.dir, { recursive: true, force: true });
    // `<root>/<videoId>` goes away only when no other run of the same video is using it.
    try {
      await rmdir(dirname(workspace.dir));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST' && code !== 'ENOENT') throw error;
    }
  }

  async sweepStale(maxAgeMs: number): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (error) {
      if (isNotFound(error)) return [];
      throw error;
    }
    const threshold = this.now() - maxAgeMs;
    const removed: string[] = [];
    for (const name of names.filter((entry) => JOB_DIR_NAME.test(entry))) {
      const path = join(this.root, name);
      try {
        // maxAgeMs <= 0: everything is a leftover (filesystem clocks may run ahead of Date.now).
        if (maxAgeMs > 0 && (await lstat(path)).mtimeMs > threshold) continue;
        await rm(path, { recursive: true, force: true });
        removed.push(name);
      } catch (error) {
        // Removed meanwhile (e.g. by another replica sharing the volume): nothing to do.
        if (!isNotFound(error)) throw error;
      }
    }
    return removed;
  }
}

/** Duck-typed on purpose: fs errors may come from another realm (e.g. Jest sandboxes). */
function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
