import type { Registry } from '@prometheus-io/client';
import { Counter } from '@prometheus-io/client';
import type { NotificationType } from '../../domain/notification';
import { NOTIFICATION_TYPES } from '../../domain/notification';
import type {
  INotificationMetrics,
  NotificationOutcome,
} from '../../domain/ports/notification-metrics.port';
import { NOTIFICATION_OUTCOMES } from '../../domain/ports/notification-metrics.port';

/** contratos.md, section 11. */
export const NOTIFICATIONS_TOTAL = 'fiapx_notifications_total';

type Labels = 'type' | 'status';

/** {@link INotificationMetrics} in the service registry (`METRICS_REGISTRY`). */
export class PrometheusNotificationMetrics implements INotificationMetrics {
  readonly total: Counter<Labels>;

  constructor(registry: Registry) {
    const existing = registry.getSingleMetric(NOTIFICATIONS_TOTAL);
    this.total =
      existing instanceof Counter
        ? existing
        : new Counter<Labels>({
            name: NOTIFICATIONS_TOTAL,
            help: 'Notification events handled, by type and outcome (SENT, FAILED, RETRY, SKIPPED)',
            labelNames: ['type', 'status'],
            registers: [registry],
          });
    // Every series exists from the first scrape, so rate()/increase() see the first event.
    for (const type of NOTIFICATION_TYPES) {
      for (const status of NOTIFICATION_OUTCOMES) this.total.inc({ type, status }, 0);
    }
  }

  record(type: NotificationType, outcome: NotificationOutcome): void {
    this.total.inc({ type, status: outcome });
  }
}
