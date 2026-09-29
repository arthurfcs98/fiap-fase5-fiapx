import type {
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorFunction,
} from '@nestjs/terminus';
import { Reflector } from '@nestjs/core';
import { testConfig } from '../../../../../test/support/config';
import { IS_PUBLIC_ROUTE } from '../../../auth/interfaces/decorators/public.decorator';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const config = testConfig({ APP_VERSION: 'abc1234' });
  const okResult: HealthCheckResult = { status: 'ok', info: {}, error: {}, details: {} };

  it('is public (no JWT: probes and the deploy smoke call it)', () => {
    expect(new Reflector().get(IS_PUBLIC_ROUTE, HealthController)).toBe(true);
  });

  it('live answers status, service and build version', () => {
    const controller = new HealthController({} as HealthCheckService, config, []);
    expect(controller.live()).toEqual({ status: 'ok', service: 'video-api', version: 'abc1234' });
  });

  it('ready delegates the registered checks to Terminus', async () => {
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
