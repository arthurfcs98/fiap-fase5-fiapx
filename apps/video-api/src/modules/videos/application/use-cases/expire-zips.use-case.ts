import type { IObjectStorage, StorageBuckets } from '@fiapx/storage';
import { OBJECT_STORAGE, STORAGE_BUCKETS } from '@fiapx/storage';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work';
import { UNIT_OF_WORK } from '../../../../shared/application/unit-of-work';
import type { Clock } from '../../../../shared/domain/clock';
import { CLOCK } from '../../../../shared/domain/clock';
import type { VideoSettings } from '../video.settings';
import { VIDEO_SETTINGS } from '../video.settings';

/** Advisory lock shared by every replica: only one runs the retention at a time. */
export const ZIP_RETENTION_LOCK = 'fiapx.video-api.zip-retention';
/** Zips handled per transaction (one advisory lock each). */
export const ZIP_RETENTION_BATCH = 500;
/**
 * Batches per run: a run keeps going while batches come back full (a backlog after downtime or
 * a burst of uploads 7 days ago is drained in one run, not 500 per hour), up to this bound.
 */
export const ZIP_RETENTION_MAX_BATCHES = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ZipRetentionSummary {
  /** Another replica held the lock. */
  skipped: boolean;
  expired: number;
  failed: number;
}

/**
 * Zip retention (LGPD, contratos.md section 12): zips of videos completed more than
 * `ZIP_RETENTION_DAYS` ago are deleted from `fiapx-zips`; the row keeps the metadata with
 * `zip_key = NULL` and `expired_at = now()`, and the download answers `410 V0006`.
 * Each batch runs in one transaction holding `pg_try_advisory_xact_lock`, so two replicas never
 * overlap; batches repeat while they come back full (up to {@link ZIP_RETENTION_MAX_BATCHES}).
 */
@Injectable()
export class ExpireZipsUseCase {
  private readonly logger = new Logger(ExpireZipsUseCase.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
    @Inject(STORAGE_BUCKETS) private readonly buckets: StorageBuckets,
    @Inject(VIDEO_SETTINGS) private readonly settings: VideoSettings,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(): Promise<ZipRetentionSummary> {
    const summary: ZipRetentionSummary = { skipped: false, expired: 0, failed: 0 };
    for (let batch = 0; batch < ZIP_RETENTION_MAX_BATCHES; batch += 1) {
      const result = await this.runBatch();
      if (result.skipped) {
        summary.skipped = batch === 0;
        break;
      }
      summary.expired += result.expired;
      summary.failed += result.failed;
      // Short batch = nothing left; a failure = storage trouble: the next hourly run retries.
      if (result.locked < ZIP_RETENTION_BATCH || result.failed > 0) break;
    }

    if (!summary.skipped && summary.expired + summary.failed > 0) {
      this.logger.log({ msg: 'Retenção de zips executada', ...summary });
    }
    return summary;
  }

  private runBatch(): Promise<ZipRetentionSummary & { locked: number }> {
    return this.uow.run(async (tx) => {
      if (!(await tx.tryAdvisoryLock(ZIP_RETENTION_LOCK))) {
        return { skipped: true, expired: 0, failed: 0, locked: 0 };
      }
      const now = this.clock.now();
      const cutoff = new Date(now.getTime() - this.settings.zipRetentionDays * DAY_MS);
      const videos = await tx.videos.lockExpiredZips(cutoff, ZIP_RETENTION_BATCH);
      let expired = 0;
      let failed = 0;
      for (const video of videos) {
        try {
          await this.storage.delete(this.buckets.zips, video.zipKey as string);
        } catch (error) {
          failed += 1;
          this.logger.warn({
            msg: 'Falha ao apagar zip vencido (nova tentativa na próxima execução)',
            videoId: video.id,
            error: error instanceof Error ? error.message : String(error),
          });
          continue;
        }
        video.expireZip(now);
        await tx.videos.update(video);
        expired += 1;
      }
      return { skipped: false, expired, failed, locked: videos.length };
    });
  }
}
