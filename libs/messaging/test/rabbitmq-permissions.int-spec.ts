import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type { StartedRabbitMq } from '@fiapx/testing';
import { startRabbitMq, waitFor } from '@fiapx/testing';
import type { ConfirmChannel } from 'amqplib';
import { connect } from 'amqplib';
import { EXCHANGES, QUEUES, retryQueueName, runTopologySetupCli, setupTopology } from '../src';

/**
 * The K8s permission model (one RabbitMQ user per service, created by the Job `rabbitmq-init`:
 * infra/k8s/base/data/rabbitmq/rabbitmq-init.mjs) against the REAL topology of the code, on a
 * real broker (same image as the compose), starting EMPTY like a fresh cluster:
 * - the Job order works: topology one-shot as the administrator, then users and policies;
 * - every service redeclares the whole topology with its own user (what its startup does), but
 *   cannot CREATE a missing queue (the reason for the one-shot);
 * - each user consumes only its queues and publishes only its own routing keys;
 * - the operator policies reach the queues (7-day TTL on the DLQs).
 */
const INIT_SCRIPT = path.resolve(
  __dirname,
  '../../../infra/k8s/base/data/rabbitmq/rabbitmq-init.mjs',
);
const DLQ_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface ServiceUser {
  user: string;
  password: string;
  consumes: string[];
  publishes: string[];
  forbidden: string[];
}

const secret = () => randomBytes(12).toString('hex');
const USERS: Record<'api' | 'worker' | 'notification', ServiceUser> = {
  api: {
    user: 'fiapx-api',
    password: secret(),
    consumes: [QUEUES.apiVideoProcessing, QUEUES.apiVideoDeadLetter],
    publishes: ['video.uploaded', 'video.completed', 'video.failed', 'user.deleted'],
    forbidden: ['video.processing.completed'],
  },
  worker: {
    user: 'fiapx-worker',
    password: secret(),
    consumes: [QUEUES.workerVideoUploaded],
    publishes: [
      'video.processing.started',
      'video.processing.completed',
      'video.processing.failed',
    ],
    forbidden: ['video.completed', 'user.deleted'],
  },
  notification: {
    user: 'fiapx-notification',
    password: secret(),
    consumes: [QUEUES.notificationEvents],
    publishes: [],
    forbidden: ['video.failed'],
  },
};
const KEDA_PASSWORD = secret();

describe('RabbitMQ per-service users (K8s rabbitmq-init) against the code topology', () => {
  let rabbit: StartedRabbitMq;

  const urlFor = (service: ServiceUser): string => {
    const url = new URL(rabbit.url);
    url.username = service.user;
    url.password = service.password;
    return url.toString();
  };

  /** Runs `fn` on a fresh confirm channel; resolves 'ok' or the broker's refusal. */
  async function attempt(
    url: string,
    fn: (channel: ConfirmChannel) => Promise<unknown>,
  ): Promise<string> {
    const connection = await connect(url);
    connection.on('error', () => undefined);
    const channel = await connection.createConfirmChannel();
    let channelError = '';
    channel.on('error', (error: Error) => {
      channelError = error.message;
    });
    try {
      await fn(channel);
      return 'ok';
    } catch (error) {
      return channelError || (error as Error).message;
    } finally {
      await connection.close().catch(() => undefined);
    }
  }

  const publish = (channel: ConfirmChannel, exchange: string, routingKey: string) =>
    new Promise<void>((resolve, reject) => {
      channel.publish(exchange, routingKey, Buffer.from('{}'), { persistent: true }, (error) =>
        error ? reject(error instanceof Error ? error : new Error(String(error))) : resolve(),
      );
    });

  async function management<T>(
    pathname: string,
    user = rabbit.username,
    password = rabbit.password,
  ) {
    const response = await fetch(`${rabbit.managementUrl}${pathname}`, {
      headers: { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` },
    });
    return { status: response.status, body: (await response.json()) as T };
  }

  beforeAll(async () => {
    rabbit = await startRabbitMq();

    // 1st container of the Job: the topology of the code, as the administrator.
    await runTopologySetupCli({
      service: 'video-api',
      env: { RABBITMQ_URL: rabbit.url },
      write: () => undefined,
    });

    // 2nd container: users, permissions and policies.
    const init = spawnSync(process.execPath, [INIT_SCRIPT], {
      env: {
        PATH: process.env.PATH,
        RABBITMQ_MANAGEMENT_URL: rabbit.managementUrl,
        RABBITMQ_ADMIN_USER: rabbit.username,
        RABBITMQ_ADMIN_PASSWORD: rabbit.password,
        KEDA_PASSWORD,
        API_PASSWORD: USERS.api.password,
        WORKER_PASSWORD: USERS.worker.password,
        NOTIFICATION_PASSWORD: USERS.notification.password,
      },
      encoding: 'utf8',
      timeout: 60_000,
    });
    if (init.status !== 0) throw new Error(`rabbitmq-init falhou: ${init.stdout}${init.stderr}`);
    for (const { password } of Object.values(USERS)) expect(init.stdout).not.toContain(password);
  }, 180_000);

  afterAll(async () => {
    await rabbit?.stop();
  });

  it.each(Object.keys(USERS) as (keyof typeof USERS)[])(
    '%s redeclares the whole topology with its own user (service startup)',
    async (name) => {
      await expect(setupTopology({ url: urlFor(USERS[name]) })).resolves.toBeDefined();
    },
  );

  it('a service user cannot CREATE a missing queue; the administrator one-shot recreates it', async () => {
    const missing = retryQueueName(QUEUES.notificationEvents, 3);
    expect(await attempt(rabbit.url, (channel) => channel.deleteQueue(missing))).toBe('ok');

    await expect(setupTopology({ url: urlFor(USERS.notification) })).rejects.toThrow(
      /ACCESS[-_]REFUSED/,
    );

    await runTopologySetupCli({
      service: 'video-api',
      env: { RABBITMQ_URL: rabbit.url },
      write: () => undefined,
    });
    await expect(setupTopology({ url: urlFor(USERS.notification) })).resolves.toBeDefined();
  });

  it.each(Object.keys(USERS) as (keyof typeof USERS)[])(
    '%s consumes only its own queues',
    async (name) => {
      const service = USERS[name];
      for (const queue of service.consumes) {
        expect(
          await attempt(urlFor(service), (channel) => channel.consume(queue, () => undefined)),
        ).toBe('ok');
      }
      const others = Object.values(QUEUES).filter((queue) => !service.consumes.includes(queue));
      for (const queue of others) {
        const result = await attempt(urlFor(service), (channel) =>
          channel.consume(queue, () => undefined),
        );
        expect(result).toMatch(/ACCESS[-_]REFUSED/);
      }
      // Nobody reads a DLQ: inspection and redrive are for the administrator.
      const dlq = await attempt(urlFor(service), (channel) =>
        channel.get(`${service.consumes[0]}.dlq`),
      );
      expect(dlq).toMatch(/ACCESS[-_]REFUSED/);
    },
  );

  it.each(Object.keys(USERS) as (keyof typeof USERS)[])(
    '%s publishes only its own routing keys; retry copies go through the default exchange',
    async (name) => {
      const service = USERS[name];
      for (const key of service.publishes) {
        expect(
          await attempt(urlFor(service), (channel) => publish(channel, EXCHANGES.events, key)),
        ).toBe('ok');
      }
      for (const key of service.forbidden) {
        const result = await attempt(urlFor(service), (channel) =>
          publish(channel, EXCHANGES.events, key),
        );
        expect(result).toMatch(/ACCESS[-_]REFUSED/);
      }
      const dlx = await attempt(urlFor(service), (channel) =>
        publish(channel, EXCHANGES.deadLetter, service.consumes[0] ?? ''),
      );
      expect(dlx).toMatch(/ACCESS[-_]REFUSED/);
      for (const queue of service.consumes) {
        const retry = await attempt(urlFor(service), (channel) =>
          publish(channel, '', retryQueueName(queue, 1)),
        );
        expect(retry).toBe('ok');
      }
    },
  );

  it('operator policies reach the queues: 64 MiB everywhere, 7-day TTL and reject-publish on DLQs', async () => {
    interface QueueInfo {
      operator_policy?: string;
      effective_policy_definition?: Record<string, unknown>;
    }
    // The management API shows policies after the first stats emission (every 5 s).
    const dlq = await waitFor(
      async () => {
        const { body } = await management<QueueInfo>('/api/queues/%2F/worker.video-uploaded.dlq');
        return body.operator_policy === 'fiapx-dlq-limits' ? body : undefined;
      },
      { timeoutMs: 25_000, intervalMs: 500 },
    );
    expect(dlq.effective_policy_definition).toMatchObject({
      'message-ttl': DLQ_TTL_MS,
      overflow: 'reject-publish',
      'max-length-bytes': 64 * 1024 ** 2,
    });
    const main = await waitFor(
      async () => {
        const { body } = await management<QueueInfo>('/api/queues/%2F/worker.video-uploaded');
        return body.operator_policy === 'fiapx-limits' ? body : undefined;
      },
      { timeoutMs: 25_000, intervalMs: 500 },
    );
    expect(main.effective_policy_definition).toEqual({ 'max-length-bytes': 64 * 1024 ** 2 });
  }, 60_000);

  it('the KEDA user reads queue sizes over HTTP and nothing else', async () => {
    const { status, body } = await waitFor(
      async () => {
        const answer = await management<{ messages?: number }>(
          '/api/queues/%2F/worker.video-uploaded',
          'fiapx-keda',
          KEDA_PASSWORD,
        );
        return typeof answer.body.messages === 'number' ? answer : undefined;
      },
      { timeoutMs: 25_000, intervalMs: 500 },
    );
    expect(status).toBe(200);
    expect(body.messages).toBeGreaterThanOrEqual(0);

    const url = new URL(rabbit.url);
    url.username = 'fiapx-keda';
    url.password = KEDA_PASSWORD;
    const result = await attempt(url.toString(), (channel) =>
      channel.consume(QUEUES.workerVideoUploaded, () => undefined),
    );
    expect(result).toMatch(/ACCESS[-_]REFUSED/);
  }, 60_000);
});
