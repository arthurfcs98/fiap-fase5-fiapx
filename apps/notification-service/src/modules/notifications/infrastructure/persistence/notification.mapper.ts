import type { Notification } from '../../domain/notification';
import { isNotificationStatus, isNotificationType } from '../../domain/notification';
import type { NotificationOrmEntity } from './notification.orm-entity';

/** ORM row → domain. Unknown `type`/`status` values mean a corrupted row: fail loudly. */
export function toDomainNotification(row: NotificationOrmEntity): Notification {
  if (!isNotificationType(row.type)) {
    throw new Error(`Notification ${row.id} has an unknown type "${row.type}"`);
  }
  if (!isNotificationStatus(row.status)) {
    throw new Error(`Notification ${row.id} has an unknown status "${row.status}"`);
  }
  return {
    id: row.id,
    dedupKey: row.dedupKey,
    userId: row.userId,
    type: row.type,
    recipient: row.recipient,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    providerMessageId: row.providerMessageId,
    lastError: row.lastError,
    payload: row.payload,
    createdAt: row.createdAt,
    sentAt: row.sentAt,
  };
}
