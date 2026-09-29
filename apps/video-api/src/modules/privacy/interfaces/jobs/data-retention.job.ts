import type { OnApplicationBootstrap } from '@nestjs/common';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ExpireZipsUseCase } from '../../../videos/application/use-cases/expire-zips.use-case';
import { PurgeDeliveryRecordsUseCase } from '../../application/use-cases/purge-delivery-records.use-case';
import { PurgeOrphanObjectsUseCase } from '../../application/use-cases/purge-orphan-objects.use-case';

/** Name of the interval in the `SchedulerRegistry`. */
export const DATA_RETENTION_JOB = 'data-retention';

/** How often the retention runs (`DATA_RETENTION_INTERVAL_S`, default every hour). */
export interface RetentionSchedule {
  intervalMs: number;
}
export const RETENTION_SCHEDULE = Symbol('RETENTION_SCHEDULE');

/**
 * Hourly retention (LGPD, contratos.md section 12): expired zips, objects of deleted users and
 * old delivery records. Each task runs on its own (one failing does not skip the others); the
 * zip and orphan tasks hold advisory locks, so several replicas never overlap. The interval is
 * registered in the `SchedulerRegistry` (cleared by `@nestjs/schedule` on shutdown), so tests
 * can shorten it.
 */
@Injectable()
export class DataRetentionJob implements OnApplicationBootstrap {
  private readonly logger = new Logger(DataRetentionJob.name);
  private running = false;

  constructor(
    private readonly expireZips: ExpireZipsUseCase,
    private readonly purgeOrphanObjects: PurgeOrphanObjectsUseCase,
    private readonly purgeDeliveryRecords: PurgeDeliveryRecordsUseCase,
    @Inject(RETENTION_SCHEDULE) private readonly schedule: RetentionSchedule,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  onApplicationBootstrap(): void {
    const handle = setInterval(() => void this.run(), this.schedule.intervalMs);
    this.scheduler.addInterval(DATA_RETENTION_JOB, handle);
  }

  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.attempt('zips vencidos', () => this.expireZips.execute());
      await this.attempt('objetos órfãos', () => this.purgeOrphanObjects.execute());
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
