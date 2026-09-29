import type { TypeOrmOptionsInput } from '@fiapx/common';
import { SERVICE_NAME } from '../config/notification.config';
import { NotificationOrmEntity } from '../modules/notifications/infrastructure/persistence/notification.orm-entity';
import { NOTIFICATION_MIGRATIONS } from './migrations';

/** Entities and migrations of `fiapx_notification`, shared by the service and `migrate.js`. */
export function notificationDataSourceInput(
  applicationName: string = SERVICE_NAME,
): TypeOrmOptionsInput {
  return {
    applicationName,
    entities: [NotificationOrmEntity],
    migrations: NOTIFICATION_MIGRATIONS,
  };
}
