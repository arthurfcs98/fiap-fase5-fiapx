import { randomUUID } from 'node:crypto';
import type { EventOf, PayloadOf } from '@fiapx/contracts';
import { createEvent } from '@fiapx/contracts';
import type { EventPublisher, MessagingModuleOptions } from '@fiapx/messaging';
import {
  EVENT_PUBLISHER,
  MESSAGING_OPTIONS,
  MessageConsumers,
  MessagingMetrics,
  QUEUES,
  TopologyInitializer,
} from '@fiapx/messaging';
import { MetricsServerService } from '@fiapx/observability';
import type { StartedPostgres, StartedRabbitMq } from '@fiapx/testing';
import { delay, quietNestLogs, startPostgres, startRabbitMq, waitFor } from '@fiapx/testing';
import type { TestingModule } from '@nestjs/testing';
import { Test } from '@nestjs/testing';
import type { Channel, ChannelModel } from 'amqplib';
import { connect } from 'amqplib';
import { DataSource } from 'typeorm';
import { runMigrateCommand } from '../src/database/migrate.command';
import { RETENTION_LOCK_KEY } from '../src/modules/notifications/infrastructure/persistence/typeorm-notification.repository';
import { NotificationRetentionJob } from '../src/modules/notifications/interfaces/jobs/notification-retention.job';
import { NotificationModule } from '../src/notification.module';
import type { StartedMailpit } from './support/mailpit';
import { startMailpit } from './support/mailpit';

const PUBLIC_BASE_URL = 'https://fiapx.example.test';

interface NotificationRow {
  id: string;
  dedup_key: string;
  user_id: string;
  type: string;
  recipient: string;
  subject: string;
  status: string;
  attempts: number;
  provider_message_id: string | null;
  last_error: string | null;
  payload: Record<string, unknown>;
  sent_at: Date | null;
}

/**
 * The real notification-service (NotificationModule, same wiring as production, schema created
 * by the real `migrate` command) against Postgres, RabbitMQ and Mailpit in containers:
 * `notification.events` in, e-mail out (read back through the Mailpit API), rows in
 * `fiapx_notification`. Only the retry TTLs are shortened (disposable broker).
 */
describe('notification-service end to end (Postgres, RabbitMQ and Mailpit)', () => {
  const previousEnv = { ...process.env };
  let postgres: StartedPostgres;
  let rabbit: StartedRabbitMq;
  let mailpit: StartedMailpit;
  let app: TestingModule;
  let dataSource: DataSource;
  let admin: ChannelModel;
  let channel: Channel;
  let dbEnv: Record<string, string>;

  beforeAll(async () => {
    quietNestLogs();
    [postgres, rabbit, mailpit] = await Promise.all([
      startPostgres('fiapx_notification'),
      startRabbitMq(),
      startMailpit(),
    ]);
    dbEnv = {
      DB_HOST: postgres.host,
      DB_PORT: String(postgres.port),
      DB_USER: postgres.user,
      DB_PASSWORD: postgres.password,
      DB_NAME: postgres.database,
      DB_SSL: 'false',
      LOG_LEVEL: 'silent',
    };
    await expect(runMigrateCommand({ env: dbEnv })).resolves.toBe(0);

    Object.assign(process.env, {
      ...dbEnv,
      METRICS_PORT: '0',
      METRICS_HOST: '127.0.0.1',
      RABBITMQ_URL: rabbit.url,
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: mailpit.smtpHost,
      SMTP_PORT: String(mailpit.smtpPort),
      EMAIL_FROM: 'FIAP Frames <nao-responda@fiapx.local>',
      NOTIFY_ON_SUCCESS: 'true',
      PUBLIC_BASE_URL,
    });
    const messaging: MessagingModuleOptions = {
      url: rabbit.url,
      connectionName: 'notification-service-int',
      topology: { retryDelaysMs: [1_000, 1_500, 2_000] },
    };
    app = await Test.createTestingModule({ imports: [NotificationModule] })
      .overrideProvider(MESSAGING_OPTIONS)
      .useValue(messaging)
      .compile();
    await app.init();
    await app.get(TopologyInitializer).whenReady();
    await waitFor(() => app.get(MessageConsumers).all[0]?.isConsuming, {
      timeoutMs: 30_000,
      description: 'consumer of notification.events active',
    });
    dataSource = app.get(DataSource);
    admin = await connect(rabbit.url);
    channel = await admin.createChannel();
  }, 240_000);

  afterAll(async () => {
    await channel?.close().catch(() => undefined);
    await admin?.close().catch(() => undefined);
    await app?.close();
    await Promise.all([postgres?.stop(), rabbit?.stop(), mailpit?.stop()]);
    process.env = { ...previousEnv };
  });

  function failedPayload(overrides: Partial<PayloadOf<'video.failed'>> = {}) {
    return {
      videoId: randomUUID(),
      userId: randomUUID(),
      userEmail: `aluno.${randomUUID().slice(0, 8)}@example.com`,
      userName: 'Ana <b>& "Bia"</b>',
      originalName: '<script>alert(1)</script>.mp4',
      errorCode: 'P0001',
      errorMessage: 'O arquivo não é um vídeo válido ou está corrompido.',
      ...overrides,
    } satisfies PayloadOf<'video.failed'>;
  }

  async function publish(event: EventOf<'video.failed' | 'video.completed' | 'user.deleted'>) {
    await app.get<EventPublisher>(EVENT_PUBLISHER).publishEvent(event);
  }

  async function rowsOf(where: string, params: unknown[]): Promise<NotificationRow[]> {
    return dataSource.query<NotificationRow[]>(
      `SELECT * FROM notifications WHERE ${where} ORDER BY created_at`,
      params,
    );
  }

  async function rowOf(
    videoId: string,
    type = 'VIDEO_FAILED',
  ): Promise<NotificationRow | undefined> {
    const [row] = await rowsOf('dedup_key = $1', [`${type}:${videoId}`]);
    return row;
  }

  async function metric(type: string, status: string): Promise<number> {
    const port = app.get(MetricsServerService).server.port;
    const text = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    const line = text
      .split('\n')
      .find((entry) =>
        entry.startsWith(`fiapx_notifications_total{type="${type}",status="${status}"`),
      );
    return Number(line?.split(' ').pop() ?? 'NaN');
  }

  async function dlqMessageIds(): Promise<string[]> {
    const ids: string[] = [];
    for (;;) {
      const message = await channel.get(`${QUEUES.notificationEvents}.dlq`, { noAck: true });
      if (message === false) return ids;
      ids.push(String(message.properties.messageId));
    }
  }

  it('the migrate one-shot created exactly the contract table and is idempotent', async () => {
    const columns = await dataSource.query<{ column_name: string; is_nullable: string }[]>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_name = 'notifications' ORDER BY ordinal_position`,
    );
    expect(columns.map((column) => column.column_name)).toEqual([
      'id',
      'dedup_key',
      'user_id',
      'type',
      'recipient',
      'subject',
      'status',
      'attempts',
      'provider_message_id',
      'last_error',
      'payload',
      'created_at',
      'sent_at',
    ]);
    expect(columns.find((column) => column.column_name === 'user_id')?.is_nullable).toBe('NO');
    const indexes = await dataSource.query<{ indexname: string }[]>(
      "SELECT indexname FROM pg_indexes WHERE tablename = 'notifications' ORDER BY indexname",
    );
    expect(indexes.map((index) => index.indexname)).toEqual([
      'ix_notifications_user',
      'notifications_dedup_key_key',
      'notifications_pkey',
    ]);

    const info = jest.fn();
    await expect(
      runMigrateCommand({ env: dbEnv, logger: { info, error: jest.fn() } }),
    ).resolves.toBe(0);
    expect(info).toHaveBeenCalledWith(
      { applied: [] },
      'Database up to date: no pending migrations',
    );
  });

  it('video.failed → the e-mail arrives in Mailpit (escaped, correlated) and the row is SENT', async () => {
    const payload = failedPayload();
    const event = createEvent('video.failed', payload, `cid-${randomUUID()}`);
    const sentBefore = await metric('VIDEO_FAILED', 'SENT');

    await publish(event);

    const [summary] = await waitFor(
      async () => {
        const messages = await mailpit.messagesTo(payload.userEmail);
        return messages.length > 0 ? messages : undefined;
      },
      { timeoutMs: 20_000, description: 'failure e-mail in Mailpit' },
    );
    const message = await mailpit.message(summary.ID);
    expect(message.Subject).toBe('FIAP Frames: não foi possível processar o seu vídeo');
    expect(message.From.Address).toBe('nao-responda@fiapx.local');
    expect(message.HTML).toContain('Ana &lt;b&gt;&amp; &quot;Bia&quot;&lt;/b&gt;');
    expect(message.HTML).toContain('&lt;script&gt;alert(1)&lt;/script&gt;.mp4');
    expect(message.HTML).not.toContain('<script>');
    expect(message.HTML).toContain(`href="${PUBLIC_BASE_URL}/"`);
    expect(message.Text).toContain('Motivo: O arquivo não é um vídeo válido ou está corrompido.');
    const headers = await mailpit.headers(summary.ID);
    expect(headers['X-Correlation-Id']).toEqual([event.correlationId]);

    const row = await waitFor(async () => {
      const current = await rowOf(payload.videoId);
      return current?.status === 'SENT' ? current : undefined;
    });
    expect(row).toMatchObject({
      user_id: payload.userId,
      type: 'VIDEO_FAILED',
      recipient: payload.userEmail,
      attempts: 1,
      last_error: null,
      provider_message_id: `<${row.id}@fiapx.notification>`,
    });
    expect(row.payload).toMatchObject({ videoId: payload.videoId, errorCode: 'P0001' });
    expect(row.sent_at).toBeInstanceOf(Date);
    expect(summary.MessageID).toBe(`${row.id}@fiapx.notification`);
    expect(await metric('VIDEO_FAILED', 'SENT')).toBe(sentBefore + 1);
  });

  it('duplicate events (same message or same video) never send a second e-mail', async () => {
    const payload = failedPayload();
    const first = createEvent('video.failed', payload, 'cid-dup');
    await publish(first);
    await waitFor(async () => (await rowOf(payload.videoId))?.status === 'SENT');
    const metrics = app.get(MessagingMetrics);
    const consumed = await metrics.consumedCount(QUEUES.notificationEvents, 'success');
    const skippedBefore = await metric('VIDEO_FAILED', 'SKIPPED');

    await publish(first);
    await publish(createEvent('video.failed', payload, 'cid-dup-2'));
    await waitFor(
      async () =>
        (await metrics.consumedCount(QUEUES.notificationEvents, 'success')) >= consumed + 2,
      { description: 'both duplicates consumed' },
    );

    expect(await mailpit.messagesTo(payload.userEmail)).toHaveLength(1);
    expect(await rowsOf('user_id = $1', [payload.userId])).toEqual([
      expect.objectContaining({ status: 'SENT', attempts: 1 }),
    ]);
    expect(await metric('VIDEO_FAILED', 'SKIPPED')).toBe(skippedBefore + 2);
  });

  it('video.completed → success e-mail (NOTIFY_ON_SUCCESS=true)', async () => {
    const base = failedPayload();
    const payload = {
      videoId: base.videoId,
      userId: base.userId,
      userEmail: base.userEmail,
      userName: 'Bia',
      originalName: 'aula.mp4',
      frameCount: 12,
    };

    await publish(createEvent('video.completed', payload, 'cid-ok'));

    const [summary] = await waitFor(async () => {
      const messages = await mailpit.messagesTo(payload.userEmail);
      return messages.length > 0 ? messages : undefined;
    });
    expect(summary.Subject).toBe('FIAP Frames: o seu vídeo foi processado');
    expect((await mailpit.message(summary.ID)).Text).toContain('12 frames extraídos');
    await waitFor(async () => (await rowOf(payload.videoId, 'VIDEO_COMPLETED'))?.status === 'SENT');
  });

  it('SMTP 451 is retried through notification.events.retry.N and the e-mail is not lost', async () => {
    const payload = failedPayload();
    await mailpit.setRecipientChaos({ ErrorCode: 451, Probability: 100 });
    try {
      await publish(createEvent('video.failed', payload, 'cid-451'));

      const pending = await waitFor(async () => {
        const row = await rowOf(payload.videoId);
        return row?.status === 'PENDING' && row.attempts >= 1 ? row : undefined;
      });
      expect(pending.last_error).toContain('451');
      expect(pending.last_error).not.toContain('@');
    } finally {
      await mailpit.setRecipientChaos({ ErrorCode: 451, Probability: 0 });
    }

    const sent = await waitFor(
      async () => {
        const row = await rowOf(payload.videoId);
        return row?.status === 'SENT' ? row : undefined;
      },
      { timeoutMs: 20_000, description: 'e-mail delivered on a retry' },
    );
    expect(sent.attempts).toBeGreaterThanOrEqual(2);
    expect(sent.last_error).toBeNull();
    expect(await mailpit.messagesTo(payload.userEmail)).toHaveLength(1);
  });

  it('SMTP 451 on every attempt → FAILED after 4 attempts and the message parks in the DLQ', async () => {
    const payload = failedPayload();
    const event = createEvent('video.failed', payload, 'cid-exhausted');
    const retryBefore = await metric('VIDEO_FAILED', 'RETRY');
    await mailpit.setRecipientChaos({ ErrorCode: 451, Probability: 100 });
    try {
      await publish(event);
      const failed = await waitFor(
        async () => {
          const row = await rowOf(payload.videoId);
          return row?.status === 'FAILED' ? row : undefined;
        },
        { timeoutMs: 30_000, description: 'notification FAILED after the retries' },
      );
      expect(failed.attempts).toBe(4);
      expect(failed.last_error).toMatch(/^Retries exhausted: SMTP EENVELOPE 451/);
      expect(failed.last_error).not.toContain('@');
    } finally {
      await mailpit.setRecipientChaos({ ErrorCode: 451, Probability: 0 });
    }

    const parked = await waitFor(async () => {
      const ids = await dlqMessageIds();
      return ids.includes(event.id) ? ids : undefined;
    });
    expect(parked.filter((id) => id === event.id)).toHaveLength(1);
    expect(await mailpit.messagesTo(payload.userEmail)).toHaveLength(0);
    expect(await metric('VIDEO_FAILED', 'RETRY')).toBe(retryBefore + 3);
  });

  it('SMTP 550 → FAILED on the first attempt, acked without retry', async () => {
    const payload = failedPayload();
    await mailpit.setRecipientChaos({ ErrorCode: 550, Probability: 100 });
    try {
      await publish(createEvent('video.failed', payload, 'cid-550'));
      const failed = await waitFor(async () => {
        const row = await rowOf(payload.videoId);
        return row?.status === 'FAILED' ? row : undefined;
      });
      expect(failed.attempts).toBe(1);
      expect(failed.last_error).toContain('smtp rejected the e-mail: SMTP EENVELOPE 550');
    } finally {
      await mailpit.setRecipientChaos({ ErrorCode: 550, Probability: 0 });
    }

    await delay(2_500); // longer than the first retry TTL: nothing comes back
    expect((await rowOf(payload.videoId))?.attempts).toBe(1);
    expect(await mailpit.messagesTo(payload.userEmail)).toHaveLength(0);
  });

  it('user.deleted anonymizes every notification of that user only (LGPD)', async () => {
    const deleted = failedPayload();
    const other = failedPayload();
    await publish(createEvent('video.failed', deleted, 'cid-a'));
    await publish(
      createEvent('video.completed', { ...deleted, videoId: randomUUID(), frameCount: 3 }, 'cid-b'),
    );
    await publish(createEvent('video.failed', other, 'cid-c'));
    await waitFor(async () => {
      const rows = await rowsOf('user_id = ANY($1)', [[deleted.userId, other.userId]]);
      return rows.length === 3 && rows.every((row) => row.status === 'SENT');
    });

    const userDeleted = createEvent('user.deleted', { userId: deleted.userId }, 'cid-lgpd');
    await publish(userDeleted);
    await publish(userDeleted); // redelivery: idempotent

    const anonymized = await waitFor(async () => {
      const rows = await rowsOf('user_id = $1', [deleted.userId]);
      return rows.every((row) => row.recipient === 'removido') ? rows : undefined;
    });
    expect(anonymized).toHaveLength(2);
    for (const row of anonymized) {
      expect(row).toMatchObject({ recipient: 'removido', payload: {}, status: 'SENT' });
    }
    const [untouched] = await rowsOf('user_id = $1', [other.userId]);
    expect(untouched).toMatchObject({ recipient: other.userEmail });
    expect(untouched?.payload).toHaveProperty('userName');
  });

  it('the daily retention job anonymizes old notifications, one replica at a time', async () => {
    const userId = randomUUID();
    const insert = `INSERT INTO notifications (id, dedup_key, user_id, type, recipient, subject, status, payload, created_at)
      VALUES ($1, $2, $3, 'VIDEO_FAILED', 'velho@example.com', 's', 'SENT', '{"userName":"Velho"}', now() - $4::interval)`;
    const oldId = randomUUID();
    const recentId = randomUUID();
    await dataSource.query(insert, [oldId, `VIDEO_FAILED:${randomUUID()}`, userId, '31 days']);
    await dataSource.query(insert, [recentId, `VIDEO_FAILED:${randomUUID()}`, userId, '29 days']);
    const job = app.get(NotificationRetentionJob);

    const holder = dataSource.createQueryRunner();
    await holder.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [RETENTION_LOCK_KEY]);
      await expect(job.run()).resolves.toBeNull();
      expect((await rowsOf('id = $1', [oldId]))[0]?.recipient).toBe('velho@example.com');
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [RETENTION_LOCK_KEY]);
      await holder.release();
    }

    await expect(job.run()).resolves.toBeGreaterThanOrEqual(1);
    const [old] = await rowsOf('id = $1', [oldId]);
    const [recent] = await rowsOf('id = $1', [recentId]);
    expect(old).toMatchObject({ recipient: 'removido', payload: {} });
    expect(recent).toMatchObject({ recipient: 'velho@example.com' });
    await expect(job.run()).resolves.toBe(0);
  });
});
