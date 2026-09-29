import { Global, Module } from '@nestjs/common';
import type { ApiConfig } from '../config/api.config';
import { API_CONFIG, SERVICE_NAME } from '../config/api.config';
import { CLOCK, systemClock } from './domain/clock';
import { createRedisClient } from './infrastructure/redis/redis.client';
import { REDIS_CLIENT } from './infrastructure/redis/redis.constants';
import { RedisLifecycle } from './infrastructure/redis/redis-lifecycle.service';

/** Cross-cutting providers (global): clock and the shared Redis client. */
@Global()
@Module({
  providers: [
    { provide: CLOCK, useValue: systemClock },
    {
      provide: REDIS_CLIENT,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig) => createRedisClient(config.REDIS_URL, SERVICE_NAME),
    },
    RedisLifecycle,
  ],
  exports: [CLOCK, REDIS_CLIENT],
})
export class SharedModule {}
