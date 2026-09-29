import { loadConfig } from '@fiapx/common';
import type { ApiConfig } from '../../src/config/api.config';
import { apiConfigSchema } from '../../src/config/api.config';

/** Minimal valid video-api environment for unit tests (only the variables without a default). */
export const REQUIRED_ENV: Readonly<Record<string, string>> = {
  RABBITMQ_URL: 'amqp://fiapx:secret@rabbitmq:5672',
  S3_ENDPOINT: 'http://garage:3900',
  S3_ACCESS_KEY_ID: 'GK0123456789abcdef',
  S3_SECRET_ACCESS_KEY: '0123456789abcdef0123456789abcdef',
  DB_HOST: 'postgres',
  DB_USER: 'fiapx_video',
  DB_PASSWORD: 'db-password',
  DB_NAME: 'fiapx_video',
  DB_SSL: 'false',
  REDIS_URL: 'redis://:secret@redis:6379',
  JWT_SECRET: 'j'.repeat(48),
  DOWNLOAD_URL_SECRET: 'd'.repeat(48),
};

/** Validated configuration with test values (overrides use the raw env names). */
export function testConfig(overrides: Record<string, string> = {}): ApiConfig {
  return loadConfig(apiConfigSchema, { ...REQUIRED_ENV, ...overrides });
}
