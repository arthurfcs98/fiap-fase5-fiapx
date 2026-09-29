import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MessageConsumers } from '@fiapx/messaging';
import { createStandaloneApp, MetricsServerService } from '@fiapx/observability';
import type { INestApplicationContext } from '@nestjs/common';
import { WorkerModule } from './worker.module';

/**
 * Boots the real root module (config, pino, metrics server, messaging, storage, processing) on an
 * ephemeral port. The broker URL points to a closed port: like a real boot with RabbitMQ down,
 * the app starts anyway and keeps reconnecting in the background.
 */
describe('WorkerModule (wiring)', () => {
  const previousEnv = { ...process.env };
  let app: INestApplicationContext | undefined;
  let workRoot: string;

  beforeEach(() => {
    workRoot = mkdtempSync(join(tmpdir(), 'fiapx-worker-module-'));
    Object.assign(process.env, {
      LOG_LEVEL: 'silent',
      APP_VERSION: 'test-sha',
      METRICS_PORT: '0',
      METRICS_HOST: '127.0.0.1',
      RABBITMQ_URL: 'amqp://guest:guest@127.0.0.1:1',
      S3_ENDPOINT: 'http://127.0.0.1:1',
      S3_ACCESS_KEY_ID: 'GK0123456789abcdef',
      S3_SECRET_ACCESS_KEY: '0123456789abcdef0123456789abcdef',
      WORK_DIR: join(workRoot, 'work'),
    });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    process.env = { ...previousEnv };
    rmSync(workRoot, { recursive: true, force: true });
  });

  it('exposes /health and the worker metrics, registers the consumer and creates WORK_DIR', async () => {
    app = await createStandaloneApp(WorkerModule);
    const service = app.get(MetricsServerService);
    const base = `http://127.0.0.1:${service.server.port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: 'ok',
      service: 'video-worker',
      version: 'test-sha',
    });
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain('fiapx_worker_in_flight{service="video-worker"} 0');
    expect(metrics).toContain(
      'fiapx_worker_jobs_total{result="completed",service="video-worker"} 0',
    );
    expect(metrics).toContain(
      'fiapx_video_processing_duration_seconds_count{service="video-worker",result="failed"} 0',
    );

    expect(app.get(MessageConsumers).all.map((runner) => runner.queue)).toEqual([
      'worker.video-uploaded',
    ]);
    expect(statSync(join(workRoot, 'work')).isDirectory()).toBe(true);

    await app.close();
    app = undefined;
    expect(service.server.port).toBeUndefined();
  }, 20_000);

  it('protects /metrics when METRICS_TOKEN is set', async () => {
    process.env['METRICS_TOKEN'] = 'token-de-teste-1234';
    app = await createStandaloneApp(WorkerModule);
    const base = `http://127.0.0.1:${app.get(MetricsServerService).server.port}`;

    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    const authorized = await fetch(`${base}/metrics`, {
      headers: { authorization: 'Bearer token-de-teste-1234' },
    });
    expect(authorized.status).toBe(200);
  }, 20_000);

  it('does not boot with an invalid configuration', async () => {
    process.env['METRICS_PORT'] = 'porta';
    await expect(createStandaloneApp(WorkerModule)).rejects.toThrow(/METRICS_PORT/);
  });
});
