import { Counter } from '@prometheus-io/client';
import { createMetricsRegistry } from './metrics-registry';

describe('createMetricsRegistry', () => {
  it('registra métricas padrão do processo com o label service', async () => {
    const registry = createMetricsRegistry('video-worker');

    const output = await registry.metrics();

    expect(output).toContain('process_cpu_user_seconds_total');
    expect(output).toContain('nodejs_eventloop_lag_seconds');
    expect(output).toMatch(/service="video-worker"/);
    registry.clear();
  });

  it('pode ficar sem métricas padrão e aceita métricas de negócio', async () => {
    const registry = createMetricsRegistry('video-api', { defaultMetrics: false });
    const counter = new Counter({
      name: 'fiapx_test_total',
      help: 'teste',
      registers: [registry],
    });
    counter.inc();

    const output = await registry.metrics();

    expect(output).not.toContain('process_cpu_user_seconds_total');
    expect(output).toContain('fiapx_test_total{service="video-api"} 1');
  });

  it('usa registries isolados (sem conflito de nomes entre instâncias)', () => {
    expect(() => {
      createMetricsRegistry('a', { defaultMetrics: true }).clear();
      createMetricsRegistry('b', { defaultMetrics: true }).clear();
    }).not.toThrow();
  });
});
