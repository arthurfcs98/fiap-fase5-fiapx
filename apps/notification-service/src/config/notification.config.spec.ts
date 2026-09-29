import { ConfigValidationError, loadConfig } from '@fiapx/common';
import {
  DEFAULT_PUBLIC_BASE_URL,
  migrateConfigSchema,
  notificationConfigSchema,
} from './notification.config';

/** Minimum valid environment (compose-like, SMTP to Mailpit). */
const BASE_ENV = {
  RABBITMQ_URL: 'amqp://fiapx:secret@rabbitmq:5672',
  DB_HOST: 'postgres',
  DB_USER: 'fiapx_notification',
  DB_PASSWORD: 'db-secret',
  DB_NAME: 'fiapx_notification',
  DB_SSL: 'false',
  EMAIL_PROVIDER: 'smtp',
  SMTP_HOST: 'mailpit',
  EMAIL_FROM: 'FIAP Frames <nao-responda@fiapx.local>',
};

function issuesOf(env: Record<string, string>): readonly string[] {
  try {
    loadConfig(notificationConfigSchema, env);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error.issues;
    throw error;
  }
  throw new Error('expected a ConfigValidationError');
}

describe('notificationConfigSchema', () => {
  it('applies the defaults (metrics on 9464, SMTP 1025, 30-day retention, no success e-mail)', () => {
    expect(loadConfig(notificationConfigSchema, BASE_ENV)).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      APP_VERSION: 'dev',
      METRICS_PORT: 9464,
      METRICS_HOST: '0.0.0.0',
      RABBITMQ_URL: BASE_ENV.RABBITMQ_URL,
      DB_HOST: 'postgres',
      DB_PORT: 5432,
      DB_USER: 'fiapx_notification',
      DB_PASSWORD: 'db-secret',
      DB_NAME: 'fiapx_notification',
      DB_SSL: false,
      EMAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'mailpit',
      SMTP_PORT: 1025,
      EMAIL_FROM: 'FIAP Frames <nao-responda@fiapx.local>',
      NOTIFY_ON_SUCCESS: false,
      PUBLIC_BASE_URL: DEFAULT_PUBLIC_BASE_URL,
      NOTIFICATION_RETENTION_DAYS: 30,
      NOTIFICATION_DAILY_LIMIT_PER_USER: 10,
      NOTIFICATION_DAILY_LIMIT: 80,
    });
  });

  it('reads the Resend key from a file and normalizes PUBLIC_BASE_URL', () => {
    const config = loadConfig(
      notificationConfigSchema,
      {
        ...BASE_ENV,
        EMAIL_PROVIDER: 'resend',
        SMTP_HOST: '',
        RESEND_API_KEY_FILE: '/run/secrets/resend_api_key',
        PUBLIC_BASE_URL: 'https://fiapx.asdevit.com//',
        NOTIFY_ON_SUCCESS: 'true',
        NOTIFICATION_RETENTION_DAYS: '7',
        EMAIL_TO_OVERRIDE: 'dev@example.com',
      },
      { readFile: () => 're_test_key\n' },
    );
    expect(config).toMatchObject({
      EMAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_key',
      PUBLIC_BASE_URL: 'https://fiapx.asdevit.com',
      NOTIFY_ON_SUCCESS: true,
      NOTIFICATION_RETENTION_DAYS: 7,
      EMAIL_TO_OVERRIDE: 'dev@example.com',
    });
    expect(config.SMTP_HOST).toBeUndefined();
  });

  it('accepts the log provider without SMTP or Resend settings', () => {
    const { SMTP_HOST: _host, ...env } = BASE_ENV;
    expect(loadConfig(notificationConfigSchema, { ...env, EMAIL_PROVIDER: 'log' })).toMatchObject({
      EMAIL_PROVIDER: 'log',
    });
  });

  it('requires RESEND_API_KEY with EMAIL_PROVIDER=resend', () => {
    expect(issuesOf({ ...BASE_ENV, EMAIL_PROVIDER: 'resend' })).toEqual([
      'RESEND_API_KEY: RESEND_API_KEY é obrigatória com EMAIL_PROVIDER=resend',
    ]);
  });

  it('requires SMTP_HOST with EMAIL_PROVIDER=smtp', () => {
    expect(issuesOf({ ...BASE_ENV, SMTP_HOST: '' })).toEqual([
      'SMTP_HOST: SMTP_HOST é obrigatória com EMAIL_PROVIDER=smtp',
    ]);
  });

  it.each([
    ['EMAIL_PROVIDER', 'sendgrid'],
    ['EMAIL_FROM', 'FIAP Frames <x@y>\r\nBcc: a@b.c'],
    ['EMAIL_FROM', 'sem-arroba'],
    ['EMAIL_TO_OVERRIDE', 'not-an-email'],
    ['PUBLIC_BASE_URL', 'javascript:alert(1)'],
    ['PUBLIC_BASE_URL', 'ftp://fiapx.asdevit.com'],
    ['NOTIFICATION_RETENTION_DAYS', '0'],
    ['SMTP_PORT', '70000'],
  ])('rejects %s=%p', (key, value) => {
    expect(issuesOf({ ...BASE_ENV, [key]: value }).join('\n')).toContain(key);
  });

  it('fails fast listing every missing required variable', () => {
    const issues = issuesOf({});
    for (const key of ['RABBITMQ_URL', 'DB_HOST', 'DB_SSL', 'EMAIL_PROVIDER', 'EMAIL_FROM']) {
      expect(issues.join('\n')).toContain(key);
    }
  });
});

describe('migrateConfigSchema', () => {
  it('only needs the database variables', () => {
    const { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL } = BASE_ENV;
    expect(
      loadConfig(migrateConfigSchema, { DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_SSL }),
    ).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      APP_VERSION: 'dev',
      DB_HOST,
      DB_PORT: 5432,
      DB_USER,
      DB_PASSWORD,
      DB_NAME,
      DB_SSL: false,
    });
  });
});
