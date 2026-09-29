import type { StorageBuckets } from '@fiapx/storage';
import { STORAGE_BUCKETS } from '@fiapx/storage';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { UnitOfWork } from '../../../../shared/application/unit-of-work';
import { UNIT_OF_WORK } from '../../../../shared/application/unit-of-work';
import { isUuid } from '../../../../shared/domain/uuid';
import type { UserObjectStore } from '../../domain/user-object.store';
import { USER_OBJECT_STORE } from '../../domain/user-object.store';

export const ORPHAN_SWEEP_LOCK = 'fiapx.video-api.orphan-objects';

export interface OrphanSweepSummary {
  skipped: boolean;
  owners: number;
  objects: number;
}

/**
 * Safety net of the erasure: objects under `{userId}/` whose user no longer exists (deletion
 * that failed half-way in the storage, or a zip the worker wrote after the account was deleted)
 * are removed. Runs hourly under an advisory lock (one replica at a time).
 */
@Injectable()
export class PurgeOrphanObjectsUseCase {
  private readonly logger = new Logger(PurgeOrphanObjectsUseCase.name);

  constructor(
    @Inject(UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(USER_OBJECT_STORE) private readonly objects: UserObjectStore,
    @Inject(STORAGE_BUCKETS) private readonly buckets: StorageBuckets,
  ) {}

  async execute(): Promise<OrphanSweepSummary> {
    const summary = await this.uow.run(async (tx): Promise<OrphanSweepSummary> => {
      if (!(await tx.tryAdvisoryLock(ORPHAN_SWEEP_LOCK))) {
        return { skipped: true, owners: 0, objects: 0 };
      }
      let owners = 0;
      let objects = 0;
      for (const bucket of [this.buckets.raw, this.buckets.zips]) {
        const ownerIds = (await this.objects.listOwnerIds(bucket)).filter(isUuid);
        const existing = await tx.users.existingIds(ownerIds);
        for (const ownerId of ownerIds.filter((id) => !existing.has(id))) {
          owners += 1;
          objects += await this.objects.deleteAllOf(bucket, ownerId);
        }
      }
      return { skipped: false, owners, objects };
    });
    if (summary.objects > 0) {
      this.logger.warn({ msg: 'Objetos órfãos de usuários eliminados removidos', ...summary });
    }
    return summary;
  }
}
