import { MessageConsumers } from '@fiapx/messaging';
import { MetricsServerService } from '@fiapx/observability';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { EMAIL_SENDER } from './modules/notifications/domain/ports/email-sender.port';
import type { EmailSender } from './modules/notifications/domain/ports/email-sender.port';
import { NOTIFICATION_REPOSITORY } from './modules/notifications/domain/ports/notification.repository';
import { TypeOrmNotificationRepository } from './modules/notifications/infrastructure/persistence/typeorm-notification.repository';
import {
  NOTIFICATION_RETENTION_CRON,
  NOTIFICATION_RETENTION_JOB,
} from './modules/notifications/interfaces/jobs/notification-retention.job';
import { NotificationModule } from './notification.module';

/**
 * Boots the real root module (config, pino, metrics server, messaging, TypeORM, schedule,
 * notifications) with the DataSource replaced (no Postgres in unit tests; the real one runs in
 * `test/notification-service.int-spec.ts`). The broker URL points to a closed port: like a real
 * boot with RabbitMQ down, the app starts anyway and keeps reconnecting in the background.
 */
describe('NotificationModule (wiring)', () => {
  const previousEnv = { ...process.env };
  let app: TestingModule | undefined;
  const dataSource = { isInitialized: false, manager: {}, destroy: jest.fn() };

  async function boot(): Promise<TestingModule> {
    const moduleRef = await Test.createTestingModule({ imports: [NotificationModule] })
      .overrideProvider(DataSource)
      .useValue(dataSource)
      .compile();
    moduleRef.enableShutdownHooks();
    await moduleRef.init();
    return moduleRef;
  }

  beforeEach(() => {
    Object.assign(process.env, {
      LOG_LEVEL: 'silent',
      APP_VERSION: 'test-sha',
      METRICS_PORT: '0',
      METRICS_HOST: '127.0.0.1',
      RABBITMQ_URL: 'amqp://guest:guest@127.0.0.1:1',
      DB_HOST: '127.0.0.1',
      DB_USER: 'fiapx_notification',
      DB_PASSWORD: 'test-password',
      DB_NAME: 'fiapx_notification',
      DB_SSL: 'false',
      EMAIL_PROVIDER: 'log',
      EMAIL_FROM: 'FIAP Frames <nao-responda@fiapx.local>',
    });
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    process.env = { ...previousEnv };
  });

  it('exposes /health and the notification metric, registers the consumer and the retention job', async () => {
    app = await boot();
    const service = app.get(MetricsServerService);
    const base = `http://127.0.0.1:${service.server.port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({
      status: 'ok',
      service: 'notification-service',
      version: 'test-sha',
    });
    const metrics = await (await fetch(`${base}/metrics`)).text();
    expect(metrics).toContain(
      'fiapx_notifications_total{type="VIDEO_FAILED",status="SENT",service="notification-service"} 0',
    );

    expect(app.get(MessageConsumers).all.map((runner) => runner.queue)).toEqual([
      'notification.events',
    ]);
    const job = app.get(SchedulerRegistry).getCronJob(NOTIFICATION_RETENTION_JOB);
    expect(job.cronTime.source).toBe(NOTIFICATION_RETENTION_CRON);
    expect(app.get(NOTIFICATION_REPOSITORY)).toBeInstanceOf(TypeOrmNotificationRepository);
    expect(app.get<EmailSender>(EMAIL_SENDER).provider).toBe('log');

    await app.close();
    app = undefined;
    expect(service.server.port).toBeUndefined();
  }, 20_000);

  it('protects /metrics when METRICS_TOKEN is set', async () => {
    process.env['METRICS_TOKEN'] = 'token-de-teste-1234';
    app = await boot();
    const base = `http://127.0.0.1:${app.get(MetricsServerService).server.port}`;

    expect((await fetch(`${base}/metrics`)).status).toBe(401);
    const authorized = await fetch(`${base}/metrics`, {
      headers: { authorization: 'Bearer token-de-teste-1234' },
    });
    expect(authorized.status).toBe(200);
  }, 20_000);

  it('does not boot with an invalid configuration', async () => {
    process.env['EMAIL_PROVIDER'] = 'resend';
    await expect(boot()).rejects.toThrow(/RESEND_API_KEY/);
  });
});
