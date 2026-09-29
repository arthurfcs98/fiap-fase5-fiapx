import type { NotificationType } from '../notification';

/** Injection token of {@link INotificationMetrics}. */
export const NOTIFICATION_METRICS = Symbol('NOTIFICATION_METRICS');

/**
 * `status` label of `fiapx_notifications_total{type,status}` (contratos.md, section 11), one
 * increment per handled event:
 * - `SENT`: the provider accepted the e-mail;
 * - `FAILED`: permanent rejection or retries exhausted (the row is FAILED);
 * - `RETRY`: transient failure, the message goes to the next `.retry.N` queue;
 * - `SKIPPED`: nothing sent on purpose (already sent, recipient removed, success e-mails off).
 */
export const NOTIFICATION_OUTCOMES = ['SENT', 'FAILED', 'RETRY', 'SKIPPED'] as const;
export type NotificationOutcome = (typeof NOTIFICATION_OUTCOMES)[number];

/** Port for the notification business metric. Labels never carry personal data. */
export interface INotificationMetrics {
  record(type: NotificationType, outcome: NotificationOutcome): void;
}
