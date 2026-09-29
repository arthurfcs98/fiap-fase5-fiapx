import { Registry } from '@prometheus-io/client';
import { PrometheusVideoMetrics } from './prometheus-video.metrics';

describe('PrometheusVideoMetrics', () => {
  it('exposes the contract counters (error_code is the only label)', async () => {
    const registry = new Registry();
    const metrics = new PrometheusVideoMetrics(registry);

    metrics.uploaded();
    metrics.uploaded();
    metrics.completed();
    metrics.failed('P0001');
    metrics.failed('P0099');

    const text = await registry.metrics();
    expect(text).toContain('fiapx_videos_uploaded_total 2');
    expect(text).toContain('fiapx_videos_completed_total 1');
    expect(text).toContain('fiapx_videos_failed_total{error_code="P0001"} 1');
    expect(text).toContain('fiapx_videos_failed_total{error_code="P0099"} 1');
  });

  it('reuses the counters already registered (app created twice in the same registry)', () => {
    const registry = new Registry();
    const first = new PrometheusVideoMetrics(registry);
    const second = new PrometheusVideoMetrics(registry);
    expect(second.uploadedTotal).toBe(first.uploadedTotal);
    expect(second.failedTotal).toBe(first.failedTotal);
  });
});
