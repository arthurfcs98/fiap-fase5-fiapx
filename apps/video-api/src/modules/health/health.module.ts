import type { IObjectStorage, StorageBuckets } from '@fiapx/storage';
import { OBJECT_STORAGE, STORAGE_BUCKETS } from '@fiapx/storage';
import { Module } from '@nestjs/common';
import type { HealthIndicatorFunction } from '@nestjs/terminus';
import { HealthIndicatorService, TerminusModule } from '@nestjs/terminus';
import { DataSource } from 'typeorm';
import { READINESS_CHECKS } from './health.constants';
import { checkDatabase, checkStorage } from './infrastructure/dependency-health.indicators';
import { HealthController } from './interfaces/controllers/health.controller';

@Module({
  imports: [TerminusModule.forRoot({ errorLogStyle: 'json' })],
  controllers: [HealthController],
  providers: [
    {
      provide: READINESS_CHECKS,
      inject: [HealthIndicatorService, DataSource, OBJECT_STORAGE, STORAGE_BUCKETS],
      useFactory: (
        indicator: HealthIndicatorService,
        dataSource: DataSource,
        storage: IObjectStorage,
        buckets: StorageBuckets,
      ): HealthIndicatorFunction[] => [
        () => checkDatabase(indicator, dataSource),
        () => checkStorage(indicator, storage, buckets),
      ],
    },
  ],
})
export class HealthModule {}
