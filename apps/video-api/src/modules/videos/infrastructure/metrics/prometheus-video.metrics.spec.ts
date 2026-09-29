import { Registry } from '@prometheus-io/client';
import { PrometheusVideoMetrics, registerZipStorageGauge } from './prometheus-video.metrics';

describe('PrometheusVideoMetrics', () => {
  it('exposes the contract counters (error_code is the only label)', async () => {
    const registry = new Registry();
    const metrics = new PrometheusVideoMetrics(registry);

    metrics.uploaded();
    metrics.uploaded();
    metrics.completed(42);
    metrics.failed('P0001');
    metrics.failed('P0099');

    const text = await registry.metrics();
    expect(text).toContain('fiapx_videos_uploaded_total 2');
    expect(text).toContain('fiapx_videos_completed_total 1');
    expect(text).toContain('fiapx_videos_failed_total{error_code="P0001"} 1');
    expect(text).toContain('fiapx_videos_failed_total{error_code="P0099"} 1');
    // Upload → COMPLETED (queue wait included), exact bucket at the 300 s SLO target.
    expect(text).toContain('fiapx_video_turnaround_seconds_bucket{le="60"} 1');
    expect(text).toContain('fiapx_video_turnaround_seconds_bucket{le="30"} 0');
    expect(text).toContain('fiapx_video_turnaround_seconds_count 1');
  });

  it('reuses the counters already registered (app created twice in the same registry)', () => {
    const registry = new Registry();
    const first = new PrometheusVideoMetrics(registry);
    const second = new PrometheusVideoMetrics(registry);
    expect(second.uploadedTotal).toBe(first.uploadedTotal);
    expect(second.failedTotal).toBe(first.failedTotal);
    expect(second.turnaround).toBe(first.turnaround);
  });

  it('every P code starts at 0, so increase() sees the FIRST failure of each code (SLO)', async () => {
    const registry = new Registry();
    new PrometheusVideoMetrics(registry);

    const text = await registry.metrics();
    for (const code of ['P0001', 'P0006', 'P0007', 'P0098', 'P0099']) {
      expect(text).toContain(`fiapx_videos_failed_total{error_code="${code}"} 0`);
    }
    expect(text).toContain('fiapx_videos_completed_total 0');
  });

  it('fiapx_zip_storage_bytes is read at scrape time and keeps the last value on errors', async () => {
    const registry = new Registry();
    const videos = { sumStoredZipBytes: jest.fn().mockResolvedValue(1_234) };
    const gauge = registerZipStorageGauge(registry, videos);
    expect(registerZipStorageGauge(registry, videos)).toBe(gauge);

    expect(await registry.metrics()).toContain('fiapx_zip_storage_bytes 1234');
    videos.sumStoredZipBytes.mockRejectedValue(new Error('db down'));
    expect(await registry.metrics()).toContain('fiapx_zip_storage_bytes 1234');
  });
});
