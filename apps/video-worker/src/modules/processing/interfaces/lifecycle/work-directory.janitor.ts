import type { OnModuleInit } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ProcessingSettings } from '../../application/processing.settings';
import { PROCESSING_SETTINGS } from '../../application/processing.settings';
import type { IWorkDirectory } from '../../domain/ports/work-directory.port';
import { WORK_DIRECTORY } from '../../domain/ports/work-directory.port';

/**
 * Boot-time care of `WORK_DIR` (runs before the consumer starts):
 * - fail fast when the directory cannot be created or written (the worker would only churn
 *   retries otherwise);
 * - remove job directories left behind by a process killed before its `finally` (OOM, SIGKILL
 *   after the grace period): `WORK_DIR` is private to the replica and no job runs yet, so
 *   everything older than `staleWorkDirMs` (0 in production: everything) is a leftover. Without
 *   this, the frames of a killed job would eat the disk of the next one.
 */
@Injectable()
export class WorkDirectoryJanitor implements OnModuleInit {
  private readonly logger = new Logger(WorkDirectoryJanitor.name);

  constructor(
    @Inject(WORK_DIRECTORY) private readonly workDirectory: IWorkDirectory,
    @Inject(PROCESSING_SETTINGS) private readonly settings: ProcessingSettings,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.workDirectory.ensureRoot();
    try {
      const removed = await this.workDirectory.sweepStale(this.settings.staleWorkDirMs);
      if (removed.length > 0) {
        this.logger.warn({ msg: 'Removed stale work directories', count: removed.length, removed });
      }
    } catch (error) {
      this.logger.warn({
        msg: 'Startup sweep of the work directory failed; continuing',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
