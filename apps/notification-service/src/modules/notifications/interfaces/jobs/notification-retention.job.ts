import { runWithCorrelation } from '@fiapx/observability';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ApplyNotificationRetentionUseCase } from '../../application/use-cases/apply-notification-retention.use-case';
import { describeFailure } from '../../domain/personal-data';

/** Daily at 03:00 (container time, UTC), outside the demo hours. */
export const NOTIFICATION_RETENTION_CRON = '0 3 * * *';
export const NOTIFICATION_RETENTION_JOB = 'notification-retention';

/**
 * LGPD retention job (contratos.md, section 12). Every replica schedules it; the advisory lock
 * in the repository lets only one of them do the work. A failure is logged and the next day's
 * run catches up (the query covers everything older than the cutoff).
 */
@Injectable()
export class NotificationRetentionJob {
  private readonly logger = new Logger(NotificationRetentionJob.name);

  constructor(private readonly retention: ApplyNotificationRetentionUseCase) {}

  @Cron(NOTIFICATION_RETENTION_CRON, { name: NOTIFICATION_RETENTION_JOB, waitForCompletion: true })
  run(): Promise<number | null> {
    // A fresh correlation id per run, so the job's log lines can be grouped.
    return runWithCorrelation(undefined, async () => {
      try {
        return await this.retention.execute();
      } catch (error) {
        this.logger.error({ msg: 'Notification retention failed', error: describeFailure(error) });
        return null;
      }
    });
  }
}
