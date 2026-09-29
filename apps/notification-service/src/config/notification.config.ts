import { baseServiceConfigShape, databaseConfigShape, envBoolean, portSchema } from '@fiapx/common';
import { messagingConfigShape } from '@fiapx/messaging';
import { metricsServerConfigShape } from '@fiapx/observability';
import { z } from 'zod';

export const SERVICE_NAME = 'notification-service';

/** Injection token of the validated notification-service config. */
export const NOTIFICATION_CONFIG = Symbol('NOTIFICATION_CONFIG');

/** `EMAIL_PROVIDER` values (contratos.md, section 10). */
export const EMAIL_PROVIDERS = ['resend', 'smtp', 'log'] as const;
export type EmailProviderName = (typeof EMAIL_PROVIDERS)[number];

/**
 * Link target of every e-mail when `PUBLIC_BASE_URL` is not set: the local compose stack
 * (`API_HOST_PORT` default). Production always sets the public URL.
 */
export const DEFAULT_PUBLIC_BASE_URL = 'http://localhost:8080';

/**
 * `Name <address@domain>` or a bare address. CR/LF and angle brackets outside the address are
 * rejected, so the value can never inject a header into the SMTP message.
 */
const EMAIL_FROM_PATTERN = /^(?:[^<>\r\n]*<[^\s<>@]+@[^\s<>@]+>|[^\s<>@]+@[^\s<>@]+)$/;

/** E-mail settings (contratos.md, sections 10 and 12). */
export const emailConfigShape = {
  EMAIL_PROVIDER: z.enum(EMAIL_PROVIDERS),
  /** Required with `EMAIL_PROVIDER=resend` (accepts `RESEND_API_KEY_FILE`). */
  RESEND_API_KEY: z.string().min(1).optional(),
  EMAIL_FROM: z
    .string()
    .max(200)
    .regex(EMAIL_FROM_PATTERN, 'EMAIL_FROM deve ser "Nome <endereco@dominio>" ou um endereço'),
  /** Required with `EMAIL_PROVIDER=smtp` (Mailpit in dev/CI). */
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: portSchema.default(1025),
  /** Dev only: every e-mail goes to this address instead of the user's. */
  EMAIL_TO_OVERRIDE: z.email().optional(),
  /** `video.completed` e-mails are optional; `video.failed` is always sent. */
  NOTIFY_ON_SUCCESS: envBoolean(false),
  /** Where the e-mail links point (the app home page, never a download URL). */
  PUBLIC_BASE_URL: z
    .url({ protocol: /^https?$/, error: 'PUBLIC_BASE_URL deve ser uma URL http(s)' })
    .transform((url) => url.replace(/\/+$/, ''))
    .default(DEFAULT_PUBLIC_BASE_URL),
  /** LGPD: notifications older than this are anonymized by the daily job. */
  NOTIFICATION_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
};

export const notificationConfigSchema = z
  .object({
    ...baseServiceConfigShape,
    ...metricsServerConfigShape,
    ...messagingConfigShape,
    ...databaseConfigShape,
    ...emailConfigShape,
  })
  .superRefine((config, context) => {
    if (config.EMAIL_PROVIDER === 'resend' && config.RESEND_API_KEY === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['RESEND_API_KEY'],
        message: 'RESEND_API_KEY é obrigatória com EMAIL_PROVIDER=resend',
      });
    }
    if (config.EMAIL_PROVIDER === 'smtp' && config.SMTP_HOST === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['SMTP_HOST'],
        message: 'SMTP_HOST é obrigatória com EMAIL_PROVIDER=smtp',
      });
    }
  });

export type NotificationConfig = z.output<typeof notificationConfigSchema>;

/**
 * Config of the `migrate` one-shot (`node dist/migrate.js`): only the database, so the Job does
 * not need the broker or e-mail secrets.
 */
export const migrateConfigSchema = z.object({
  ...baseServiceConfigShape,
  ...databaseConfigShape,
});

export type MigrateConfig = z.output<typeof migrateConfigSchema>;
