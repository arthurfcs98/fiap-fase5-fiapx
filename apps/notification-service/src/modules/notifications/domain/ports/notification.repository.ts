import type { DeliveryRecord, NewNotification, Notification } from '../notification';

/** Injection token of {@link INotificationRepository}. */
export const NOTIFICATION_REPOSITORY = Symbol('NOTIFICATION_REPOSITORY');

/** What a delivery attempt returns: the state to persist (if any) and a result for the caller. */
export interface DeliveryStep<T> {
  record?: DeliveryRecord;
  result: T;
}

export interface INotificationRepository {
  /**
   * Idempotent registration (`INSERT ... ON CONFLICT (dedup_key) DO NOTHING`).
   * @returns `true` when the row was created, `false` when it already existed.
   */
  registerIfAbsent(notification: NewNotification): Promise<boolean>;

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
   * LGPD, `user.deleted`: `recipient = 'removido'` and `payload = '{}'` on every notification of
   * the user. Idempotent. @returns rows changed now.
   */
  anonymizeByUser(userId: string): Promise<number>;

  /**
   * LGPD, retention: anonymizes notifications created before `cutoff`, guarded by a
   * transaction-level advisory lock so only one replica runs it.
   * @returns rows changed, or `null` when another replica holds the lock.
   */
  anonymizeCreatedBefore(cutoff: Date): Promise<number | null>;
}
