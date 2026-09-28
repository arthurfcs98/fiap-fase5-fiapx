import type {
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorFunction,
} from '@nestjs/terminus';
import { loadConfig } from '@fiapx/common';
import { apiConfigSchema } from '../../../../config/api.config';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const config = loadConfig(apiConfigSchema, { APP_VERSION: 'abc1234' });
  const okResult: HealthCheckResult = { status: 'ok', info: {}, error: {}, details: {} };

  it('live responde status, serviço e versão de build', () => {
    const controller = new HealthController({} as HealthCheckService, config, []);
    expect(controller.live()).toEqual({ status: 'ok', service: 'video-api', version: 'abc1234' });
  });

  it('ready delega ao Terminus as checagens registradas', async () => {
    const checks: HealthIndicatorFunction[] = [jest.fn()];
    const health = { check: jest.fn().mockResolvedValue(okResult) };
    const controller = new HealthController(
      health as unknown as HealthCheckService,
      config,
      checks,
    );

    await expect(controller.ready()).resolves.toBe(okResult);
    expect(health.check).toHaveBeenCalledWith(checks);
  });
});
