import type { NotificationConfig } from '../../../config/notification.config';

/** Injection token of {@link NotificationSettings}. */
export const NOTIFICATION_SETTINGS = Symbol('NOTIFICATION_SETTINGS');

/** Runtime settings of the notification use cases (derived from the validated config). */
export interface NotificationSettings {
  /** Link target of the e-mails, without a trailing slash. */
  publicBaseUrl: string;
  /** `NOTIFY_ON_SUCCESS`: `video.completed` e-mails are optional. */
  notifyOnSuccess: boolean;
  /** `NOTIFICATION_RETENTION_DAYS` (LGPD). */
  retentionDays: number;
  /** `NOTIFICATION_DAILY_LIMIT_PER_USER`: e-mails per user in 24 h. */
  dailyLimitPerUser: number;
  /** `NOTIFICATION_DAILY_LIMIT`: e-mails for everyone in 24 h. */
  dailyLimit: number;
}

export function notificationSettingsFromConfig(
  config: Pick<
    NotificationConfig,
    | 'PUBLIC_BASE_URL'
    | 'NOTIFY_ON_SUCCESS'
    | 'NOTIFICATION_RETENTION_DAYS'
    | 'NOTIFICATION_DAILY_LIMIT_PER_USER'
    | 'NOTIFICATION_DAILY_LIMIT'
  >,
): NotificationSettings {
  return {
    publicBaseUrl: config.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    notifyOnSuccess: config.NOTIFY_ON_SUCCESS,
    retentionDays: config.NOTIFICATION_RETENTION_DAYS,
    dailyLimitPerUser: config.NOTIFICATION_DAILY_LIMIT_PER_USER,
    dailyLimit: config.NOTIFICATION_DAILY_LIMIT,
  };
}
