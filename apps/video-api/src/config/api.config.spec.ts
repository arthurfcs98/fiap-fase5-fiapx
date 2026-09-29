import { ConfigValidationError, loadConfig } from '@fiapx/common';
import { REQUIRED_ENV } from '../../test/support/config';
import { apiConfigSchema } from './api.config';

describe('apiConfigSchema', () => {
  it('applies the video-api defaults', () => {
    const config = loadConfig(apiConfigSchema, REQUIRED_ENV);

    expect(config).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      APP_VERSION: 'dev',
      PORT: 3000,
      SWAGGER_ENABLED: true,
      METRICS_PORT: 9464,
      METRICS_HOST: '0.0.0.0',
      JWT_EXPIRES_IN: 3600,
      PUBLIC_BASE_URL: 'http://localhost:3000',
      MAX_UPLOAD_MB: 95,
      ZIP_RETENTION_DAYS: 7,
      DATA_RETENTION_INTERVAL_S: 3600,
      THROTTLE_REGISTER_LIMIT: 10,
      THROTTLE_LOGIN_LIMIT: 5,
      THROTTLE_UPLOAD_LIMIT: 30,
      PRIVACY_POLICY_VERSION: '2026-09-28',
      S3_BUCKET_RAW: 'fiapx-raw',
      S3_BUCKET_ZIPS: 'fiapx-zips',
      DB_PORT: 5432,
      DB_SSL: false,
    });
    expect(config.CORS_ORIGIN).toBeUndefined();
  });

  it('reads the environment values', () => {
    const config = loadConfig(apiConfigSchema, {
      ...REQUIRED_ENV,
      NODE_ENV: 'production',
      PORT: '8080',
      SWAGGER_ENABLED: 'false',
      PUBLIC_BASE_URL: 'https://fiapx.asdevit.com/',
      MAX_UPLOAD_MB: '10',
      CORS_ORIGIN: 'https://fiapx.asdevit.com, http://localhost:8080',
      ZIP_RETENTION_DAYS: '0.001',
      DATA_RETENTION_INTERVAL_S: '10',
      THROTTLE_REGISTER_LIMIT: '1000',
      THROTTLE_LOGIN_LIMIT: '60',
      THROTTLE_UPLOAD_LIMIT: '600',
      PRIVACY_POLICY_VERSION: '2027-01-01',
    });

    expect(config).toMatchObject({
      PORT: 8080,
      SWAGGER_ENABLED: false,
      PUBLIC_BASE_URL: 'https://fiapx.asdevit.com',
      MAX_UPLOAD_MB: 10,
      CORS_ORIGIN: ['https://fiapx.asdevit.com', 'http://localhost:8080'],
      ZIP_RETENTION_DAYS: 0.001,
      DATA_RETENTION_INTERVAL_S: 10,
      THROTTLE_REGISTER_LIMIT: 1000,
      THROTTLE_LOGIN_LIMIT: 60,
      THROTTLE_UPLOAD_LIMIT: 600,
      PRIVACY_POLICY_VERSION: '2027-01-01',
    });
  });

  it('fails fast on invalid values and never ships default secrets', () => {
    expect(() => loadConfig(apiConfigSchema, { ...REQUIRED_ENV, PORT: 'http' })).toThrow(
      ConfigValidationError,
    );
    expect(() => loadConfig(apiConfigSchema, { ...REQUIRED_ENV, JWT_SECRET: 'short' })).toThrow(
      /JWT_SECRET/,
    );
    expect(() => loadConfig(apiConfigSchema, { ...REQUIRED_ENV, REDIS_URL: 'http://x' })).toThrow(
      /REDIS_URL/,
    );
    const { DOWNLOAD_URL_SECRET: _omitted, ...withoutSecret } = REQUIRED_ENV;
    expect(() => loadConfig(apiConfigSchema, withoutSecret)).toThrow(/DOWNLOAD_URL_SECRET/);
  });
});
