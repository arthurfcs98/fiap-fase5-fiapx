import {
  baseServiceConfigShape,
  csvList,
  databaseConfigShape,
  envBoolean,
  portSchema,
} from '@fiapx/common';
import { messagingConfigShape } from '@fiapx/messaging';
import { metricsServerConfigShape } from '@fiapx/observability';
import { storageConfigShape } from '@fiapx/storage';
import { z } from 'zod';
import {
  DEFAULT_LOGIN_IP_LIMIT,
  DEFAULT_THROTTLE_LIMITS,
} from '../shared/infrastructure/throttling/throttle';

export const SERVICE_NAME = 'video-api';

/** Injection token of the validated video-api configuration. */
export const API_CONFIG = Symbol('API_CONFIG');

/** Privacy policy version accepted at sign-up (contratos.md, section 12). */
export const DEFAULT_PRIVACY_POLICY_VERSION = '2026-09-28';

/**
 * video-api variables (contratos.md, sections 10 and 12). Secrets (`JWT_SECRET`,
 * `DOWNLOAD_URL_SECRET`, `DB_PASSWORD`, `S3_SECRET_ACCESS_KEY`, `RABBITMQ_URL`, `REDIS_URL`)
 * also accept `<VAR>_FILE`, and none of them has a default.
 */
export const apiConfigSchema = z.object({
  ...baseServiceConfigShape,
  ...metricsServerConfigShape,
  ...messagingConfigShape,
  ...storageConfigShape,
  ...databaseConfigShape,
  PORT: portSchema.default(3000),
  /** Swagger at /api/docs (can be turned off in production). */
  SWAGGER_ENABLED: envBoolean(true),
  REDIS_URL: z
    .string()
    .regex(/^rediss?:\/\/\S+$/, 'REDIS_URL deve ser uma URL redis:// ou rediss://'),
  /** HS256 key: at least 32 characters (the dev-secrets script generates 48 hex characters). */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET precisa de pelo menos 32 caracteres'),
  /** Access token lifetime in seconds (contract: 1 h). */
  JWT_EXPIRES_IN: z.coerce.number().int().min(60).max(86_400).default(3600),
  /** HMAC key of the signed download URLs. */
  DOWNLOAD_URL_SECRET: z
    .string()
    .min(32, 'DOWNLOAD_URL_SECRET precisa de pelo menos 32 caracteres'),
  /** Public origin used to build the download URLs (no trailing slash needed). */
  PUBLIC_BASE_URL: z
    .url({ protocol: /^https?$/, error: 'PUBLIC_BASE_URL deve ser uma URL http(s)' })
    .transform((url) => url.replace(/\/+$/, ''))
    .default('http://localhost:3000'),
  /** Upload limit per file (95 MB = Cloudflare proxy limit). */
  MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(5_120).default(95),
  /**
   * Uploads streamed at the same time by ONE replica (each holds ~10 MiB of S3 part buffers):
   * beyond it `503 X0003` + `Retry-After` (the frontend retries). Sized for the 320 MiB pod.
   */
  MAX_CONCURRENT_UPLOADS: z.coerce.number().int().min(1).max(256).default(8),
  /**
   * Videos one user may have in progress (uploading, QUEUED or PROCESSING): beyond it
   * `429 V0007` + `Retry-After`. Keeps one user from filling the queue and `fiapx-raw`.
   */
  MAX_PENDING_VIDEOS_PER_USER: z.coerce.number().int().min(1).default(5),
  /** Allowed CORS origins (comma separated). Empty = no CORS headers (same origin only). */
  CORS_ORIGIN: csvList.optional(),
  /**
   * Days a zip stays downloadable after COMPLETED (LGPD retention, section 12). Fractions are
   * accepted so tests can use minutes (e.g. `0.001` ≈ 86 s).
   */
  ZIP_RETENTION_DAYS: z.coerce.number().positive().max(365).default(7),
  /** Interval of the retention job (expired zips, orphan objects): default every hour. */
  DATA_RETENTION_INTERVAL_S: z.coerce.number().int().min(5).max(86_400).default(3600),
  /** Sign-ups per hour per client IP. */
  THROTTLE_REGISTER_LIMIT: z.coerce.number().int().min(1).default(DEFAULT_THROTTLE_LIMITS.register),
  /** Logins per minute per client IP + e-mail (contract: 5). */
  THROTTLE_LOGIN_LIMIT: z.coerce.number().int().min(1).default(DEFAULT_THROTTLE_LIMITS.login),
  /**
   * Logins per minute per client IP, whatever the e-mail (each costs a bcrypt check): bounds
   * the CPU an attacker rotating e-mails can burn.
   */
  THROTTLE_LOGIN_IP_LIMIT: z.coerce.number().int().min(1).default(DEFAULT_LOGIN_IP_LIMIT),
  /** Uploads per minute per user. */
  THROTTLE_UPLOAD_LIMIT: z.coerce.number().int().min(1).default(DEFAULT_THROTTLE_LIMITS.upload),
  /** Privacy policy version stored with the consent (`users.privacy_policy_version`). */
  PRIVACY_POLICY_VERSION: z.string().min(1).max(20).default(DEFAULT_PRIVACY_POLICY_VERSION),
});

export type ApiConfig = z.output<typeof apiConfigSchema>;
