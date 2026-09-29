import { notificationSettingsFromConfig } from './notification.settings';

describe('notificationSettingsFromConfig', () => {
  it('maps the config and drops trailing slashes from the base URL', () => {
    expect(
      notificationSettingsFromConfig({
        PUBLIC_BASE_URL: 'https://fiapx.asdevit.com/',
        NOTIFY_ON_SUCCESS: true,
        NOTIFICATION_RETENTION_DAYS: 30,
        NOTIFICATION_DAILY_LIMIT_PER_USER: 10,
        NOTIFICATION_DAILY_LIMIT: 80,
      }),
    ).toEqual({
      publicBaseUrl: 'https://fiapx.asdevit.com',
      notifyOnSuccess: true,
      retentionDays: 30,
      dailyLimitPerUser: 10,
      dailyLimit: 80,
    });
  });
});
