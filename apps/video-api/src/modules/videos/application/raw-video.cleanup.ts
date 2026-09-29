import { RetryableError } from '@fiapx/common';
import type { IObjectStorage, StorageBuckets } from '@fiapx/storage';
import { OBJECT_STORAGE, STORAGE_BUCKETS } from '@fiapx/storage';
import { Inject, Injectable } from '@nestjs/common';
import type { Video } from '../domain/video';

/**
 * LGPD retention of the original video (contratos.md, section 12): the `fiapx-raw` object is
 * deleted as soon as the video reaches COMPLETED or FAILED (there is no reprocessing). Called by
 * the consumers after the commit; a storage failure becomes a `RetryableError`, so the message
 * is retried and the (idempotent) delete runs again.
 */
@Injectable()
export class RawVideoCleanup {
  constructor(
    @Inject(OBJECT_STORAGE) private readonly storage: IObjectStorage,
    @Inject(STORAGE_BUCKETS) private readonly buckets: StorageBuckets,
  ) {}

  async deleteRaw(video: Video): Promise<void> {
    try {
      await this.storage.delete(this.buckets.raw, video.rawKey);
    } catch (error) {
      throw new RetryableError('falha ao apagar o vídeo original do storage', { cause: error });
    }
  }
}
