import type { OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ExpireZipsUseCase } from '../../../videos/application/use-cases/expire-zips.use-case';
import { PurgeDeliveryRecordsUseCase } from '../../application/use-cases/purge-delivery-records.use-case';
import { PurgeLeftoverUploadsUseCase } from '../../application/use-cases/purge-leftover-uploads.use-case';
import { PurgeOrphanObjectsUseCase } from '../../application/use-cases/purge-orphan-objects.use-case';

/** Name of the interval in the `SchedulerRegistry`. */
export const DATA_RETENTION_JOB = 'data-retention';
/** Name of the first run (timeout) in the `SchedulerRegistry`. */
export const DATA_RETENTION_FIRST_RUN = 'data-retention-first-run';
/**
 * First run shortly after the boot, not only after a full interval: with deploys less than an
 * hour apart the hourly retention would otherwise never run.
 */
export const FIRST_RUN_DELAY_MS = 60_000;

/** How often the retention runs (`DATA_RETENTION_INTERVAL_S`, default every hour). */
export interface RetentionSchedule {
  intervalMs: number;
}
export const RETENTION_SCHEDULE = Symbol('RETENTION_SCHEDULE');

/**
 * Hourly retention (LGPD, contratos.md section 12): expired zips, objects of deleted users,
 * leftover originals and interrupted uploads, and old delivery records. Each task runs on its
 * own (one failing does not skip the others); the storage tasks hold advisory locks, so several
 * replicas never overlap. First run {@link FIRST_RUN_DELAY_MS} after the boot (or at the first
 * tick, when the interval is shorter). Interval and first run live in the `SchedulerRegistry` (cleared by
 * `@nestjs/schedule` on shutdown), so tests can shorten them.
 */
@Injectable()
export class DataRetentionJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(DataRetentionJob.name);
  private running = false;

  constructor(
    private readonly expireZips: ExpireZipsUseCase,
    private readonly purgeOrphanObjects: PurgeOrphanObjectsUseCase,
    private readonly purgeLeftoverUploads: PurgeLeftoverUploadsUseCase,
    private readonly purgeDeliveryRecords: PurgeDeliveryRecordsUseCase,
    @Inject(RETENTION_SCHEDULE) private readonly schedule: RetentionSchedule,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const handle = setInterval(() => void this.run(), this.schedule.intervalMs);
    this.scheduler.addInterval(DATA_RETENTION_JOB, handle);
    // A short interval (tests, BDD) already runs soon: no extra first run.
    if (this.schedule.intervalMs > FIRST_RUN_DELAY_MS) {
      const first = setTimeout(() => void this.run(), FIRST_RUN_DELAY_MS);
      this.scheduler.addTimeout(DATA_RETENTION_FIRST_RUN, first);
    }
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.attempt('zips vencidos', () => this.expireZips.execute());
      await this.attempt('objetos órfãos', () => this.purgeOrphanObjects.execute());
      await this.attempt('sobras de upload', () => this.purgeLeftoverUploads.execute());
      await this.attempt('registros de entrega', () => this.purgeDeliveryRecords.execute());
    } finally {
      this.running = false;
    }
  }

  private async attempt(task: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.error({
        msg: `Retenção falhou: ${task} (nova tentativa na próxima execução)`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
