import { Registry } from '@prometheus-io/client';
import type { OutboxStore } from '../domain/outbox.ports';
import { registerOutboxPendingGauge } from './prometheus-outbox.metrics';

describe('fiapx_outbox_pending', () => {
  it('is counted at scrape time and keeps the last value when the database fails', async () => {
    const countPending = jest
      .fn()
      .mockResolvedValueOnce(4)
      .mockRejectedValueOnce(new Error('down'));
    const registry = new Registry();
    const gauge = registerOutboxPendingGauge(registry, { countPending } as unknown as OutboxStore);

    expect(await registry.metrics()).toContain('fiapx_outbox_pending 4');
    expect(await registry.metrics()).toContain('fiapx_outbox_pending 4');
    expect(registerOutboxPendingGauge(registry, { countPending } as unknown as OutboxStore)).toBe(
      gauge,
    );
  });
});
