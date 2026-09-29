import { NotificationOrmEntity } from '../modules/notifications/infrastructure/persistence/notification.orm-entity';
import { NOTIFICATION_MIGRATIONS } from './migrations';
import { notificationDataSourceInput } from './notification-data-source';

describe('notificationDataSourceInput', () => {
  it('lists the entity and the explicit migrations, named after the service by default', () => {
    expect(notificationDataSourceInput()).toEqual({
      applicationName: 'notification-service',
      entities: [NotificationOrmEntity],
      migrations: NOTIFICATION_MIGRATIONS,
    });
    expect(notificationDataSourceInput('notification-service-migrate').applicationName).toBe(
      'notification-service-migrate',
    );
  });
});
