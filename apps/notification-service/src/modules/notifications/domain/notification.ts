/**
 * Notification (one row of `notifications`, contratos.md sections 6 and 12). Pure domain: no Nest,
 * TypeORM or SDK imports.
 */

/** `notifications.type`: one template per type. */
export const NOTIFICATION_TYPES = ['VIDEO_FAILED', 'VIDEO_COMPLETED'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** `notifications.status`: PENDING until delivered (SENT) or given up (FAILED). */
export const NOTIFICATION_STATUSES = ['PENDING', 'SENT', 'FAILED'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

/** Written over `recipient` when a notification is anonymized (user deleted or retention). */
export const ANONYMIZED_RECIPIENT = 'removido';

/** `notifications.last_error` is `varchar(500)`. */
export const LAST_ERROR_MAX_LENGTH = 500;

export interface Notification {
  id: string;
  /** `<TYPE>:<videoId>`: at most one e-mail per type and video (idempotency). */
  dedupKey: string;
  userId: string;
  type: NotificationType;
  /** E-mail address (personal data): never logged, anonymized per LGPD. */
  recipient: string;
  subject: string;
  status: NotificationStatus;
  attempts: number;
  providerMessageId: string | null;
  lastError: string | null;
  /** Template data (personal data: user name and file name). `{}` once anonymized. */
  payload: Record<string, unknown>;
  createdAt: Date;
  sentAt: Date | null;
}

/** What the consumer registers before the first delivery attempt. */
export type NewNotification = Pick<
  Notification,
  'id' | 'dedupKey' | 'userId' | 'type' | 'recipient' | 'subject' | 'payload'
>;

export function notificationDedupKey(type: NotificationType, videoId: string): string {
  return `${type}:${videoId}`;
}

export function isAnonymized(notification: Pick<Notification, 'recipient'>): boolean {
  return notification.recipient === ANONYMIZED_RECIPIENT;
}

export function isNotificationType(value: unknown): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly unknown[]).includes(value);
}

export function isNotificationStatus(value: unknown): value is NotificationStatus {
  return (NOTIFICATION_STATUSES as readonly unknown[]).includes(value);
}

/**
 * State change persisted after a delivery attempt, under the row lock:
 * - `SENT`: the provider accepted the e-mail (`attempts + 1`, `sent_at`, provider id);
 * - `FAILED`: permanent rejection, retries exhausted or recipient removed;
 * - `PENDING`: transient failure, the queue retries it.
 *
 * `attempted` is false when no e-mail left the service (e.g. anonymized recipient), so
 * `attempts` only counts real calls to the provider.
 */
export type DeliveryRecord =
  | { status: 'SENT'; providerMessageId: string }
  | { status: 'FAILED' | 'PENDING'; error: string; attempted: boolean };
