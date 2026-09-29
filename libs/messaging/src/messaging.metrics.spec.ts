import { Registry } from '@prometheus-io/client';
import { CONSUME_RESULTS, MESSAGES_CONSUMED_TOTAL, MessagingMetrics } from './messaging.metrics';

describe('MessagingMetrics', () => {
  it('registra fiapx_messages_consumed_total{queue,result} no registry do serviço', async () => {
    const registry = new Registry();
    const metrics = new MessagingMetrics(registry);

    metrics.consumed('worker.video-uploaded', 'retry');
    metrics.consumed('worker.video-uploaded', 'retry');
    metrics.consumed('notification.events', 'success');

    const text = await registry.metrics();
    expect(text).toContain(
      `${MESSAGES_CONSUMED_TOTAL}{queue="worker.video-uploaded",result="retry"} 2`,
    );
    expect(await metrics.consumedCount('notification.events', 'success')).toBe(1);
    expect(await metrics.consumedCount('notification.events', 'invalid')).toBe(0);
  });

  it('reaproveita o contador já registrado (vários consumidores no mesmo registry)', () => {
    const registry = new Registry();
    const first = new MessagingMetrics(registry);
    const second = new MessagingMetrics(registry);
    expect(second.consumedTotal).toBe(first.consumedTotal);
  });

  it('lista os resultados possíveis do label result', () => {
    expect(CONSUME_RESULTS).toEqual([
      'success',
      'retry',
      'dead_letter',
      'permanent_failure',
      'invalid',
      'requeued',
      'deferred',
      'aborted',
    ]);
  });
});
