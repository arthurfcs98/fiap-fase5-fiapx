import { ConfigValidationError, loadConfig } from '@fiapx/common';
import { apiConfigSchema } from './api.config';

describe('apiConfigSchema', () => {
  it('aplica os defaults do video-api', () => {
    expect(loadConfig(apiConfigSchema, {})).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      APP_VERSION: 'dev',
      PORT: 3000,
      SWAGGER_ENABLED: true,
      METRICS_PORT: 9464,
      METRICS_HOST: '0.0.0.0',
    });
  });

  it('lê valores do ambiente', () => {
    const config = loadConfig(apiConfigSchema, {
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      APP_VERSION: '3f2c1a9',
      PORT: '8080',
      SWAGGER_ENABLED: 'false',
    });
    expect(config).toMatchObject({ PORT: 8080, SWAGGER_ENABLED: false, APP_VERSION: '3f2c1a9' });
  });

  it('falha rápido com porta inválida', () => {
    expect(() => loadConfig(apiConfigSchema, { PORT: 'http' })).toThrow(ConfigValidationError);
  });
});
