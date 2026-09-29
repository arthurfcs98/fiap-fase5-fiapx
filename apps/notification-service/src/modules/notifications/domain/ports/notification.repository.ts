import type { DeliveryRecord, NewNotification, Notification } from '../notification';

/** Injection token of {@link INotificationRepository}. */
export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');

/**
 * Result of the idempotent registration: row created now, already there (redelivery), or not
 * registered because the user was deleted (`user.deleted` already applied: LGPD).
 */
export type RegisterOutcome = 'created' | 'exists' | 'user-deleted';

/** Notifications created since a moment, for the e-mail budget. */
export interface NotificationCounts {
  /** Of this user. */
  user: number;
  /** Of everyone (daily budget below the provider quota). */
  total: number;
}

/** What a delivery attempt returns: the state to persist (if any) and a result for the caller. */
export interface DeliveryStep<T> {
  record?: DeliveryRecord;
  result: T;
}

export interface INotificationRepository {
  /**
   * Idempotent registration (`INSERT ... ON CONFLICT (dedup_key) DO NOTHING`), refused for a
   * user in `deleted_users`. Serialized per user with {@link anonymizeByUser} (advisory lock):
   * an event that races with the erasure can never store the address again.
   */
  registerIfAbsent(notification: NewNotification): Promise<RegisterOutcome>;

  /** `true` when a notification with this `dedup_key` already exists (a redelivery). */
  isRegistered(dedupKey: string): Promise<boolean>;

  /** Notifications created at or after `since` (the user's and everyone's). */
  countCreatedSince(since: Date, userId: string): Promise<NotificationCounts>;

  /**
   * Runs `attempt` holding an exclusive lock on the notification row, so duplicate deliveries
   * of the same event (at-least-once) are serialized and only one of them sends the e-mail.
   * The returned `record` is persisted before the lock is released.
   */
  deliverExclusively<T>(
    dedupKey: string,
    attempt: (notification: Notification) => Promise<DeliveryStep<T>>,
  ): Promise<T>;

  /**
   * LGPD, `user.deleted`: records the user in `deleted_users` and sets `recipient = 'removido'`
   * and `payload = '{}'` on every notification of the user, in one transaction. Idempotent.
   * @returns rows changed now.
   */
  anonymizeByUser(userId: string): Promise<number>;

  /**
   * LGPD, retention: anonymizes notifications created before `cutoff` and forgets the
   * `deleted_users` older than it, guarded by a transaction-level advisory lock so only one
   * replica runs it.
   * @returns rows anonymized, or `null` when another replica holds the lock.
   */
  anonymizeCreatedBefore(cutoff: Date): Promise<number | null>;
}
