import { ConfigurableModuleBuilder } from '@nestjs/common';
import { z } from 'zod';
import { BUCKETS } from './object-keys';
import type { S3ClientOptions, S3ObjectStorageOptions } from './s3-object-storage';
import { storageConfigShape } from './storage.config';

export interface StorageBuckets {
  raw: string;
  zips: string;
}

export interface StorageModuleOptions extends S3ClientOptions, S3ObjectStorageOptions {
  /** Padrão: `fiapx-raw` / `fiapx-zips`. */
  buckets?: StorageBuckets;
}

/** Cliente `S3Client` do serviço (para operações fora da porta, ex.: listagem em scripts). */
export const S3_CLIENT = Symbol('S3_CLIENT');
/** Buckets configurados (`S3_BUCKET_RAW`, `S3_BUCKET_ZIPS`). */
export const STORAGE_BUCKETS = Symbol('STORAGE_BUCKETS');

export const {
  ConfigurableModuleClass: StorageConfigurableModule,
  MODULE_OPTIONS_TOKEN: STORAGE_OPTIONS,
} = new ConfigurableModuleBuilder<StorageModuleOptions>()
  .setClassMethodName('forRoot')
  .setExtras({ isGlobal: true }, (definition, extras) => ({
    ...definition,
    global: extras.isGlobal,
  }))
  .build();

export const storageConfigSchema = z.object(storageConfigShape);
/** Configuração validada das variáveis `S3_*` (ver `storageConfigShape`). */
export type StorageConfig = z.output<typeof storageConfigSchema>;

/** Converte as variáveis `S3_*` validadas nas opções do `StorageModule`. */
export function storageOptionsFromConfig(config: StorageConfig): StorageModuleOptions {
  return {
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    accessKeyId: config.S3_ACCESS_KEY_ID,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    buckets: { raw: config.S3_BUCKET_RAW, zips: config.S3_BUCKET_ZIPS },
  };
}

export function resolveBuckets(options: StorageModuleOptions): StorageBuckets {
  return options.buckets ?? { raw: BUCKETS.raw, zips: BUCKETS.zips };
}
