import { baseServiceConfigShape } from '@fiapx/common';
import { metricsServerConfigShape } from '@fiapx/observability';
import { z } from 'zod';

export const SERVICE_NAME = 'notification-service';

/** Token de injeção da configuração validada do notification-service. */
export const NOTIFICATION_CONFIG = Symbol('NOTIFICATION_CONFIG');

export const notificationConfigSchema = z.object({
  ...baseServiceConfigShape,
  ...metricsServerConfigShape,
});

export type NotificationConfig = z.output<typeof notificationConfigSchema>;
