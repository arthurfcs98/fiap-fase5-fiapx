import { Registry } from '@prometheus-io/client';
import { PrometheusProcessingMetrics, WORKER_METRICS } from './prometheus-processing-metrics';

async function valueOf(registry: Registry, name: string, labels: Record<string, string> = {}) {
  const metric = registry.getSingleMetric(name);
  const { values } = await metric!.get();
  const match = values.find((value) =>
    Object.entries(labels).every(([key, expected]) => value.labels[key] === expected),
  );
  return match?.value;
}

describe('PrometheusProcessingMetrics', () => {
  it('registers the contract metrics with every result series at zero', async () => {
    const registry = new Registry();
    new PrometheusProcessingMetrics(registry);

    const text = await registry.metrics();
    for (const result of ['completed', 'duplicate', 'failed', 'retry']) {
      expect(text).toContain(`${WORKER_METRICS.jobs}{result="${result}"} 0`);
      expect(text).toContain(`${WORKER_METRICS.processingDuration}_count{result="${result}"} 0`);
    }
    expect(text).toContain(`${WORKER_METRICS.inFlight} 0`);
  });

  it('tracks in-flight jobs, results and durations', async () => {
    const registry = new Registry();
    const metrics = new PrometheusProcessingMetrics(registry);

    metrics.jobStarted();
    metrics.jobStarted();
    expect(await valueOf(registry, WORKER_METRICS.inFlight)).toBe(2);

    metrics.jobFinished('completed', 12.5);
    metrics.jobFinished('failed', 0.4);

    expect(await valueOf(registry, WORKER_METRICS.inFlight)).toBe(0);
    expect(await valueOf(registry, WORKER_METRICS.jobs, { result: 'completed' })).toBe(1);
    expect(await valueOf(registry, WORKER_METRICS.jobs, { result: 'failed' })).toBe(1);
    const text = await registry.metrics();
    expect(text).toContain(`${WORKER_METRICS.processingDuration}_sum{result="completed"} 12.5`);
    expect(text).toContain(
      `${WORKER_METRICS.processingDuration}_bucket{le="20",result="completed"} 1`,
    );
  });
});
