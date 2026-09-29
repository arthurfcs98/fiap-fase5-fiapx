import { Inject, Injectable, Logger } from '@nestjs/common';
import type { INotificationRepository } from '../../domain/ports/notification.repository';
import { NOTIFICATION_REPOSITORY } from '../../domain/ports/notification.repository';

/**
 * LGPD, art. 18 VI (contratos.md, section 12 — "Propagação da eliminação"): on `user.deleted`,
 * every notification of the user keeps only ids and technical fields (`recipient = 'removido'`,
 * `payload = '{}'`). Idempotent: a redelivered event changes nothing.
 */
@Injectable()
export class AnonymizeUserNotificationsUseCase {
  private readonly logger = new Logger(AnonymizeUserNotificationsUseCase.name);

  constructor(
    @Inject(NOTIFICATION_REPOSITORY) private readonly repository: INotificationRepository,
  ) {}

  async execute(userId: string): Promise<number> {
    const anonymized = await this.repository.anonymizeByUser(userId);
    this.logger.log({ msg: 'Notifications of the deleted user anonymized', userId, anonymized });
    return anonymized;
  }
}
