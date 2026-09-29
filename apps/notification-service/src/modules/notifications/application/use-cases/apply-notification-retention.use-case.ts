import { Inject, Injectable, Logger } from '@nestjs/common';
import type { INotificationRepository } from '../../domain/ports/notification.repository';
import { NOTIFICATION_REPOSITORY } from '../../domain/ports/notification.repository';
import type { NotificationSettings } from '../notification.settings';
import { NOTIFICATION_SETTINGS } from '../notification.settings';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * LGPD retention (contratos.md, section 12): notifications older than
 * `NOTIFICATION_RETENTION_DAYS` are anonymized (`recipient = 'removido'`, `payload = '{}'`).
 * Only one replica runs it at a time (advisory lock in the repository).
 */
@Injectable()
export class ApplyNotificationRetentionUseCase {
  private readonly logger = new Logger(ApplyNotificationRetentionUseCase.name);

  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly repository: INotificationRepository,
    @Inject(NOTIFICATION_SETTINGS) private readonly settings: NotificationSettings,
  ) {}

  /** @returns rows anonymized now, or `null` when another replica is running it. */
  async execute(now: Date = new Date()): Promise<number | null> {
    const cutoff = new Date(now.getTime() - this.settings.retentionDays * DAY_MS);
    const anonymized = await this.repository.anonymizeCreatedBefore(cutoff);
    if (anonymized === null) {
      this.logger.log({ msg: 'Notification retention skipped: another replica holds the lock' });
      return null;
    }
    this.logger.log({
      msg: 'Notification retention applied',
      retentionDays: this.settings.retentionDays,
      cutoff: cutoff.toISOString(),
      anonymized,
    });
    return anonymized;
  }
}
