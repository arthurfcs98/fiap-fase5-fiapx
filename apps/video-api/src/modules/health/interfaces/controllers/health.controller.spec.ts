import { Reflector } from '@nestjs/core';
import { testConfig } from '../../../../../test/support/config';
import { IS_PUBLIC_ROUTE } from '../../../auth/interfaces/decorators/public.decorator';
import type { CachedReadiness } from '../../infrastructure/cached-readiness';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const config = testConfig({ APP_VERSION: 'abc1234' });

  function controller(ready: boolean) {
    const readiness = { isReady: jest.fn().mockResolvedValue(ready) };
    return new HealthController(config, readiness as unknown as CachedReadiness);
  }

  it('is public (no JWT: probes and the deploy smoke call it)', () => {
    expect(new Reflector().get(IS_PUBLIC_ROUTE, HealthController)).toBe(true);
  });

  it('live answers status, service and build version', () => {
    expect(controller(true).live()).toEqual({
      status: 'ok',
      service: 'video-api',
      version: 'abc1234',
    });
  });

  it('ready answers the same contract shape, 200 when the dependencies are up', async () => {
    const response = { status: jest.fn() };

    await expect(controller(true).ready(response)).resolves.toEqual({
      status: 'ok',
      service: 'video-api',
      version: 'abc1234',
    });
    expect(response.status).not.toHaveBeenCalled();
  });

  it('ready answers 503 without the error details (internal hosts stay in the logs)', async () => {
    const response = { status: jest.fn() };

    const body = await controller(false).ready(response);

    expect(response.status).toHaveBeenCalledWith(503);
    expect(body).toEqual({ status: 'unavailable', service: 'video-api', version: 'abc1234' });
  });
});
