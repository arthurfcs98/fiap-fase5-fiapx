import type { Registry } from '@prometheus-io/client';
import { Gauge } from '@prometheus-io/client';
import type { OutboxStore } from '../domain/outbox.ports';

/** contratos.md, section 11 (and the "nenhuma requisição perdida" SLO, section 13). */
export const OUTBOX_PENDING = 'fiapx_outbox_pending';

/**
 * `fiapx_outbox_pending`: counted at scrape time (`SELECT count(*) ... WHERE published_at IS
 * NULL`, served by the partial index `ix_outbox_pending`). If the database is down the last
 * value is kept, so the scrape itself never fails.
 */
export function registerOutboxPendingGauge(registry: Registry, store: OutboxStore): Gauge {
  const existing = registry.getSingleMetric(OUTBOX_PENDING);
  if (existing instanceof Gauge) return existing;
  return new Gauge({
    name: OUTBOX_PENDING,
    help: 'Eventos do outbox ainda não publicados no RabbitMQ',
    registers: [registry],
    async collect() {
      try {
        this.set(await store.countPending());
      } catch {
        // keep the previous value
      }
    },
  });
}
