import { Injectable } from '@nestjs/common';
import type { EntityManager, QueryDeepPartialEntity } from 'typeorm';
import { DataSource, LessThan, Not } from 'typeorm';
import type { DeliveryRecord, NewNotification, Notification } from '../../domain/notification';
import { ANONYMIZED_RECIPIENT, LAST_ERROR_MAX_LENGTH } from '../../domain/notification';
import type {
  DeliveryStep,
  INotificationRepository,
} from '../../domain/ports/notification.repository';
import { toDomainNotification } from './notification.mapper';
import { NotificationOrmEntity } from './notification.orm-entity';

/**
 * Key of the transaction-level advisory lock of the retention job (`pg_try_advisory_xact_lock`).
 * Advisory locks are per database, so it only has to be unique inside `fiapx_notification`.
 */
export const RETENTION_LOCK_KEY = 5_100_001;

/** `notifications.provider_message_id` is `varchar(100)`. */
const PROVIDER_MESSAGE_ID_MAX_LENGTH = 100;

/** contratos.md, section 6: idempotent registration by `dedup_key`. */
export const INSERT_IF_ABSENT_SQL = `INSERT INTO notifications (id, dedup_key, user_id, type, recipient, subject, payload)
VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
ON CONFLICT (dedup_key) DO NOTHING
RETURNING id`;

/** contratos.md, section 12: what "anonymized" means for a notification. */
const ANONYMIZED_FIELDS: QueryDeepPartialEntity<NotificationOrmEntity> = {
  recipient: ANONYMIZED_RECIPIENT,
  payload: {},
};

/** {@link INotificationRepository} on Postgres (TypeORM 1.x, `fiapx_notification`). */
@Injectable()
export class TypeOrmNotificationRepository implements INotificationRepository {
  constructor(private readonly dataSource: DataSource) {}

  async registerIfAbsent(notification: NewNotification): Promise<boolean> {
    const inserted = await this.dataSource.query<{ id: string }[]>(INSERT_IF_ABSENT_SQL, [
      notification.id,
      notification.dedupKey,
      notification.userId,
      notification.type,
      notification.recipient,
      notification.subject,
      JSON.stringify(notification.payload),
    ]);
    return inserted.length > 0;
  }

  deliverExclusively<T>(
    dedupKey: string,
    attempt: (notification: Notification) => Promise<DeliveryStep<T>>,
  ): Promise<T> {
    return this.dataSource.transaction(async (manager) => {
      const notifications = manager.getRepository(NotificationOrmEntity);
      // SELECT ... FOR UPDATE: a second delivery of the same event waits here until this one
      // commits, then sees SENT and does nothing.
      const row = await notifications.findOne({
        where: { dedupKey },
        lock: { mode: 'pessimistic_write' },
      });
      if (row === null) throw new Error(`Notification ${dedupKey} not found`);

      const { record, result } = await attempt(toDomainNotification(row));
      if (record !== undefined) {
        await notifications.update({ id: row.id }, deliveryUpdate(record));
      }
      return result;
    });
  }

  async anonymizeByUser(userId: string): Promise<number> {
    const result = await this.dataSource
      .getRepository(NotificationOrmEntity)
      .update({ userId, recipient: Not(ANONYMIZED_RECIPIENT) }, ANONYMIZED_FIELDS);
    return result.affected ?? 0;
  }

  anonymizeCreatedBefore(cutoff: Date): Promise<number | null> {
    return this.dataSource.transaction(async (manager) => {
      if (!(await tryRetentionLock(manager))) return null;
      const result = await manager
        .getRepository(NotificationOrmEntity)
        .update(
          { createdAt: LessThan(cutoff), recipient: Not(ANONYMIZED_RECIPIENT) },
          ANONYMIZED_FIELDS,
        );
      return result.affected ?? 0;
    });
  }
}

async function tryRetentionLock(manager: EntityManager): Promise<boolean> {
  const rows = await manager.query<{ locked: boolean }[]>(
    'SELECT pg_try_advisory_xact_lock($1) AS locked',
    [RETENTION_LOCK_KEY],
  );
  return rows[0]?.locked === true;
}

function deliveryUpdate(record: DeliveryRecord): QueryDeepPartialEntity<NotificationOrmEntity> {
  if (record.status === 'SENT') {
    return {
      status: 'SENT',
      attempts: () => 'attempts + 1',
      providerMessageId: record.providerMessageId.slice(0, PROVIDER_MESSAGE_ID_MAX_LENGTH),
      lastError: null,
      sentAt: () => 'now()',
    };
  }
  return {
    status: record.status,
    lastError: record.error.slice(0, LAST_ERROR_MAX_LENGTH),
    ...(record.attempted ? { attempts: () => 'attempts + 1' } : {}),
  };
}
