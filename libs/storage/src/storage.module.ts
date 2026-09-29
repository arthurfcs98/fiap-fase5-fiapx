import { Module } from '@nestjs/common';
import type { S3Client } from '@aws-sdk/client-s3';
import { OBJECT_STORAGE } from './object-storage.port';
import { createS3Client, S3ObjectStorage } from './s3-object-storage';
import { StorageLifecycle } from './storage-lifecycle.service';
import type { StorageModuleOptions } from './storage.options';
import {
  resolveBuckets,
  S3_CLIENT,
  STORAGE_BUCKETS,
  STORAGE_OPTIONS,
  StorageConfigurableModule,
} from './storage.options';

/**
 * `StorageModule.forRootAsync({ inject: [CONFIG], useFactory: (c) => storageOptionsFromConfig(c) })`
 * no módulo raiz (global). Exporta `OBJECT_STORAGE` (porta `IObjectStorage`), `S3_CLIENT` e
 * `STORAGE_BUCKETS`.
 */
@Module({
  providers: [
    {
      provide: S3_CLIENT,
      inject: [STORAGE_OPTIONS],
      useFactory: (options: StorageModuleOptions) => createS3Client(options),
    },
    {
      provide: OBJECT_STORAGE,
      inject: [S3_CLIENT, STORAGE_OPTIONS],
      useFactory: (client: S3Client, options: StorageModuleOptions) =>
        new S3ObjectStorage(client, options),
    },
    {
      provide: STORAGE_BUCKETS,
      inject: [STORAGE_OPTIONS],
      useFactory: resolveBuckets,
    },
    StorageLifecycle,
  ],
  exports: [OBJECT_STORAGE, S3_CLIENT, STORAGE_BUCKETS],
})
export class StorageModule extends StorageConfigurableModule {}
