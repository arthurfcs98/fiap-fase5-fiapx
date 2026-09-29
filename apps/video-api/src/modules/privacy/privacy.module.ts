import type { S3Client } from '@aws-sdk/client-s3';
import type { IObjectStorage } from '@fiapx/storage';
import { OBJECT_STORAGE, S3_CLIENT } from '@fiapx/storage';
import { Module } from '@nestjs/common';
import type { ApiConfig } from '../../config/api.config';
import { API_CONFIG } from '../../config/api.config';
import { AuthModule } from '../auth/auth.module';
import { VideosModule } from '../videos/videos.module';
import { DeleteMyAccountUseCase } from './application/use-cases/delete-my-account.use-case';
import { ExportMyDataUseCase } from './application/use-cases/export-my-data.use-case';
import { PurgeDeliveryRecordsUseCase } from './application/use-cases/purge-delivery-records.use-case';
import { PurgeLeftoverUploadsUseCase } from './application/use-cases/purge-leftover-uploads.use-case';
import { PurgeOrphanObjectsUseCase } from './application/use-cases/purge-orphan-objects.use-case';
import { USER_OBJECT_STORE } from './domain/user-object.store';
import { S3UserObjectStore } from './infrastructure/s3-user-object.store';
import { MeController } from './interfaces/controllers/me.controller';
import type { RetentionSchedule } from './interfaces/jobs/data-retention.job';
import { DataRetentionJob, RETENTION_SCHEDULE } from './interfaces/jobs/data-retention.job';

/** LGPD: data export, account erasure and the hourly retention job (contratos.md, section 12). */
@Module({
  imports: [AuthModule, VideosModule],
  controllers: [MeController],
  providers: [
    {
      provide: USER_OBJECT_STORE,
      inject: [S3_CLIENT, OBJECT_STORAGE],
      useFactory: (client: S3Client, storage: IObjectStorage) =>
        new S3UserObjectStore(client, storage),
    },
    ExportMyDataUseCase,
    DeleteMyAccountUseCase,
    PurgeOrphanObjectsUseCase,
    PurgeLeftoverUploadsUseCase,
    PurgeDeliveryRecordsUseCase,
    {
      provide: RETENTION_SCHEDULE,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): RetentionSchedule => ({
        intervalMs: config.DATA_RETENTION_INTERVAL_S * 1000,
      }),
    },
    DataRetentionJob,
  ],
})
export class PrivacyModule {}
