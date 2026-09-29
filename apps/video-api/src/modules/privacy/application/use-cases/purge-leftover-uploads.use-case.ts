import type { IObjectStorage, StorageBuckets } from '@fiapx/storage';
import { OBJECT_STORAGE, STORAGE_BUCKETS } from '@fiapx/storage';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work';
import { UNIT_OF_WORK } from '../../../../shared/application/unit-of-work';
import type { Clock } from '../../../../shared/domain/clock';
import { CLOCK } from '../../../../shared/domain/clock';
import { isTerminalStatus } from '../../../videos/domain/video-status';
import type { UserObjectStore } from '../../domain/user-object.store';
import { USER_OBJECT_STORE } from '../../domain/user-object.store';

export const LEFTOVER_SWEEP_LOCK = 'fiapx.video-api.leftover-uploads';

/**
 * How old an original without a database row (or an unfinished multipart upload) must be to be
 * a leftover: an upload lasts minutes (95 MiB, Cloudflare timeouts) and the row is committed
 * milliseconds after the object, so 1 h never touches work in progress.
 */
export const LEFTOVER_MIN_AGE_MS = 60 * 60 * 1000;

/** Raw key `{userId}/{videoId}.{ext}` (contratos.md, section 7). */
const RAW_KEY = /^[0-9a-f-]{36}\/([0-9a-f-]{36})\.[a-z0-9]{2,5}$/i;

export interface LeftoverSweepSummary {
  skipped: boolean;
  /** Originals deleted: video already COMPLETED/FAILED, or no row after 1 h. */
  rawDeleted: number;
  /** Multipart uploads interrupted more than 1 h ago, in both buckets. */
  uploadsAborted: number;
}

/**
 * LGPD safety net of the original videos (contratos.md, section 12: "apagado assim que o vídeo
 * chega a COMPLETED ou FAILED"). The consumers delete the original after the commit, but a
 * delete that exhausted its retries, a failed cleanup after an upload whose transaction did not
 * commit, or an upload interrupted mid-way (its parts are never listed as an object) would keep
 * video content forever. Hourly, under an advisory lock:
 * - `fiapx-raw` objects of COMPLETED/FAILED videos → deleted;
 * - `fiapx-raw` objects with no video row, older than 1 h → deleted;
 * - multipart uploads (both buckets) started more than 1 h ago and never completed → aborted.
 * Originals of videos still QUEUED/PROCESSING stay: they are needed to process the video
 * (a stuck one is recovered by the DLQ redrive, docs/observabilidade.md).
 */
@Injectable()
export class PurgeLeftoverUploadsUseCase {
  private readonly logger = new Logger(PurgeLeftoverUploadsUseCase.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(USER_OBJECT_STORE) private readonly objects: UserObjectStore,
    @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
    @Inject(STORAGE_BUCKETS) private readonly buckets: StorageBuckets,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(): Promise<LeftoverSweepSummary> {
    const summary = await this.uow.run(async (tx): Promise<LeftoverSweepSummary> => {
      if (!(await tx.tryAdvisoryLock(LEFTOVER_SWEEP_LOCK))) {
        return { skipped: true, rawDeleted: 0, uploadsAborted: 0 };
      }
      const cutoff = new Date(this.clock.now().getTime() - LEFTOVER_MIN_AGE_MS);

      const originals = (await this.objects.listObjects(this.buckets.raw)).flatMap((object) => {
        const videoId = RAW_KEY.exec(object.key)?.[1];
        return videoId ? [{ ...object, videoId }] : [];
      });
      const statuses = await tx.videos.statusesOf(originals.map((object) => object.videoId));
      let rawDeleted = 0;
      for (const object of originals) {
        const status = statuses.get(object.videoId);
        const leftover =
          status === undefined
            ? object.lastModified !== undefined && object.lastModified < cutoff
            : isTerminalStatus(status);
        if (!leftover) continue;
        await this.storage.delete(this.buckets.raw, object.key);
        rawDeleted += 1;
      }

      let uploadsAborted = 0;
      for (const bucket of [this.buckets.raw, this.buckets.zips]) {
        uploadsAborted += await this.objects.abortIncompleteUploads(bucket, cutoff);
      }
      return { skipped: false, rawDeleted, uploadsAborted };
    });
    if (summary.rawDeleted + summary.uploadsAborted > 0) {
      this.logger.warn({ msg: 'Sobras de upload removidas (LGPD)', ...summary });
    }
    return summary;
  }
}
