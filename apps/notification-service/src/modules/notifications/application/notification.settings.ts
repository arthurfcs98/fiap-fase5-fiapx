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
}

export function notificationSettingsFromConfig(
  config: Pick<
    NotificationConfig,
    'PUBLIC_BASE_URL' | 'NOTIFY_ON_SUCCESS' | 'NOTIFICATION_RETENTION_DAYS'
  >,
): NotificationSettings {
  return {
    publicBaseUrl: config.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    notifyOnSuccess: config.NOTIFY_ON_SUCCESS,
    retentionDays: config.NOTIFICATION_RETENTION_DAYS,
  };
}
