import { Counter, Registry } from '@prometheus-io/client';
import { HTTP_DURATION_BUCKETS, HTTP_REQUEST_DURATION_SECONDS, HttpMetrics } from './http-metrics';

describe('HttpMetrics', () => {
  it('registra fiapx_http_request_duration_seconds{method,route,status} com bucket exato em 5 s', async () => {
    const registry = new Registry();
    const metrics = new HttpMetrics(registry);

    metrics.observe({ method: 'POST', route: '/api/videos', status: 202 }, 4.2);
    metrics.observe({ method: 'POST', route: '/api/videos', status: 202 }, 6);

    const text = await registry.metrics();
    expect(text).toContain(`# TYPE ${HTTP_REQUEST_DURATION_SECONDS} histogram`);
    expect(text).toContain(
      `${HTTP_REQUEST_DURATION_SECONDS}_bucket{le="5",method="POST",route="/api/videos",status="202"} 1`,
    );
    expect(text).toContain(
      `${HTTP_REQUEST_DURATION_SECONDS}_count{method="POST",route="/api/videos",status="202"} 2`,
    );
    expect(HTTP_DURATION_BUCKETS).toContain(5);
    expect([...HTTP_DURATION_BUCKETS].sort((a, b) => a - b)).toEqual(HTTP_DURATION_BUCKETS);
  });

  it('requestCount soma os _count que casam com os labels (omitido = qualquer valor)', async () => {
    const metrics = new HttpMetrics(new Registry());
    metrics.observe({ method: 'GET', route: '/api/videos/:id', status: 200 }, 0.01);
    metrics.observe({ method: 'GET', route: '/api/videos/:id', status: 404 }, 0.01);
    metrics.observe({ method: 'GET', route: '/api/videos', status: '200' }, 0.01);

    expect(await metrics.requestCount()).toBe(3);
    expect(await metrics.requestCount({ route: '/api/videos/:id' })).toBe(2);
    expect(await metrics.requestCount({ route: '/api/videos/:id', status: 404 })).toBe(1);
    expect(await metrics.requestCount({ method: 'DELETE' })).toBe(0);
  });

  it('reaproveita o histograma já registrado (várias instâncias no mesmo registry)', () => {
    const registry = new Registry();
    const first = new HttpMetrics(registry);
    const second = new HttpMetrics(registry);
    expect(second.requestDuration).toBe(first.requestDuration);
  });

  it('não reaproveita métrica de outro tipo com o mesmo nome (falha alto, sem mascarar)', () => {
    const registry = new Registry();
    new Counter({ name: HTTP_REQUEST_DURATION_SECONDS, help: 'x', registers: [registry] });
    expect(() => new HttpMetrics(registry)).toThrow();
  });
});
