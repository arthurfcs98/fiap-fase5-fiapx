import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
import { RedisContainer } from '@testcontainers/redis';
import type { StartedTestContainer } from 'testcontainers';
import { GenericContainer, Wait } from 'testcontainers';
import { Logger } from '@nestjs/common';

/**
 * Containers descartáveis (Testcontainers) para os testes de integração (`*.int-spec.ts`).
 *
 * As imagens vêm do `compose.yaml` (tag + digest): dev, CI e testes usam a MESMA versão e o
 * Dependabot atualiza num lugar só. Credenciais são aleatórias por execução (nada fixo no repo).
 * Requer Docker (local: OrbStack; CI: runner do GitHub).
 */
const ROOT = path.resolve(__dirname, '..', '..');

export function composeImage(service: string): string {
  const compose = readFileSync(path.join(ROOT, 'compose.yaml'), 'utf8');
  const pattern = new RegExp(`^ {2}${service}:\\n(?: {4}.*\\n)*? {4}image: (\\S+)`, 'm');
  const image = pattern.exec(compose)?.[1];
  if (!image) throw new Error(`Imagem do serviço "${service}" não encontrada no compose.yaml`);
  return image;
}

function secret(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}

export interface StartedDependency {
  container: StartedTestContainer;
  stop(): Promise<void>;
}

export interface StartedRabbitMq extends StartedDependency {
  /** `amqp://user:pass@host:port` (vhost `/`). */
  url: string;
  /** Base da API de management (`http://host:port`), com as mesmas credenciais. */
  managementUrl: string;
  username: string;
  password: string;
}

export async function startRabbitMq(): Promise<StartedRabbitMq> {
  const username = 'fiapx';
  const password = secret();
  const container = await new RabbitMQContainer(composeImage('rabbitmq'))
    .withEnvironment({ RABBITMQ_DEFAULT_USER: username, RABBITMQ_DEFAULT_PASS: password })
    .withStartupTimeout(90_000)
    .start();
  const host = container.getHost();
  return {
    container,
    username,
    password,
    url: `amqp://${username}:${password}@${host}:${container.getMappedPort(5672)}`,
    managementUrl: `http://${host}:${container.getMappedPort(15672)}`,
    stop: async () => {
      await container.stop();
    },
  };
}

export interface StartedPostgres extends StartedDependency {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export async function startPostgres(database = 'fiapx_test'): Promise<StartedPostgres> {
  const password = secret();
  const container = await new PostgreSqlContainer(composeImage('postgres'))
    .withDatabase(database)
    .withUsername('fiapx')
    .withPassword(password)
    .start();
  return {
    container,
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password,
    database: container.getDatabase(),
    stop: async () => {
      await container.stop();
    },
  };
}

export interface StartedRedis extends StartedDependency {
  /** `redis://:senha@host:port`. */
  url: string;
}

export async function startRedis(): Promise<StartedRedis> {
  const container = await new RedisContainer(composeImage('redis')).withPassword(secret()).start();
  return {
    container,
    url: container.getConnectionUrl(),
    stop: async () => {
      await container.stop();
    },
  };
}

export interface StartedGarage extends StartedDependency {
  endpoint: string;
  region: 'garage';
  accessKeyId: string;
  secretAccessKey: string;
  buckets: { raw: string; zips: string };
}

/**
 * Garage de nó único com o MESMO `infra/garage/garage.toml` do compose, inicializado pelo MESMO
 * `infra/garage/init.mjs` (layout, chave S3 e buckets `fiapx-raw`/`fiapx-zips`).
 */
export async function startGarage(): Promise<StartedGarage> {
  const adminToken = secret(24);
  const container = await new GenericContainer(composeImage('garage'))
    .withEnvironment({
      GARAGE_RPC_SECRET: secret(32),
      GARAGE_ADMIN_TOKEN: adminToken,
      GARAGE_METRICS_TOKEN: secret(24),
    })
    .withCopyFilesToContainer([
      { source: path.join(ROOT, 'infra', 'garage', 'garage.toml'), target: '/etc/garage.toml' },
    ])
    .withExposedPorts(3900, 3903)
    // Imagem "scratch" (sem shell): a checagem é por HTTP a partir do host. Qualquer resposta
    // da API admin serve; o init espera o cluster ficar saudável.
    .withWaitStrategy(Wait.forHttp('/health', 3903).forStatusCodeMatching(() => true))
    .withStartupTimeout(60_000)
    .start();

  const host = container.getHost();
  const accessKeyId = `GK${secret(12)}`;
  const secretAccessKey = secret(32);
  const buckets = { raw: 'fiapx-raw', zips: 'fiapx-zips' };
  await promisify(execFile)(process.execPath, [path.join(ROOT, 'infra', 'garage', 'init.mjs')], {
    env: {
      PATH: process.env['PATH'],
      GARAGE_ADMIN_URL: `http://${host}:${container.getMappedPort(3903)}`,
      GARAGE_ADMIN_TOKEN: adminToken,
      S3_ACCESS_KEY_ID: accessKeyId,
      S3_SECRET_ACCESS_KEY: secretAccessKey,
      GARAGE_BUCKETS: `${buckets.raw},${buckets.zips}`,
    },
    timeout: 120_000,
  });

  return {
    container,
    endpoint: `http://${host}:${container.getMappedPort(3900)}`,
    region: 'garage',
    accessKeyId,
    secretAccessKey,
    buckets,
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * Silencia o `Logger` do Nest nos testes de integração (a lib loga conexões e retries).
 * `INT_LOGS=1 npm run test:int` mostra tudo.
 */
export function quietNestLogs(): void {
  if (process.env['INT_LOGS'] === '1') return;
  Logger.overrideLogger(['error']);
}
