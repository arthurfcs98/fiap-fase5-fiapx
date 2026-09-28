import { ConfigValidationError, loadConfig } from '@fiapx/common';
import { notificationConfigSchema } from './notification.config';

describe('notificationConfigSchema', () => {
  it('aplica os defaults (métricas na 9464, todas as interfaces, sem token)', () => {
    expect(loadConfig(notificationConfigSchema, {})).toEqual({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      APP_VERSION: 'dev',
      METRICS_PORT: 9464,
      METRICS_HOST: '0.0.0.0',
    });
  });

  it('aceita token de métricas por arquivo (METRICS_TOKEN_FILE)', () => {
    const config = loadConfig(
      notificationConfigSchema,
      { METRICS_TOKEN_FILE: '/run/secrets/metrics_token' },
      { readFile: () => 'token-com-mais-de-16\n' },
    );
    expect(config.METRICS_TOKEN).toBe('token-com-mais-de-16');
  });

  it('falha rápido com configuração inválida', () => {
    expect(() =>
      loadConfig(notificationConfigSchema, { METRICS_PORT: '99999', LOG_LEVEL: 'x' }),
    ).toThrow(ConfigValidationError);
  });
});
