import { Registry } from '@prometheus-io/client';
import {
  NOTIFICATIONS_TOTAL,
  PrometheusNotificationMetrics,
} from './prometheus-notification-metrics';

describe('PrometheusNotificationMetrics', () => {
  it('exposes fiapx_notifications_total{type,status} with every series at zero', async () => {
    const registry = new Registry();
    new PrometheusNotificationMetrics(registry);

    const text = await registry.metrics();
    for (const type of ['VIDEO_FAILED', 'VIDEO_COMPLETED']) {
      for (const status of ['SENT', 'FAILED', 'RETRY', 'SKIPPED']) {
        expect(text).toContain(`${NOTIFICATIONS_TOTAL}{type="${type}",status="${status}"} 0`);
      }
    }
  });

  it('counts each outcome and reuses the counter already in the registry', async () => {
    const registry = new Registry();
    const first = new PrometheusNotificationMetrics(registry);
    const second = new PrometheusNotificationMetrics(registry);

    first.record('VIDEO_FAILED', 'SENT');
    second.record('VIDEO_FAILED', 'SENT');
    second.record('VIDEO_COMPLETED', 'SKIPPED');

    expect(second.total).toBe(first.total);
    const text = await registry.metrics();
    expect(text).toContain(`${NOTIFICATIONS_TOTAL}{type="VIDEO_FAILED",status="SENT"} 2`);
    expect(text).toContain(`${NOTIFICATIONS_TOTAL}{type="VIDEO_COMPLETED",status="SKIPPED"} 1`);
  });
});
