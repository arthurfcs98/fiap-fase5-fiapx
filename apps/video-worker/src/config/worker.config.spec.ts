import { ConfigValidationError, loadConfig } from '@fiapx/common';
import { workerConfigSchema } from './worker.config';

const REQUIRED = {
  RABBITMQ_URL: 'amqp://fiapx:secret@rabbitmq:5672',
  S3_ENDPOINT: 'http://garage:3900',
  S3_ACCESS_KEY_ID: 'GK0123456789abcdef',
  S3_SECRET_ACCESS_KEY: '0123456789abcdef0123456789abcdef',
};

describe('workerConfigSchema', () => {
  it('applies the contract defaults (prefetch 1, /work, 10 min ffmpeg, 600 s max)', () => {
    expect(loadConfig(workerConfigSchema, REQUIRED)).toEqual({
      ...REQUIRED,
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      APP_VERSION: 'dev',
      METRICS_PORT: 9464,
      METRICS_HOST: '0.0.0.0',
      S3_REGION: 'garage',
      S3_BUCKET_RAW: 'fiapx-raw',
      S3_BUCKET_ZIPS: 'fiapx-zips',
      S3_FORCE_PATH_STYLE: true,
      WORKER_PREFETCH: 1,
      WORK_DIR: '/work',
      FFMPEG_TIMEOUT_MS: 600_000,
      MAX_VIDEO_DURATION_S: 600,
      MAX_FRAMES_MB: 1536,
    });
  });

  it('reads the worker variables from the environment', () => {
    const config = loadConfig(workerConfigSchema, {
      ...REQUIRED,
      WORKER_PREFETCH: '2',
      WORK_DIR: '/tmp/fiapx-work',
      FFMPEG_TIMEOUT_MS: '120000',
      MAX_VIDEO_DURATION_S: '90.5',
      MAX_FRAMES_MB: '900',
    });
    expect(config).toMatchObject({
      WORKER_PREFETCH: 2,
      WORK_DIR: '/tmp/fiapx-work',
      FFMPEG_TIMEOUT_MS: 120_000,
      MAX_VIDEO_DURATION_S: 90.5,
      MAX_FRAMES_MB: 900,
    });
  });

  it('accepts secrets from files (S3_SECRET_ACCESS_KEY_FILE, RABBITMQ_URL_FILE)', () => {
    const files: Record<string, string> = {
      '/run/secrets/s3': 'secret-from-file-0123456789\n',
      '/run/secrets/amqp': 'amqp://fiapx:file@rabbitmq:5672\n',
    };
    const config = loadConfig(
      workerConfigSchema,
      {
        ...REQUIRED,
        S3_SECRET_ACCESS_KEY: undefined,
        S3_SECRET_ACCESS_KEY_FILE: '/run/secrets/s3',
        RABBITMQ_URL: undefined,
        RABBITMQ_URL_FILE: '/run/secrets/amqp',
      },
      { readFile: (path) => files[path] ?? '' },
    );
    expect(config.S3_SECRET_ACCESS_KEY).toBe('secret-from-file-0123456789');
    expect(config.RABBITMQ_URL).toBe('amqp://fiapx:file@rabbitmq:5672');
  });

  it.each([
    ['missing broker and storage', {}],
    ['prefetch 0', { ...REQUIRED, WORKER_PREFETCH: '0' }],
    ['non-integer ffmpeg timeout', { ...REQUIRED, FFMPEG_TIMEOUT_MS: '1.5' }],
    ['negative max duration', { ...REQUIRED, MAX_VIDEO_DURATION_S: '-1' }],
    ['non-amqp broker url', { ...REQUIRED, RABBITMQ_URL: 'http://rabbitmq' }],
  ])('fails fast on invalid configuration (%s)', (_case, env) => {
    expect(() => loadConfig(workerConfigSchema, env)).toThrow(ConfigValidationError);
  });
});
