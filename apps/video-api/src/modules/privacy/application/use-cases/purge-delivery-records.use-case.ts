import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ProcessedMessages } from '../../../../shared/application/processed-messages';
import { PROCESSED_MESSAGES } from '../../../../shared/application/processed-messages';
import type { Clock } from '../../../../shared/domain/clock';
import { CLOCK } from '../../../../shared/domain/clock';
import type { OutboxStore } from '../../../outbox/domain/outbox.ports';
import { OUTBOX_STORE } from '../../../outbox/domain/outbox.ports';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Published outbox rows are kept 7 days (their `video.*` payloads carry e-mail and name). */
export const PUBLISHED_OUTBOX_RETENTION_DAYS = 7;
/** Inbox rows are kept 14 days (a redelivery never takes that long). */
export const PROCESSED_MESSAGES_RETENTION_DAYS = 14;

export interface DeliveryPurgeSummary {
  outbox: number;
  processedMessages: number;
}

/**
 * Data minimization (LGPD art. 6 III): delivery bookkeeping is not kept forever. Idempotent
 * DELETEs, safe to run on several replicas.
 */
@Injectable()
export class PurgeDeliveryRecordsUseCase {
  private readonly logger = new Logger(PurgeDeliveryRecordsUseCase.name);

  constructor(
    @Inject(OUTBOX_STORE) private readonly outbox: OutboxStore,
    @Inject(PROCESSED_MESSAGES) private readonly processedMessages: ProcessedMessages,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async execute(): Promise<DeliveryPurgeSummary> {
    const now = this.clock.now().getTime();
    const summary = {
      outbox: await this.outbox.purgePublishedBefore(
        new Date(now - PUBLISHED_OUTBOX_RETENTION_DAYS * DAY_MS),
      ),
      processedMessages: await this.processedMessages.purgeBefore(
        new Date(now - PROCESSED_MESSAGES_RETENTION_DAYS * DAY_MS),
      ),
    };
    if (summary.outbox + summary.processedMessages > 0) {
      this.logger.log({ msg: 'Registros de entrega antigos removidos', ...summary });
    }
    return summary;
  }
}
