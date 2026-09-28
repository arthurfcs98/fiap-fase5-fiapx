import { envBoolean } from '@fiapx/common';
import { z } from 'zod';
import { BUCKETS } from './object-keys';

/** Variáveis do cliente S3 (Garage local e na VM). Segredo aceita `S3_SECRET_ACCESS_KEY_FILE`. */
export const storageConfigShape = {
  S3_ENDPOINT: z.url({ protocol: /^https?$/, error: 'S3_ENDPOINT deve ser uma URL http(s)' }),
  S3_REGION: z.string().min(1).default('garage'),
  S3_BUCKET_RAW: z.string().min(3).default(BUCKETS.raw),
  S3_BUCKET_ZIPS: z.string().min(3).default(BUCKETS.zips),
  S3_ACCESS_KEY_ID: z.string().min(16),
  S3_SECRET_ACCESS_KEY: z.string().min(16),
  S3_FORCE_PATH_STYLE: envBoolean(true),
};
